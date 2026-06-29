export function process(raw: number): number {
  const cleaned = sanitize(raw);
  const scaled = normalize(cleaned);
  return scaled;
}
