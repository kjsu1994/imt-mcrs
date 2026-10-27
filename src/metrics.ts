export type RecordEntry = {
  atUs: number;
  type: string;
  linkId?: string;
  path?: number[];
  version?: number;
  outageId?: number;
};
export type LinkFailure = {
  id: number;
  linkId: string;
  startedUs: number;
  restoredUs: number | null;
  detectedUs: number | null;
};
export type ServiceOutage = {
  id: number;
  source: number;
  target: number;
  startedUs: number;
  recoveredUs: number | null;
  detectedUs: number | null;
  reason: "initial-unreachable" | "path-unavailable";
  causeLinkIds: string[];
  previousPath: number[];
  restoredPath: number[];
};
export class MetricsEngine {
  readonly events: RecordEntry[] = [];
  readonly linkFailures: LinkFailure[] = [];
  readonly serviceOutages: ServiceOutage[] = [];
  private openLinks = new Map<string, LinkFailure>();
  private open: ServiceOutage | null = null;
  constructor(
    private source: number,
    private target: number,
  ) {}
  get previousPath() {
    return this.open?.previousPath ?? [];
  }
  record(event: RecordEntry) {
    this.events.push(structuredClone(event));
  }
  failure(atUs: number, linkId: string) {
    const entry: LinkFailure = {
      id: this.linkFailures.length + 1,
      linkId,
      startedUs: atUs,
      restoredUs: null,
      detectedUs: null,
    };
    this.linkFailures.push(entry);
    this.openLinks.set(linkId, entry);
    this.record({ atUs, type: "link-down", linkId });
  }
  linkUp(atUs: number, linkId: string) {
    const entry = this.openLinks.get(linkId);
    if (entry) entry.restoredUs = atUs;
    this.openLinks.delete(linkId);
    this.record({ atUs, type: "link-up", linkId });
  }
  detected(atUs: number, linkId: string) {
    const entry = this.openLinks.get(linkId);
    if (entry) entry.detectedUs = atUs;
    this.record({ atUs, type: "link-detected-down", linkId });
  }
  observe(
    atUs: number,
    path: number[],
    available: boolean,
    missing: string[],
    detected: Set<string>,
  ) {
    if (!available && !this.open) {
      this.open = {
        id: this.serviceOutages.length + 1,
        source: this.source,
        target: this.target,
        startedUs: atUs,
        recoveredUs: null,
        detectedUs: null,
        reason: atUs === 0 ? "initial-unreachable" : "path-unavailable",
        causeLinkIds: [],
        previousPath: [...path],
        restoredPath: [],
      };
      this.serviceOutages.push(this.open);
      this.record({
        atUs,
        type: "service-interrupted",
        outageId: this.open.id,
        path,
      });
    }
    const outage = this.open;
    if (!outage) return;
    for (const id of missing)
      if (!outage.causeLinkIds.includes(id)) outage.causeLinkIds.push(id);
    if (
      outage.detectedUs === null &&
      outage.causeLinkIds.some((id) => detected.has(id))
    )
      outage.detectedUs = atUs;
    if (available) {
      outage.recoveredUs = atUs;
      outage.restoredPath = [...path];
      this.record({
        atUs,
        type: "service-restored",
        outageId: outage.id,
        path,
      });
      this.open = null;
    }
  }
  summary(timeUs: number, completed: boolean, limit = Infinity) {
    // Availability measures [0, timeUs); a new outage exactly at the endpoint has no exposure yet.
    const measured = this.serviceOutages.filter((o) => o.startedUs < timeUs);
    const recovered = measured.filter((o) => o.recoveredUs !== null);
    const totalDowntimeUs = measured.reduce(
      (sum, o) => sum + (o.recoveredUs ?? timeUs) - o.startedUs,
      0,
    );
    const entries = this.serviceOutages
      .slice(limit === Infinity ? 0 : -limit)
      .map((o) => ({
        ...structuredClone(o),
        status:
          o.recoveredUs !== null
            ? "recovered"
            : completed
              ? "unrecovered"
              : "pending",
        durationUs: (o.recoveredUs ?? timeUs) - o.startedUs,
        recoveryUs: o.recoveredUs === null ? null : o.recoveredUs - o.startedUs,
        detectionUs: o.detectedUs === null ? null : o.detectedUs - o.startedUs,
        establishmentUs:
          o.recoveredUs === null || o.detectedUs === null
            ? null
            : o.recoveredUs - o.detectedUs,
      }));
    return {
      outageCount: measured.length,
      initialOutageCount: measured.filter(
        (o) => o.reason === "initial-unreachable",
      ).length,
      totalDowntimeUs,
      availability: timeUs === 0 ? null : 1 - totalDowntimeUs / timeUs,
      recoveredCount: recovered.length,
      unrecoveredCount: completed ? measured.length - recovered.length : 0,
      pendingCount: completed ? 0 : measured.length - recovered.length,
      meanOutageUs: recovered.length
        ? recovered.reduce((sum, o) => sum + o.recoveredUs! - o.startedUs, 0) /
          recovered.length
        : null,
      serviceOutages: entries,
      linkFailures: structuredClone(
        this.linkFailures.slice(limit === Infinity ? 0 : -limit),
      ),
    };
  }
  result(timeUs: number, completed: boolean) {
    return {
      events: structuredClone(this.events),
      ...this.summary(timeUs, completed),
    };
  }
}
