import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { type Db, db, schema } from "@/lib/db";
import { env } from "@/lib/env";
import { TooManyRequestsError } from "@/lib/errors";
import {
  type ItemForecast,
  RECENT_DAYS,
  WINDOW_DAYS,
  compareForecast,
  computeForecast,
  localDate,
} from "@/lib/forecast";
import {
  type Choices,
  DRIVERS,
  CAVEATS,
  type Explanation,
  buildModelInput,
  inputHash,
  renderExplanation,
  runExplain,
} from "@/lib/forecast-explain";
import { log } from "@/lib/log";
import { requireMember } from "@/lib/tenancy";
import { advisoryLock, releaseDaily, reserveDaily } from "@/lib/usage";

/** Per workspace, per hour (spec 10, rate limits). The app-wide daily cap is `FORECAST_DAILY_CAP`. */
export const EXPLAINS_PER_WORKSPACE_PER_HOUR = 10;
const MAX_ITEMS = 2000;
const KEEP_EXPLANATIONS = 20;
const DAY_MS = 86_400_000;

type Reader = Pick<Db, "execute" | "select">;

export type ForecastView = {
  generatedAt: string;
  timeZone: string;
  windowDays: number;
  counts: { reorderNow: number; reorderSoon: number; ok: number; noData: number };
  items: ItemForecast[];
  /** The latest explanation if it was made from exactly the numbers shown; otherwise null. Never calls a model. */
  explanation: (Explanation & { cached: true; createdAt: string }) | null;
};

/** Which provider setup would answer, so a cached demo answer is never served as a live one or the other way round. */
export function modeKey(): string {
  const e = env();
  if (e.AI_PROVIDER === "gemini" && e.GEMINI_API_KEY) return `gemini:${e.AI_MODEL ?? ""}`;
  if (e.AI_PROVIDER === "anthropic" && e.ANTHROPIC_API_KEY) return `anthropic:${e.AI_MODEL ?? ""}`;
  return "demo";
}

type Row = {
  id: string; sku: string; name: string; unit: string; on_hand: number; reorder_point: number; lead_time_days: number;
  pack_size: number; created_at: Date | string; sold28: number | string; sold7: number | string; first_movement: Date | string | null;
};

/**
 * One SQL query: each active item with its last-28-day and last-7-day sales and its first record. `now` is a parameter so
 * tests can pin the clock. The caller has already passed `requireMember`.
 */
export async function loadForecastRows(executor: Reader, workspaceId: string, now: Date = new Date()): Promise<{ rows: ItemForecast[]; timeZone: string }> {
  const { workspace } = schema;
  const [ws] = await executor.select({ timeZone: workspace.timeZone }).from(workspace).where(eq(workspace.id, workspaceId));
  const timeZone = ws?.timeZone ?? "UTC";
  const since28 = new Date(now.getTime() - WINDOW_DAYS * DAY_MS).toISOString();
  const since7 = new Date(now.getTime() - RECENT_DAYS * DAY_MS).toISOString();
  const until = now.toISOString();
  const result = await executor.execute<Row>(sql`
    select i.id, i.sku, i.name, i.unit, i.on_hand, i.reorder_point, i.lead_time_days, i.pack_size, i.created_at,
      coalesce(sum(-m.delta) filter (where m.kind = 'sale' and m.created_at > ${since28}::timestamptz and m.created_at <= ${until}::timestamptz), 0)::bigint as sold28,
      coalesce(sum(-m.delta) filter (where m.kind = 'sale' and m.created_at > ${since7}::timestamptz and m.created_at <= ${until}::timestamptz), 0)::bigint as sold7,
      min(m.created_at) as first_movement
    from item i
    left join stock_movement m on m.item_id = i.id and m.workspace_id = i.workspace_id
    where i.workspace_id = ${workspaceId} and i.archived_at is null
    group by i.id
    order by i.sku, i.id
    limit ${MAX_ITEMS}
  `);
  const today = localDate(now, timeZone);
  const rows = Array.from(result, (r): ItemForecast => {
    const start = Math.min(new Date(r.created_at).getTime(), r.first_movement ? new Date(r.first_movement).getTime() : Infinity);
    const historyDays = Math.max(0, Math.floor((now.getTime() - start) / DAY_MS));
    const base = {
      itemId: r.id, sku: r.sku, name: r.name, unit: r.unit, onHand: r.on_hand, reorderPoint: r.reorder_point,
      leadTimeDays: r.lead_time_days, packSize: r.pack_size, historyDays,
    };
    return { ...base, ...computeForecast({ ...base, sold28: Number(r.sold28), sold7: Number(r.sold7), today }) };
  });
  return { rows: rows.sort(compareForecast), timeZone };
}

