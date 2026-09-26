// @ts-nocheck
export class LatestTask {
  private sequence = 0;
  begin(): number {
    return ++this.sequence;
  }
  current(token: number): boolean {
    return token === this.sequence;
  }
  cancel(): void {
    this.sequence++;
  }
}
