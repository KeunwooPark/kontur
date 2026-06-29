export function risky(n: number): void {
  try {
    console.log(n);
  } catch (e) {
    console.log(e);
  }
}
