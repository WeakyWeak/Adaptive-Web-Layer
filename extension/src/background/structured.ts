// ─── Validated structured model calls ────────────────────────────────────────
// One model call whose reply must pass a Zod schema, with one corrective retry
// that tells the model what was wrong. Used by comprehension and the inspector.

import type { z } from "zod";
import type { JsonSchema } from "../shared/jsonSchema";
import type { ImageInput } from "../shared/llmProvider";
import { ProviderError } from "../shared/plan";
import type { StructuredGenerator } from "./planner";

const MAX_ATTEMPTS = 2;

export interface ValidatedRequest<T extends z.ZodTypeAny> {
  systemPrompt: string;
  /** The user prompt; `errors` lists what was wrong with the previous reply. */
  userPrompt: (errors: string[]) => string;
  schema: T;
  jsonSchema: JsonSchema;
  maxTokens: number;
  /** Screenshots for vision models (the P10 reviewer). */
  images?: ImageInput[];
}

export async function runValidated<T extends z.ZodTypeAny>(
  generator: StructuredGenerator,
  request: ValidatedRequest<T>,
  options: { signal?: AbortSignal; onProgress?: (received: number) => void } = {},
): Promise<{ reply: z.infer<T>; retried: boolean }> {
  let errors: string[] = [];
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let raw: unknown;
    try {
      raw = await generator.generateStructured({
        systemPrompt: request.systemPrompt,
        userPrompt: request.userPrompt(errors),
        schema: request.jsonSchema,
        images: request.images,
        signal: options.signal,
        maxTokens: request.maxTokens,
        onProgress: options.onProgress,
      });
    } catch (error) {
      if (error instanceof ProviderError && error.code === "invalid-json" && attempt + 1 < MAX_ATTEMPTS) {
        errors = ["Your reply was not a valid JSON object."];
        continue;
      }
      throw error;
    }
    const parsed = request.schema.safeParse(raw);
    if (parsed.success) return { reply: parsed.data, retried: attempt > 0 };
    errors = parsed.error.issues.slice(0, 6).map((issue) => `${issue.path.join(".") || "reply"}: ${issue.message}`);
  }
  throw new ProviderError("invalid-plan", `The model's reply was rejected: ${errors.join("; ")}`, "Try again, or switch to a larger model.");
}
