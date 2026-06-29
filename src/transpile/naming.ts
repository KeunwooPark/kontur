/** Shared identifier casing for backends. Labels/ids may contain spaces. */

function words(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // split camelCase
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

export function camel(s: string): string {
  const w = words(s);
  if (w.length === 0) return "_";
  return w
    .map((part, i) => (i === 0 ? part.toLowerCase() : part[0]!.toUpperCase() + part.slice(1).toLowerCase()))
    .join("");
}

export function snake(s: string): string {
  const w = words(s);
  if (w.length === 0) return "_";
  return w.map((p) => p.toLowerCase()).join("_");
}
