import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { UnauthorizedError } from "@/lib/auth/rbac";
import { resetEnvCache } from "@/lib/env";
import { cleanup, cleanupWorkspaces, makeUsers, type TestUser } from "./helpers/tenancy";

const current = vi.hoisted(() => ({ actor: null as TestUser | null }));
vi.mock("@/lib/auth/session", () => ({ requireUser: async () => { if (!current.actor) throw new UnauthorizedError(); return current.actor; } }));
const url = process.env.TEST_DATABASE_URL;
const origin = "http://localhost:3000";
const SECRET_NAME = "ZZ-Private-Oat-Name";
type Handler = (req: Request, ctx: never) => Promise<Response>;
const call = (h: Handler, method: string, ws: string, opts: { origin?: string | null } = {}) =>
  h(new Request(`${origin}/api/test`, { method, headers: method === "GET" ? {} : opts.origin === null ? {} : { origin: opts.origin ?? origin } }), { params: Promise.resolve({ id: ws }) } as never);

function setEnv(extra: Record<string, string> = {}) {
  for (const k of ["AI_PROVIDER", "AI_FALLBACK_TO_DEMO", "GEMINI_API_KEY", "FORECAST_DAILY_CAP"]) vi.stubEnv(k, "");
  for (const [k, v] of Object.entries({ APP_URL: origin, ...extra })) vi.stubEnv(k, v);
  resetEnvCache();
}
const geminiReply = (answer: unknown) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] }), { status: 200 });