const choicesSchema = z.object({
  overview: z.string().max(200),
  items: z.array(z.object({
    itemId: z.string().uuid(),
    status: z.enum(["reorder_now", "reorder_soon"]),
    drivers: z.array(z.enum(DRIVERS)).max(3),
    phrase: z.string().max(200),
  })).max(25),
  caveats: z.array(z.enum(CAVEATS)).max(3),
});

type Stored = { mode: "live" | "demo"; createdAt: Date; choices: Choices | null };

function parseStored(row: { data: unknown; mode: "live" | "demo"; createdAt: Date }): Stored {
  const parsed = choicesSchema.safeParse(row.data);
  return { mode: row.mode, createdAt: row.createdAt, choices: parsed.success ? parsed.data : null };
}

function countsOf(rows: ItemForecast[]) {
  const n = (status: ItemForecast["status"]) => rows.filter((r) => r.status === status).length;
  return { reorderNow: n("reorder_now"), reorderSoon: n("reorder_soon"), ok: n("ok"), noData: n("no_data") };
}

/**
 * The forecast table: numbers computed from the ledger on every visit, one SQL query, no model call. Includes the latest
 * explanation only when it was made from exactly these numbers. Managers only (staff 403, outsiders and admins 404).
 */
export async function getForecast(actor: { id: string }, workspaceId: string, now: Date = new Date()): Promise<ForecastView> {
  const member = await requireMember(actor, workspaceId, "manager");
  const { rows, timeZone } = await loadForecastRows(db(), member.workspaceId, now);
  const { sent } = buildModelInput(rows);
  let explanation: ForecastView["explanation"] = null;
  if (sent.length > 0) {
    const { forecastExplanation: fe } = schema;
    const [latest] = await db().select().from(fe).where(eq(fe.workspaceId, member.workspaceId)).orderBy(desc(fe.createdAt)).limit(1);
    if (latest && latest.inputHash === inputHash(sent, modeKey())) {
      const stored = parseStored(latest);
      explanation = { ...renderExplanation(rows, stored.choices, stored.mode === "demo"), cached: true, createdAt: stored.createdAt.toISOString() };
    }
  }
  return { generatedAt: now.toISOString(), timeZone, windowDays: WINDOW_DAYS, counts: countsOf(rows), items: rows, explanation };
}

export type ExplainResult = { explanation: Explanation; cached: boolean; generatedAt: string };

/**
 * Manager-only, on request. Order: the same numbers already explained are served from the cache for free; otherwise the
 * per-workspace hourly cap and the app-wide daily cap are reserved in one short transaction (before the model call, never
 * held across it), the model is called through `generate()`, the guarded choices are cached, and a failed call refunds
 * its reservation. Nothing here changes stock; the explanation is text beside the table.
 */
