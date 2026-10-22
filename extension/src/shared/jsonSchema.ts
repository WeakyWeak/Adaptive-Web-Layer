// ─── Plan JSON Schema, generated from the Zod field schemas ─────────────────
// Each provider accepts a different JSON-Schema dialect, so the canonical schema
// is generated once and then adapted per provider. Zod validation of the reply
// stays the final authority in every case.

import { z } from "zod";
import { AI_FIELDS, type AiField } from "./aiFields";

export type JsonSchema = Record<string, unknown>;
export type SchemaDialect = "llamacpp" | "gemini" | "gemini-openapi" | "anthropic";

/** Enum token the model uses for "keep the site's own value" (settings store ""). */
export const SITE_DEFAULT_TOKEN = "default";

export function numberBounds(schema: z.ZodNumber): { minimum?: number; maximum?: number } {
  const bounds: { minimum?: number; maximum?: number } = {};
  for (const check of schema._def.checks) {
    if (check.kind === "min") bounds.minimum = check.value;
    if (check.kind === "max") bounds.maximum = check.value;
  }
  return bounds;
}

/** Converts the small set of Zod types used by AI fields. Throws on anything else. */
export function fieldJsonSchema(field: AiField): JsonSchema {
  const { schema } = field;
  if (schema instanceof z.ZodNumber) {
    const bounds = numberBounds(schema);
    const range = bounds.minimum !== undefined && bounds.maximum !== undefined ? `; ${bounds.minimum}–${bounds.maximum}${field.unit}` : "";
    return { type: "number", ...bounds, description: `${field.label}: ${field.hint}${range}` };
  }
  if (schema instanceof z.ZodBoolean) {
    return { type: "boolean", description: `${field.label}: ${field.hint}` };
  }
  if (schema instanceof z.ZodEnum) {
    const values = (schema.options as string[]).map((value) => value === "" ? SITE_DEFAULT_TOKEN : value);
    return { type: "string", enum: values, description: `${field.label}: ${field.hint}` };
  }
  throw new Error(`AI field "${field.key}" uses an unsupported Zod type`);
}

export function planJsonSchema(): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    required: ["interpretedRequest", "changes", "reasons", "confidence"],
    properties: {
      interpretedRequest: { type: "string", maxLength: 200, description: "What you understood the user to want" },
      changes: {
        type: "object",
        additionalProperties: false,
        properties: Object.fromEntries(AI_FIELDS.map((field) => [field.key, fieldJsonSchema(field)])),
        description: "Only the settings that should change; omit everything else",
      },
      reasons: { type: "array", maxItems: 8, items: { type: "string", maxLength: 200 } },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
  };
}

const UNSUPPORTED: Record<SchemaDialect, readonly string[]> = {
  // llama.cpp converts JSON Schema to a grammar and ignores what it cannot express.
  llamacpp: [],
  // Gemini responseJsonSchema accepts JSON Schema; length keywords are ignored anyway.
  gemini: ["maxLength"],
  // Gemini's older OpenAPI-style responseSchema rejects these keywords.
  "gemini-openapi": ["additionalProperties", "maxLength"],
  // Claude structured outputs reject numeric, string-length and array-size constraints.
  anthropic: ["minimum", "maximum", "maxLength", "maxItems", "minItems"],
};

function strip(value: unknown, keys: readonly string[]): unknown {
  if (Array.isArray(value)) return value.map((item) => strip(item, keys));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as JsonSchema)
    // `properties` holds field names, not keywords: never strip its keys.
    .filter(([key]) => !keys.includes(key))
    .map(([key, child]) => [key, key === "properties"
      ? Object.fromEntries(Object.entries(child as JsonSchema).map(([name, sub]) => [name, strip(sub, keys)]))
      : strip(child, keys)]));
}

export function schemaForDialect(schema: JsonSchema, dialect: SchemaDialect): JsonSchema {
  return strip(schema, UNSUPPORTED[dialect]) as JsonSchema;
}
