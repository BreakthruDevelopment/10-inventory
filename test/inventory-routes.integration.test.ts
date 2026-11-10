import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { UnauthorizedError } from "@/lib/auth/rbac";
import { cleanup, cleanupWorkspaces, makeUsers, type TestUser } from "./helpers/tenancy";
const current = vi.hoisted(() => ({ actor: null as TestUser | null }));
vi.mock("@/lib/auth/session", () => ({ requireUser: async () => { if (!current.actor) throw new UnauthorizedError(); return current.actor; } }));
const url = process.env.TEST_DATABASE_URL;
const origin = "http://localhost:3000";
type Handler = (req: Request, ctx: never) => Promise<Response>;
async function call(h: Handler, method: string, ws: string, itemId?: string, body?: unknown, opts: { origin?: string | null; query?: string; raw?: string } = {}) {
  return h(new Request(`${origin}/api/test${opts.query ?? ""}`, { method, headers: { "content-type": "application/json", ...(method === "GET" || opts.origin === null ? {} : { origin: opts.origin ?? origin }) },
    body: opts.raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  }), { params: Promise.resolve({ id: ws, itemId }) } as never);
}

describe.skipIf(!url)("inventory HTTP routes (Postgres)", () => {
  let sql: postgres.Sql;
  let manager: TestUser, staff: TestUser, outsider: TestUser, admin: TestUser;
  let ws: string, foreignWs: string, item: string, foreignItem: string;
  let routes: {
    items: typeof import("@/app/api/w/[id]/items/route");
    item: typeof import("@/app/api/w/[id]/items/[itemId]/route");
    movement: typeof import("@/app/api/w/[id]/movements/route");
    lookup: typeof import("@/app/api/w/[id]/lookup/route");
    csv: typeof import("@/app/api/w/[id]/export/items.csv/route");
    reorder: typeof import("@/app/api/w/[id]/export/reorder.csv/route");
  };
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    process.env.APP_URL = origin;
    sql = postgres(url!, { max: 2, onnotice: () => {} });
    await cleanup(sql);
    [manager, staff, outsider] = await makeUsers(sql, ["ir-manager", "ir-staff", "ir-other"]);
    [admin] = await makeUsers(sql, ["ir-admin"], "admin");
    routes = {
      items: await import("@/app/api/w/[id]/items/route"), item: await import("@/app/api/w/[id]/items/[itemId]/route"),
      movement: await import("@/app/api/w/[id]/movements/route"), lookup: await import("@/app/api/w/[id]/lookup/route"),
      csv: await import("@/app/api/w/[id]/export/items.csv/route"), reorder: await import("@/app/api/w/[id]/export/reorder.csv/route"),
    };
  });
  beforeEach(async () => {
    await cleanupWorkspaces(sql);
    await sql`delete from rate_event where user_id like 'tn-ir-%'`;
    const { createWorkspace } = await import("@/lib/workspaces");
    const { createItem } = await import("@/lib/items");
    ws = (await createWorkspace(manager, { name: "Inventory A" })).id;
    foreignWs = (await createWorkspace(outsider, { name: "Inventory B" })).id;
    await sql`insert into membership (workspace_id,user_id,role) values (${ws},${staff.id},'staff')`;
    item = (await createItem(manager, ws, { sku: "ITEM-A", name: "=SUM(1,2)", barcode: "4006381333931", supplierName: '+supplier "quoted"\nnext' })).id;
    foreignItem = (await createItem(outsider, foreignWs, { sku: "ITEM-B", name: "Private B" })).id;
    current.actor = manager;
  });
  afterAll(async () => { await cleanup(sql); await sql.end(); });
  const cases = () => [
    ["list", routes.items.GET, "GET", undefined, "staff"],
    ["create", routes.items.POST, "POST", { sku: "NEW", name: "New" }, "manager"],
    ["detail", routes.item.GET, "GET", undefined, "staff"],
    ["edit", routes.item.PATCH, "PATCH", { version: 1, name: "Edited" }, "manager"],
    ["archive", routes.item.DELETE, "DELETE", { version: 1 }, "manager"],
    ["movement", routes.movement.POST, "POST", { itemId: item, kind: "receive", qty: 1, clientOpId: randomUUID() }, "staff"],
    ["lookup", routes.lookup.GET, "GET", undefined, "staff"],
    ["CSV", routes.csv.GET, "GET", undefined, "manager"],
    ["reorder CSV", routes.reorder.GET, "GET", undefined, "manager"],
  ] as const;
  it("nonmembers, admins, anonymous callers and malformed workspace ids are refused on every route", async () => {
    for (const actor of [outsider, admin, null]) {
      current.actor = actor;
      for (const [name, handler, method, body] of cases()) {
        expect((await call(handler as Handler, method, ws, item, body, { query: name == "lookup" ? "?code=ITEM-A" : "" })).status, name).toBe(actor ? 404 : 401);
      }
    }
    current.actor = manager;
    for (const bad of ["invalid", randomUUID()]) for (const [name, handler, method, body] of cases()) {
      expect((await call(handler as Handler, method, bad, item, body, { query: name == "lookup" ? "?code=ITEM-A" : "" })).status, name).toBe(404);
    }
  });
  it("foreign item ids in my workspace path cannot be read, edited, archived, or moved", async () => {
    for (const [handler, method, body] of [
      [routes.item.GET, "GET", undefined], [routes.item.PATCH, "PATCH", { version: 1, name: "Stolen" }],
      [routes.item.DELETE, "DELETE", { version: 1 }], [routes.movement.POST, "POST", { itemId: foreignItem, kind: "receive", qty: 1, clientOpId: randomUUID() }],
    ] as const) expect((await call(handler as Handler, method, ws, foreignItem, body)).status).toBe(404);
    expect((await call(routes.lookup.GET, "GET", ws, undefined, undefined, { query: "?code=ITEM-B" })).status).toBe(404);
    expect(await (await call(routes.csv.GET, "GET", ws)).text()).not.toContain("Private B");
    expect((await sql`select on_hand,name from item where id = ${foreignItem}`)[0]).toMatchObject({ on_hand: 0, name: "Private B" });
  });
  it("staff can read, look up and record stock, but cannot manage items or export", async () => {
    current.actor = staff;
    for (const [name, handler, method, body, role] of cases()) expect((await call(handler as Handler, method, ws, item, body, { query: name == "lookup" ? "?code=ITEM-A" : "" })).status, name).toBe(role === "manager" ? 403 : 200);
  });
  it("mutations reject missing/foreign Origin and strict schemas reject smuggled scope", async () => {
    for (const [name, handler, method, body] of cases().filter(([, , method]) => method !== "GET")) {
      for (const bad of [null, "https://evil.example"]) expect((await call(handler as Handler, method, ws, item, body, { origin: bad })).status, name).toBe(403);
      expect((await call(handler as Handler, method, ws, item, { ...body, workspaceId: foreignWs })).status, name).toBe(400);
      expect((await call(handler as Handler, method, ws, item, undefined, { raw: "{bad" })).status, name).toBe(400);
      expect((await call(handler as Handler, method, ws, item, undefined, { raw: "x".repeat(17000) })).status, name).toBe(413);
    }
  });
  it("returns safe structured conflicts and a stable receipt on replay", async () => {
    const body = { itemId: item, kind: "receive", qty: 10, clientOpId: randomUUID() };
    const first = await (await call(routes.movement.POST, "POST", ws, item, body)).json();
    const sale = await call(routes.movement.POST, "POST", ws, item, { ...body, kind: "sale", qty: 3, clientOpId: randomUUID() });
    expect(sale.status).toBe(200);
    expect(await (await call(routes.movement.POST, "POST", ws, item, body)).json()).toEqual(first);
    for (const [handler, method, payload] of [
      [routes.movement.POST, "POST", { ...body, kind: "count", qty: 12, expectedVersion: 2, clientOpId: randomUUID() }],
      [routes.item.PATCH, "PATCH", { name: "Stale edit", version: 2 }],
    ] as const) {
      const res = await call(handler, method, ws, item, payload);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ current: { onHand: 7, version: 3 }, movements: [{ kind: "sale", delta: -3 }] });
    }
    const detail = await (await call(routes.item.GET, "GET", ws, item)).json();
    expect(detail).toMatchObject({ item: { onHand: 7, ledgerBalance: 7, ledgerMatches: true } });
    const res = await call(routes.movement.POST, "POST", ws, item, { ...body, kind: "sale", qty: 8, clientOpId: randomUUID() });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "Only 7 left", current: { onHand: 7 } });
  });
  it("exports CSV attachments, escapes formulas/quotes/newlines, and filters reorder stock", async () => {
    const csv = await call(routes.csv.GET, "GET", ws);
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(csv.headers.get("content-disposition")).toContain('attachment; filename="items.csv"');
    expect(csv.headers.get("cache-control")).toBe("no-store");
    const text = await csv.text();
    expect(text).toContain('"\'=SUM(1,2)"');
    expect(text).toContain('"\'+supplier ""quoted""\nnext"');
    expect(text).not.toContain("Private B");
    expect(await (await call(routes.reorder.GET, "GET", ws)).text()).toContain("ITEM-A");
    await call(routes.movement.POST, "POST", ws, item, { itemId: item, kind: "receive", qty: 1, clientOpId: randomUUID() });
    expect(await (await call(routes.reorder.GET, "GET", ws)).text()).not.toContain("ITEM-A");
  });
});
