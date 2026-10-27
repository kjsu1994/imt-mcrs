export type RecordEntry = {
  atUs: number;
  type: string;
  linkId?: string;
  path?: number[];
  version?: number;
};
export type Recovery = {
  id: number;
  linkId: string;
  failureUs: number;
  detectedUs: number | null;
  recoveredUs: number | null;
  affected: boolean;
};
export class MetricsEngine {
  readonly events: RecordEntry[] = [];
  readonly recoveries: Recovery[] = [];
  record(event: RecordEntry) {
    this.events.push(structuredClone(event));
  }
  failure(atUs: number, linkId: string, affected: boolean) {
    this.record({ atUs, type: "link-down", linkId });
    this.recoveries.push({
      id: this.recoveries.length + 1,
      linkId,
      failureUs: atUs,
      detectedUs: null,
      recoveredUs: null,
      affected,
    });
  }
  detected(atUs: number, linkId: string) {
    this.record({ atUs, type: "link-detected-down", linkId });
    const entry = [...this.recoveries]
      .reverse()
      .find((r) => r.linkId === linkId && r.detectedUs === null);
    if (entry) entry.detectedUs = atUs;
  }
  restored(atUs: number) {
    for (const r of this.recoveries)
      if (r.affected && r.recoveredUs === null) {
        r.recoveredUs = atUs;
        this.record({ atUs, type: "service-restored", linkId: r.linkId });
      }
  }
  result(completed: boolean) {
    return { events: structuredClone(this.events), ...this.summary(completed) };
  }
  summary(completed: boolean) {
    const recoveries = this.recoveries.map((r) => ({
      ...r,
      status: !r.affected
        ? "unaffected"
        : r.recoveredUs !== null
          ? "recovered"
          : completed
            ? "unrecovered"
            : "pending",
      detectionUs: r.detectedUs === null ? null : r.detectedUs - r.failureUs,
      recoveryUs: r.recoveredUs === null ? null : r.recoveredUs - r.failureUs,
      establishmentUs:
        r.recoveredUs === null || r.detectedUs === null
          ? null
          : r.recoveredUs - r.detectedUs,
    }));
    const recovered = recoveries.filter(
      (r) => r.affected && r.recoveryUs !== null,
    );
    return {
      recoveries,
      meanRecoveryUs: recovered.length
        ? recovered.reduce((s, r) => s + r.recoveryUs!, 0) / recovered.length
        : null,
    };
  }
}
