import type { RuntimeProfile } from "./performance";
export type WorkerPerformance = {
  constructorMs: number;
  eventsPerActiveSecond: number | null;
  activeMs: number;
  maxSliceMs: number;
  pumps: number;
  commands: number;
  maxCommandLatencyMs: number;
  engine: ReturnType<RuntimeProfile["report"]> | null;
};
export class FrameSamples {
  private intervals: number[] = [];
  private updates: number[] = [];
  private renders: number[] = [];
  private previous = 0;
  private count = 0;
  sample(now: number, updateMs: number, renderMs: number) {
    const i = this.count++ % 600;
    if (this.previous) this.intervals[i] = now - this.previous;
    this.previous = now;
    this.updates[i] = updateMs;
    this.renders[i] = renderMs;
  }
  report() {
    const p95 = (values: number[]) =>
      [...values].sort((a, b) => a - b)[
        Math.max(0, Math.ceil(values.length * 0.95) - 1)
      ] ?? 0;
    const intervals = this.intervals.filter(Number.isFinite);
    return {
      frames: this.count,
      windowFrames: this.updates.length,
      fps: intervals.length
        ? (1000 * intervals.length) / intervals.reduce((a, b) => a + b, 0)
        : 0,
      frameP95Ms: p95(intervals),
      updateP95Ms: p95(this.updates),
      renderSubmissionP95Ms: p95(this.renders),
    };
  }
}
declare global {
  interface Window {
    __mcsrPerformance?: {
      renderer?: ReturnType<FrameSamples["report"]>;
      worker?: WorkerPerformance;
    };
  }
}
