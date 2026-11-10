import "server-only";
import { randomBytes, randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { and, count, eq, gt, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { type Actor, assertCan } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import { DEMO_EMAIL_DOMAIN, MARKER } from "@/lib/demo-identity";
import { demoSeedConfig } from "@/lib/demo-seed-config";
import { DEMO_LOADS_PER_DAY } from "@/lib/domain";
import { ConflictError, TooManyRequestsError } from "@/lib/errors";
import { log } from "@/lib/log";
import { releaseDaily, releaseRate, reserveDaily } from "@/lib/usage";

export { DEMO_LOADS_PER_DAY };

/** The demo team: one manager and two staff, in one café. Includes 60 days of ledger history, with several recent fast movers. */
export const DEMO_WORKSPACE_NAME = "Demo Corner Store";
const PEOPLE = [
  { name: "Maya", role: "manager" },
  { name: "Sam", role: "staff" },
  { name: "Jo", role: "staff" },
] as const;
/** Postgres unique violation, possibly wrapped by Drizzle (`cause`). */
const isUniqueViolation = (e: unknown): boolean =>
  typeof e === "object" && e !== null && ((e as { code?: unknown }).code === "23505" || isUniqueViolation((e as { cause?: unknown }).cause));
const emailFor = (name: string) => `${name.toLowerCase()}@${DEMO_EMAIL_DOMAIN}`;
const optionsSchema = z.discriminatedUnion("mode", [z.object({ mode: z.literal("admin") }).strict(), z.object({ mode: z.literal("cli") }).strict()]);

/** One constant key serializes every demo load and reservation across processes. */
const LOCK_KEY = "demo-load";
type Tx = Parameters<Parameters<ReturnType<typeof db>["transaction"]>[0]>[0];
const tryLock = (tx: Pick<ReturnType<typeof db>, "execute">) =>
  tx.execute<{ ok: boolean }>(sql`select pg_try_advisory_xact_lock(hashtextextended(${LOCK_KEY}, 0)) as ok`);

/** One load per minute and `DEMO_LOADS_PER_DAY` per UTC day for the whole app, reserved under the load lock. */
async function reserveLocked(tx: Tx, actor: Actor): Promise<void> {
  const { rateEvent } = schema;
  const any = eq(rateEvent.kind, "demo_load");
  await tx.delete(rateEvent).where(and(any, sql`${rateEvent.at} <= now() - interval '1 minute'`));
  const [{ n }] = await tx.select({ n: count() }).from(rateEvent).where(and(any, gt(rateEvent.at, sql`now() - interval '1 minute'`)));
  if (n) throw new TooManyRequestsError("Demo workspace can be loaded once per minute. Try again shortly.");
  if (!(await reserveDaily(tx, "demo_load", DEMO_LOADS_PER_DAY))) {
    throw new TooManyRequestsError("The demo workspace was loaded the maximum number of times today. Try again tomorrow.");
  }
  await tx.insert(rateEvent).values({ userId: actor.id, kind: "demo_load" });
}

export type DemoLoadResult = { users: number; workspaces: number; members: number };

/**
 * Admin-only. Default is the safe admin-route mode; CLI mode re-checks the production guards in `demoSeedConfig()`.
 * Replaces exactly the demo users' own workspaces (found through the marker-checked accounts, never by name).
 *
 * No transaction is held while Better Auth works (it uses its own pooled connections, so holding one here would hang
 * with `DB_POOL_MAX=1`). Order: reserve the load (short transaction under the load lock), prepare the three accounts,
 * then replace the workspace in one short transaction under the same lock. A failure after the reservation refunds it.
 */
export async function loadDemoWorkspace(
  actor: Actor,
  options: unknown = { mode: "admin" },
  { reserve = false }: { reserve?: boolean } = {},
): Promise<DemoLoadResult> {
  assertCan(actor, "delete");
  const parsed = optionsSchema.parse(options);
  if (reserve) {
    await db().transaction(async (tx) => {
      await takeLock(tx);
      await reserveLocked(tx, actor);
    });
    log.info("admin.demo_load", { by: actor.id });
  }
  try {
    const ids = await prepareAccounts(actor, parsed.mode);
    const result = await db().transaction(async (tx) => {
      await takeLock(tx);
      return replaceWorkspace(tx, ids);
    });
    log.info("demo.loaded", { by: actor.id, mode: parsed.mode, ...result });
    return result;
  } catch (err) {
    if (reserve) await refund(actor);
    throw err;
  }
}

async function takeLock(tx: Tx): Promise<void> {
  const [{ ok }] = await tryLock(tx);
  if (!ok) throw new TooManyRequestsError("A demo load is already running. Try again shortly.");
}

/** Give back a reservation whose load never happened. Best effort: a refund failure must not hide the real error. */
async function refund(actor: Actor): Promise<void> {
  try {
    await db().transaction(async (tx) => {
      await releaseRate(tx, actor.id, "demo_load");
      await releaseDaily(tx, "demo_load");
    });
  } catch (err) {
    log.error("demo.refund_failed", { errorName: err instanceof Error ? err.name : typeof err });
  }
}

/** Check every identity, then create or reset the three accounts. Returns their ids by name. */
async function prepareAccounts(actor: Actor, mode: "admin" | "cli"): Promise<Map<string, string>> {
  const password = mode === "cli" ? demoSeedConfig().password : undefined;
  const ctx = await auth().$context;

  // Preflight every identity before changing anything: an unrelated account at a demo address is never adopted.
  for (const p of PEOPLE) {
    const [existing] = await db().select().from(schema.user).where(eq(schema.user.email, emailFor(p.name)));
    if (existing && existing.image !== MARKER) throw new ConflictError("A demo email belongs to an unrelated account; no demo data was replaced.");
    if (existing?.id === actor.id) throw new ConflictError("Load the demo from a separate administrator account.");
  }

  const ids = new Map<string, string>();
  for (const p of PEOPLE) {
    const email = emailFor(p.name);
    const secret = password ?? randomBytes(32).toString("base64url");
    const [existing] = await db().select().from(schema.user).where(eq(schema.user.email, email));
    if (existing) {
      // Rotate the password on every load so a previous CLI password can't sign in on a live deploy.
      await ctx.internalAdapter.updateUser(existing.id, { role: "user" });
      await ctx.internalAdapter.updatePassword(existing.id, await ctx.password.hash(secret));
      await ctx.internalAdapter.deleteUserSessions(existing.id);
      ids.set(p.name, existing.id);
    } else {
      // Written with Drizzle, not Better Auth: the auth hooks refuse demo emails and marker images.
      const id = randomUUID();
      try {
        await db().transaction(async (tx) => {
          await tx.insert(schema.user).values({ id, email, name: p.name, role: "user", image: MARKER });
          await tx.insert(schema.account).values({ id: randomUUID(), accountId: id, providerId: "credential", userId: id, password: await hashPassword(secret) });
        });
      } catch (e) {
        // A real account took the demo email since the preflight: report a conflict, not a crash.
        if (isUniqueViolation(e)) throw new ConflictError("A demo email belongs to an unrelated account; no demo data was replaced.");
        throw e;
      }
      ids.set(p.name, id);
    }
  }
  return ids;
}

async function replaceWorkspace(tx: Tx, ids: Map<string, string>): Promise<DemoLoadResult> {
  const all = [...ids.values()];
  const { rateEvent, workspace, membership } = schema;
  await tx.delete(rateEvent).where(and(inArray(rateEvent.userId, all), sql`${rateEvent.kind} <> 'demo_load'`));
  // Memberships and invites cascade with the workspace.
  await tx.delete(workspace).where(inArray(workspace.createdBy, all));
  const [ws] = await tx
    .insert(workspace)
    .values({ name: DEMO_WORKSPACE_NAME, timeZone: "America/Denver", createdBy: ids.get("Maya")! })
    .returning({ id: workspace.id });
  await tx.insert(membership).values(PEOPLE.map((p) => ({ workspaceId: ws.id, userId: ids.get(p.name)!, role: p.role })));
  await seedInventory(tx, ws.id, ids.get("Maya")!);
  return { users: PEOPLE.length, workspaces: 1, members: PEOPLE.length };
}

/** Deterministic sales quantities: 60 days, faster sales in the last week, and a reconciled cached balance. */
async function seedInventory(tx: Tx, workspaceId: string, actorId: string) {
  const products = [
    { sku: "OAT-MILK", name: "Oat milk", barcode: "4006381333931", base: 3, fast: true, remaining: 6 },
    { sku: "COFFEE", name: "Coffee beans", barcode: null, base: 2, fast: true, remaining: 8 },
    { sku: "BREAD", name: "Sourdough bread", barcode: null, base: 4, fast: true, remaining: 5 },
    { sku: "TEA", name: "Breakfast tea", barcode: null, base: 1, fast: false, remaining: 90 },
    { sku: "SUGAR", name: "Sugar", barcode: null, base: 1, fast: false, remaining: 100 },
    { sku: "CUPS", name: "Paper cups", barcode: null, base: 5, fast: false, remaining: 300 },
  ];
  for (const product of products) {
    const sales = Array.from({ length: 60 }, (_, i) => product.base * (product.fast && i >= 53 ? 2 : 1));
    const initial = sales.reduce((a, b) => a + b, product.remaining);
    const firstDay = new Date(Date.now() - 60 * 86400000);
    const [created] = await tx.insert(schema.item).values({
      workspaceId, sku: product.sku, name: product.name, barcode: product.barcode,
      reorderPoint: 12, leadTimeDays: 4, packSize: 6, supplierName: "Demo supplier", unitCostCents: 250,
      onHand: product.remaining, version: 62, createdAt: firstDay,
    }).returning();
    let onHand = initial;
    const ledger: (typeof schema.stockMovement.$inferInsert)[] = [{ workspaceId, itemId: created.id,
      kind: "receive", delta: initial, onHandAfter: initial, itemVersion: 2, reason: "Demo opening delivery", actorId,
      clientOpId: randomUUID(), createdAt: firstDay }];
    for (let i = 0; i < sales.length; i++) {
      onHand -= sales[i];
      ledger.push({ workspaceId, itemId: created.id, kind: "sale", delta: -sales[i], onHandAfter: onHand,
        itemVersion: i + 3, reason: "Demo daily sales", actorId, clientOpId: randomUUID(),
        createdAt: new Date(firstDay.getTime() + i * 86400000 + 3600000) });
    }
    await tx.insert(schema.stockMovement).values(ledger);
  }
}
