export function risky(n: number): void {
  if (n < 0) {
    throw new TypeError("negative");
  }
  console.log(n);
}
