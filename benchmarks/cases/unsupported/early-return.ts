export function classify(x: number): string {
  if ((x < 0)) {
    return "neg";
  } else {
    return "pos";
  }
}
