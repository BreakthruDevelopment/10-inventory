/**
 * The demo workspace ("Demo Corner Store": 1 manager, 2 staff): CLI refusal rules, the loader against Postgres and
 * Better Auth, and the rule that public sign-up can't take a demo identity.
 */
import { spawnSync } from "node:child_process";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanup } from "./helpers/tenancy";

const url = process.env.TEST_DATABASE_URL;
const base = { DEMO_SEED: "yes", APP_URL: "http://localhost:3000", DEMO_PASSWORD: "demo-test-password-123" };
const tsxArgs = ["--conditions=react-server", "--import", "tsx", "scripts/seed-demo.mts"];

describe("demo CLI guards", () => {
  it("the actual CLI refuses production URLs and databases before connecting", () => {
    for (const values of [
      { ...base, DEMO_SEED: "no" },
      { ...base, APP_URL: "https://app10.breakthruventures.ai" },
      { ...base, APP_URL: "https://inventory.azurecontainerapps.io" },
    ]) {
      const child = spawnSync(process.execPath, tsxArgs, {
        env: { ...process.env, ...values, DATABASE_URL: "postgres://invalid:invalid@127.0.0.1:1/invalid" },
        encoding: "utf8",
        timeout: 15000,
      });
      expect(child.status).toBe(1);
      expect(child.stderr).toContain("Demo seed refused");
      expect(child.stderr).not.toContain("ECONNREFUSED");
    }
    const azure = spawnSync(process.execPath, tsxArgs, {
      env: { ...process.env, ...base, DATABASE_URL: "postgres://u:p@x.postgres.database.azure.com:5432/db" },
      encoding: "utf8",
      timeout: 15000,
    });
    expect(azure.status).toBe(1);
    expect(azure.stderr).toContain("production database");
  });
});

