import { route } from "./model";
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
    | "ack-ignored";
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
  nowUs(): number;
  schedule(atUs: number, priority: number, run: () => void): void;
  graph(domainId: number): RoutingGraph;
  physical(
    a: number,
    b: number,
  ): { available: boolean; token: number; delayUs: number };
  receive(ad: DomainAdvertisement, recipient: number): boolean;
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
};
// shortcut: atomic control messages omit serialization and queue contention; add those only for packet-level experiments.
export class ControlTransport {
  readonly events: ControlEvent[] = [];
  private pending = new Map<string, Pending>();
  private flights = new Map<number, ControlFlight>();
  private sequence = 0;
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
      this.attempt(p);
    }
  }
  private emit(type: ControlEvent["type"], f: ControlFlight, reason?: string) {
    if (this.events.length >= CONTROL_EVENT_LIMIT)
      throw new ControlTransportError(
        "제어 사건 한도(100,000건)를 초과했습니다.",
      );
    this.events.push({
      atUs: this.env.nowUs(),
      type,
      messageId: f.messageId,
      kind: f.kind,
      origin: f.origin,
      recipient: f.recipient,
      revision: f.revision,
      attempt: f.attempt,
      path: [...f.path],
      hop: f.hop,
      ...(reason ? { reason } : {}),
    });
    this.stats.eventCount++;
  }
  private attempt(p: Pending) {
    if (p.attempt) this.stats.retries++;
    p.attempt++;
    p.expiresUs = this.env.nowUs() + this.timeoutUs;
    const f = this.send(
      "update",
      p.ad.domainId,
      p.recipient,
      p.ad.revision,
      p.attempt,
      p.expiresUs,
      () => {
        this.stats.deliveredUpdates++;
        const applied = this.env.receive(p.ad, p.recipient);
        if (applied) this.stats.appliedUpdates++;
        this.emit(applied ? "applied" : "duplicate", f);
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
              this.pending.delete(this.key(p.ad.domainId, p.recipient));
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
      f.path = route(
        graph.nodeCount,
        graph.links
          .filter((l) => l.knownAvailable)
          .map((l) => [l.sourceId, l.targetId]),
        this.ds[origin],
        this.ds[recipient],
      );
      if (!f.path.length) {
        this.drop(f, "no-known-route");
        return;
      }
      this.hop(f, delivered);
    });
    return f;
  }
  private drop(f: ControlFlight, reason: string) {
    this.flights.delete(f.messageId);
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
      this.emit("delivered", f);
      delivered();
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
      const current = this.env.physical(a, b);
      if (!current.available || current.token !== observed.token) {
        this.drop(f, "link-interrupted");
        return;
      }
      this.emit("hop-arrived", f);
      f.hop++;
      this.hop(f, delivered);
    });
  }
  view(): ControlView {
    return {
      pending: [...this.pending.values()].map((p) => ({
        origin: p.ad.domainId,
        recipient: p.recipient,
        revision: p.ad.revision,
        attempt: p.attempt,
        messageId: p.messageId,
        expiresUs: p.expiresUs,
      })),
      flights: structuredClone([...this.flights.values()]),
      events: structuredClone(this.events.slice(-24)),
      stats: { ...this.stats },
    };
  }
  exportState() {
    return { ...this.view(), events: structuredClone(this.events) };
  }
}
