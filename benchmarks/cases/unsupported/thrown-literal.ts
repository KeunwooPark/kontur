export function risky(n: number): void {
  if (n < 0) {
    throw "negative";
  }
  console.log(n);
}
