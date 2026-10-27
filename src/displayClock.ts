// Display time stays within received simulation states; it never advances the engine.
export class DisplayClock {
  private fromUs = 0;
  private toUs = 0;
  private receivedMs = 0;
  at(nowMs: number) {
    const fraction = Math.min(1, Math.max(0, (nowMs - this.receivedMs) / 100));
    return this.fromUs + (this.toUs - this.fromUs) * fraction;
  }
  receive(timeUs: number, nowMs: number, smooth: boolean) {
    this.fromUs = smooth && timeUs >= this.toUs ? this.at(nowMs) : timeUs;
    this.toUs = timeUs;
    this.receivedMs = nowMs;
  }
}
