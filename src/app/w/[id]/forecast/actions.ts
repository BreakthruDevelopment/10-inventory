"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import type { Explanation } from "@/lib/forecast-explain";
import { explainForecast } from "@/lib/forecast-service";
import { actionError } from "../action-error";

export type ShownExplanation = Explanation & { createdAt: string };
export type ExplainState = { explanation: ShownExplanation | null; error?: string };

/** On request only. Opening the page never calls this. */
export async function explainForecastAction(workspaceId: string, prev: ExplainState, form: FormData): Promise<ExplainState> {
  void form;
  try {
    const user = await requireUser();
    const result = await explainForecast(user, workspaceId);
    revalidatePath(`/w/${workspaceId}/forecast`);
    return { explanation: { ...result.explanation, createdAt: result.generatedAt } };
  } catch (err) {
    return { explanation: prev.explanation, error: actionError(err, "forecast.explain_failed") };
  }
}
