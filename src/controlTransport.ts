import type { RuntimeProfile } from "./performance";
import { makeCsibDelta } from "./csibDelta";
import type { CsibDelta } from "./csibDelta";

import type { RoutingGraph } from "./routing";
import type { DomainAdvertisement } from "./mcsr";

export const CONTROL_EVENT_LIMIT = 100000;
export type ControlSettings = { mode: "fixed" | "isl"; ackTimeoutUs: number };
export type ControlEvent = {
  atUs: number;
  type:
    | "sent"
    | "hop-started"
    | "hop-arrived"
    | "delivered"
    | "applied"
    | "duplicate"
    | "dropped"
    | "expired"
    | "timeout"
    | "acknowledged"
    | "ack-ignored"
    | "resync-requested";
  messageId: number;
  kind: "update" | "ack";
  origin: number;
  recipient: number;
  revision: number;
  attempt: number;
  path: number[];
  hop: number;
  reason?: string;
};
export type ControlFlight = {
  messageId: number;
  kind: "update" | "ack";
  origin: number;
  recipient: number;
  revision: number;
  attempt: number;
  path: number[];
  hop: number;
  departedUs: number;
  arrivesUs: number;
  expiresUs: number;
};
export type ControlView = {
  payloadStats?: {
    deltas: number;
    checkpoints: number;
    resyncRequests: number;
  };
  pendingTotal?: number;
  flightsTotal?: number;
  traceOmitted?: number;
  flightOmitted?: number;
  focusDomain?: number;
  pending: {
    origin: number;
    recipient: number;
    revision: number;
    attempt: number;
    messageId: number;
    expiresUs: number;
  }[];
  flights: ControlFlight[];
  events: ControlEvent[];
  stats: {
    sentUpdates: number;
    sentAcks: number;
    deliveredUpdates: number;
    appliedUpdates: number;
    deliveredAcks: number;
    acknowledged: number;
    retries: number;
    dropped: number;
    expired: number;
    eventCount: number;
  };
};
export interface ControlEnvironment {
  profile?: RuntimeProfile;
  physicalState?(a: number, b: number): { available: boolean; token: number };
  nowUs(): number;
  schedule(atUs: number, priority: number, run: () => void): void;
  graph(domainId: number): RoutingGraph;
  availabilityKey?(domainId: number): string;
  physical(
    a: number,
    b: number,
  ): { available: boolean; token: number; delayUs: number };
  receive(ad: DomainAdvertisement, recipient: number): boolean;
  receiveDelta?(delta: CsibDelta, recipient: number): boolean | null;
  initialAdvertisement?(domainId: number): DomainAdvertisement;
}
export class ControlTransportError extends Error {
  readonly code = "control-event-limit";
}
type Pending = {
  ad: DomainAdvertisement;
  recipient: number;
  attempt: number;
  messageId: number;
  expiresUs: number;
  forceCheckpoint?: boolean;
};
// shortcut: atomic control messages omit serialization and queue contention; add those only for packet-level experiments.
export class ControlTransport {
  private records: ControlEvent[] = [];
  get events(): ControlEvent[] {
    return structuredClone(this.records);
  }
  private acknowledgedAds = new Map<string, DomainAdvertisement>();
  private payloadStats = { deltas: 0, checkpoints: 0, resyncRequests: 0 };
  private focusedPending = new Set<string>();
  private focusedFlights = new Set<number>();
  private pending = new Map<string, Pending>();
  private flights = new Map<number, ControlFlight>();
  private sequence = 0;
  displayRevision = 0;
  traceOmitted = 0;
  private recent: ControlEvent[] = [];
  private trees = new Map<number, { signature: string; parents: Int32Array }>();
  private stats: ControlView["stats"] = {
    sentUpdates: 0,
    sentAcks: 0,
    deliveredUpdates: 0,
    appliedUpdates: 0,
    deliveredAcks: 0,
    acknowledged: 0,
    retries: 0,
    dropped: 0,
    expired: 0,
    eventCount: 0,
  };
  constructor(
    private ds: number[],
    private processingUs: number,
    private timeoutUs: number,
    private env: ControlEnvironment,
    private limits?: {
      eventLimit: number;
      traceLimit: number;
      focusDomain: number;
    },
  ) {
    if (
      !ds.length ||
      new Set(ds).size !== ds.length ||
      !Number.isSafeInteger(processingUs) ||
      processingUs < 0 ||
      !Number.isSafeInteger(timeoutUs) ||
      timeoutUs < 1
    )
      throw new Error("잘못된 제어 통신 설정입니다.");
  }
  setFocusDomain(domain: number) {
    if (this.limits && this.limits.focusDomain !== domain) {
      this.limits.focusDomain = domain;
      this.displayRevision++;
    }
  }
  private key(origin: number, recipient: number) {
    return `${origin}:${recipient}`;
  }
  publish(ad: DomainAdvertisement) {
    for (let recipient = 0; recipient < this.ds.length; recipient++) {
      if (recipient === ad.domainId) continue;
      const key = this.key(ad.domainId, recipient),
        previous = this.pending.get(key);
      if (previous && previous.ad.revision >= ad.revision) continue;
      const p: Pending = {
        ad,
        recipient,
        attempt: 0,
        messageId: 0,
        expiresUs: 0,
      };
      this.pending.set(key, p);
      if (
        this.limits &&
        (ad.domainId === this.limits.focusDomain ||
          recipient === this.limits.focusDomain)
      )
        this.focusedPending.add(key);
      this.attempt(p);
    }
  }
  private emit(type: ControlEvent["type"], f: ControlFlight, reason?: string) {
    if (
      this.stats.eventCount >= (this.limits?.eventLimit ?? CONTROL_EVENT_LIMIT)
    )
      throw new ControlTransportError(
        `제어 사건 한도(${(this.limits?.eventLimit ?? CONTROL_EVENT_LIMIT).toLocaleString("en-US")}건)를 초과했습니다.`,
      );
    const event: ControlEvent = {
      atUs: this.env.nowUs(),
      type,
      messageId: f.messageId,
      kind: f.kind,
      origin: f.origin,
      recipient: f.recipient,
      revision: f.revision,
      attempt: f.attempt,
      path: f.path,
      hop: f.hop,
      ...(reason ? { reason } : {}),
    };
    this.env.profile?.count(`control.records.${type}`);
    this.records.push(event);
    if (this.limits && this.records.length > this.limits.traceLimit) {
      const removed = Math.max(1, Math.floor(this.limits.traceLimit / 10));
      this.records.splice(0, removed);
      this.traceOmitted += removed;
    }
    if (
      !this.limits ||
      f.origin === this.limits.focusDomain ||
      f.recipient === this.limits.focusDomain
    ) {
      this.displayRevision++;
      this.recent.push(event);
      if (this.recent.length > 24) this.recent.shift();
    }
    this.stats.eventCount++;
  }
  private attempt(p: Pending) {
    this.env.profile?.enter(
      p.attempt ? "control.retry" : "control.publishUpdate",
    );
    try {
      this.attemptImpl(p);
    } finally {
      this.env.profile?.leave();
    }
  }
  private attemptImpl(p: Pending) {
    if (p.attempt) this.stats.retries++;
    p.attempt++;
    p.expiresUs = this.env.nowUs() + this.timeoutUs;
    const baseline =
      this.acknowledgedAds.get(this.key(p.ad.domainId, p.recipient)) ??
      this.env.initialAdvertisement?.(p.ad.domainId);
    this.env.profile?.enter("csib.delta");
    let delta: CsibDelta | undefined;
    try {
      delta =
        this.limits &&
        this.env.receiveDelta &&
        baseline?.links &&
        p.ad.links &&
        baseline.revision < p.ad.revision &&
        !p.forceCheckpoint
          ? makeCsibDelta(baseline, p.ad)
          : undefined;
    } finally {
      this.env.profile?.leave();
    }
    if (this.limits) {
      if (delta) this.payloadStats.deltas++;
      else this.payloadStats.checkpoints++;
    }
    const f = this.send(
      "update",
      p.ad.domainId,
      p.recipient,
      p.ad.revision,
      p.attempt,
      p.expiresUs,
      () => {
        this.stats.deliveredUpdates++;
        const applied = delta
          ? this.env.receiveDelta!(delta, p.recipient)
          : this.env.receive(p.ad, p.recipient);
        const resync = applied === null;
        if (resync) this.payloadStats.resyncRequests++;
        if (applied) this.stats.appliedUpdates++;
        this.emit(
          resync ? "resync-requested" : applied ? "applied" : "duplicate",
          f,
          resync ? "csib-base-mismatch" : undefined,
        );
        const ack = this.send(
          "ack",
          p.recipient,
          p.ad.domainId,
          p.ad.revision,
          f.attempt,
          f.expiresUs,
          () => {
            this.stats.deliveredAcks++;
            const current = this.pending.get(
              this.key(p.ad.domainId, p.recipient),
            );
            if (current === p && current.messageId === f.messageId) {
              if (resync) {
                p.forceCheckpoint = true;
                this.attempt(p);
                return;
              }
              this.acknowledgedAds.set(
                this.key(p.ad.domainId, p.recipient),
                p.ad,
              );
              this.pending.delete(this.key(p.ad.domainId, p.recipient));
              this.focusedPending.delete(this.key(p.ad.domainId, p.recipient));
              this.stats.acknowledged++;
              this.emit("acknowledged", ack);
            } else this.emit("ack-ignored", ack, "superseded-attempt");
          },
        );
      },
    );
    p.messageId = f.messageId;
    this.env.schedule(f.expiresUs, 2.35, () => {
      if (
        this.pending.get(this.key(p.ad.domainId, p.recipient)) !== p ||
        p.messageId !== f.messageId
      )
        return;
      this.emit("timeout", f, "ack-timeout");
      this.attempt(p);
    });
  }
  private send(
    kind: ControlFlight["kind"],
    origin: number,
    recipient: number,
    revision: number,
    attempt: number,
    expiresUs: number,
    delivered: () => void,
  ): ControlFlight {
    this.env.profile?.enter("control.generate");
    try {
      return this.sendImpl(
        kind,
        origin,
        recipient,
        revision,
        attempt,
        expiresUs,
        delivered,
      );
    } finally {
      this.env.profile?.leave();
    }
  }
  private sendImpl(
    kind: ControlFlight["kind"],
    origin: number,
    recipient: number,
    revision: number,
    attempt: number,
    expiresUs: number,
    delivered: () => void,
  ): ControlFlight {
    const f: ControlFlight = {
      messageId: ++this.sequence,
      kind,
      origin,
      recipient,
      revision,
      attempt,
      expiresUs,
      path: [],
      hop: 0,
      departedUs: this.env.nowUs(),
      arrivesUs: this.env.nowUs() + this.processingUs,
    };
    this.flights.set(f.messageId, f);
    if (
      this.limits &&
      (origin === this.limits.focusDomain ||
        recipient === this.limits.focusDomain)
    )
      this.focusedFlights.add(f.messageId);
    if (kind === "update") this.stats.sentUpdates++;
    else this.stats.sentAcks++;
    this.emit("sent", f);
    this.env.schedule(expiresUs, 2.35, () => {
      if (this.flights.has(f.messageId)) this.drop(f, "expired");
    });
    this.env.schedule(f.arrivesUs, 2.3, () => {
      if (!this.flights.has(f.messageId) || this.env.nowUs() > expiresUs)
        return;
      const graph = this.env.graph(origin);
      f.path = this.path(graph, origin, this.ds[recipient]);
      if (!f.path.length) {
        this.drop(f, "no-known-route");
        return;
      }
      this.hop(f, delivered);
    });
    return f;
  }
  private path(graph: RoutingGraph, origin: number, target: number) {
    const signature =
      this.env.availabilityKey?.(origin) ??
      graph.links
        .filter((l) => l.knownAvailable)
        .map((l) => l.id)
        .join("|");
    let tree = this.trees.get(origin);
    if (!tree || tree.signature !== signature) {
      this.env.profile?.count("control.path.cacheMisses");
      const adjacency: number[][] = Array.from(
        { length: graph.nodeCount },
        () => [],
      );
      for (const l of graph.links)
        if (l.knownAvailable) {
          adjacency[l.sourceId].push(l.targetId);
          adjacency[l.targetId].push(l.sourceId);
        }
      const parents = new Int32Array(graph.nodeCount).fill(-1),
        queue = [this.ds[origin]];
      parents[queue[0]] = queue[0];
      for (let i = 0; i < queue.length; i++)
        for (const n of adjacency[queue[i]])
          if (parents[n] === -1) {
            parents[n] = queue[i];
            queue.push(n);
          }
      tree = { signature, parents };
      this.trees.set(origin, tree);
    } else this.env.profile?.count("control.path.cacheHits");
    if (tree.parents[target] === -1) return [];
    const path = [target];
    while (path.at(-1)! !== this.ds[origin])
      path.push(tree.parents[path.at(-1)!]);
    return path.reverse();
  }
  private drop(f: ControlFlight, reason: string) {
    this.flights.delete(f.messageId);
    this.focusedFlights.delete(f.messageId);
    this.stats.dropped++;
    if (reason === "expired") this.stats.expired++;
    this.emit(reason === "expired" ? "expired" : "dropped", f, reason);
  }
  private hop(f: ControlFlight, delivered: () => void) {
    if (!this.flights.has(f.messageId)) return;
    if (this.env.nowUs() > f.expiresUs) {
      this.drop(f, "expired");
      return;
    }
    if (f.hop === f.path.length - 1) {
      this.flights.delete(f.messageId);
      this.focusedFlights.delete(f.messageId);
      this.emit("delivered", f);
      this.env.profile?.enter(
        f.kind === "ack" ? "control.ack" : "control.receiveUpdate",
      );
      try {
        delivered();
      } finally {
        this.env.profile?.leave();
      }
      return;
    }
    const a = f.path[f.hop],
      b = f.path[f.hop + 1],
      observed = this.env.physical(a, b);
    if (!observed.available) {
      this.drop(f, "link-unavailable");
      return;
    }
    if (!Number.isSafeInteger(observed.delayUs) || observed.delayUs < 1)
      throw new Error("제어 홉 지연은 양의 정수여야 합니다.");
    f.departedUs = this.env.nowUs();
    f.arrivesUs = f.departedUs + observed.delayUs;
    this.emit("hop-started", f);
    this.env.schedule(f.arrivesUs, 2.3, () => {
      if (!this.flights.has(f.messageId) || this.env.nowUs() > f.expiresUs)
        return;
      const current = this.env.physicalState?.(a, b) ?? this.env.physical(a, b);
      if (!current.available || current.token !== observed.token) {
        this.drop(f, "link-interrupted");
        return;
      }
      this.emit("hop-arrived", f);
      f.hop++;
      this.hop(f, delivered);
    });
  }
  view(copy = true): ControlView {
    const pending = this.limits
      ? [...this.focusedPending].map((key) => this.pending.get(key)!)
      : [...this.pending.values()];
    const flights = this.limits
      ? [...this.focusedFlights].map((id) => this.flights.get(id)!)
      : [...this.flights.values()];
    const result = {
      ...(this.limits
        ? {
            payloadStats: { ...this.payloadStats },
            pendingTotal: this.pending.size,
            flightsTotal: this.flights.size,
            traceOmitted: this.traceOmitted,
            flightOmitted: Math.max(0, flights.length - 256),
            focusDomain: this.limits.focusDomain,
          }
        : {}),
      pending: pending.map((p) => ({
        origin: p.ad.domainId,
        recipient: p.recipient,
        revision: p.ad.revision,
        attempt: p.attempt,
        messageId: p.messageId,
        expiresUs: p.expiresUs,
      })),
      flights: (this.limits ? flights.slice(-256) : flights).map((f) => ({
        ...f,
      })),
      events: [...this.recent],
      stats: { ...this.stats },
    };
    return copy ? structuredClone(result) : result;
  }
  exportState() {
    return {
      ...this.view(),
      events: structuredClone(this.records),
      ...(this.limits
        ? {
            traceOmitted: this.traceOmitted,
            flightsAll: structuredClone([...this.flights.values()]),
            pendingAll: [...this.pending.values()].map((p) => ({
              origin: p.ad.domainId,
              recipient: p.recipient,
              revision: p.ad.revision,
              attempt: p.attempt,
              messageId: p.messageId,
              expiresUs: p.expiresUs,
            })),
          }
        : {}),
    };
  }
}
