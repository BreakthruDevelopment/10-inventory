/**
 * An admin removing an account through Better Auth (POST /api/auth/admin/remove-user) must not orphan workspaces:
 * a solo workspace goes with its only member, a shared one promotes the longest-serving remaining member, and an
 * account with no workspace is removed as before. The 0004 trigger stays as the backstop (tested in tenancy tests).
 */
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const PASSWORD = "correct-horse-battery";
const email = (n: string) => `ar-${n}@test.local`;

describe.skipIf(!url)("admin remove-user and workspaces (Better Auth + Postgres)", () => {
  let sql: postgres.Sql;
  let handler: (req: Request) => Promise<Response>;
  let adminCookie: string;
  const ids: Record<string, string> = {};

  const post = (path: string, body: unknown, cookie?: string) =>
    handler(
      new Request(`http://localhost:3000/api/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
        body: JSON.stringify(body),
      }),
    );
  async function signUp(name: string) {
    const res = await post("/sign-up/email", { name, email: email(name), password: PASSWORD });
    expect(res.status).toBe(200);
    ids[name] = ((await res.json()) as { user: { id: string } }).user.id;
  }
  const remove = (name: string) => post("/admin/remove-user", { userId: ids[name] }, adminCookie);
  const exists = async (name: string) => (await sql`select 1 from "user" where id = ${ids[name]}`).length === 1;
  async function workspaceWith(name: string, members: [string, "manager" | "staff", string][]) {
    const [w] = await sql`insert into workspace (name, created_by) values (${name}, ${ids[members[0][0]]}) returning id`;
    for (const [n, role, joined] of members) {
      await sql`insert into membership (workspace_id, user_id, role, joined_at) values (${w.id}, ${ids[n]}, ${role}, ${joined})`;
    }
    return w.id as string;
  }
  const roles = async (w: string) =>
    Object.fromEntries((await sql`select u.name, m.role from membership m join "user" u on u.id = m.user_id where m.workspace_id = ${w}`).map((r) => [r.name, r.role]));

  async function cleanup() {
    await sql`delete from workspace where id in (select workspace_id from membership where user_id in (select id from "user" where email like 'ar-%@test.local')) or created_by in (select id from "user" where email like 'ar-%@test.local')`;
    await sql`delete from "user" where email like 'ar-%@test.local'`;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    sql = postgres(url!, { max: 2, onnotice: () => {} });
    await cleanup();
    handler = (await import("@/lib/auth")).auth().handler;
    for (const n of ["admin", "solo", "boss", "old", "new", "none", "dup1", "dup2", "mixed"]) await signUp(n);
    await sql`update "user" set role = 'admin' where id = ${ids.admin}`;
    const res = await post("/sign-in/email", { email: email("admin"), password: PASSWORD });
    adminCookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  });
  afterAll(async () => {
    await cleanup();
    await sql.end();
  });

  it("a user with no workspace is removed as before", async () => {
    expect((await remove("none")).status).toBe(200);
    expect(await exists("none")).toBe(false);
  });

  it("the sole manager of a solo workspace: the workspace and the user are deleted", async () => {
    const w = await workspaceWith("Solo shop", [["solo", "manager", "2026-01-01"]]);
    expect((await remove("solo")).status).toBe(200);
    expect(await exists("solo")).toBe(false);
    expect((await sql`select 1 from workspace where id = ${w}`).length).toBe(0);
  });

  it("the last manager of a shared workspace: the longest-serving remaining member is promoted, the user is deleted", async () => {
    const w = await workspaceWith("Shared shop", [
      ["boss", "manager", "2026-01-01"],
      ["new", "staff", "2026-03-01"],
      ["old", "staff", "2026-02-01"],
    ]);
    expect((await remove("boss")).status).toBe(200);
    expect(await exists("boss")).toBe(false);
    expect(await roles(w)).toEqual({ old: "manager", new: "staff" });
  });

  it("a removed user who is staff or a non-last manager changes nobody else's role; mixed workspaces are each handled", async () => {
    const withOther = await workspaceWith("Two managers", [["dup1", "manager", "2026-01-01"], ["dup2", "manager", "2026-02-01"]]);
    const asStaff = await workspaceWith("Staff only here", [["dup2", "manager", "2026-01-01"], ["mixed", "staff", "2026-01-02"]]);
    const solo = await workspaceWith("Dup solo", [["dup1", "manager", "2026-01-01"]]);
    expect((await remove("dup1")).status).toBe(200);
    expect(await roles(withOther)).toEqual({ dup2: "manager" });
    expect((await sql`select 1 from workspace where id = ${solo}`).length).toBe(0);
    expect(await roles(asStaff)).toEqual({ dup2: "manager", mixed: "staff" });
  });

  it("the trigger still backs this up for any path that skips the hook", async () => {
    const w = await workspaceWith("Backstop", [["dup2", "manager", "2026-01-01"], ["mixed", "staff", "2026-01-02"]]);
    await expect(sql`delete from "user" where id = ${ids.dup2}`).rejects.toMatchObject({ message: expect.stringContaining("at least one manager") });
    expect(Object.keys(await roles(w)).sort()).toEqual(["dup2", "mixed"]);
  });
});
