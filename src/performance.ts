export type ProfileMode = "off" | "light" | "detail";
export interface ExecutionOptions {
  profile?: ProfileMode;
  render?: boolean;
}
type Scope = { calls: number; inclusiveMs: number; exclusiveMs: number };
// Wall time only: this observer never schedules or timestamps simulation events.
export class RuntimeProfile {
  readonly counters: Record<string, number> = {};
  private scopes: Record<string, Scope> = {};
  private names: string[] = [];
  private starts: number[] = [];
  private children: number[] = [];
  private depth = 0;
  constructor(readonly mode: Exclude<ProfileMode, "off">) {}
  enter(name: string) {
    const i = this.depth++;
    this.names[i] = name;
    this.children[i] = 0;
    this.starts[i] = performance.now();
  }
  leave() {
    const elapsed = performance.now() - this.starts[--this.depth];
    const name = this.names[this.depth];
    const scope = (this.scopes[name] ??= {
      calls: 0,
      inclusiveMs: 0,
      exclusiveMs: 0,
    });
    scope.calls++;
    scope.inclusiveMs += elapsed;
    scope.exclusiveMs += elapsed - this.children[this.depth];
    if (this.depth) this.children[this.depth - 1] += elapsed;
  }
  count(name: string, amount = 1) {
    this.counters[name] = (this.counters[name] ?? 0) + amount;
  }
  maximum(name: string, value: number) {
    this.counters[name] = Math.max(this.counters[name] ?? 0, value);
  }
  report() {
    return {
      mode: this.mode,
      scopes: structuredClone(this.scopes),
      counters: { ...this.counters },
    };
  }
}
