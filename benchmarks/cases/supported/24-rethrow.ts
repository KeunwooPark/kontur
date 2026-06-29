export function risky(n: number): void {
  try {
    console.log(n);
  } catch (e) {
    throw e;
  }
}
