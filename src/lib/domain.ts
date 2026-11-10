/** Limits for the tenancy layer, in one place so tests and pages read the same numbers. */
export const MAX_WORKSPACES_PER_USER = 3;
export const MAX_MEMBERS = 20;
export const MAX_OPEN_INVITES = 10;
export const INVITES_PER_WORKSPACE_PER_DAY = 20;
export const INVITE_TTL_DAYS = 7;
/** Writes to workspaces, members and invites, per user per hour (the `api_write` kind). */
export const API_WRITES_PER_HOUR = 200;
/** Attempts to accept an invite link, per user per hour, whether or not the token is valid (the `invite` kind). */
export const INVITE_ACCEPTS_PER_HOUR = 30;
/** One admin demo load per minute and this many per UTC day, for the whole app. */
export const DEMO_LOADS_PER_DAY = 5;
