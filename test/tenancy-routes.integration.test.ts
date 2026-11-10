/**
 * Every tenancy route, called as the route handler (session mocked, everything else real, against Postgres):
 * a user from another workspace gets 404 on all of them (and on ids that belong to a different workspace inside
 * their own path), staff get 403 on manager routes, admins are not members, anonymous is 401, a foreign Origin is 403.
 */
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError, UnauthorizedError } from "@/lib/auth/rbac";
import { PREFIX, type TestUser, cleanup, cleanupWorkspaces, makeUsers } from "./helpers/tenancy";

const current = vi.hoisted(() => ({ actor: null as null | { id: string; role: "user" | "admin"; name: string; email: string } }));
vi.mock("@/lib/auth/session", () => ({
  requireUser: vi.fn(async () => {
    if (!current.actor) throw new UnauthorizedError();
    return current.actor;
  }),
  requireRole: vi.fn(async (role: "user" | "admin") => {
    if (!current.actor) throw new UnauthorizedError();
    if (role === "admin" && current.actor.role !== "admin") throw new ForbiddenError();
    return current.actor;
  }),
}));

const url = process.env.TEST_DATABASE_URL;
const ORIGIN = "http://localhost:3000";

describe.skipIf(!url)("tenancy routes (Postgres)", () => {
  let sql: postgres.Sql;
  let alice: TestUser, bob: TestUser, cara: TestUser, dan: TestUser, admin: TestUser;
  let wsA: string, wsB: string;
  let inviteA: string, inviteB: string; // invite ids
  let tokenB: string;
  const as = (u: TestUser | null) => {
    current.actor = u && { id: u.id, role: u.role, name: u.id, email: `${u.id}@test.local` };
  };

  // Route handlers differ in their params shape; the tests pass the right one per route.
  type Handler = (req: Request, ctx: never) => Promise<Response>;
  async function call(h: Handler, method: string, params: Record<string, string> = {}, opts: { body?: unknown; origin?: string | null } = {}) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.origin !== null && method !== "GET") headers.origin = opts.origin ?? ORIGIN;
    const req = new Request(`${ORIGIN}/api/test`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
    return h(req, { params: Promise.resolve(params) } as never);
  }

  let routes: {
    workspaces: typeof import("@/app/api/workspaces/route");
    workspace: typeof import("@/app/api/w/[id]/route");
    members: typeof import("@/app/api/w/[id]/members/route");
    member: typeof import("@/app/api/w/[id]/members/[userId]/route");
    invites: typeof import("@/app/api/w/[id]/invites/route");
    invite: typeof import("@/app/api/w/[id]/invites/[inviteId]/route");
    join: typeof import("@/app/api/join/[token]/route");
    stats: typeof import("@/app/api/admin/stats/route");
    demo: typeof import("@/app/api/admin/demo/route");
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    process.env.APP_URL = ORIGIN;
    sql = postgres(url!, { max: 2, onnotice: () => {} });
    await cleanup(sql);
    [alice, bob, cara, dan] = await makeUsers(sql, ["ra", "rb", "rc", "rd"]);
    [admin] = await makeUsers(sql, ["radmin"], "admin");
    routes = {
      workspaces: await import("@/app/api/workspaces/route"),
      workspace: await import("@/app/api/w/[id]/route"),
      members: await import("@/app/api/w/[id]/members/route"),
      member: await import("@/app/api/w/[id]/members/[userId]/route"),
      invites: await import("@/app/api/w/[id]/invites/route"),
      invite: await import("@/app/api/w/[id]/invites/[inviteId]/route"),
      join: await import("@/app/api/join/[token]/route"),
      stats: await import("@/app/api/admin/stats/route"),
      demo: await import("@/app/api/admin/demo/route"),
    };
  });
  afterAll(async () => {
    await cleanup(sql);
    await sql`delete from rate_event where user_id like ${PREFIX + "%"}`;
    await sql.end();
  });

  beforeEach(async () => {
    await cleanupWorkspaces(sql);
    await sql`delete from rate_event where user_id like ${PREFIX + "%"}`;
    as(alice);
    wsA = ((await (await call(routes.workspaces.POST, "POST", {}, { body: { name: "A shop" } })).json()) as { workspace: { id: string } }).workspace.id;
    await sql`insert into membership (workspace_id, user_id, role) values (${wsA}, ${bob.id}, 'staff')`;
    as(cara);
    wsB = ((await (await call(routes.workspaces.POST, "POST", {}, { body: { name: "B shop" } })).json()) as { workspace: { id: string } }).workspace.id;
    inviteB = ((await (await call(routes.invites.POST, "POST", { id: wsB }, { body: { role: "staff" } })).json()) as { invite: { id: string }; token: string }).invite.id;
    const second = (await (await call(routes.invites.POST, "POST", { id: wsB }, { body: {} })).json()) as { token: string };
    tokenB = second.token;
    as(alice);
    inviteA = ((await (await call(routes.invites.POST, "POST", { id: wsA }, { body: { role: "staff" } })).json()) as { invite: { id: string } }).invite.id;
  });

  /** Every workspace-scoped route, as [name, handler, method, params, body]. `mine` params point into the caller's own workspace. */
  const scoped = (ws: string, inviteId: string, userId: string) =>
    [
      ["GET /api/w/:id", routes.workspace.GET, "GET", { id: ws }, undefined, "staff"],
      ["GET members", routes.members.GET, "GET", { id: ws }, undefined, "manager"],
      ["PATCH member", routes.member.PATCH, "PATCH", { id: ws, userId }, { role: "staff" }, "manager"],
      ["DELETE member", routes.member.DELETE, "DELETE", { id: ws, userId }, undefined, "manager"],
      ["GET invites", routes.invites.GET, "GET", { id: ws }, undefined, "manager"],
      ["POST invites", routes.invites.POST, "POST", { id: ws }, { role: "staff" }, "manager"],
      ["DELETE invite", routes.invite.DELETE, "DELETE", { id: ws, inviteId }, undefined, "manager"],
    ] as const;

  it("a user from another workspace gets 404 on every route of this one", async () => {
    as(dan); // member of nothing
    for (const [name, h, method, params, body] of scoped(wsA, inviteA, bob.id)) {
      const res = await call(h as Handler, method, params as Record<string, string>, { body });
      expect(res.status, name).toBe(404);
    }
    as(cara); // manager of B, stranger to A
    for (const [name, h, method, params, body] of scoped(wsA, inviteA, bob.id)) {
      const res = await call(h as Handler, method, params as Record<string, string>, { body });
      expect(res.status, name).toBe(404);
    }
    // Nothing changed in A.
    expect(Number((await sql`select count(*) from membership where workspace_id = ${wsA}`)[0].count)).toBe(2);
    expect((await sql`select revoked_at from invite where id = ${inviteA}`)[0].revoked_at).toBeNull();
    expect(Number((await sql`select count(*) from invite where workspace_id = ${wsA}`)[0].count)).toBe(1);
  });

  it("ids from a foreign workspace inside my own path are 404 and change nothing", async () => {
    as(alice);
    // Alice manages A. Cara's membership and B's invite are not reachable through A's path.
    expect((await call(routes.member.PATCH, "PATCH", { id: wsA, userId: cara.id }, { body: { role: "staff" } })).status).toBe(404);
    expect((await call(routes.member.DELETE, "DELETE", { id: wsA, userId: cara.id })).status).toBe(404);
    expect((await call(routes.invite.DELETE, "DELETE", { id: wsA, inviteId: inviteB })).status).toBe(404);
    expect((await sql`select role from membership where workspace_id = ${wsB} and user_id = ${cara.id}`)[0].role).toBe("manager");
    expect((await sql`select revoked_at from invite where id = ${inviteB}`)[0].revoked_at).toBeNull();
    // A workspace id in the body is ignored (strict schemas refuse it); the path decides.
    expect((await call(routes.invites.POST, "POST", { id: wsA }, { body: { role: "staff", workspaceId: wsB } })).status).toBe(400);
    expect((await call(routes.workspaces.POST, "POST", {}, { body: { name: "x", id: wsB } })).status).toBe(400);
    expect((await call(routes.member.PATCH, "PATCH", { id: wsA, userId: bob.id }, { body: { role: "staff", workspaceId: wsB } })).status).toBe(400);
  });

  it("the admin role is not a membership: 404 on every workspace route", async () => {
    as(admin);
    for (const [name, h, method, params, body] of scoped(wsA, inviteA, bob.id)) {
      const res = await call(h as Handler, method, params as Record<string, string>, { body });
      expect(res.status, name).toBe(404);
    }
    const mine = await (await call(routes.workspaces.GET, "GET")).json();
    expect(mine).toEqual({ workspaces: [] });
  });

  it("staff get 403 on every manager route and 200 on the staff one", async () => {
    as(bob);
    for (const [name, h, method, params, body, min] of scoped(wsA, inviteA, alice.id)) {
      const res = await call(h as Handler, method, params as Record<string, string>, { body });
      expect(res.status, name).toBe(min === "manager" ? 403 : 200);
    }
    // 403 changed nothing.
    expect(Number((await sql`select count(*) from invite where workspace_id = ${wsA}`)[0].count)).toBe(1);
    expect(Number((await sql`select count(*) from membership where workspace_id = ${wsA} and role = 'manager'`)[0].count)).toBe(1);
  });

  it("anonymous callers get 401 everywhere, including the join route", async () => {
    as(null);
    for (const [name, h, method, params, body] of scoped(wsA, inviteA, bob.id)) {
      expect((await call(h as Handler, method, params as Record<string, string>, { body })).status, name).toBe(401);
    }
    expect((await call(routes.workspaces.GET, "GET")).status).toBe(401);
    expect((await call(routes.workspaces.POST, "POST", {}, { body: { name: "x" } })).status).toBe(401);
    expect((await call(routes.join.POST, "POST", { token: tokenB })).status).toBe(401);
    expect((await call(routes.stats.GET as unknown as Handler, "GET")).status).toBe(401);
  });

  it("mutations refuse a foreign or missing Origin (403) before doing anything", async () => {
    as(alice);
    const mutating = scoped(wsA, inviteA, bob.id).filter(([, , m]) => m !== "GET");
    for (const origin of ["https://evil.example", null]) {
      for (const [name, h, method, params, body] of mutating) {
        expect((await call(h as Handler, method, params as Record<string, string>, { body, origin })).status, `${name} ${origin}`).toBe(403);
      }
      expect((await call(routes.workspaces.POST, "POST", {}, { body: { name: "x" }, origin })).status).toBe(403);
      expect((await call(routes.join.POST, "POST", { token: tokenB }, { origin })).status).toBe(403);
    }
    expect(Number((await sql`select count(*) from membership where workspace_id = ${wsA}`)[0].count)).toBe(2);
  });

  it("the happy path: list, get, members, invite, join, role change, remove, revoke", async () => {
    as(alice);
    expect(await (await call(routes.workspaces.GET, "GET")).json()).toMatchObject({ workspaces: [{ id: wsA, name: "A shop", role: "manager" }] });
    expect(await (await call(routes.workspace.GET, "GET", { id: wsA })).json()).toMatchObject({ workspace: { id: wsA, role: "manager" } });
    const made = await call(routes.invites.POST, "POST", { id: wsA }, {});
    expect(made.status).toBe(201);
    expect(made.headers.get("cache-control")).toBe("no-store");
    const { token, url: link, invite } = (await made.json()) as { token: string; url: string; invite: { id: string } };
    expect(link).toBe(`${ORIGIN}/join/${token}`);
    const listed = JSON.stringify(await (await call(routes.invites.GET, "GET", { id: wsA })).json());
    expect(listed).not.toContain(token);

    as(dan);
    const joined = await call(routes.join.POST, "POST", { token });
    expect(joined.status).toBe(200);
    expect(await joined.json()).toEqual({ workspaceId: wsA, role: "staff", joined: true });
    expect(await (await call(routes.join.POST, "POST", { token })).json()).toMatchObject({ joined: false });
    expect((await call(routes.workspace.GET, "GET", { id: wsA })).status).toBe(200);
    expect((await call(routes.workspace.GET, "GET", { id: wsB })).status).toBe(404);

    as(alice);
    const team = (await (await call(routes.members.GET, "GET", { id: wsA })).json()) as { members: { userId: string }[] };
    expect(team.members.map((m) => m.userId).sort()).toEqual([alice.id, bob.id, dan.id].sort());
    expect((await call(routes.member.PATCH, "PATCH", { id: wsA, userId: dan.id }, { body: { role: "manager" } })).status).toBe(200);
    expect((await call(routes.member.PATCH, "PATCH", { id: wsA, userId: dan.id }, { body: { role: "staff" } })).status).toBe(200);
    expect((await call(routes.member.PATCH, "PATCH", { id: wsA, userId: alice.id }, { body: { role: "staff" } })).status).toBe(409); // last manager
    expect((await call(routes.member.DELETE, "DELETE", { id: wsA, userId: alice.id })).status).toBe(409);
    expect((await call(routes.member.DELETE, "DELETE", { id: wsA, userId: dan.id })).status).toBe(204);
    expect((await call(routes.invite.DELETE, "DELETE", { id: wsA, inviteId: invite.id })).status).toBe(409); // used
    expect((await call(routes.invite.DELETE, "DELETE", { id: wsA, inviteId: inviteA })).status).toBe(204);
    expect((await call(routes.invite.DELETE, "DELETE", { id: wsA, inviteId: inviteA })).status).toBe(204); // twice: no-op
    as(dan);
    expect((await call(routes.workspace.GET, "GET", { id: wsA })).status).toBe(404);
  });

  it("join: every bad link gets the same 404 body", async () => {
    as(dan);
    const bodies = new Set<string>();
    for (const t of ["A".repeat(43), "short", "A".repeat(100), "%00", tokenB.slice(0, -1) + (tokenB.endsWith("A") ? "B" : "A")]) {
      const res = await call(routes.join.POST, "POST", { token: t });
      expect(res.status).toBe(404);
      bodies.add(await res.text());
    }
    expect(bodies.size).toBe(1);
  });

  it("malformed workspace ids are 404 on every route", async () => {
    as(alice);
    for (const bad of ["x", "123", "00000000-0000-0000-0000-000000000000", "../a"]) {
      for (const [name, h, method, params, body] of scoped(bad, inviteA, bob.id)) {
        expect((await call(h as Handler, method, params as Record<string, string>, { body })).status, `${name} ${bad}`).toBe(404);
      }
    }
  });

  it("workspace creation: validation errors are 400, the fourth workspace is 409", async () => {
    as(dan);
    expect((await call(routes.workspaces.POST, "POST", {}, { body: { name: "" } })).status).toBe(400);
    expect((await call(routes.workspaces.POST, "POST", {})).status).toBe(400); // no body
    for (let i = 0; i < 3; i++) expect((await call(routes.workspaces.POST, "POST", {}, { body: { name: `D${i}` } })).status).toBe(201);
    expect((await call(routes.workspaces.POST, "POST", {}, { body: { name: "D3" } })).status).toBe(409);
  });

  it("admin routes: counts for admins, 403 for users", async () => {
    as(alice);
    expect((await (routes.stats.GET as unknown as () => Promise<Response>)()).status).toBe(403);
    expect((await call(routes.demo.POST as unknown as Handler, "POST")).status).toBe(403);
    as(admin);
    const res = await (routes.stats.GET as unknown as () => Promise<Response>)();
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toMatch(/A shop|B shop|ra@test|name/);
    expect(Object.keys(JSON.parse(text).stats).sort()).toEqual(["aiCallsToday", "aiDailyCap", "memberships", "openInvites", "users", "workspaces"]);
  });
});
