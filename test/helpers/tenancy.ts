import postgres from "postgres";

export const PREFIX = "tn-";

export type TestUser = { id: string; role: "user" | "admin" };

/** Insert users straight into the database (the data layer takes the actor; no session is involved). */
export async function makeUsers(sql: postgres.Sql, names: string[], role: "user" | "admin" = "user"): Promise<TestUser[]> {
  const users: TestUser[] = [];
  for (const n of names) {
    const id = `${PREFIX}${n}`;
    await sql`insert into "user" (id, name, email, role) values (${id}, ${n}, ${id + "@test.local"}, ${role}) on conflict do nothing`;
    users.push({ id, role });
  }
  return users;
}

/** Memberships and invites cascade with the workspace. */
export async function cleanupWorkspaces(sql: postgres.Sql) {
  await sql`delete from workspace where created_by like ${PREFIX + "%"} or id in (select workspace_id from membership where user_id like ${PREFIX + "%"})`;
}

/** Workspaces first: `workspace.created_by` is set null (not cascaded) when a user goes away. */
export async function cleanup(sql: postgres.Sql) {
  await cleanupWorkspaces(sql);
  await sql`delete from "user" where id like ${PREFIX + "%"}`;
}


export const statusOf = (r: PromiseSettledResult<unknown>) =>
  r.status === "fulfilled" ? 200 : ((r.reason as { status?: number }).status ?? 500);
