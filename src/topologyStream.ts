import { applyMcsr } from "./mcsrStream";
import type { LinkState, RenderCheckpoint, TopologyDelta } from "./engine";

export class TopologyStream {
  generation = 0;
  private received: RenderCheckpoint | null = null;
  private latest = new Map<string, LinkState>();
  private visible = new Map<string, LinkState>();
  private displayed: RenderCheckpoint | null = null;
  private pending: TopologyDelta[] = [];
  reset(checkpoint: RenderCheckpoint) {
    this.received = structuredClone(checkpoint);
    this.latest = new Map(checkpoint.links.map((l) => [l.id, { ...l }]));
    this.visible = new Map(checkpoint.links.map((l) => [l.id, { ...l }]));
    this.displayed = structuredClone(checkpoint);
    this.pending = [];
    this.generation++;
  }
  receive(deltas: TopologyDelta[]) {
    if (!this.received) throw new Error("초기 토폴로지가 없습니다.");
    let revision = this.received.stateRevision,
      time = this.received.timeUs;
    for (const d of deltas) {
      if (
        d.stateRevision !== ++revision ||
        d.timeUs < time ||
        !Number.isSafeInteger(d.timeUs)
      )
        throw new Error(
          "토폴로지 변경분이 누락되었거나 순서가 잘못되었습니다.",
        );
      time = d.timeUs;
      for (const link of d.changedLinks)
        if (
          !this.latest.has(link.id) ||
          [link.physical, link.known, link.forced].some(
            (v) => typeof v !== "boolean",
          )
        )
          throw new Error("잘못된 링크 변경분입니다.");
    }
    for (const d of deltas) {
      for (const link of d.changedLinks)
        this.latest.set(link.id, { ...this.latest.get(link.id)!, ...link });
      this.received = {
        ...this.received,
        ...d.route,
        ...(d.analysis ? { analysis: d.analysis } : {}),
        ...(d.mcsr
          ? { mcsr: d.mcsr }
          : d.mcsrDelta
            ? { mcsr: applyMcsr(this.received.mcsr, d.mcsrDelta) }
            : {}),
        timeUs: d.timeUs,
        stateRevision: d.stateRevision,
        version: d.version,
      };
      this.pending.push(d);
    }
  }
  matches(checkpoint: RenderCheckpoint) {
    if (
      !this.received ||
      checkpoint.stateRevision !== this.received.stateRevision ||
      checkpoint.links.length !== this.latest.size ||
      checkpoint.version !== this.received.version ||
      JSON.stringify(checkpoint.mcsr) !== JSON.stringify(this.received.mcsr) ||
      checkpoint.analysis.id !== this.received.analysis.id ||
      checkpoint.analysis.status !== this.received.analysis.status ||
      checkpoint.pathValid !== this.received.pathValid ||
      checkpoint.path.join(":") !== this.received.path.join(":")
    )
      return false;
    return checkpoint.links.every((l) => {
      const current = this.latest.get(l.id);
      return (
        current &&
        current.a === l.a &&
        current.b === l.b &&
        current.physical === l.physical &&
        current.known === l.known &&
        current.forced === l.forced
      );
    });
  }
  at(timeUs: number) {
    if (!this.displayed) return null;
    let consumed = 0,
      changed = false;
    for (const d of this.pending) {
      if (d.timeUs > timeUs) break;
      for (const link of d.changedLinks)
        this.visible.set(link.id, { ...this.visible.get(link.id)!, ...link });
      this.displayed = {
        ...this.displayed,
        ...d.route,
        ...(d.analysis ? { analysis: d.analysis } : {}),
        ...(d.mcsr
          ? { mcsr: d.mcsr }
          : d.mcsrDelta
            ? { mcsr: applyMcsr(this.displayed.mcsr, d.mcsrDelta) }
            : {}),
        stateRevision: d.stateRevision,
        version: d.version,
      };
      changed ||= d.changedLinks.length > 0;
      consumed++;
    }
    if (consumed) this.pending.splice(0, consumed);
    if (changed) this.displayed.links = [...this.visible.values()];
    this.displayed.timeUs = timeUs;
    return this.displayed;
  }
  get latestMcsr() {
    return this.received?.mcsr;
  }
  get pendingCount() {
    return this.pending.length;
  }
}
