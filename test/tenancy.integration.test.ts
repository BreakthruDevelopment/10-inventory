/**
 * Tenancy at the data layer, against a real Postgres (TEST_DATABASE_URL): isolation between workspaces, manager vs
 * staff, the last-manager rule, invite tokens (hashed, expiring, single use, revocable, capped) and the races that
 * matter (concurrent accepts, concurrent demotions, concurrent creates).
 */
import { createHash } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PREFIX, type TestUser, cleanup, cleanupWorkspaces, makeUsers, statusOf } from "./helpers/tenancy";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("tenancy (Postgres)", () => {
  let sql: postgres.Sql;
  let ws: typeof import("@/lib/workspaces");
  let members: typeof import("@/lib/members");
  let invites: typeof import("@/lib/invites");
  let tenancy: typeof import("@/lib/tenancy");
  let stats: typeof import("@/lib/admin-stats");
  let alice: TestUser, bob: TestUser, cara: TestUser, dan: TestUser, eve: TestUser, admin: TestUser;
  let wsA: string; // alice manages; bob is staff
  let wsB: string; // cara manages (alice and bob are strangers)

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    process.env.APP_URL = "http://localhost:3000";
    sql = postgres(url!, { max: 4, onnotice: () => {} });
    await cleanup(sql);
    [alice, bob, cara, dan, eve] = await makeUsers(sql, ["alice", "bob", "cara", "dan", "eve"]);
    [admin] = await makeUsers(sql, ["admin"], "admin");
    ws = await import("@/lib/workspaces");
    members = await import("@/lib/members");
    invites = await import("@/lib/invites");
    tenancy = await import("@/lib/tenancy");
    stats = await import("@/lib/admin-stats");
  });
  afterAll(async () => {
    await cleanup(sql);
    await sql`delete from rate_event where user_id like ${PREFIX + "%"}`;
    await sql.end();
  });

  /** A fresh A (alice manager, bob staff) and B (cara manager) before every test. */
  beforeEach(async () => {
    await cleanupWorkspaces(sql);
    await sql`delete from rate_event where user_id like ${PREFIX + "%"}`;
    wsA = (await ws.createWorkspace(alice, { name: "Alpha" })).id;
    await sql`insert into membership (workspace_id, user_id, role) values (${wsA}, ${bob.id}, 'staff')`;
    wsB = (await ws.createWorkspace(cara, { name: "Bravo" })).id;
  });

  const rejects = (p: Promise<unknown>, status: number) => expect(p).rejects.toMatchObject({ status });
  const openInviteCount = async (w: string) =>
    Number((await sql`select count(*) from invite where workspace_id = ${w} and used_at is null and revoked_at is null and expires_at > now()`)[0].count);

  describe("requireMember", () => {
    it("returns the role for members and enforces minRole with 403", async () => {
      expect(await tenancy.requireMember(alice, wsA, "manager")).toMatchObject({ role: "manager", workspaceId: wsA });
      expect(await tenancy.requireMember(bob, wsA, "staff")).toMatchObject({ role: "staff" });
      await rejects(tenancy.requireMember(bob, wsA, "manager"), 403);
    });

    it("answers non-members, unknown ids and malformed ids with the same 404", async () => {
      await rejects(tenancy.requireMember(alice, wsB, "staff"), 404);
      await rejects(tenancy.requireMember(alice, wsB, "manager"), 404); // not 403: a stranger can't tell the role rule exists
      await rejects(tenancy.requireMember(alice, "00000000-0000-4000-8000-000000000000"), 404);
      for (const bad of ["nope", "", "1; drop table workspace", undefined, null, 42, { id: wsA }]) {
        await rejects(tenancy.requireMember(alice, bad), 404);
      }
    });

    it("gives the global admin role no access to a workspace", async () => {
      await rejects(tenancy.requireMember(admin, wsA, "staff"), 404);
      await rejects(ws.getWorkspace(admin, wsA), 404);
      await rejects(members.listMembers(admin, wsA), 404);
      await rejects(invites.createInvite(admin, wsA, { role: "staff" }), 404);
    });
  });

  describe("workspaces", () => {
    it("the creator is the manager, and the list shows only your own workspaces", async () => {
      expect((await ws.listMyWorkspaces(alice)).map((w) => [w.name, w.role])).toEqual([["Alpha", "manager"]]);
      expect((await ws.listMyWorkspaces(bob)).map((w) => [w.name, w.role])).toEqual([["Alpha", "staff"]]);
      expect(await ws.listMyWorkspaces(dan)).toEqual([]);
      expect(await ws.listMyWorkspaces(admin)).toEqual([]);
    });

    it("getWorkspace works for members and is 404 for everyone else", async () => {
      expect(await ws.getWorkspace(bob, wsA)).toMatchObject({ name: "Alpha", role: "staff" });
      await rejects(ws.getWorkspace(bob, wsB), 404);
    });

    it("validates input and ignores ids smuggled into the body", async () => {
      await expect(ws.createWorkspace(dan, { name: "   " })).rejects.toThrow();
      await expect(ws.createWorkspace(dan, { name: "x".repeat(81) })).rejects.toThrow();
      await expect(ws.createWorkspace(dan, { name: "ok", timeZone: "Mars/Olympus" })).rejects.toThrow();
      await expect(ws.createWorkspace(dan, { name: "ok", id: wsA })).rejects.toThrow(); // strict: no extra keys
      await expect(ws.createWorkspace(dan, { name: "ok", createdBy: alice.id })).rejects.toThrow();
    });

    it("caps creation at 3 per user, even when 8 requests race", async () => {
      const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => ws.createWorkspace(dan, { name: `D${i}` })));
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
      expect(results.filter((r) => statusOf(r) === 409)).toHaveLength(5);
      expect(await ws.listMyWorkspaces(dan)).toHaveLength(3);
    });
  });

  describe("members", () => {
    it("only managers list members; staff get 403, strangers 404", async () => {
      expect((await members.listMembers(alice, wsA)).map((m) => [m.userId, m.role]).sort()).toEqual([
        [alice.id, "manager"],
        [bob.id, "staff"],
      ]);
      await rejects(members.listMembers(bob, wsA), 403);
      await rejects(members.listMembers(alice, wsB), 404);
    });

    it("a manager changes roles; staff can't; strangers get 404; the target must be in this workspace", async () => {
      expect(await members.changeMemberRole(alice, wsA, bob.id, { role: "manager" })).toEqual({ userId: bob.id, role: "manager" });
      await members.changeMemberRole(alice, wsA, bob.id, { role: "staff" });
      await rejects(members.changeMemberRole(bob, wsA, bob.id, { role: "manager" }), 403); // no self-promotion
      await rejects(members.changeMemberRole(bob, wsB, bob.id, { role: "manager" }), 404);
      await rejects(members.changeMemberRole(alice, wsB, cara.id, { role: "staff" }), 404);
      // cara belongs to B, not A: A's manager can't reach her through A's path
      await rejects(members.changeMemberRole(alice, wsA, cara.id, { role: "staff" }), 404);
      expect((await sql`select role from membership where workspace_id = ${wsB} and user_id = ${cara.id}`)[0].role).toBe("manager");
      await expect(members.changeMemberRole(alice, wsA, bob.id, { role: "owner" })).rejects.toThrow();
      await expect(members.changeMemberRole(alice, wsA, bob.id, { role: "staff", workspaceId: wsB })).rejects.toThrow();
    });

    it("the last manager can't be demoted, removed or leave", async () => {
      await rejects(members.changeMemberRole(alice, wsA, alice.id, { role: "staff" }), 409);
      await rejects(members.removeMember(alice, wsA, alice.id), 409);
      await members.changeMemberRole(alice, wsA, bob.id, { role: "manager" });
      await members.changeMemberRole(alice, wsA, alice.id, { role: "staff" }); // now bob is the last manager
      await rejects(members.removeMember(bob, wsA, bob.id), 409);
      await rejects(members.changeMemberRole(bob, wsA, bob.id, { role: "staff" }), 409);
    });

    it("two managers demoting each other at once leave exactly one manager", async () => {
      await members.changeMemberRole(alice, wsA, bob.id, { role: "manager" });
      const results = await Promise.allSettled([
        members.changeMemberRole(alice, wsA, bob.id, { role: "staff" }),
        members.changeMemberRole(bob, wsA, alice.id, { role: "staff" }),
      ]);
      // The loser is refused: 403 (already demoted when its turn came: the role is rechecked under the lock) or 409.
      const codes = results.map(statusOf).sort();
      expect(codes[0]).toBe(200);
      expect([403, 409]).toContain(codes[1]);
      expect(Number((await sql`select count(*) from membership where workspace_id = ${wsA} and role = 'manager'`)[0].count)).toBe(1);
    });

    it("two managers removing each other at once leave one", async () => {
      await members.changeMemberRole(alice, wsA, bob.id, { role: "manager" });
      const results = await Promise.allSettled([members.removeMember(alice, wsA, bob.id), members.removeMember(bob, wsA, alice.id)]);
      // The second request is refused: either it was removed first (404) or it would remove the last manager (409).
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(Number((await sql`select count(*) from membership where workspace_id = ${wsA} and role = 'manager'`)[0].count)).toBe(1);
    });

    it("staff can leave; staff can't remove others; a manager removes staff; a stranger gets 404", async () => {
      await members.changeMemberRole(alice, wsA, alice.id, { role: "manager" });
      await rejects(members.removeMember(bob, wsA, alice.id), 403);
      await rejects(members.removeMember(cara, wsA, bob.id), 404);
      await rejects(members.removeMember(alice, wsB, cara.id), 404);
      await rejects(members.removeMember(alice, wsA, cara.id), 404); // cara isn't in A
      expect(await ws.getWorkspace(cara, wsB)).toBeTruthy();
      await members.removeMember(bob, wsA, bob.id); // leave
      await rejects(ws.getWorkspace(bob, wsA), 404);
      await invitesAdd(wsA, bob);
      await members.removeMember(alice, wsA, bob.id);
      await rejects(members.removeMember(alice, wsA, bob.id), 404); // already gone
    });

    it("a removed member loses access at once", async () => {
      await members.removeMember(alice, wsA, bob.id);
      await rejects(ws.getWorkspace(bob, wsA), 404);
      await rejects(invites.listInvites(bob, wsA), 404);
    });

    it("malformed user ids in the path are 404 for managers and strangers alike", async () => {
      await rejects(members.removeMember(alice, wsA, ""), 404);
      await rejects(members.changeMemberRole(alice, wsA, "x".repeat(200), { role: "staff" }), 404);
      await rejects(members.removeMember(dan, wsA, ""), 404);
    });

    async function invitesAdd(w: string, user: TestUser) {
      await sql`insert into membership (workspace_id, user_id, role) values (${w}, ${user.id}, 'staff') on conflict do nothing`;
    }
  });

  describe("database guard (every path, not just removeMember)", () => {
    const sqlRejects = (p: PromiseLike<unknown>) => expect(p).rejects.toMatchObject({ message: expect.stringContaining("at least one manager") });
    const managers = async (w: string) => Number((await sql`select count(*) from membership where workspace_id = ${w} and role = 'manager'`)[0].count);

    it("deleting the last manager's account is refused and changes nothing; with a second manager it works", async () => {
      await sqlRejects(sql`delete from "user" where id = ${alice.id}`);
      expect((await sql`select 1 from "user" where id = ${alice.id}`).length).toBe(1);
      expect(await managers(wsA)).toBe(1);
      await members.changeMemberRole(alice, wsA, bob.id, { role: "manager" });
      await sql`delete from "user" where id = ${alice.id}`;
      expect(await managers(wsA)).toBe(1);
      await makeUsers(sql, ["alice"]); // put her back for the other tests (she is no longer a member of A)
    });

    it("a direct UPDATE or DELETE of the last manager's membership is refused", async () => {
      await sqlRejects(sql`update membership set role = 'staff' where workspace_id = ${wsA} and user_id = ${alice.id}`);
      await sqlRejects(sql`delete from membership where workspace_id = ${wsA} and user_id = ${alice.id}`);
      await sqlRejects(sql`update membership set workspace_id = ${wsB} where workspace_id = ${wsA} and user_id = ${alice.id}`);
      expect(await managers(wsA)).toBe(1);
      await sql`update membership set role = 'manager' where workspace_id = ${wsA} and user_id = ${alice.id}`; // no-op update is fine
      await sql`update membership set role = 'manager' where workspace_id = ${wsA} and user_id = ${bob.id}`;
      await sql`update membership set role = 'staff' where workspace_id = ${wsA} and user_id = ${alice.id}`;
    });

    it("two managers' accounts deleted at once leave one manager", async () => {
      await members.changeMemberRole(alice, wsA, bob.id, { role: "manager" });
      const results = await Promise.allSettled([sql`delete from "user" where id = ${alice.id}`, sql`delete from "user" where id = ${bob.id}`]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(await managers(wsA)).toBe(1);
      await makeUsers(sql, ["alice", "bob"]);
    });

    it("deleting a whole workspace is not blocked by the rule", async () => {
      await sql`delete from workspace where id = ${wsA}`;
      expect((await sql`select 1 from membership where workspace_id = ${wsA}`).length).toBe(0);
    });
  });

  describe("invites", () => {
    const sha = (t: string) => createHash("sha256").update(t).digest("hex");

    it("a manager creates a link; only the hash is stored; expiry is 7 days; the list never shows the token", async () => {
      const made = await invites.createInvite(alice, wsA, { role: "staff" });
      expect(made.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(made.url).toBe(`http://localhost:3000/join/${made.token}`);
      const [row] = await sql`select * from invite where id = ${made.invite.id}`;
      expect(row.token_hash).toBe(sha(made.token));
      expect(JSON.stringify(row)).not.toContain(made.token);
      const days = (new Date(row.expires_at).getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(6.99);
      expect(days).toBeLessThanOrEqual(7.001);
      const listed = await invites.listInvites(alice, wsA);
      expect(listed).toHaveLength(1);
      expect(JSON.stringify(listed)).not.toContain(made.token);
      expect(JSON.stringify(listed)).not.toContain(sha(made.token));
      expect(listed[0]).toMatchObject({ role: "staff", open: true });
    });

    it("staff can't create, list or revoke invites (403); strangers get 404; nothing is created", async () => {
      await rejects(invites.createInvite(bob, wsA, { role: "staff" }), 403);
      await rejects(invites.createInvite(bob, wsA, { role: "manager" }), 403);
      await rejects(invites.listInvites(bob, wsA), 403);
      await rejects(invites.createInvite(alice, wsB, { role: "staff" }), 404);
      await rejects(invites.createInvite(dan, wsA, { role: "staff" }), 404);
      await rejects(invites.listInvites(alice, wsB), 404);
      const made = await invites.createInvite(alice, wsA, {});
      await rejects(invites.revokeInvite(bob, wsA, made.invite.id), 403);
      expect(await openInviteCount(wsA)).toBe(1);
      expect(Number((await sql`select count(*) from invite where workspace_id = ${wsB}`)[0].count)).toBe(0);
    });

    it("rejects bad roles and extra keys", async () => {
      await expect(invites.createInvite(alice, wsA, { role: "admin" })).rejects.toThrow();
      await expect(invites.createInvite(alice, wsA, { role: "staff", workspaceId: wsB })).rejects.toThrow();
    });

    it("accepting joins with the invite's role", async () => {
      const staff = await invites.createInvite(alice, wsA, { role: "staff" });
      expect(await invites.acceptInvite(dan, staff.token)).toEqual({ workspaceId: wsA, role: "staff", joined: true });
      const mgr = await invites.createInvite(alice, wsA, { role: "manager" });
      expect(await invites.acceptInvite(eve, mgr.token)).toEqual({ workspaceId: wsA, role: "manager", joined: true });
      expect(await ws.getWorkspace(dan, wsA)).toMatchObject({ role: "staff" });
      await rejects(ws.getWorkspace(dan, wsB), 404); // joining A grants nothing in B
    });

    it("accepting twice is a no-op; the invite stays used by the first accept", async () => {
      const { token, invite } = await invites.createInvite(alice, wsA, { role: "staff" });
      expect((await invites.acceptInvite(dan, token)).joined).toBe(true);
      expect(await invites.acceptInvite(dan, token)).toEqual({ workspaceId: wsA, role: "staff", joined: false });
      expect(Number((await sql`select count(*) from membership where workspace_id = ${wsA} and user_id = ${dan.id}`)[0].count)).toBe(1);
      expect((await sql`select used_by from invite where id = ${invite.id}`)[0].used_by).toBe(dan.id);
    });

    it("a used link is dead for everyone else (single use)", async () => {
      const { token } = await invites.createInvite(alice, wsA, { role: "staff" });
      await invites.acceptInvite(dan, token);
      await rejects(invites.acceptInvite(eve, token), 404);
      await rejects(ws.getWorkspace(eve, wsA), 404);
    });

    it("an expired link is refused", async () => {
      const { token, invite } = await invites.createInvite(alice, wsA, { role: "staff" });
      await sql`update invite set expires_at = now() - interval '1 second' where id = ${invite.id}`;
      await rejects(invites.acceptInvite(dan, token), 404);
      await rejects(ws.getWorkspace(dan, wsA), 404);
      expect((await invites.listInvites(alice, wsA))[0].open).toBe(false);
      // Not open any more, so it doesn't count against the cap of 10.
      expect(await openInviteCount(wsA)).toBe(0);
    });

    it("a revoked link is refused; revoking twice is a no-op; a used invite can't be revoked", async () => {
      const a = await invites.createInvite(alice, wsA, { role: "staff" });
      await invites.revokeInvite(alice, wsA, a.invite.id);
      await invites.revokeInvite(alice, wsA, a.invite.id);
      await rejects(invites.acceptInvite(dan, a.token), 404);
      const b = await invites.createInvite(alice, wsA, { role: "staff" });
      await invites.acceptInvite(dan, b.token);
      await rejects(invites.revokeInvite(alice, wsA, b.invite.id), 409);
      await expect(ws.getWorkspace(dan, wsA)).resolves.toBeTruthy();
    });

    it("a manager can't revoke another workspace's invite, by its id or through the other workspace's path", async () => {
      const inB = await invites.createInvite(cara, wsB, { role: "staff" });
      await rejects(invites.revokeInvite(alice, wsA, inB.invite.id), 404); // my path, their invite id
      await rejects(invites.revokeInvite(alice, wsB, inB.invite.id), 404); // their path
      await rejects(invites.revokeInvite(alice, wsA, "not-a-uuid"), 404);
      expect(await openInviteCount(wsB)).toBe(1);
      expect((await invites.acceptInvite(dan, inB.token)).workspaceId).toBe(wsB);
    });

    it("unknown, malformed and wrong-length tokens are the same 404", async () => {
      for (const t of ["", "x", "A".repeat(43), "A".repeat(44), "../../etc/passwd", null, undefined, 7, "A".repeat(42) + "!"]) {
        await rejects(invites.acceptInvite(dan, t), 404);
      }
    });

    it("an existing member can't use a manager link to promote themselves, and the link isn't consumed", async () => {
      const mgr = await invites.createInvite(alice, wsA, { role: "manager" });
      expect(await invites.acceptInvite(bob, mgr.token)).toEqual({ workspaceId: wsA, role: "staff", joined: false });
      expect((await sql`select role from membership where workspace_id = ${wsA} and user_id = ${bob.id}`)[0].role).toBe("staff");
      expect((await sql`select used_at from invite where id = ${mgr.invite.id}`)[0].used_at).toBeNull();
      expect((await invites.acceptInvite(dan, mgr.token)).role).toBe("manager"); // still usable by someone new
    });

    it("a removed member can't walk back in with the link they used", async () => {
      const { token } = await invites.createInvite(alice, wsA, { role: "staff" });
      await invites.acceptInvite(dan, token);
      await members.removeMember(alice, wsA, dan.id);
      await rejects(invites.acceptInvite(dan, token), 404);
    });

    it("caps open invites at 10 (races included)", async () => {
      const results = await Promise.allSettled(Array.from({ length: 14 }, () => invites.createInvite(alice, wsA, { role: "staff" })));
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(10);
      expect(results.filter((r) => statusOf(r) === 409)).toHaveLength(4);
      expect(await openInviteCount(wsA)).toBe(10);
      const first = await invites.listInvites(alice, wsA);
      await invites.revokeInvite(alice, wsA, first[0].id);
      await expect(invites.createInvite(alice, wsA, {})).resolves.toBeTruthy();
    });

    it("caps creation at 20 per workspace per day, revoked invites included", async () => {
      for (let round = 0; round < 2; round++) {
        const made = await Promise.all(Array.from({ length: 10 }, () => invites.createInvite(alice, wsA, {})));
        for (const m of made) await invites.revokeInvite(alice, wsA, m.invite.id);
      }
      await rejects(invites.createInvite(alice, wsA, {}), 409);
      // The cap is per workspace: B is unaffected.
      await expect(invites.createInvite(cara, wsB, {})).resolves.toBeTruthy();
      // And it's a rolling day.
      await sql`update invite set created_at = now() - interval '25 hours' where workspace_id = ${wsA}`;
      await expect(invites.createInvite(alice, wsA, {})).resolves.toBeTruthy();
    });

    it("one link accepted by 6 people at once admits exactly one", async () => {
      const users = await makeUsers(sql, ["r1", "r2", "r3", "r4", "r5", "r6"]);
      const { token } = await invites.createInvite(alice, wsA, { role: "staff" });
      const results = await Promise.allSettled(users.map((u) => invites.acceptInvite(u, token)));
      expect(results.map(statusOf).sort()).toEqual([200, 404, 404, 404, 404, 404]);
      expect(Number((await sql`select count(*) from membership where workspace_id = ${wsA} and user_id like ${PREFIX + "r%"}`)[0].count)).toBe(1);
    });

    it("the same person double-tapping gets one membership and both calls succeed", async () => {
      const { token } = await invites.createInvite(alice, wsA, { role: "staff" });
      const results = await Promise.all([invites.acceptInvite(dan, token), invites.acceptInvite(dan, token), invites.acceptInvite(dan, token)]);
      expect(results.filter((r) => r.joined)).toHaveLength(1);
      expect(Number((await sql`select count(*) from membership where workspace_id = ${wsA} and user_id = ${dan.id}`)[0].count)).toBe(1);
    });

    it("a revoke racing an accept leaves a consistent state", async () => {
      const { token, invite } = await invites.createInvite(alice, wsA, { role: "staff" });
      const [rev, acc] = await Promise.allSettled([invites.revokeInvite(alice, wsA, invite.id), invites.acceptInvite(dan, token)]);
      const [row] = await sql`select used_by, revoked_at from invite where id = ${invite.id}`;
      const joined = acc.status === "fulfilled";
      expect(joined).toBe(row.used_by === dan.id);
      // Either the accept won (revoke then 409, nobody is let in by a revoked link) or the revoke won (accept 404).
      expect(rev.status === "fulfilled" ? !joined : joined).toBe(true);
      if (joined) expect(row.revoked_at).toBeNull();
    });

    it("a full workspace (20 members) refuses a new member and keeps the invite unused", async () => {
      const crowd = await makeUsers(sql, Array.from({ length: 18 }, (_, i) => `m${i}`));
      for (const u of crowd) await sql`insert into membership (workspace_id, user_id, role) values (${wsA}, ${u.id}, 'staff')`;
      const { token, invite } = await invites.createInvite(alice, wsA, { role: "staff" }); // alice + bob + 18 = 20
      await rejects(invites.acceptInvite(dan, token), 409);
      expect((await sql`select used_at from invite where id = ${invite.id}`)[0].used_at).toBeNull();
      await members.removeMember(alice, wsA, crowd[0].id);
      expect((await invites.acceptInvite(dan, token)).joined).toBe(true);
    });

    it("20 members is a hard cap even when people accept at once", async () => {
      const crowd = await makeUsers(sql, Array.from({ length: 17 }, (_, i) => `m${i}`));
      for (const u of crowd) await sql`insert into membership (workspace_id, user_id, role) values (${wsA}, ${u.id}, 'staff')`; // 19 members
      const late = await makeUsers(sql, ["l1", "l2", "l3", "l4"]);
      const tokens = await Promise.all(late.map(() => invites.createInvite(alice, wsA, { role: "staff" })));
      const results = await Promise.allSettled(late.map((u, i) => invites.acceptInvite(u, tokens[i].token)));
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(Number((await sql`select count(*) from membership where workspace_id = ${wsA}`)[0].count)).toBe(20);
    });

    it("rate-limits accept attempts per user (30 an hour), valid or not", async () => {
      const probe = await makeUsers(sql, ["probe"]);
      for (let i = 0; i < 30; i++) await rejects(invites.acceptInvite(probe[0], "A".repeat(43)), 404);
      await rejects(invites.acceptInvite(probe[0], "A".repeat(43)), 429);
      const { token } = await invites.createInvite(alice, wsA, { role: "staff" });
      await rejects(invites.acceptInvite(probe[0], token), 429); // even a good link, until the window slides
      await expect(invites.acceptInvite(dan, token)).resolves.toMatchObject({ joined: true }); // other users unaffected
    });
  });

  describe("admin", () => {
    it("sees counts only", async () => {
      const s = await stats.adminStats(admin);
      expect(Object.keys(s).sort()).toEqual(["aiCallsToday", "aiDailyCap", "memberships", "openInvites", "users", "workspaces"]);
      for (const v of Object.values(s)) expect(typeof v).toBe("number");
      expect(s.workspaces).toBeGreaterThanOrEqual(2);
      expect(JSON.stringify(s)).not.toMatch(/Alpha|Bravo|alice/);
    });
    it("is refused to everyone else", async () => {
      await rejects(stats.adminStats(alice), 403);
    });
  });
});
