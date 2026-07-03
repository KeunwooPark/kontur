/**
 * Shared identifier casing for backends. Labels/ids may contain spaces.
 *
 * These must be IDEMPOTENT on already-valid identifiers so a same-language lift →
 * transpile round-trip preserves names exactly: leading/trailing underscore runs
 * are kept verbatim (so a dunder like `__init__` survives), and word tails are NOT
 * lowercased (so an acronym like `HTTPError` / `JSONDecodeError` survives). Only
 * the word-boundary casing the target convention dictates is applied.
 */

function words(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // split camelCase
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

/** Split off leading/trailing underscore runs (kept verbatim) from the core. */
function affix(s: string): { lead: string; core: string; trail: string } {
  const lead = /^_+/.exec(s)?.[0] ?? "";
  const trail = s.length > lead.length ? (/_+$/.exec(s)?.[0] ?? "") : "";
  return { lead, core: s.slice(lead.length, s.length - trail.length), trail };
}

export function camel(s: string): string {
  const { lead, core, trail } = affix(s);
  const w = words(core);
  if (w.length === 0) return s || "_"; // all underscores / empty → verbatim
  return lead + w.map((part, i) => (i === 0 ? part.toLowerCase() : part[0]!.toUpperCase() + part.slice(1))).join("") + trail;
}

export function snake(s: string): string {
  const { lead, core, trail } = affix(s);
  const w = words(core);
  if (w.length === 0) return s || "_";
  return lead + w.map((p) => p.toLowerCase()).join("_") + trail;
}

/** PascalCase — for type/class names (e.g. "user account" → "UserAccount"). */
export function pascal(s: string): string {
  const { lead, core, trail } = affix(s);
  const w = words(core);
  if (w.length === 0) return s || "_";
  return lead + w.map((p) => p[0]!.toUpperCase() + p.slice(1)).join("") + trail;
}
