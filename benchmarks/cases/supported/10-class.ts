export class Counter {
  count: number;

  increment(): void {
    this.count = (this.count + 1);
  }

  current(): number {
    return this.count;
  }
}
