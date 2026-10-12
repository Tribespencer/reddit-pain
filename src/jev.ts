import { QUESTIONS } from "./config";
import type { JevResult, JevState, Labels } from "./types";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const DEFAULT_MODEL = "jev-latest";

interface JevResponse {
  model: string;
  answers: {
    asks_for_product: { noul: number };
    has_pain: { noul: number };
    pain_intensity: { score: number };
  };
  usage?: { input_tokens?: number };
}

const HTTP_ERRORS: Record<number, string> = {
  401: "Jev rejected the API key",
  403: "Jev rejected the API key",
  422: "Jev rejected the request format",
  429: "Jev rate limit reached",
  529: "Jev is overloaded",
};

export async function labelWithJev(apiKey: string, model: string, state: JevState): Promise<JevResult> {
  const started = performance.now();
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, state, questions: QUESTIONS }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    return { ok: false, error: `Could not reach Jev (${(err as Error).name})` };
  }

  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    return { ok: false, error: `${HTTP_ERRORS[res.status] ?? "Jev error"} (HTTP ${res.status}) ${detail}` };
  }

  const data = (await res.json().catch(() => null)) as JevResponse | null;
  const a = data?.answers;
  if (typeof a?.asks_for_product?.noul !== "number" || typeof a?.has_pain?.noul !== "number") {
    return { ok: false, error: "Jev response was missing expected answers" };
  }

  const labels: Labels = {
    asksForProduct: a.asks_for_product.noul,
    hasPain: a.has_pain.noul,
    painIntensity: a.pain_intensity?.score ?? 0,
  };
  return {
    ok: true,
    labels,
    model: data!.model,
    ms: Math.round(performance.now() - started),
    inputTokens: data!.usage?.input_tokens ?? 0,
  };
}
