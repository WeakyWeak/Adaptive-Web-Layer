import { z } from "zod";

// ─── Revert handle ────────────────────────────────────────────────────────────
export interface Revert {
  /** Restore the page to exactly the state before apply() was called. */
  (): void;
}

// ─── Apply context ────────────────────────────────────────────────────────────
export interface ApplyContext {
  /** The managed stylesheet layer for this content script. */
  styleLayer: StyleLayer;
  /** Whether to apply to the whole page (body) vs content region only. */
  applyToWholePage: boolean;
}

export type OperationTarget = "prose" | "content-region";

// ─── Managed style layer interface ───────────────────────────────────────────
// Implemented in content/styleLayer.ts; used here as an interface
// so the registry does not depend on DOM APIs at import time.
export interface StyleLayer {
  /** Set a CSS rule for an operation. Overwrites any previous rule for that id. */
  set(opId: string, css: string): void;
  /** Read a current rule so an operation can restore it exactly. */
  get(opId: string): string | undefined;
  /** Remove the rule for an operation. */
  remove(opId: string): void;
  /** Remove all rules. */
  clear(): void;
}

// ─── Operation descriptor ─────────────────────────────────────────────────────
export interface Operation<TParams> {
  /** Unique string id used as the storage key in the managed stylesheet. */
  id: string;
  /** Human-readable label for UI. */
  label: string;
  /** The kind of page region this operation styles. */
  target: OperationTarget;
  /** Elements and descendants excluded from this operation. */
  protectedElements: readonly string[];
  /** Zod schema with bounds. */
  paramsSchema: z.ZodType<TParams>;
  /**
   * Apply the operation. Must return a Revert function that undoes exactly what
   * apply() did. Must not throw; return an error result instead.
   */
  apply(ctx: ApplyContext, params: TParams): ApplyResult;
  /**
   * Validate params + optional DOM snapshot context.
   * Returns null if valid, or a typed error string if not.
   */
  validate(params: TParams, snapshot?: unknown): string | null;
}

// ─── Apply result ─────────────────────────────────────────────────────────────
export type ApplyResult =
  | { ok: true; revert: Revert }
  | { ok: false; error: string };

// ─── Registry ─────────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _registry = new Map<string, Operation<any>>();

export function registerOperation<TParams>(op: Operation<TParams>): void {
  if (_registry.has(op.id)) {
    console.warn(`[AWL registry] duplicate operation id: ${op.id}`);
    return;
  }
  _registry.set(op.id, op);
}

export function getOperation(id: string): Operation<unknown> | undefined {
  return _registry.get(id);
}

export function listOperations(): ReadonlyArray<Operation<unknown>> {
  return Array.from(_registry.values());
}

// ─── Apply a plan step ───────────────────────────────────────────────────────
export interface PlanStep {
  opId: string;
  params: unknown;
}

export function applyStep(ctx: ApplyContext, step: PlanStep): ApplyResult {
  const op = getOperation(step.opId);
  if (!op) return { ok: false, error: `Unknown operation: ${step.opId}` };

  const parsed = op.paramsSchema.safeParse(step.params);
  if (!parsed.success) {
    return { ok: false, error: `Invalid params for ${step.opId}: ${parsed.error.message}` };
  }

  const validationError = op.validate(parsed.data);
  if (validationError !== null) {
    return { ok: false, error: `Validation failed for ${step.opId}: ${validationError}` };
  }

  try {
    return op.apply(ctx, parsed.data);
  } catch (error) {
    return { ok: false, error: `Apply failed for ${step.opId}: ${String(error)}` };
  }
}

// ─── Apply a full plan ────────────────────────────────────────────────────────
// Returns a single combined Revert that reverts all steps in reverse order.
export function applyPlan(
  ctx: ApplyContext,
  steps: PlanStep[]
): { ok: true; revert: Revert; errors: string[] } {
  const reverts: Revert[] = [];
  const errors: string[] = [];

  for (const step of steps) {
    const result = applyStep(ctx, step);
    if (result.ok) {
      reverts.push(result.revert);
    } else {
      errors.push(result.error);
      console.warn("[AWL registry] step failed:", result.error);
    }
  }

  const revert: Revert = () => {
    for (const r of [...reverts].reverse()) {
      try {
        r();
      } catch (e) {
        console.warn("[AWL registry] revert error:", e);
      }
    }
  };

  return { ok: true, revert, errors };
}