describe.skipIf(!url)("demo workspace (Postgres, Better Auth)", () => {
  let sql: postgres.Sql;
  let loader: typeof import("@/lib/demo-workspace");
  const admin = { id: "tn-demo-admin", role: "admin" as const };
  const real = { id: "tn-demo-real", role: "user" as const };

  const demoState = async () => ({
    users: await sql`select id, email, role, image from "user" where email like '%@demo.breakthru.test' order by email`,
    workspaces: await sql`select w.id, w.name, w.created_by from workspace w where w.name = 'Demo Corner Store'`,
    memberships: await sql`select u.email, m.role from membership m join "user" u on u.id = m.user_id join workspace w on w.id = m.workspace_id where w.name = 'Demo Corner Store' order by u.email`,
  });

  async function wipeDemo() {
    await sql`delete from workspace where name = 'Demo Corner Store'`;
    await sql`delete from "user" where email like '%@demo.breakthru.test'`;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    process.env.APP_URL = "http://localhost:3000";
    sql = postgres(url!, { max: 2, onnotice: () => {} });
    await cleanup(sql);
    await wipeDemo();
    for (const u of [admin, real]) await sql`insert into "user" (id, name, email, role) values (${u.id}, ${u.id}, ${u.id + "@test.local"}, ${u.role})`;
    loader = await import("@/lib/demo-workspace");
  });
  afterAll(async () => {
    await wipeDemo();
    await cleanup(sql);
    await sql`delete from rate_event where user_id like 'tn-demo-%'`;
    await sql`delete from daily_usage where kind = 'demo_load'`;
    await sql.end();
  });

  it("only an admin can load it", async () => {
    await expect(loader.loadDemoWorkspace(real, { mode: "admin" })).rejects.toMatchObject({ status: 403 });
    await expect(loader.loadDemoWorkspace(admin, { mode: "root" })).rejects.toThrow();
    expect((await demoState()).workspaces).toHaveLength(0);
  });

  it("the CLI loads the demo with a single-connection pool (DB_POOL_MAX=1) and doesn't hang", () => {
    const child = spawnSync(process.execPath, tsxArgs, {
      env: { ...process.env, ...base, DATABASE_URL: url!, DB_POOL_MAX: "1" },
      encoding: "utf8",
      timeout: 60000,
    });
    expect(child.stderr).toBe("");
    expect(child.status).toBe(0);
    expect(child.stdout).toContain("Loaded 3 demo users");
  });

  it("creates one workspace with one manager and two staff, all marked as demo accounts", async () => {
    expect(await loader.loadDemoWorkspace(admin, { mode: "admin" })).toEqual({ users: 3, workspaces: 1, members: 3 });
    const s = await demoState();
    expect(s.workspaces).toHaveLength(1);
    expect(s.memberships.map((m) => [m.email, m.role])).toEqual([
      ["jo@demo.breakthru.test", "staff"],
      ["maya@demo.breakthru.test", "manager"],
      ["sam@demo.breakthru.test", "staff"],
    ]);
    expect(s.users.every((u) => u.image === "urn:breakthru:inventory-demo:v1" && u.role === "user")).toBe(true);
  });

  it("seeds sixty days of reconciled history, including three fast movers", async () => {
    const rows = await sql`select i.sku, i.on_hand, coalesce(sum(m.delta),0)::int balance,
      count(*) filter (where m.kind = 'sale')::int sales,
      count(distinct m.created_at::date) filter (where m.kind = 'sale')::int days,
      avg(-m.delta) filter (where m.kind = 'sale' and m.created_at > now() - interval '8 days') recent,
      avg(-m.delta) filter (where m.kind = 'sale' and m.created_at <= now() - interval '8 days') older
      from item i join workspace w on w.id = i.workspace_id
      join stock_movement m on m.item_id = i.id and m.workspace_id = i.workspace_id
      where w.name = 'Demo Corner Store' group by i.id`;
    expect(rows).toHaveLength(6);
    expect(rows.every(r => r.sales === 60 && r.days === 60 && r.on_hand === r.balance)).toBe(true);
    expect(rows.filter(r => Number(r.recent) > Number(r.older) * 1.3)).toHaveLength(3);
  });

  it("a reload replaces the demo workspace and leaves real users' workspaces alone", async () => {
    const { createWorkspace } = await import("@/lib/workspaces");
    const mine = await createWorkspace(real, { name: "Real shop" });
    const before = await demoState();
    await loader.loadDemoWorkspace(admin, { mode: "admin" });
    const after = await demoState();
    expect(after.workspaces).toHaveLength(1);
    expect(after.workspaces[0].id).not.toBe(before.workspaces[0].id);
    expect(after.users.map((u) => u.id)).toEqual(before.users.map((u) => u.id)); // same accounts, new workspace
    expect((await sql`select id from workspace where id = ${mine.id}`).length).toBe(1);
    await sql`delete from workspace where id = ${mine.id}`;
  });

  it("refuses to adopt an unrelated account at a demo address", async () => {
    await sql`update "user" set image = null where email = 'sam@demo.breakthru.test'`;
    await expect(loader.loadDemoWorkspace(admin, { mode: "admin" })).rejects.toMatchObject({ status: 409 });
    await sql`update "user" set image = 'urn:breakthru:inventory-demo:v1' where email = 'sam@demo.breakthru.test'`;
  });

  it("the admin route reserves one load a minute", async () => {
    await sql`delete from rate_event where kind = 'demo_load'`;
    await sql`delete from daily_usage where kind = 'demo_load'`;
    await loader.loadDemoWorkspace(admin, { mode: "admin" }, { reserve: true });
    await expect(loader.loadDemoWorkspace(admin, { mode: "admin" }, { reserve: true })).rejects.toMatchObject({ status: 429 });
    // A load that fails after reserving gives the reservation back.
    await sql`delete from rate_event where kind = 'demo_load'`;
    await sql`delete from daily_usage where kind = 'demo_load'`;
    await sql`update "user" set image = null where email = 'jo@demo.breakthru.test'`;
    await expect(loader.loadDemoWorkspace(admin, { mode: "admin" }, { reserve: true })).rejects.toMatchObject({ status: 409 });
    expect(Number((await sql`select count(*) from rate_event where kind = 'demo_load'`)[0].count)).toBe(0);
    expect(Number((await sql`select coalesce(sum(count), 0) as n from daily_usage where kind = 'demo_load'`)[0].n)).toBe(0);
    await sql`update "user" set image = 'urn:breakthru:inventory-demo:v1' where email = 'jo@demo.breakthru.test'`;
  });

  it("public sign-up can't take a demo address or the demo marker", async () => {
    const { auth } = await import("@/lib/auth");
    const signUp = (email: string, extra: Record<string, unknown> = {}) =>
      auth().handler(
        new Request("http://localhost:3000/api/auth/sign-up/email", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, password: "correct-horse-battery", name: "x", ...extra }),
        }),
      );
    expect((await signUp("someone@demo.breakthru.test")).status).toBe(400);
    expect((await signUp("tn-honest@test.local", { image: "urn:breakthru:inventory-demo:v1" })).status).toBe(400);
    expect((await sql`select 1 from "user" where email in ('someone@demo.breakthru.test', 'tn-honest@test.local')`).length).toBe(0);
  });
});
