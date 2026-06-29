export function risky(n: number): void {
  if (n < 0) {
    throw new Error("negative");
  }
  console.log(n);
}