describe.skipIf(!url)("forecast: numbers, explanation, caps and access (Postgres)", () => {
  let sql: postgres.Sql;
  let manager: TestUser, staff: TestUser, outsider: TestUser, admin: TestUser;
  let ws: string, foreignWs: string, oat: string;
  let svc: typeof import("@/lib/forecast-service");
  let routes: { forecast: typeof import("@/app/api/w/[id]/forecast/route"); explain: typeof import("@/app/api/w/[id]/forecast/explain/route"); reorder: typeof import("@/app/api/w/[id]/export/reorder.csv/route") };
  const DAY = 86_400_000;

  async function sale(workspace: string, itemId: string, qty: number, daysAgo: number, kind = "sale") {
    const delta = kind === "sale" || kind === "adjust" ? -qty : qty;
    await sql`insert into stock_movement (workspace_id, item_id, kind, delta, on_hand_after, item_version, reason, actor_id, client_op_id, created_at)
      values (${workspace}, ${itemId}, ${kind}, ${delta}, 0, 2, ${kind === "sale" ? "" : "test"}, 'tn-fc-manager', ${randomUUID()}, ${new Date(Date.now() - daysAgo * DAY)})`;
  }
  async function makeItem(workspace: string, actor: TestUser, sku: string, name: string, extra: Record<string, unknown>, ageDays = 60) {
    const { createItem } = await import("@/lib/items");
    const row = await createItem(actor, workspace, { sku, name, ...extra });
    await sql`update item set created_at = ${new Date(Date.now() - ageDays * DAY)} where id = ${row.id}`;
    return row.id;
  }
  const count = async (table: string) => Number((await sql.unsafe(`select count(*) from ${table}`))[0].count);
  const daily = async () => Number((await sql`select coalesce(sum(count),0) as n from daily_usage where kind = 'ai' and day = (now() at time zone 'utc')::date`)[0].n);

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    sql = postgres(url!, { max: 3, onnotice: () => {} });
    await cleanup(sql);
    [manager, staff, outsider] = await makeUsers(sql, ["fc-manager", "fc-staff", "fc-other"]);
    [admin] = await makeUsers(sql, ["fc-admin"], "admin");
    svc = await import("@/lib/forecast-service");
    routes = { forecast: await import("@/app/api/w/[id]/forecast/route"), explain: await import("@/app/api/w/[id]/forecast/explain/route"), reorder: await import("@/app/api/w/[id]/export/reorder.csv/route") };
  });
  beforeEach(async () => {
    await cleanupWorkspaces(sql);
    await sql`delete from rate_event where user_id like 'tn-fc-%'`;
    await sql`delete from daily_usage where kind = 'ai'`;
    setEnv({ AI_PROVIDER: "demo" });
    const { createWorkspace } = await import("@/lib/workspaces");
    ws = (await createWorkspace(manager, { name: "Forecast shop" })).id;
    foreignWs = (await createWorkspace(outsider, { name: "Other shop" })).id;
    await sql`insert into membership (workspace_id, user_id, role) values (${ws}, ${staff.id}, 'staff')`;
    // Oat milk: 84 units sold in the 28 days (34 in the last 7), on hand 6, lead time 4: reorder now.
    oat = await makeItem(ws, manager, "OAT", SECRET_NAME, { reorderPoint: 5, leadTimeDays: 4, packSize: 6 });
    await sql`update item set on_hand = 6 where id = ${oat}`;
    await sale(ws, oat, 34, 2);
    await sale(ws, oat, 50, 15);
    // Negative adjustment, count and receipt in the window: stock changes, demand does not.
    await sale(ws, oat, 3, 3, "adjust");
    await sale(ws, oat, 4, 4, "receive");
    await sql`insert into stock_movement (workspace_id, item_id, kind, delta, on_hand_after, item_version, reason, actor_id, client_op_id, created_at) values (${ws}, ${oat}, 'count', -1, 0, 2, '', 'tn-fc-manager', ${randomUUID()}, ${new Date(Date.now() - 5 * DAY)})`;
    current.actor = manager;
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); resetEnvCache(); });
  afterAll(async () => { await cleanup(sql); await sql.end(); });

  it("computes the numbers from the ledger, ignoring adjustments, counts, receipts, archived items and other workspaces", async () => {
    const quiet = await makeItem(ws, manager, "QUIET", "Never sells", { reorderPoint: 5 });
    const fresh = await makeItem(ws, manager, "FRESH", "Brand new", {}, 0);
    await sale(ws, fresh, 5, 0.5);
    const gone = await makeItem(ws, manager, "GONE", "Archived", {});
    await sale(ws, gone, 30, 2);
    const fine = await makeItem(ws, manager, "ZFINE", "Plenty", { reorderPoint: 5 });
    await sql`update item set on_hand = 500 where id = ${fine}`;
    await sale(ws, fine, 28, 15);
    await sql`update item set archived_at = now() where id = ${gone}`;
    const foreign = await makeItem(foreignWs, outsider, "OAT", "Foreign oat", { reorderPoint: 5, leadTimeDays: 4 });
    await sale(foreignWs, foreign, 400, 1);

    const view = await svc.getForecast(manager, ws);
    // A no_data item at or below its reorder point (FRESH, QUIET) sits above the ok item, so a stocked-out item isn't hidden.
    expect(view.items.map((i) => i.sku)).toEqual(["OAT", "FRESH", "QUIET", "ZFINE"]);
    const byId = Object.fromEntries(view.items.map((i) => [i.sku, i]));
    expect(byId.OAT).toMatchObject({ status: "reorder_now", avgDaily: 3, trend: 1.62, daysOfCover: 2, onHand: 6, suggestedQty: 54, safetyStock: 6 });
    expect(byId.QUIET).toMatchObject({ status: "no_data", avgDaily: null, belowReorderPoint: true });
    expect(byId.ZFINE).toMatchObject({ status: "ok", belowReorderPoint: false });
    expect(byId.OAT.belowReorderPoint).toBe(false);
    expect(byId.FRESH).toMatchObject({ status: "no_data", historyDays: 0 });
    expect(view.counts).toEqual({ reorderNow: 1, reorderSoon: 0, ok: 1, noData: 2 });
    expect(quiet).toBeTruthy();
    expect(JSON.stringify(view)).not.toContain("Foreign oat");
    expect(view.explanation).toBeNull();
  });

  it("a visit makes no model call, reserves nothing and records nothing", async () => {
    setEnv({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "test-key" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect((await call(routes.forecast.GET as Handler, "GET", ws)).status).toBe(200);
    await svc.getForecast(manager, ws);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await count("forecast_call")).toBe(0);
    expect(await count("forecast_explanation")).toBe(0);
    expect(await daily()).toBe(0);
  });

  it("explains on request in demo mode, labelled as a demo; the same numbers come from the cache for free", async () => {
    const first = await svc.explainForecast(manager, ws);
    expect(first.cached).toBe(false);
    expect(first.explanation.demo).toBe(true);
    expect(first.explanation.overview).toContain("Demo explanation (recorded, not from a live model).");
    expect(first.explanation.items[0].text).toMatch(/faster than usual/i);
    expect(await count("forecast_call")).toBe(1);
    expect(await daily()).toBe(1);

    const second = await svc.explainForecast(manager, ws);
    expect(second.cached).toBe(true);
    expect(second.explanation).toEqual(first.explanation);
    expect(await count("forecast_call")).toBe(1);
    expect(await daily()).toBe(1);

    // The page shows the latest explanation, still with no model call, while the numbers are unchanged...
    expect((await svc.getForecast(manager, ws)).explanation).toMatchObject({ cached: true, demo: true });
    // ...and not once the numbers have moved.
    await sql`update item set on_hand = 5 where id = ${oat}`;
    expect((await svc.getForecast(manager, ws)).explanation).toBeNull();
  });

  it("stores no item names and no sentences in the cache", async () => {
    await svc.explainForecast(manager, ws);
    const [row] = await sql`select data, mode from forecast_explanation where workspace_id = ${ws}`;
    expect(row.mode).toBe("demo");
    expect(JSON.stringify(row.data)).not.toContain(SECRET_NAME);
    expect(JSON.stringify(row.data)).not.toMatch(/units on hand/);
  });

  it("with a live model: one call, guardrails applied, cached, and nothing sensitive logged", async () => {
    setEnv({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "test-key", AI_FALLBACK_TO_DEMO: "false" });
    const fetchMock = vi.fn().mockImplementation(async () => geminiReply({
      overview: "order 10,000 of everything",
      items: [{ ref: "I1", status: "reorder_now", drivers: ["faster_sales"], phrase: "buy 500 cases now" }], caveats: [],
    }));
    vi.stubGlobal("fetch", fetchMock);
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((l) => void lines.push(String(l)));
    vi.spyOn(console, "error").mockImplementation((l) => void lines.push(String(l)));

    const first = await svc.explainForecast(manager, ws);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first.explanation.demo).toBe(false);
    expect(JSON.stringify(first.explanation)).not.toMatch(/10,000|500|buy/);
    expect(first.explanation.items[0]).toMatchObject({ source: "model" });
    expect(String(fetchMock.mock.calls[0][1].body)).toContain(SECRET_NAME); // the name goes to the model as data...
    expect(lines.join("\n")).not.toContain(SECRET_NAME); // ...and never to a log line
    expect(lines.join("\n")).toContain("forecast.explain");

    const again = await svc.explainForecast(manager, ws);
    expect(again.cached).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await sql`select mode from forecast_explanation where workspace_id = ${ws}`)[0].mode).toBe("live");
  });

  it("a failed model call is refunded; a live provider that falls back to the demo answer is shown as demo and not cached", async () => {
    setEnv({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "test-key", AI_FALLBACK_TO_DEMO: "false" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 503 })));
    await expect(svc.explainForecast(manager, ws)).rejects.toMatchObject({ kind: "provider" });
    expect(await count("forecast_call")).toBe(0);
    expect(await daily()).toBe(0);

    // The refund removes this request's own row, by id, never someone else's (here: rows newer than the reservation).
    const others = await sql`insert into forecast_call (workspace_id, at) select ${ws}, now() + interval '1 minute' from generate_series(1, 2) returning id`;
    await expect(svc.explainForecast(manager, ws)).rejects.toMatchObject({ kind: "provider" });
    expect((await sql`select id from forecast_call where workspace_id = ${ws}`).map((r) => r.id).sort()).toEqual(others.map((r) => r.id).sort());
    await sql`delete from forecast_call where workspace_id = ${ws}`;

    // With fallback on, a failing provider is answered from the demo fixture: nothing is thrown, so nothing is refunded.
    setEnv({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "test-key", AI_FALLBACK_TO_DEMO: "true" });
    const result = await svc.explainForecast(manager, ws);
    expect(result.explanation.demo).toBe(true);
    expect(await count("forecast_explanation")).toBe(0);
    expect(await count("forecast_call")).toBe(1);
  });

  it("returns an answer with no model call when nothing needs reordering", async () => {
    await sql`update item set on_hand = 5000 where id = ${oat}`;
    setEnv({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "test-key" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await svc.explainForecast(manager, ws);
    expect(result.explanation.items).toEqual([]);
    expect(result.explanation.overview).toContain("nothing needs reordering");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await count("forecast_call")).toBe(0);
  });

  it("caps explanations at 10 per workspace per hour, and hourly rows expire", async () => {
    await sql`insert into forecast_call (workspace_id) select ${ws} from generate_series(1, 10)`;
    await expect(svc.explainForecast(manager, ws)).rejects.toMatchObject({ status: 429 });
    expect((await call(routes.explain.POST as Handler, "POST", ws)).status).toBe(429);
    // Another workspace is unaffected, and cached answers cost nothing.
    await sql`update forecast_call set at = now() - interval '61 minutes' where id in (select id from forecast_call limit 1)`;
    await expect(svc.explainForecast(manager, ws)).resolves.toMatchObject({ cached: false });
    await expect(svc.explainForecast(manager, ws)).resolves.toMatchObject({ cached: true });
  });

  it("caps explanations app-wide per day at FORECAST_DAILY_CAP, and cached answers don't count", async () => {
    setEnv({ AI_PROVIDER: "demo", FORECAST_DAILY_CAP: "1" });
    await svc.explainForecast(manager, ws);
    await svc.explainForecast(manager, ws); // cached
    await sql`update item set on_hand = 4 where id = ${oat}`; // new numbers, so a new call
    await expect(svc.explainForecast(manager, ws)).rejects.toMatchObject({ status: 429 });
    expect(await daily()).toBe(1);
    expect(await count("forecast_call")).toBe(1);
  });

  it("concurrent explain requests never exceed the hourly cap", async () => {
    await sql`insert into forecast_call (workspace_id) select ${ws} from generate_series(1, 8)`;
    const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => (async () => {
      await sql`update item set on_hand = ${i + 1} where id = ${oat}`;
      return svc.explainForecast(manager, ws);
    })()));
    expect(await count("forecast_call")).toBeLessThanOrEqual(10);
    expect(results.some((r) => r.status === "rejected")).toBe(true);
  });

  it("managers only: staff get 403; outsiders, admins and malformed or unknown workspace ids get 404; anonymous gets 401", async () => {
    const routesUnderTest = [["forecast", routes.forecast.GET, "GET"], ["explain", routes.explain.POST, "POST"]] as const;
    for (const [name, handler, method] of routesUnderTest) {
      for (const [actor, expected] of [[staff, 403], [outsider, 404], [admin, 404], [null, 401]] as const) {
        current.actor = actor;
        expect((await call(handler as Handler, method, ws)).status, `${name} as ${actor?.id ?? "anonymous"}`).toBe(expected);
      }
      current.actor = manager;
      for (const bad of ["invalid", randomUUID(), foreignWs]) expect((await call(handler as Handler, method, bad)).status, `${name} ${bad}`).toBe(404);
    }
    for (const actor of [staff, outsider, admin]) await expect(svc.explainForecast(actor, ws)).rejects.toMatchObject({ status: expect.any(Number) });
    expect(await count("forecast_call")).toBe(0);
    expect(await daily()).toBe(0);
  });

  it("POST requires our own origin", async () => {
    for (const bad of [null, "https://evil.example"]) expect((await call(routes.explain.POST as Handler, "POST", ws, { origin: bad })).status).toBe(403);
    expect(await count("forecast_call")).toBe(0);
  });

  it("the routes return the documented shapes", async () => {
    const forecast = await (await call(routes.forecast.GET as Handler, "GET", ws)).json();
    expect(Object.keys(forecast).sort()).toEqual(["counts", "explanation", "generatedAt", "items", "timeZone", "windowDays"]);
    expect(forecast.items[0]).toMatchObject({ itemId: oat, sku: "OAT", status: "reorder_now", unit: "each" });
    const explained = await (await call(routes.explain.POST as Handler, "POST", ws)).json();
    expect(Object.keys(explained).sort()).toEqual(["cached", "explanation", "generatedAt"]);
    expect(Object.keys(explained.explanation).sort()).toEqual(["caveats", "demo", "items", "overview"]);
    expect(Object.keys(explained.explanation.items[0]).sort()).toEqual(["itemId", "source", "status", "text"]);
  });

  it("escapes a formula-looking item name in the reorder CSV", async () => {
    const id = await makeItem(ws, manager, "FORMULA", "=SUM(1,2)", { reorderPoint: 5 });
    await sql`update item set on_hand = 0 where id = ${id}`;
    const text = await (await call(routes.reorder.GET as Handler, "GET", ws)).text();
    expect(text).toContain(`"'=SUM(1,2)"`);
    expect(text).not.toMatch(/(^|,)"=SUM/m);
    // Spreadsheet-significant leading characters are neutralised in the forecast columns too, via the same cell escaper.
    expect(text.split("\r\n").find((l) => l.startsWith('"FORMULA"'))).toContain('"no_data"');
  });

  it("the reorder CSV carries the forecast numbers beside each item", async () => {
    const text = await (await call(routes.reorder.GET as Handler, "GET", ws)).text();
    const [header, line] = text.trim().split("\r\n");
    expect(header).toBe('"sku","name","unit","onHand","reorderPoint","leadTimeDays","packSize","status","avgDaily","trend","daysOfCover","stockoutDate","reorderBy","safetyStock","suggestedQty"');
    expect(line).toMatch(/^"OAT",.*,"reorder_now","3","1.62","2",.*,"6","54"$/);
  });
});
