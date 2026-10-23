import type { ApplyContext, ApplyResult, Revert } from "../shared/registry";

/** Set (or remove, with null) one style-layer entry; the revert puts the previous value back. */
export function setStyleEntry(ctx: ApplyContext, id: string, value: string | null, restore?: () => void): ApplyResult {
  const previous = ctx.styleLayer.get(id);
  if (value === null) ctx.styleLayer.remove(id); else ctx.styleLayer.set(id, value);
  const revert: Revert = () => {
    if (previous === undefined) ctx.styleLayer.remove(id); else ctx.styleLayer.set(id, previous);
    restore?.();
  };
  return { ok: true, revert };
}
