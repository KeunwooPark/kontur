export function double(x: number): number {
  return (x + x);
}

export function quadruple(x: number): number {
  const doubled = double(x);
  const result = double(doubled);
  return result;
}