export async function explainForecast(actor: { id: string }, workspaceId: string, now: Date = new Date()): Promise<ExplainResult> {
  const member = await requireMember(actor, workspaceId, "manager");
  const { rows } = await loadForecastRows(db(), member.workspaceId, now);
  const { sent } = buildModelInput(rows);
  const generatedAt = now.toISOString();
  if (sent.length === 0) {
    // Nothing needs a reorder, so there is nothing to ask a model.
    return { explanation: renderExplanation(rows, null, false), cached: false, generatedAt };
  }
  const { forecastExplanation: fe, forecastCall } = schema;
  const key = modeKey();
  const hash = inputHash(sent, key);

  const [hit] = await db().select().from(fe).where(and(eq(fe.workspaceId, member.workspaceId), eq(fe.inputHash, hash)));
  if (hit) {
    const stored = parseStored(hit);
    return { explanation: renderExplanation(rows, stored.choices, stored.mode === "demo"), cached: true, generatedAt: stored.createdAt.toISOString() };
  }

  await db().transaction(async (tx) => {
    await requireMember(actor, member.workspaceId, "manager", tx);
    await advisoryLock(tx, `forecast-explain:${member.workspaceId}`);
    await tx.delete(forecastCall).where(and(eq(forecastCall.workspaceId, member.workspaceId), sql`${forecastCall.at} <= now() - interval '1 hour'`));
    const [{ n }] = await tx.execute<{ n: number }>(sql`select count(*)::int as n from forecast_call where workspace_id = ${member.workspaceId}`);
    if (n >= EXPLAINS_PER_WORKSPACE_PER_HOUR) {
      throw new TooManyRequestsError(`This workspace has asked for ${EXPLAINS_PER_WORKSPACE_PER_HOUR} explanations in the last hour. The numbers above are unaffected; try again later.`);
    }
    if (!(await reserveDaily(tx, "ai", env().FORECAST_DAILY_CAP))) {
      throw new TooManyRequestsError("The app's daily limit for AI explanations has been reached. The numbers above are unaffected; try again tomorrow.");
    }
    await tx.insert(forecastCall).values({ workspaceId: member.workspaceId });
  });

  let run;
  try {
    run = await runExplain(rows);
  } catch (err) {
    await refund(member.workspaceId);
    throw err;
  }

  // A live provider that failed over to the recorded demo answer is shown as demo but not cached under the live key,
  // so the next request tries the live model again instead of replaying a canned answer.
  const cacheable = run.demo === (key === "demo");
  const stored = { ...run.choices } as unknown as Record<string, unknown>;
  if (cacheable) {
    await db().transaction(async (tx) => {
      await tx.insert(fe).values({ workspaceId: member.workspaceId, inputHash: hash, data: stored, mode: run.demo ? "demo" : "live", createdBy: actor.id })
        .onConflictDoUpdate({ target: [fe.workspaceId, fe.inputHash], set: { data: stored, mode: run.demo ? "demo" : "live", createdBy: actor.id, createdAt: new Date() } });
      await tx.execute(sql`
        delete from forecast_explanation where workspace_id = ${member.workspaceId} and input_hash not in (
          select input_hash from forecast_explanation where workspace_id = ${member.workspaceId} order by created_at desc limit ${KEEP_EXPLANATIONS})
      `);
    });
  }
  log.info("forecast.explained", { workspaceId: member.workspaceId, cached: false, demo: run.demo, items: run.sent.length, replaced: run.replaced });
  return { explanation: renderExplanation(rows, run.choices, run.demo), cached: false, generatedAt };
}

/** Give back one reservation whose model call never produced an answer. Best effort: it must not hide the real error. */
async function refund(workspaceId: string): Promise<void> {
  try {
    await db().transaction(async (tx) => {
      await advisoryLock(tx, `forecast-explain:${workspaceId}`);
      await tx.execute(sql`delete from forecast_call where id = (select id from forecast_call where workspace_id = ${workspaceId} order by at desc limit 1)`);
      await releaseDaily(tx, "ai");
    });
  } catch (err) {
    log.error("forecast.refund_failed", { errorName: err instanceof Error ? err.name : typeof err });
  }
}
