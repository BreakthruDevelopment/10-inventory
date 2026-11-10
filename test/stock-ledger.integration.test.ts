import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanup, cleanupWorkspaces, makeUsers, statusOf, type TestUser } from "./helpers/tenancy";

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("stock ledger (Postgres)", () => {
  let sql: postgres.Sql;
  let manager: TestUser, staff: TestUser, outsider: TestUser, admin: TestUser;
  let ws: string;
  let items: typeof import("@/lib/items");
  let movements: typeof import("@/lib/movements");
  let exports: typeof import("@/lib/inventory-export");
  const create = (sku = "ITEM-1", extra = {}) => items.createItem(manager, ws, { sku, name: sku, ...extra });
  const move = (itemId: string, kind: string, qty: number, extra = {}, actor = staff) => movements.recordMovement(actor, ws, { itemId, kind, qty, clientOpId: randomUUID(), ...extra });
  async function reconcile(itemId: string) {
    const [row] = await sql`select i.on_hand, coalesce(sum(m.delta),0)::int as balance from item i left join stock_movement m on m.item_id = i.id and m.workspace_id = i.workspace_id where i.id = ${itemId} group by i.id`;
    expect(row.on_hand).toBe(row.balance);
  }
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    sql = postgres(url!, { max: 5, onnotice: () => {} });
    await cleanup(sql);
    [manager, staff, outsider] = await makeUsers(sql, ["stock-manager", "stock-staff", "stock-outside"]);
    [admin] = await makeUsers(sql, ["stock-admin"], "admin");
    items = await import("@/lib/items");
    movements = await import("@/lib/movements");
    exports = await import("@/lib/inventory-export");
  });
  beforeEach(async () => {
    await cleanupWorkspaces(sql);
    await sql`delete from rate_event where user_id like 'tn-stock-%'`;
    const { createWorkspace } = await import("@/lib/workspaces");
    ws = (await createWorkspace(manager, { name: "Stock shop" })).id;
    await sql`insert into membership (workspace_id, user_id, role) values (${ws}, ${staff.id}, 'staff')`;
  });
  afterAll(async () => { await cleanup(sql); await sql.end(); });

  // Twenty repetitions are part of the acceptance criteria, not just a lucky one-off race.
  for (let run = 1; run <= 20; run++) {
    it(`concurrent sells and retries preserve the ledger (run ${run}/20)`, async () => {
      const row = await create();
      await move(row.id, "receive", 10);
      const result = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => move(row.id, "sale", 1, {}, i % 2 ? staff : manager)));
      expect(result.filter(r => statusOf(r) === 200)).toHaveLength(10);
      expect(result.filter(r => statusOf(r) === 409)).toHaveLength(10);
      expect((await items.getItem(staff, ws, row.id)).onHand).toBe(0);
      expect(Number((await sql`select count(*) from stock_movement where item_id = ${row.id} and kind = 'sale'`)[0].count)).toBe(10);
      await reconcile(row.id);
      const op = randomUUID();
      const repeated = await Promise.all(Array.from({ length: 20 }, (_, i) => move(row.id, "receive", 3, { clientOpId: op }, i % 2 ? staff : manager)));
      expect(new Set(repeated.map(m => m.id)).size).toBe(1);
      expect((await items.getItem(staff, ws, row.id)).onHand).toBe(3);
      // A delayed replay returns the original receipt, even after another movement changed the item.
      await move(row.id, "sale", 1);
      expect(await move(row.id, "receive", 3, { clientOpId: op })).toEqual(repeated[0]);
      await reconcile(row.id);
    });
  }

  it("counts and edits reject stale versions with the current stock and movements since, then explicitly keep mine", async () => {
    const row = await create("COUNT", { reorderPoint: 9, packSize: 6, supplierName: "Supplier" });
    await move(row.id, "receive", 10);
    await move(row.id, "sale", 3);
    const current = await items.getItem(staff, ws, row.id);
    expect(current).toMatchObject({ onHand: 7, version: 3, ledgerBalance: 7, ledgerMatches: true });
    for (const operation of [() => move(row.id, "count", 11, { expectedVersion: 2 }), () => items.editItem(manager, ws, row.id, { version: 2, name: "Stale" })]) {
      await expect(operation()).rejects.toMatchObject({ status: 409, current: { onHand: 7, version: 3 }, movements: [{ kind: "sale", delta: -3, itemVersion: 3 }] });
    }
    const counted = await move(row.id, "count", 11, { expectedVersion: current.version, reason: "Keep mine after recount" });
    expect(counted).toMatchObject({ delta: 4, onHandAfter: 11, itemVersion: 4 });
    const edit = await items.editItem(manager, ws, row.id, { version: 4, name: "Changed" });
    expect(edit).toMatchObject({ name: "Changed", onHand: 11, version: 5, reorderPoint: 9, packSize: 6, supplierName: "Supplier" });
    await move(row.id, "count", 0, { expectedVersion: 5 });
    await reconcile(row.id);
  });

  it("simultaneous absolute counts and item edits allow one winner", async () => {
    const row = await create();
    const counts = await Promise.allSettled([move(row.id, "count", 8, { expectedVersion: 1 }), move(row.id, "count", 12, { expectedVersion: 1 }, manager)]);
    expect(counts.map(statusOf).sort()).toEqual([200, 409]);
    await reconcile(row.id);
    const edits = await Promise.allSettled([items.editItem(manager, ws, row.id, { version: 2, name: "A" }), items.editItem(manager, ws, row.id, { version: 2, name: "B" })]);
    expect(edits.map(statusOf).sort()).toEqual([200, 409]);
    await reconcile(row.id);
  });

  it("deltas race a count without losing stock, and adjust needs a reason", async () => {
    const row = await create();
    await move(row.id, "receive", 10);
    const race = await Promise.allSettled([move(row.id, "sale", 2, {}, manager), move(row.id, "count", 6, { expectedVersion: 2 })]);
    expect(statusOf(race[0])).toBe(200);
    expect([200, 409]).toContain(statusOf(race[1]));
    await reconcile(row.id);
    await expect(move(row.id, "adjust", -1)).rejects.toThrow();
    await move(row.id, "adjust", -1, { reason: "Damaged" });
    await reconcile(row.id);
    await expect(move(row.id, "sale", 100)).rejects.toMatchObject({ status: 409 });
    await reconcile(row.id);
  });

  it("rolls back the balance if inserting the movement fails", async () => {
    const row = await create();
    // A statement trigger fails the append after UPDATE; the transaction must undo that UPDATE too.
    await sql`create function test_reject_stock() returns trigger language plpgsql as $$ begin raise exception 'test append failed'; end $$`;
    await sql`create trigger test_reject_stock before insert on stock_movement for each statement execute function test_reject_stock()`;
    try { await expect(move(row.id, "receive", 10)).rejects.toThrow(); }
    finally { await sql`drop trigger test_reject_stock on stock_movement`; await sql`drop function test_reject_stock()`; }
    expect((await items.getItem(staff, ws, row.id)).onHand).toBe(0);
    await reconcile(row.id);
  });

  it("cannot update/delete/truncate the ledger, delete an item with history, or violate tenant FK", async () => {
    const row = await create();
    const m = await move(row.id, "receive", 10);
    await expect(sql`update stock_movement set delta = 100 where id = ${m.id}`).rejects.toMatchObject({ code: "23514" });
    await expect(sql`delete from stock_movement where id = ${m.id}`).rejects.toMatchObject({ code: "23514" });
    await expect(sql`truncate stock_movement`).rejects.toMatchObject({ code: "23514" });
    await expect(sql`delete from item where id = ${row.id}`).rejects.toMatchObject({ code: "23514" });
    const { createWorkspace } = await import("@/lib/workspaces");
    const other = await createWorkspace(outsider, { name: "Other" });
    await expect(sql`insert into stock_movement (workspace_id,item_id,kind,delta,on_hand_after,item_version,actor_id,client_op_id) values (${other.id},${row.id},'receive',1,1,2,${outsider.id},${randomUUID()})`).rejects.toMatchObject({ code: "23503" });
    await reconcile(row.id);
    // Explicit workspace removal is the sole deletion exception, required for demo replacement.
    await sql`delete from workspace where id = ${ws}`;
    expect((await sql`select id from stock_movement where id = ${m.id}`).length).toBe(0);
  });

  it("archives without deleting history and excludes archived stock from lookup/exports", async () => {
    const row = await create("ARCH", { barcode: "4006381333931" });
    const receipt = await move(row.id, "receive", 3);
    await expect(items.archiveItem(manager, ws, row.id, { version: 1 })).rejects.toMatchObject({ status: 409 });
    await items.archiveItem(manager, ws, row.id, { version: 2 });
    await expect(move(row.id, "sale", 1)).rejects.toMatchObject({ status: 409 });
    expect(await move(row.id, "receive", 3, { clientOpId: receipt.clientOpId })).toEqual(receipt);
    expect(await items.listItems(staff, ws)).toEqual([]);
    expect(await items.listItems(staff, ws, { archived: "true" })).toHaveLength(1);
    await expect(items.lookupItem(staff, ws, row.barcode)).rejects.toMatchObject({ status: 404 });
    expect(await exports.exportItems(manager, ws)).not.toContain("ARCH");
    await reconcile(row.id);
  });

  it("checks GTINs and scopes SKU/barcode uniqueness, lookup, and literal search", async () => {
    const row = await create("SKU-1", { barcode: "4006381333931", name: "100%_cotton" });
    expect((await items.lookupItem(staff, ws, "SKU-1")).id).toBe(row.id);
    expect((await items.lookupItem(staff, ws, "4006381333931")).id).toBe(row.id);
    await expect(items.lookupItem(staff, ws, "4006381333932")).rejects.toThrow();
    await expect(create("SECOND", { barcode: "4006381333932" })).rejects.toThrow();
    await expect(create("SKU-1")).rejects.toMatchObject({ status: 409 });
    await expect(create("SECOND", { barcode: row.barcode })).rejects.toMatchObject({ status: 409 });
    expect(await items.listItems(staff, ws, { q: "%_" })).toHaveLength(1);
    await expect(items.lookupItem(staff, ws, "unknown")).rejects.toMatchObject({ status: 404 });
    await create("4006381333931");
    await expect(items.lookupItem(staff, ws, "4006381333931")).rejects.toMatchObject({ status: 409 });
  });

  it("enforces stock overflow, strict schemas, roles and nonmember/admin isolation", async () => {
    const row = await create();
    await move(row.id, "receive", 2147483647);
    await expect(move(row.id, "receive", 1)).rejects.toMatchObject({ status: 409 });
    await expect(create("NEG", { onHand: 1 })).rejects.toThrow();
    for (const actor of [outsider, admin]) {
      await expect(items.listItems(actor, ws)).rejects.toMatchObject({ status: 404 });
      await expect(items.getItem(actor, ws, row.id)).rejects.toMatchObject({ status: 404 });
      await expect(items.lookupItem(actor, ws, row.sku)).rejects.toMatchObject({ status: 404 });
      await expect(items.createItem(actor, ws, {})).rejects.toMatchObject({ status: 404 });
      await expect(move(row.id, "receive", 1, {}, actor)).rejects.toMatchObject({ status: 404 });
      await expect(exports.exportItems(actor, ws)).rejects.toMatchObject({ status: 404 });
    }
    await expect(items.createItem(staff, ws, {})).rejects.toMatchObject({ status: 403 });
    await expect(items.editItem(staff, ws, row.id, { version: 2 })).rejects.toMatchObject({ status: 403 });
    await expect(items.archiveItem(staff, ws, row.id, { version: 2 })).rejects.toMatchObject({ status: 403 });
    await expect(exports.exportItems(staff, ws)).rejects.toMatchObject({ status: 403 });
    await reconcile(row.id);
  });

  it("enforces item, movement, export limits and the concurrent 2,000 item cap", async () => {
    const row = await create();
    for (const [kind, limit] of [["api_write", 200], ["movement", 600], ["export", 20]] as const) {
      await sql`delete from rate_event where user_id = ${manager.id}`;
      await sql`insert into rate_event (user_id, kind) select ${manager.id}, ${kind} from generate_series(1, ${limit})`;
      const operation = kind === "api_write" ? items.editItem(manager, ws, row.id, { version: 1 }) : kind === "movement" ? move(row.id, "receive", 1, {}, manager) : exports.exportItems(manager, ws);
      await expect(operation).rejects.toMatchObject({ status: 429 });
    }
    await sql`delete from rate_event where user_id = ${manager.id}`;
    await sql`insert into item (workspace_id,sku,name) select ${ws}, 'cap-' || g, 'Cap item' from generate_series(1,1998) g`;
    const attempts = await Promise.allSettled([create("LAST-A"), create("LAST-B")]);
    expect(attempts.map(statusOf).sort()).toEqual([200, 409]);
    await reconcile(row.id);
  });
});
