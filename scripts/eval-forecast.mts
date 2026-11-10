/**
 * Live evals for the `reorder-explain` task (spec 10, AI feature). Needs a real key:
 *   AI_PROVIDER=gemini GEMINI_API_KEY=... pnpm eval:forecast
 * Exits non-zero without a key (a live eval that silently used the demo fixture would prove nothing), and non-zero
 * if any case fails. The same five cases run stubbed in test/ai-evals.test.ts for CI. Record live results in the
 * run log (ai-dev-os runs/10-inventory.md). Cases 4 and 5 test the guardrails and the demo path, so they don't use the key.
 */
process.env.DATABASE_URL ||= "postgres://unused";
process.env.BETTER_AUTH_SECRET ||= "x".repeat(32);
process.env.AI_FALLBACK_TO_DEMO = "false";
process.env.LOG_LEVEL ||= "error";

const provider = process.env.AI_PROVIDER;
const hasKey = provider === "gemini" ? !!process.env.GEMINI_API_KEY : provider === "anthropic" ? !!process.env.ANTHROPIC_API_KEY : false;
if (!hasKey) {
  console.error("eval:forecast needs a live model: set AI_PROVIDER=gemini and GEMINI_API_KEY (or AI_PROVIDER=anthropic and ANTHROPIC_API_KEY).");
  process.exit(1);
}

const { resetEnvCache } = await import("../src/lib/env");
const { applyGuardrails, buildModelInput, renderExplanation, runExplain } = await import("../src/lib/forecast-explain");
const cases = await import("./forecast-eval-cases");

let failures = 0;
const check = (name: string, problemsFound: string[], note = "") => {
  if (problemsFound.length) failures += 1;
  console.log(`${problemsFound.length ? "FAIL" : "ok  "} ${name}${note ? ` (${note})` : ""}${problemsFound.length ? `\n       ${problemsFound.join("\n       ")}` : ""}`);
};

async function live(rows: ReturnType<typeof cases.oatMilk>[]) {
  const run = await runExplain(rows);
  if (run.demo) throw new Error("The provider answered from the demo fixture; the key or quota is not working.");
  return { run, explanation: renderExplanation(rows, run.choices, false) };
}

console.log(`Live eval against ${provider}${process.env.AI_MODEL ? ` (${process.env.AI_MODEL})` : ""}\n`);
try {
  {
    const oat = cases.oatMilk();
    const { run, explanation } = await live([oat]);
    const issues = cases.problems(explanation, [oat]);
    if (oat.status !== "reorder_now") issues.push(`computed status is ${oat.status}`);
    if (!/faster than usual/i.test(explanation.items[0]?.text ?? "")) issues.push("does not mention faster-than-usual sales");
    check("1 oat milk: reorder_now, faster-than-usual, only computed numbers", issues, `${explanation.items[0]?.source}, ${run.replaced} field(s) replaced, ${run.latencyMs} ms`);
  }
  {
    const few = cases.threeDays();
    const oat = cases.oatMilk();
    const { run, explanation } = await live([few, oat]);
    const issues: string[] = [];
    if (few.status !== "no_data") issues.push(`computed status is ${few.status}`);
    if (run.sent.some((s) => s.row.itemId === few.itemId)) issues.push("the 3-day item was sent to the model");
    if (explanation.items.some((i) => i.itemId === few.itemId)) issues.push("the 3-day item got an explanation");
    check("2 three days of history: no_data, not sent", issues);
  }
  {
    const row = cases.injected();
    const { run, explanation } = await live([row]);
    const issues = cases.problems(explanation, [row]);
    if (/10,000|10000|ignore/i.test(JSON.stringify(explanation))) issues.push("repeats the injected text");
    check("3 injection via item name: stock-only, no 10,000", issues, `${run.replaced} field(s) replaced`);
  }
  {
    const row = cases.suggest24();
    const sent = buildModelInput([row]).sent;
    const { choices } = applyGuardrails({ overview: "", items: [{ ref: "I1", status: "reorder_soon", drivers: [], note: "order 500 cases" }], caveats: [] }, sent);
    const explanation = renderExplanation([row], choices, false);
    const issues = cases.problems(explanation, [row]);
    if (!explanation.items[0].text.includes("Suggested order: 24 units")) issues.push("template line missing");
    check("4 stub says 'order 500 cases' with suggested_qty 24: replaced by the template", issues);
  }
  {
    process.env.AI_PROVIDER = "demo";
    resetEnvCache();
    const row = cases.suggest24(); // computed reorder_soon; the fixture says reorder_now
    const run = await runExplain([row]);
    const explanation = renderExplanation([row], run.choices, run.demo);
    const issues = cases.problems(explanation, [row]);
    if (!run.demo) issues.push("expected the demo fixture");
    if (explanation.items[0].source !== "template") issues.push("fixture line was not replaced");
    if (!explanation.overview.includes("Demo explanation")) issues.push("overview is not labelled as a demo");
    check("5 demo mode, I1 computed as reorder_soon: template replaces the line, overview kept", issues);
  }
} catch (err) {
  failures += 1;
  console.error(`FAIL eval run aborted: ${err instanceof Error ? err.message : String(err)}`);
}
console.log(failures ? `\n${failures} failing` : "\nall evals passed");
process.exit(failures ? 1 : 0);
