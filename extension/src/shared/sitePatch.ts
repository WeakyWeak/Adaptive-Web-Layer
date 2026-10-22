// ─── Plan changes ↔ site rules ───────────────────────────────────────────────
// Preview and Apply share one function: preview resolves a patched copy of the
// settings in memory, Apply saves the same copy. Undo restores the previous rule.

import { AI_FIELDS, aiField, type PlanChanges, type SettingsGroup } from "./aiFields";
import {
  MAX_SAVED_SELECTORS,
  matchingSiteRule,
  normalizeHostname,
  resolveAppearance,
  resolveFocus,
  resolveMotion,
  resolveTypography,
  SiteRuleSchema,
  type Settings,
  type SiteRule,
} from "./settings";

function emptyRule(hostname: string): SiteRule {
  return SiteRuleSchema.parse({ hostname });
}

/** Returns settings whose site rule for `hostname` includes `changes`. */
export function withSitePatch(settings: Settings, hostname: string, changes: PlanChanges): Settings {
  const host = normalizeHostname(hostname);
  const current = matchingSiteRule(settings, host);
  // A subdomain-wide rule stays untouched; the patch becomes an exact-host rule.
  const base = current && normalizeHostname(current.hostname) === host ? current : { ...(current ?? emptyRule(host)), hostname: host, includeSubdomains: false };
  const grouped: Record<SettingsGroup, Record<string, unknown>> = { typography: {}, appearance: {}, focus: {}, motion: {} };
  for (const [key, value] of Object.entries(changes)) {
    const field = aiField(key);
    if (field) grouped[field.group][key] = value;
  }
  const rule: SiteRule = {
    ...base,
    typography: { ...base.typography, ...grouped.typography },
    appearance: { ...base.appearance, ...grouped.appearance },
    focus: { ...(base.focus ?? {}), ...grouped.focus },
    motion: { ...(base.motion ?? {}), ...grouped.motion },
  };
  return { ...settings, siteRules: [...settings.siteRules.filter((item) => normalizeHostname(item.hostname) !== host), rule] };
}

/** Selector lists for the three element operations. */
export interface SiteElements {
  hide: string[];
  dim: string[];
  highlight: string[];
}

const SELECTOR_FIELDS = { hide: "hiddenSelectors", dim: "dimSelectors", highlight: "highlightSelectors" } as const;

/**
 * Returns settings whose exact-host rule also hides/dims/highlights `elements`.
 * The preview passes marker selectors, Apply passes saved selectors: one path.
 * Lists start from the resolved value so a profile's selectors are kept.
 */
export function withSiteElements(settings: Settings, hostname: string, elements: SiteElements): Settings {
  const host = normalizeHostname(hostname);
  if (!elements.hide.length && !elements.dim.length && !elements.highlight.length) return settings;
  const resolved = resolveFocus(settings, host);
  const patched = withSitePatch(settings, host, {});
  const rule = exactSiteRule(patched, host)!;
  const focus = { ...(rule.focus ?? {}) };
  for (const [action, field] of Object.entries(SELECTOR_FIELDS) as Array<[keyof SiteElements, typeof SELECTOR_FIELDS[keyof SiteElements]]>) {
    if (!elements[action].length) continue;
    focus[field] = [...new Set([...(rule.focus?.[field] ?? resolved[field]), ...elements[action]])].slice(0, MAX_SAVED_SELECTORS);
  }
  return { ...patched, siteRules: patched.siteRules.map((item) => item === rule ? { ...rule, focus } : item) };
}

/** Saved element selectors in effect on a site (hide + dim + highlight). */
export function savedSiteSelectors(settings: Settings, hostname: string): string[] {
  const focus = resolveFocus(settings, hostname);
  return [...new Set([...focus.hiddenSelectors, ...focus.dimSelectors, ...focus.highlightSelectors])];
}

/** Remove selectors that no longer match anything, from the exact-host rule. */
export function pruneSiteSelectors(settings: Settings, hostname: string, stale: readonly string[]): Settings {
  const host = normalizeHostname(hostname);
  const resolved = resolveFocus(settings, host);
  const patched = withSitePatch(settings, host, {});
  const rule = exactSiteRule(patched, host)!;
  const focus = { ...(rule.focus ?? {}) };
  for (const field of Object.values(SELECTOR_FIELDS)) {
    const current = rule.focus?.[field] ?? resolved[field];
    if (current.some((selector) => stale.includes(selector))) focus[field] = current.filter((selector) => !stale.includes(selector));
  }
  return { ...patched, siteRules: patched.siteRules.map((item) => item === rule ? { ...rule, focus } : item) };
}

/** Put back the exact-host rule captured before an Apply (undefined = no rule). */
export function restoreSiteRule(settings: Settings, hostname: string, previous: SiteRule | undefined): Settings {
  const host = normalizeHostname(hostname);
  const others = settings.siteRules.filter((item) => normalizeHostname(item.hostname) !== host);
  return { ...settings, siteRules: previous ? [...others, previous] : others };
}

export function exactSiteRule(settings: Settings, hostname: string): SiteRule | undefined {
  const host = normalizeHostname(hostname);
  return settings.siteRules.find((rule) => normalizeHostname(rule.hostname) === host);
}

/** Current resolved value of every AI field, so models can make relative changes. */
export function currentAiValues(settings: Settings, hostname: string): Record<string, string | number | boolean> {
  const resolved: Record<SettingsGroup, Record<string, unknown>> = {
    typography: resolveTypography(settings, hostname),
    appearance: resolveAppearance(settings, hostname),
    focus: resolveFocus(settings, hostname),
    motion: resolveMotion(settings, hostname),
  };
  return Object.fromEntries(AI_FIELDS.map((field) => [field.key, resolved[field.group][field.key] as string | number | boolean]));
}
