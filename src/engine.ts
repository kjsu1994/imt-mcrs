import { GroundAccess, GroundMetrics, validateGround } from "./ground";
import type { GroundSettings, GroundView } from "./ground";
import { diffMcsr } from "./mcsrStream";
import type { McsrDelta } from "./mcsrStream";
import { searchDefaults, runSearch } from "./boundedSearch";
import type { McsrSearchSettings } from "./boundedSearch";
import { ControlTransport, ControlTransportError } from "./controlTransport";
import type { ControlSettings } from "./controlTransport";
import { McsrController } from "./mcsr";
import type { SrdSettings, McsrView } from "./mcsr";
import {
  mesh,
  position,
  positions,
  activeEdges,
  pathLength,
  validate,
} from "./model";
import type { Config } from "./model";
import { MetricsEngine } from "./metrics";
import {
  createRoutingStrategy,
  DominantSearchError,
  DOMINANT_NODE_LIMIT,
  validateCandidates,
  pathProblem,
  analyseCandidates,
  candidateId,
  DEFAULT_LINK_LOAD,
  linkMetrics,
  evaluatePath,
} from "./routing";
import type {
  LinkLoad,
  NetworkLink,
  RoutingGraph,
  RoutingStrategy,
  PathCandidate,
  RoutingSettings,
  RoutingAnalysis,
  DominantSearchSummary,
} from "./routing";
export const SECOND = 1000000;
export const DEFAULT_EPOCH_MS = Date.UTC(2026, 0, 1);
export const MODEL_VERSION = "mcsr-ground-v9";
export type FailureEvent = { atUs: number; linkId: string; down: boolean };
export type LinkMetricUpdate = LinkLoad & { atUs: number; linkId: string };
export type Scenario = {
  schemaVersion: 9;
  ground: GroundSettings | null;
  mcsrSearch: McsrSearchSettings;
  config: Config;
  srd: SrdSettings;
  controlTransport: ControlSettings;
  epochMs: number;
  durationUs: number;
  seed: number;
  source: number;
  target: number;
  slsIntervalUs: number;
  computeDelayUs: number;
  installDelayUs: number;
  failures: FailureEvent[];
  linkMetricUpdates: LinkMetricUpdate[];
  routing: RoutingSettings;
  notificationDelayUs: number;
  switchDelayUs: number;
};
export type LinkState = {
  id: string;
  a: number;
  b: number;
  physical: boolean;
  known: boolean;
  forced: boolean;
};
export const edgeId = (a: number, b: number) =>
  `${Math.min(a, b)}:${Math.max(a, b)}`;
export function createScenario(
  config: Config,
  epochMs: number,
  source = 0,
  target = Math.min(41, config.planes * config.perPlane - 1),
): Scenario {
  return {
    schemaVersion: 9,
    ground: null,
    mcsrSearch: searchDefaults(config.planes * config.perPlane),
    config: { ...config },
    srd: {
      planesPerDomain: Math.min(
        config.planes * config.perPlane > 72 ? 6 : 2,
        config.planes,
      ),
      satellitesPerDomain: Math.min(
        config.planes * config.perPlane <= 16 ? 2 : 4,
        config.perPlane,
      ),
    },
    controlTransport: { mode: "isl", ackTimeoutUs: SECOND },
    epochMs,
    durationUs: 86400 * SECOND,
    seed: 1,
    source,
    target,
    slsIntervalUs: 100000,
    computeDelayUs: 1000,
    installDelayUs: 1000,
    failures: [],
    linkMetricUpdates: [],
    routing: { algorithm: "bfs", service: "LS", candidatePaths: [] },
    notificationDelayUs: 0,
    switchDelayUs: 0,
  };
}
export function normalizeScenario(input: unknown): Scenario {
  if (!input || typeof input !== "object")
    throw new Error("시나리오 형식이 올바르지 않습니다.");
  const version = (input as { schemaVersion?: number }).schemaVersion;
  if (
    version !== undefined &&
    version !== 1 &&
    version !== 2 &&
    version !== 3 &&
    version !== 4 &&
    version !== 5 &&
    version !== 6 &&
    version !== 7 &&
    version !== 8 &&
    version !== 9
  )
    throw new Error("지원하지 않는 시나리오 버전입니다.");
  const scenario = { ...structuredClone(input), schemaVersion: 9 } as Scenario;
  if (
    version !== 3 &&
    version !== 4 &&
    version !== 5 &&
    version !== 6 &&
    version !== 7 &&
    version !== 8 &&
    version !== 9 &&
    scenario.linkMetricUpdates === undefined
  )
    scenario.linkMetricUpdates = [];
  if (
    version !== 4 &&
    version !== 5 &&
    version !== 6 &&
    version !== 7 &&
    version !== 8 &&
    version !== 9
  ) {
    scenario.routing ??= {
      algorithm: "bfs",
      service: "LS",
      candidatePaths: [],
    };
    scenario.notificationDelayUs ??= 0;
    scenario.switchDelayUs ??= 0;
  }
  if (version !== 6 && version !== 7 && version !== 8 && version !== 9)
    scenario.srd = {
      planesPerDomain: Math.min(2, scenario.config?.planes),
      satellitesPerDomain: Math.min(2, scenario.config?.perPlane),
    };
  if (version !== 7 && version !== 8 && version !== 9)
    scenario.controlTransport = { mode: "fixed", ackTimeoutUs: SECOND };
  if (version !== 8 && version !== 9)
    scenario.mcsrSearch = searchDefaults(
      scenario.config?.planes * scenario.config?.perPlane,
      "reference",
    );
  if (version !== 9) scenario.ground = null;
  validateScenario(scenario);
  return scenario;
}
export type LinkChange = Pick<
  LinkState,
  "id" | "physical" | "known" | "forced"
>;
export type TopologyDelta = {
  timeUs: number;
  stateRevision: number;
  version: number;
  changedLinks: LinkChange[];
  route?: { path: number[]; pathValid: boolean };
  analysis?: RoutingAnalysis;
  mcsr?: McsrView;
  mcsrDelta?: McsrDelta;
  ground?: GroundView;
};
export type RenderCheckpoint = {
  ground?: GroundView;
  timeUs: number;
  stateRevision: number;
  version: number;
  links: LinkState[];
  analysis: RoutingAnalysis;
  mcsr?: McsrView;
  path: number[];
  pathValid: boolean;
};
function integer(value: number, min: number, max: number, label: string) {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`${label}: ${min}~${max} 범위의 정수가 필요합니다.`);
}
export function validateScenario(s: Scenario) {
  if (!s || typeof s !== "object" || !s.config)
    throw new Error("시나리오 형식이 올바르지 않습니다.");
  if (s.schemaVersion !== 9)
    throw new Error("지원하지 않는 시나리오 버전입니다.");
  if (
    !s.controlTransport ||
    !["fixed", "isl"].includes(s.controlTransport.mode)
  )
    throw new Error("잘못된 제어 통신 모드입니다.");
  integer(s.controlTransport.ackTimeoutUs, 1, 86400 * SECOND, "ACK 제한 시간");
  if (!s.mcsrSearch || !["reference", "bounded"].includes(s.mcsrSearch.mode))
    throw new Error("MCSR 탐색 모드가 필요합니다.");
  for (const [key, min, max] of [
    ["localCandidates", 1, 16],
    ["labelsPerBoundary", 1, 64],
    ["endCandidates", 1, 64],
    ["expansionLimit", 1, 10000000],
    ["delayPublishIntervalUs", 1000000, 86400 * SECOND],
    ["metricCoalesceUs", 0, SECOND],
    ["traceLimit", 24, 100000],
    ["controlEventLimit", 1, 50000000],
  ] as const)
    integer(s.mcsrSearch[key], min, max, `MCSR ${key}`);
  if (!s.srd) throw new Error("SRD 설정이 필요합니다.");
  integer(s.srd.planesPerDomain, 1, s.config.planes, "SRD 궤도면 수");
  integer(s.srd.satellitesPerDomain, 1, s.config.perPlane, "SRD 슬롯 수");
  if (
    s.mcsrSearch.mode === "bounded" &&
    s.srd.planesPerDomain * s.srd.satellitesPerDomain > 32
  )
    throw new Error("확장 모드 SRD는 32기 이하로 분할하세요.");
  validateGround(s.ground);
  if (s.ground && s.routing?.algorithm === "candidate-paths")
    throw new Error(
      "지상 모드는 고정 수동 후보 대신 BFS·자동 우세 경로·MCSR을 사용하세요.",
    );
  const invalid = validate(s.config);
  if (invalid) throw new Error(invalid);
  integer(s.epochMs, 0, 8640000000000000, "시작 시각");
  integer(s.durationUs, 1, 86400 * SECOND, "실험 길이");
  if (s.epochMs + s.durationUs / 1000 > 8640000000000000)
    throw new Error("종료 UTC가 지원 범위를 벗어납니다.");
  integer(s.seed, 0, 4294967295, "시드");
  integer(s.source, 0, s.config.planes * s.config.perPlane - 1, "출발 노드");
  integer(s.target, 0, s.config.planes * s.config.perPlane - 1, "도착 노드");
  integer(s.slsIntervalUs, 1, s.durationUs, "SLS 간격");
  integer(s.computeDelayUs, 0, s.durationUs, "계산 지연");
  integer(s.installDelayUs, 0, s.durationUs, "설치 지연");
  if (!Array.isArray(s.failures))
    throw new Error("장애 일정은 배열이어야 합니다.");
  integer(s.notificationDelayUs, 0, s.durationUs, "인지 후 통지 지연");
  integer(s.switchDelayUs, 0, s.durationUs, "예비 전환 지연");
  if (
    !s.routing ||
    !["bfs", "candidate-paths", "dominant-paths", "mcsr"].includes(
      s.routing.algorithm,
    ) ||
    !["LS", "TS", "HR"].includes(s.routing.service) ||
    !Array.isArray(s.routing.candidatePaths)
  )
    throw new Error("잘못된 라우팅 설정입니다.");
  if (
    (s.routing.algorithm === "dominant-paths" ||
      (s.routing.algorithm === "mcsr" && s.mcsrSearch.mode === "reference")) &&
    s.config.planes * s.config.perPlane > DOMINANT_NODE_LIMIT
  )
    throw new Error("자동 우세 경로는 16기 이하 성좌를 적용한 뒤 선택하세요.");
  const structuralGraph: RoutingGraph = {
    nodeCount: s.config.planes * s.config.perPlane,
    links: mesh(s.config).map(([a, b]) => ({
      id: edgeId(a, b),
      sourceId: a,
      targetId: b,
      knownAvailable: true,
      metrics: { propagationDelayMs: 0, availableBufferRatio: 1, jitterMs: 0 },
    })),
  };
  for (const nodes of s.routing.candidatePaths) {
    const problem = pathProblem(nodes, structuralGraph, s.source, s.target);
    if (problem) throw new Error(`잘못된 수동 후보: ${problem}`);
  }
  const ids = new Set(mesh(s.config).map(([a, b]) => edgeId(a, b))),
    seen = new Set<string>();
  for (const e of s.failures) {
    integer(e.atUs, 1, s.durationUs, "장애 시각");
    if (!ids.has(e.linkId) || typeof e.down !== "boolean")
      throw new Error("잘못된 장애 링크입니다.");
    const key = `${e.atUs}:${e.linkId}`;
    if (seen.has(key))
      throw new Error("같은 시각·링크의 장애 일정이 중복됩니다.");
    seen.add(key);
  }
  if (!Array.isArray(s.linkMetricUpdates))
    throw new Error("링크 속성 변경은 배열이어야 합니다.");
  const metricSeen = new Set<string>();
  for (const e of s.linkMetricUpdates) {
    if (!e || typeof e !== "object")
      throw new Error("잘못된 링크 속성 변경입니다.");
    integer(e.atUs, 0, s.durationUs, "속성 변경 시각");
    if (!ids.has(e.linkId)) throw new Error("알 수 없는 속성 변경 링크입니다.");
    integer(e.bufferCapacityPackets, 1, Number.MAX_SAFE_INTEGER, "버퍼 용량");
    integer(e.queuedPackets, 0, e.bufferCapacityPackets, "버퍼 점유량");
    if (!Number.isFinite(e.jitterMs) || e.jitterMs < 0)
      throw new Error("가상 지터는 유한한 비음수여야 합니다.");
    const key = `${e.atUs}:${e.linkId}`;
    if (metricSeen.has(key))
      throw new Error("같은 시각·링크의 속성 변경이 중복됩니다.");
    metricSeen.add(key);
  }
}
type Event = {
  atUs: number;
  priority: number;
  sequence: number;
  run: () => void;
};
class EventQueue {
  private heap: Event[] = [];
  peek() {
    return this.heap[0];
  }
  private before(a: Event, b: Event) {
    return (
      a.atUs - b.atUs || a.priority - b.priority || a.sequence - b.sequence
    );
  }
  push(e: Event) {
    const h = this.heap;
    h.push(e);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.before(h[p], e) <= 0) break;
      h[i] = h[p];
      i = p;
    }
    h[i] = e;
  }
  pop() {
    const h = this.heap,
      first = h[0],
      last = h.pop()!;
    if (h.length) {
      let i = 0;
      while (i * 2 + 1 < h.length) {
        let c = i * 2 + 1;
        if (c + 1 < h.length && this.before(h[c + 1], h[c]) < 0) c++;
        if (this.before(last, h[c]) <= 0) break;
        h[i] = h[c];
        i = c;
      }
      h[i] = last;
    }
    return first;
  }
}
export class SimulationEngine {
  readonly scenario: Scenario;
  readonly metrics: MetricsEngine;
  readonly profiling: { atUs: number; wallMs: number }[] = [];
  readonly edges: [number, number][];
  private groundAccess?: GroundAccess;
  private groundMetrics?: GroundMetrics;
  private groundRoutePending = false;
  private groundWasReady = false;
  private committedGroundKey = "";
  private cachedGroundView?: { key: string; view: GroundView };
  private sourceNode = 0;
  private targetNode = 0;
  nowUs = 0;
  private queue = new EventQueue();
  private sequence = 0;
  private version = 0;
  private geometric = new Set<string>();
  private physical = new Set<string>();
  private known = new Set<string>();
  private forced = new Set<string>();
  private missed = new Map<string, number>();
  private tokens = new Map<string, number>();
  private installed: number[] = [];
  private installedKey = "";
  private serviceDirty = true;
  private linkLoads = new Map<string, LinkLoad>();
  private installedEvaluation: {
    evaluatedUs: number;
    candidate: PathCandidate | null;
  } | null = null;
  private routingEvaluations: {
    evaluatedUs: number;
    inputRevision: number;
    candidates: PathCandidate[];
    search?: DominantSearchSummary;
  }[] = [];
  failure: {
    atUs: number;
    code: string;
    message: string;
    search?: DominantSearchSummary;
  } | null = null;
  private strategy: RoutingStrategy;
  private builtinMcsr: boolean;
  private mcsr?: McsrController;
  private control?: ControlTransport;
  private routeRestoredAtUs = -1;
  private routeRestoredMode: "initial" | "reserve" | "recalculate" = "initial";
  private committedMcsrKey = "";
  private committedMcsr?: McsrView;
  private inputRevision = 0;
  private requestAtUs = -1;
  private requestedVersion = -1;

  private cachedCandidates: PathCandidate[] = [];
  private analyses: RoutingAnalysis[] = [];
  private analysis: RoutingAnalysis = {
    status: "pending",
    id: 0,
    atUs: 0,
    inputRevision: 0,
    algorithm: "",
    service: "LS",
    mode: "initial",
    trigger: "initial",
    selectedId: null,
    candidates: [],
  };
  private pendingJob?: Generator<void, unknown>;
  private instantOpen = false;
  get needsWork() {
    return !!this.pendingJob || this.instantOpen;
  }
  nextEventUs() {
    return this.queue.peek()?.atUs ?? this.scenario.durationUs;
  }
  private committedAnalysisKey = "";
  private previousDelays: number[] = [];
  private delayChanged = false;
  private routingReasons = new Set<string>();
  private physicalCommitUs = -1;
  private dirtyLinks = new Set<string>();
  private detectedLinks = new Set<string>();
  private committedLinks = new Map<string, LinkState>();
  private committedPath = "";
  private committedValid = false;
  private stateRevision = 0;
  private deltas: TopologyDelta[] = [];
  constructor(
    input: unknown,
    strategy?: RoutingStrategy,
    deferRouting = false,
  ) {
    const scenario = normalizeScenario(input);
    this.scenario = scenario;
    this.builtinMcsr = !strategy && scenario.routing.algorithm === "mcsr";
    this.strategy =
      strategy ??
      createRoutingStrategy(scenario.routing, {
        name: "MCSR",
        reactsToMetrics: true,
        calculate: (_graph, source, target, report) =>
          this.mcsr!.calculate(source, target, report),
      });
    this.sourceNode = scenario.source;
    this.targetNode = scenario.target;
    if (scenario.ground) {
      this.groundAccess = new GroundAccess(scenario.ground);
      this.groundMetrics = new GroundMetrics();
      this.groundAccess.update(
        positions(scenario.config, 0, scenario.epochMs),
        0,
      );
      this.sourceNode = this.groundAccess.source ?? this.sourceNode;
      this.targetNode = this.groundAccess.target ?? this.targetNode;
      this.groundWasReady = this.groundAccess.ready(0);
    }
    this.metrics = new MetricsEngine(this.sourceNode, this.targetNode);
    if (this.groundAccess && !this.groundWasReady)
      this.metrics.setMonitoring(0, false);
    this.edges = mesh(scenario.config);
    this.geometric = this.geometry(0);
    this.physical = new Set(this.geometric);
    this.known = new Set(this.geometric);
    for (const e of scenario.linkMetricUpdates) {
      const apply = () => {
        this.linkLoads.set(e.linkId, {
          bufferCapacityPackets: e.bufferCapacityPackets,
          queuedPackets: e.queuedPackets,
          jitterMs: e.jitterMs,
        });
        if (e.atUs > 0) {
          this.metrics.record({
            atUs: this.nowUs,
            type: "link-metrics-changed",
            linkId: e.linkId,
          });
          if (
            this.strategy.reactsToMetrics !== false ||
            scenario.routing.service === "HR"
          )
            if (this.mcsr) this.updateMcsr("metrics");
            else this.inputsChanged("metrics");
        }
      };
      if (e.atUs === 0) apply();
      else this.schedule(e.atUs, 1, apply);
    }
    if (scenario.routing.algorithm === "mcsr")
      this.mcsr = new McsrController(
        scenario.config,
        scenario.srd,
        this.observedGraph(),
        this.sourceNode,
        scenario.mcsrSearch,
        this.targetNode,
      );
    if (this.mcsr && scenario.controlTransport.mode === "isl") {
      this.control = new ControlTransport(
        this.mcsr.partition.domains.map((d) => d.ds),
        scenario.notificationDelayUs,
        scenario.controlTransport.ackTimeoutUs,
        {
          nowUs: () => this.nowUs,
          schedule: (atUs, priority, run) => this.schedule(atUs, priority, run),
          graph: (domainId) => this.mcsr!.graph(domainId, false),
          availabilityKey: (domainId) => this.mcsr!.availabilityKey(domainId),
          physical: (a, b) => {
            const id = edgeId(a, b);
            const seconds = this.nowUs / SECOND;
            return {
              available: this.physical.has(id),
              token: this.tokens.get(id) ?? 0,
              delayUs: Math.max(
                1,
                Math.ceil(
                  linkMetrics(
                    position(scenario.config, a, seconds, scenario.epochMs),
                    position(scenario.config, b, seconds, scenario.epochMs),
                    DEFAULT_LINK_LOAD,
                  ).propagationDelayMs * 1000,
                ),
              ),
            };
          },
          receive: (ad, recipient) =>
            this.receiveMcsr(ad.domainId, ad.revision, recipient, () =>
              this.mcsr!.receive(ad, recipient, this.nowUs),
            )!,
          receiveDelta: (delta, recipient) =>
            this.receiveMcsr(delta.domainId, delta.revision, recipient, () =>
              this.mcsr!.receiveDelta(delta, recipient, this.nowUs),
            ),
          initialAdvertisement: (domainId) =>
            this.mcsr!.initialAdvertisement(domainId),
        },
        scenario.mcsrSearch.mode === "bounded"
          ? {
              eventLimit: scenario.mcsrSearch.controlEventLimit,
              traceLimit: scenario.mcsrSearch.traceLimit,
              focusDomain: this.mcsr.sourceDomain,
            }
          : undefined,
      );
    }
    if (deferRouting) {
      this.pendingJob = this.initializeRouting();
      this.instantOpen = true;
    } else runSearch(this.initializeRouting());
    for (const [a, b] of this.edges) {
      const id = edgeId(a, b);
      this.committedLinks.set(id, {
        id,
        a,
        b,
        physical: this.physical.has(id),
        known: this.known.has(id),
        forced: false,
      });
    }
    this.committedAnalysisKey = `${this.analysis.id}:${this.analysis.status}`;
    this.committedPath = this.installedKey;
    this.committedValid = this.validPath();
    if (!this.pendingJob) this.observeService();
    this.committedMcsr = this.mcsrView();
    this.committedMcsrKey = this.mcsrStateKey(this.committedMcsr);
    this.committedGroundKey = JSON.stringify(this.groundView());
    this.scheduleTopology(SECOND);
    for (const e of scenario.failures) this.scheduleFailure(e);
  }
  private receiveMcsr(
    domainId: number,
    revision: number,
    recipient: number,
    apply: () => boolean | null,
  ): boolean | null {
    const affectsSource = recipient === this.mcsr!.sourceDomain;
    const beforeGraph = affectsSource
      ? this.mcsr!.graph(undefined, false)
      : undefined;
    const previous = this.mcsr!.inputKey(),
      accepted = apply();
    if (accepted === null) return null;
    if (affectsSource && accepted) this.serviceDirty = true;
    this.metrics.record({
      atUs: this.nowUs,
      type: accepted ? "csib-received" : "csib-discarded",
      domainId: domainId,
      recipientDomainId: recipient,
      version: revision,
    });
    if (affectsSource && previous !== this.mcsr!.inputKey()) {
      const afterGraph = this.mcsr!.graph(undefined, false),
        byId = new Map(afterGraph.links.map((l) => [l.id, l]));
      const down = beforeGraph!.links.some(
        (l) => l.knownAvailable && !byId.get(l.id)?.knownAvailable,
      );
      const beforeIds = new Set(
        beforeGraph!.links.filter((l) => l.knownAvailable).map((l) => l.id),
      );
      const up = afterGraph.links.some(
        (l) => l.knownAvailable && !beforeIds.has(l.id),
      );
      const changedMetrics = beforeGraph!.links.some((l) => {
        const next = byId.get(l.id);
        return (
          l.knownAvailable &&
          next?.knownAvailable &&
          JSON.stringify(l.metrics) !== JSON.stringify(next.metrics)
        );
      });
      this.inputsChanged(
        down && !up && !changedMetrics ? "link-down" : "csib-update",
      );
    }
    return accepted;
  }
  private *initializeRouting(): Generator<void, void> {
    const initial = yield* this.calculateSteps();
    this.cachedCandidates = initial.candidates;
    const chosen = this.decide(
      initial.candidates,
      "initial",
      "initial",
      [],
      initial.search,
    );
    this.installed = chosen?.nodes ?? [];
    this.installedKey = this.installed.join(":");
    this.serviceDirty = true;
    this.installedEvaluation = {
      evaluatedUs: initial.evaluatedUs,
      candidate: chosen,
    };
    this.metrics.record({
      atUs: 0,
      type: "route-installed",
      path: this.installed,
      version: 0,
    });
  }
  private schedule(atUs: number, priority: number, run: () => void) {
    if (atUs <= this.scenario.durationUs)
      this.queue.push({ atUs, priority, sequence: this.sequence++, run });
  }
  private geometry(atUs: number) {
    const p = positions(
      this.scenario.config,
      atUs / SECOND,
      this.scenario.epochMs,
    );
    const delays = this.edges.map(
      ([a, b]) => linkMetrics(p[a], p[b], DEFAULT_LINK_LOAD).propagationDelayMs,
    );
    this.delayChanged = delays.some(
      (d, i) =>
        Math.abs(d - (this.previousDelays[i] ?? d)) >
        1e-9 * Math.max(1, Math.abs(d)),
    );
    this.previousDelays = delays;
    return new Set(activeEdges(this.edges, p).map(([a, b]) => edgeId(a, b)));
  }
  private scheduleTopology(atUs: number) {
    this.schedule(atUs, 1, () => {
      const next = this.geometry(this.nowUs);
      this.geometric = next;
      this.stagePhysical();
      if (this.groundAccess)
        this.schedule(this.nowUs, 1.75, () => this.refreshGround());
      if (
        (this.strategy.reactsToMetrics !== false ||
          this.scenario.routing.service === "HR") &&
        this.delayChanged
      )
        if (this.mcsr) this.updateMcsr("geometry-metrics");
        else this.inputsChanged("geometry-metrics");
      this.scheduleTopology(this.nowUs + SECOND);
    });
  }
  private scheduleFailure(e: FailureEvent) {
    this.schedule(e.atUs, 0, () => {
      if (e.down) this.forced.add(e.linkId);
      else this.forced.delete(e.linkId);
      this.metrics.record({
        atUs: this.nowUs,
        type: e.down ? "failure-command" : "restore-command",
        linkId: e.linkId,
      });
      this.dirtyLinks.add(e.linkId);
      this.stagePhysical();
    });
  }
  addFailure(event: FailureEvent) {
    if (event.atUs <= this.nowUs)
      throw new Error("장애 시각은 현재 논리 시각보다 뒤여야 합니다.");
    const candidate = {
      ...this.scenario,
      failures: [...this.scenario.failures, event],
    };
    validateScenario(candidate);
    this.scenario.failures.push(structuredClone(event));
    this.scheduleFailure(event);
  }
  private stagePhysical() {
    if (this.physicalCommitUs === this.nowUs) return;
    this.physicalCommitUs = this.nowUs;
    this.schedule(this.nowUs, 1.5, () => {
      for (const [a, b] of this.edges) {
        const id = edgeId(a, b);
        this.changePhysical(id, this.geometric.has(id) && !this.forced.has(id));
      }
    });
  }
  private groundView(
    pathValid = this.serviceDirty ? this.validPath() : this.committedValid,
  ): GroundView | undefined {
    const access = this.groundAccess;
    if (!access) return undefined;
    const sample = Math.floor(this.nowUs / SECOND);
    const key = `${sample}:${access.source}:${access.target}:${access.readinessKey(this.nowUs)}:${this.groundRoutePending}:${pathValid}`;
    if (this.cachedGroundView?.key === key) return this.cachedGroundView.view;
    const p: ReturnType<typeof positions> = [];
    for (const id of [access.source, access.target])
      if (id !== null)
        p[id] = position(
          this.scenario.config,
          id,
          sample,
          this.scenario.epochMs,
        );
    const view = access.view(p, this.nowUs, this.groundRoutePending, pathValid);
    this.cachedGroundView = { key, view };
    return view;
  }
  private refreshGround() {
    const access = this.groundAccess;
    if (!access) return;
    const changed = access.update(
      positions(
        this.scenario.config,
        this.nowUs / SECOND,
        this.scenario.epochMs,
      ),
      this.nowUs,
    );
    const ready = access.ready(this.nowUs);
    if (changed) {
      this.metrics.setMonitoring(this.nowUs, false);
      this.sourceNode = access.source ?? this.sourceNode;
      this.targetNode = access.target ?? this.targetNode;
      this.installed = [];
      this.installedKey = "";
      this.installedEvaluation = null;
      this.cachedCandidates = [];
      this.groundRoutePending = true;
      if (this.mcsr) {
        this.mcsr.setEndpoints(this.sourceNode, this.targetNode);
        this.control?.setFocusDomain(this.mcsr.sourceDomain);
        this.updateMcsr("ground-endpoints");
      }
      for (const atUs of access.readyTimesUs)
        if (atUs > this.nowUs)
          this.schedule(atUs, 1.75, () => this.refreshGround());
      this.metrics.record({
        atUs: this.nowUs,
        type: "ground-attachment-changed",
        reason: `${access.source ?? "none"}->${access.target ?? "none"}`,
      });
    }
    if (changed || ready !== this.groundWasReady) {
      this.serviceDirty = true;
      this.inputsChanged(ready ? "ground-ready" : "ground-access-change");
    }
    this.serviceDirty = true;
    this.groundWasReady = ready;
  }
  private observeService(available = this.validPath()) {
    const ground = this.groundView(available);
    if (ground) this.groundMetrics!.observe(this.nowUs, ground);
    const missing = new Set<string>();
    for (const path of !available || this.metrics.previousPath.length
      ? [this.installed, this.metrics.previousPath]
      : []) {
      for (let i = 1; i < path.length; i++) {
        const id = edgeId(path[i - 1], path[i]);
        if (!this.physical.has(id)) missing.add(id);
      }
    }
    this.metrics.observe(
      this.nowUs,
      this.installed,
      available,
      [...missing].sort(),
      this.detectedLinks,
      !available || this.metrics.previousPath.length
        ? this.routingGraph()
        : undefined,
      this.routeRestoredAtUs === this.nowUs ? this.routeRestoredMode : null,
    );
    this.detectedLinks.clear();
    this.serviceDirty = false;
  }
  private commitInstant() {
    const path = this.installedKey,
      pathValid = this.serviceDirty ? this.validPath() : this.committedValid;
    if (this.serviceDirty) this.observeService(pathValid);
    const changedLinks: LinkChange[] = [];
    for (const id of [...this.dirtyLinks].sort()) {
      const previous = this.committedLinks.get(id)!;
      const next = {
        ...previous,
        physical: this.physical.has(id),
        known: this.known.has(id),
        forced: this.forced.has(id),
      };
      if (
        next.physical !== previous.physical ||
        next.known !== previous.known ||
        next.forced !== previous.forced
      ) {
        this.committedLinks.set(id, next);
        changedLinks.push({
          id,
          physical: next.physical,
          known: next.known,
          forced: next.forced,
        });
      }
    }
    this.dirtyLinks.clear();
    const routeChanged =
      path !== this.committedPath || pathValid !== this.committedValid;
    const analysisChanged =
      `${this.analysis.id}:${this.analysis.status}` !==
      this.committedAnalysisKey;
    const bounded = this.scenario.mcsrSearch.mode === "bounded";
    const mcsrKey = bounded
      ? this.mcsrStateKey()
      : this.mcsrStateKey(this.mcsrView());
    const mcsrChanged = mcsrKey !== this.committedMcsrKey;
    const mcsr = mcsrChanged ? this.mcsrView() : this.committedMcsr;
    const ground = this.groundView(pathValid);
    const groundKey = JSON.stringify(ground);
    const groundChanged = groundKey !== this.committedGroundKey;
    if (
      changedLinks.length ||
      routeChanged ||
      analysisChanged ||
      mcsrChanged ||
      groundChanged
    ) {
      this.deltas.push({
        timeUs: this.nowUs,
        stateRevision: ++this.stateRevision,
        version: this.version,
        changedLinks,
        ...(groundChanged && ground ? { ground: structuredClone(ground) } : {}),
        ...(mcsrChanged && mcsr
          ? bounded && this.committedMcsr
            ? { mcsrDelta: diffMcsr(this.committedMcsr, mcsr) }
            : { mcsr }
          : {}),
        ...(analysisChanged
          ? { analysis: structuredClone(this.analysis) }
          : {}),
        ...(routeChanged
          ? { route: { path: [...this.installed], pathValid } }
          : {}),
      });
    }
    this.committedMcsr = mcsr;
    this.committedMcsrKey = mcsrKey;
    this.committedAnalysisKey = `${this.analysis.id}:${this.analysis.status}`;
    this.committedGroundKey = groundKey;
    this.committedPath = path;
    this.committedValid = pathValid;
  }
  drainDeltas() {
    const deltas = this.deltas;
    this.deltas = [];
    return deltas;
  }
  checkpoint(): RenderCheckpoint {
    return {
      timeUs: this.nowUs,
      stateRevision: this.stateRevision,
      version: this.version,
      links: structuredClone([...this.committedLinks.values()]),
      ...(this.groundAccess
        ? { ground: structuredClone(this.groundView()) }
        : {}),
      analysis: structuredClone(this.analysis),
      ...(this.mcsr
        ? { mcsr: structuredClone(this.committedMcsr ?? this.mcsrView()) }
        : {}),
      path: [...this.installed],
      pathValid: this.validPath(),
    };
  }
  private validPath() {
    const nodes = this.installed;
    return (
      (!this.groundAccess || this.groundAccess.ready(this.nowUs)) &&
      nodes.length > 0 &&
      nodes[0] === this.sourceNode &&
      nodes.at(-1) === this.targetNode &&
      new Set(nodes).size === nodes.length &&
      nodes.every(
        (v, i) =>
          Number.isInteger(v) &&
          v >= 0 &&
          v < this.scenario.config.planes * this.scenario.config.perPlane &&
          (i === 0 || this.physical.has(edgeId(nodes[i - 1], v))),
      )
    );
  }
  private changePhysical(id: string, up: boolean) {
    if (this.physical.has(id) === up) return;
    this.serviceDirty = true;
    if (up) {
      this.physical.add(id);
      this.metrics.linkUp(this.nowUs, id);
    } else {
      this.physical.delete(id);
      this.metrics.failure(this.nowUs, id);
    }
    this.dirtyLinks.add(id);
    const token = (this.tokens.get(id) ?? 0) + 1;
    this.tokens.set(id, token);
    this.scheduleHeartbeat(
      id,
      token,
      Math.ceil(this.nowUs / this.scenario.slsIntervalUs) *
        this.scenario.slsIntervalUs,
    );
  }
  private scheduleHeartbeat(id: string, token: number, atUs: number) {
    this.schedule(atUs, 2, () => {
      if (this.tokens.get(id) !== token) return;
      if (this.physical.has(id)) {
        this.missed.set(id, 0);
        if (!this.known.has(id)) this.notifyLink(id, true, token);
      } else {
        const misses = (this.missed.get(id) ?? 0) + 1;
        this.missed.set(id, misses);
        this.metrics.record({
          atUs: this.nowUs,
          type: "sls-missed",
          linkId: id,
        });
        if (misses >= 3) {
          if (this.known.has(id)) {
            this.detectedLinks.add(id);
            this.serviceDirty = true;
            this.metrics.detected(this.nowUs, id);
            this.notifyLink(id, false, token);
          }
        } else
          this.scheduleHeartbeat(
            id,
            token,
            this.nowUs + this.scenario.slsIntervalUs,
          );
      }
    });
  }
  private notifyLink(id: string, up: boolean, token: number) {
    this.metrics.record({
      atUs: this.nowUs,
      type: "notification-started",
      linkId: id,
    });
    this.schedule(
      this.nowUs + (this.mcsr ? 0 : this.scenario.notificationDelayUs),
      2.25,
      () => {
        if (this.tokens.get(id) !== token) {
          this.metrics.record({
            atUs: this.nowUs,
            type: "notification-discarded",
            linkId: id,
          });
          return;
        }
        if (this.known.has(id) === up) return;
        if (up) this.known.add(id);
        else this.known.delete(id);
        this.dirtyLinks.add(id);
        this.version++;
        this.metrics.record({
          atUs: this.nowUs,
          type: up ? "link-detected-up" : "link-known-down",
          linkId: id,
        });
        this.metrics.record({
          atUs: this.nowUs,
          type: "notification-completed",
          linkId: id,
        });
        if (this.mcsr) this.updateMcsr(up ? "link-up" : "link-down");
        else this.inputsChanged(up ? "link-up" : "link-down");
      },
    );
  }
  private networkLink(
    a: number,
    b: number,
    p: ReturnType<typeof positions>,
  ): NetworkLink {
    const id = edgeId(a, b);
    return {
      id,
      sourceId: a,
      targetId: b,
      knownAvailable: this.known.has(id),
      metrics: linkMetrics(
        p[a],
        p[b],
        this.linkLoads.get(id) ?? DEFAULT_LINK_LOAD,
      ),
    };
  }
  private observedGraph(): RoutingGraph {
    const interval =
      this.scenario.mcsrSearch.mode === "bounded"
        ? this.scenario.mcsrSearch.delayPublishIntervalUs
        : SECOND;
    // Attribute notifications must not reveal geometry newer than the observation epoch.
    const seconds = this.mcsr
      ? (Math.floor(this.nowUs / interval) * interval) / SECOND
      : this.nowUs / SECOND;
    const p = positions(this.scenario.config, seconds, this.scenario.epochMs);
    return {
      nodeCount: p.length,
      links: this.edges.map(([a, b]) => this.networkLink(a, b, p)),
    };
  }
  graph(): RoutingGraph {
    return structuredClone(this.routingGraph());
  }
  private routingGraph(): RoutingGraph {
    return this.mcsr?.graph(undefined, false) ?? this.observedGraph();
  }
  private mcsrStateKey(view?: McsrView) {
    if (!this.mcsr) return "";
    if (this.scenario.mcsrSearch.mode === "reference")
      return JSON.stringify(view ?? this.mcsrView());
    return `${this.mcsr.viewRevision}:${this.control?.displayRevision ?? 0}:${Math.floor(this.nowUs / 100000)}`;
  }
  private mcsrView(): McsrView | undefined {
    return this.mcsr
      ? {
          ...this.mcsr.view(false),
          ...(this.control ? { control: this.control.view(false) } : {}),
        }
      : undefined;
  }
  private metricCommitUs = -1;
  private updateMcsr(reason: string, coalesced = false) {
    if (this.scenario.mcsrSearch.mode === "bounded") {
      if (
        reason === "geometry-metrics" &&
        this.nowUs % this.scenario.mcsrSearch.delayPublishIntervalUs !== 0
      )
        return;
      const interval = this.scenario.mcsrSearch.metricCoalesceUs;
      if (reason === "metrics" && !coalesced && interval) {
        const atUs = Math.ceil(this.nowUs / interval) * interval;
        if (this.metricCommitUs !== atUs) {
          this.metricCommitUs = atUs;
          this.schedule(atUs, 2.25, () => this.updateMcsr(reason, true));
        }
        return;
      }
    }
    const controller = this.mcsr!;
    const before = controller.inputKey();
    const updates = controller.update(this.observedGraph(), this.nowUs);
    if (updates.some((ad) => ad.domainId === controller.sourceDomain))
      this.serviceDirty = true;
    if (before !== controller.inputKey()) this.inputsChanged(reason);
    for (const ad of updates) {
      this.metrics.record({
        atUs: this.nowUs,
        type: "srd-local-update",
        domainId: ad.domainId,
        version: ad.revision,
        reason,
      });
      if (this.control) {
        this.control.publish(ad);
        continue;
      }
      for (const domain of controller.partition.domains) {
        if (domain.id === ad.domainId) continue;
        this.metrics.record({
          atUs: this.nowUs,
          type: "csib-notification-started",
          domainId: ad.domainId,
          recipientDomainId: domain.id,
          version: ad.revision,
        });
        this.schedule(
          this.nowUs + this.scenario.notificationDelayUs,
          2.25,
          () => {
            const previous = controller.inputKey();
            const accepted = controller.receive(ad, domain.id, this.nowUs);
            if (accepted && domain.id === controller.sourceDomain)
              this.serviceDirty = true;
            this.metrics.record({
              atUs: this.nowUs,
              type: accepted ? "csib-received" : "csib-discarded",
              domainId: ad.domainId,
              recipientDomainId: domain.id,
              version: ad.revision,
            });
            if (previous !== controller.inputKey()) this.inputsChanged(reason);
          },
        );
      }
    }
  }
  private currentPathMetrics(p: ReturnType<typeof positions>) {
    const links = this.installed
      .slice(1)
      .map((b, i) => this.networkLink(this.installed[i], b, p));
    return {
      evaluatedUs: this.nowUs,
      candidate: this.validPath() ? evaluatePath(this.installed, links) : null,
    };
  }
  private *calculateSteps() {
    const graph = this.routingGraph();
    let started = performance.now(),
      activeMs = 0;
    let candidates: PathCandidate[];
    let search: DominantSearchSummary | undefined;
    try {
      let raw: PathCandidate[];
      if (
        this.groundAccess &&
        (!this.groundAccess.ready(this.nowUs) ||
          this.mcsr?.endpointSummariesReady === false)
      ) {
        raw = [];
        if (this.mcsr) this.mcsr.lastAnalysis = undefined;
      } else if (
        this.builtinMcsr &&
        this.mcsr &&
        this.scenario.mcsrSearch.mode === "bounded"
      ) {
        const job = this.mcsr.calculateSteps(
          this.sourceNode,
          this.targetNode,
          (summary) => {
            search = structuredClone(summary);
          },
        );
        let step = job.next();
        while (!step.done) {
          activeMs += performance.now() - started;
          yield;
          started = performance.now();
          step = job.next();
        }
        raw = step.value;
      } else
        raw = this.strategy.calculate(
          structuredClone(graph),
          this.sourceNode,
          this.targetNode,
          (summary) => {
            search = structuredClone(summary);
          },
        );
      if (search && !search.complete)
        throw new Error("완료되지 않은 경로 탐색 결과입니다.");
      candidates = validateCandidates(
        raw,
        graph,
        this.sourceNode,
        this.targetNode,
      );
      if (raw.length !== candidates.length)
        this.metrics.record({
          atUs: this.nowUs,
          type: "candidate-duplicates-removed",
        });
    } catch (error) {
      this.failure = {
        atUs: this.nowUs,
        code:
          error instanceof DominantSearchError
            ? error.code
            : "invalid-routing-result",
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof DominantSearchError
          ? { search: structuredClone(error.search) }
          : {}),
      };
      this.metrics.record({
        atUs: this.nowUs,
        type:
          error instanceof DominantSearchError
            ? "routing-search-aborted"
            : "routing-validation-failed",
        reason: this.failure.code,
        inputRevision: this.inputRevision,
      });
      throw error;
    }
    this.profiling.push({
      atUs: this.nowUs,
      wallMs: activeMs + performance.now() - started,
    });
    const evaluation = {
      evaluatedUs: this.nowUs,
      inputRevision: this.inputRevision,
      source: this.sourceNode,
      target: this.targetNode,
      candidates: structuredClone(candidates),
      ...(search ? { search } : {}),
      ...(this.mcsr ? { mcsr: structuredClone(this.mcsr.lastAnalysis) } : {}),
    };
    this.routingEvaluations.push(evaluation);
    return evaluation;
  }
  private decide(
    candidates: PathCandidate[],
    mode: RoutingAnalysis["mode"],
    trigger: string,
    unavailable: PathCandidate[] = [],
    search?: DominantSearchSummary,
  ): PathCandidate | null {
    const { selected, decisions } = analyseCandidates(
      candidates,
      this.scenario.routing.service,
    );
    for (const c of unavailable)
      decisions.push({
        id: candidateId(c.nodes),
        nodes: [...c.nodes],
        metrics: null,
        status: "unavailable",
        reason: "known-link-unavailable",
      });
    this.analysis = {
      status: mode === "initial" ? "installed" : "pending",
      id: this.analyses.length + 1,
      atUs: this.nowUs,
      inputRevision: this.inputRevision,
      algorithm: this.strategy.name,
      service: this.scenario.routing.service,
      mode,
      trigger,
      selectedId: selected ? candidateId(selected.nodes) : null,
      candidates: decisions,
      ...(search ? { search: structuredClone(search) } : {}),
      ...(this.mcsr
        ? {
            mcsr:
              mode === "reserve"
                ? this.mcsr.describe(candidates)
                : structuredClone(this.mcsr.lastAnalysis),
          }
        : {}),
    };
    this.analyses.push(structuredClone(this.analysis));
    this.metrics.record({
      atUs: this.nowUs,
      type: "route-decision",
      decisionId: this.analysis.id,
      inputRevision: this.inputRevision,
      reason: trigger,
      mode,
      path: selected?.nodes ?? [],
    });
    return selected;
  }
  private decisionStatus(id: number, status: RoutingAnalysis["status"]) {
    this.analyses[id - 1].status = status;
    if (this.analysis.id === id) this.analysis.status = status;
  }
  private inputsChanged(reason: string) {
    this.serviceDirty = true;
    this.inputRevision++;
    this.routingReasons.add(reason);
    const interval =
      this.scenario.mcsrSearch.mode === "bounded" &&
      ![
        "link-down",
        "link-up",
        "ground-ready",
        "ground-access-change",
        "ground-endpoints",
      ].includes(reason)
        ? this.scenario.mcsrSearch.metricCoalesceUs
        : 0;
    const atUs = interval
      ? Math.ceil(this.nowUs / interval) * interval
      : this.nowUs;
    // A previously queued later batch becomes a no-op if an urgent link change arrives first.
    if (this.requestAtUs >= this.nowUs && this.requestAtUs <= atUs) return;
    this.requestAtUs = atUs;
    this.schedule(atUs, 2.5, () => {
      if (this.requestAtUs !== atUs) return;
      this.requestAtUs = -1;
      const trigger = [...this.routingReasons].sort().join(",");
      this.routingReasons.clear();
      this.pendingJob = this.requestRoute(trigger);
    });
  }
  private *requestRoute(trigger: string): Generator<void, void> {
    if (this.requestedVersion === this.inputRevision) return;
    this.requestedVersion = this.inputRevision;
    const revision = this.inputRevision,
      version = this.version;
    const graph = this.routingGraph();
    let evaluation: {
      evaluatedUs: number;
      candidates: PathCandidate[];
      search?: DominantSearchSummary;
    };
    let mode: RoutingAnalysis["mode"] = "recalculate";
    let unavailable: PathCandidate[] = [];
    if (trigger === "link-down") {
      const available: PathCandidate[] = [];
      for (const c of this.cachedCandidates) {
        const refreshed = evaluatePath(c.nodes, graph.links);
        if (refreshed) available.push(refreshed);
        else unavailable.push(c);
      }
      if (
        analyseCandidates(available, this.scenario.routing.service).selected
      ) {
        mode = "reserve";
        evaluation = { evaluatedUs: this.nowUs, candidates: available };
      } else evaluation = yield* this.calculateSteps();
    } else evaluation = yield* this.calculateSteps();
    const selected = this.decide(
      evaluation.candidates,
      mode,
      trigger,
      unavailable,
      evaluation.search,
    );
    const decisionId = this.analysis.id;
    const path = selected?.nodes ?? [];
    const stale = () => revision !== this.inputRevision;
    const discard = () => {
      this.decisionStatus(decisionId, "discarded");
      this.metrics.record({
        atUs: this.nowUs,
        type: "route-discarded",
        version,
        inputRevision: revision,
        decisionId,
        reason: "input-revision-changed",
        mode,
      });
    };
    if (mode === "reserve" && path.join(":") === this.installed.join(":")) {
      this.decisionStatus(decisionId, "retained");
      this.cachedCandidates = structuredClone(evaluation.candidates);
      this.metrics.record({
        atUs: this.nowUs,
        type: "route-retained",
        decisionId,
        inputRevision: revision,
        mode,
        path,
      });
      return;
    }
    this.metrics.record({
      atUs: this.nowUs,
      type: mode === "reserve" ? "reserve-switch-started" : "route-started",
      version,
      inputRevision: revision,
      decisionId,
      mode,
      reason: trigger,
    });
    const delay =
      mode === "reserve"
        ? this.scenario.switchDelayUs
        : this.scenario.computeDelayUs;
    this.schedule(this.nowUs + delay, 3, () => {
      if (stale()) {
        discard();
        return;
      }
      this.cachedCandidates = structuredClone(evaluation.candidates);
      this.metrics.record({
        atUs: this.nowUs,
        type: mode === "reserve" ? "reserve-switch-ready" : "route-computed",
        version,
        inputRevision: revision,
        decisionId,
        mode,
        path,
      });
      this.metrics.record({
        atUs: this.nowUs,
        type: "route-install-started",
        version,
        inputRevision: revision,
        decisionId,
        mode,
        path,
      });
      this.schedule(this.nowUs + this.scenario.installDelayUs, 4, () => {
        if (stale()) {
          discard();
          return;
        }
        this.decisionStatus(decisionId, "installed");
        const wasAvailable = this.validPath();
        if (
          this.groundAccess?.ready(this.nowUs) &&
          (this.mcsr?.endpointSummariesReady ?? true)
        ) {
          this.groundRoutePending = false;
          this.metrics.setMonitoring(
            this.nowUs,
            true,
            this.sourceNode,
            this.targetNode,
          );
        }
        this.installed = [...path];
        this.installedKey = this.installed.join(":");
        this.serviceDirty = true;
        if (!wasAvailable && this.validPath()) {
          this.routeRestoredAtUs = this.nowUs;
          this.routeRestoredMode = mode;
        }
        this.installedEvaluation = {
          evaluatedUs: evaluation.evaluatedUs,
          candidate: structuredClone(selected),
        };
        this.metrics.record({
          atUs: this.nowUs,
          type: "route-installed",
          version,
          inputRevision: revision,
          decisionId,
          mode,
          path,
        });
      });
    });
  }
  advanceTo(targetUs: number, budget = Infinity) {
    if (this.failure) throw new Error(this.failure.message);
    integer(targetUs, this.nowUs, this.scenario.durationUs, "진행 시각");
    if (!(budget >= 1))
      throw new Error("사건 처리 묶음은 1 이상이어야 합니다.");
    let processed = 0;
    while (
      this.pendingJob ||
      this.instantOpen ||
      (this.queue.peek() &&
        this.queue.peek().atUs <= targetUs &&
        processed < budget)
    ) {
      try {
        if (this.pendingJob) {
          const step = this.pendingJob.next();
          if (!step.done) {
            if (Number.isFinite(budget)) return false;
            continue;
          }
          this.pendingJob = undefined;
          continue;
        }
        if (this.instantOpen) {
          if (this.queue.peek()?.atUs === this.nowUs) {
            if (processed >= budget) return false;
            this.queue.pop().run();
            processed++;
            continue;
          }
          this.commitInstant();
          this.instantOpen = false;
          continue;
        }
        this.nowUs = this.queue.peek().atUs;
        this.instantOpen = true;
      } catch (error) {
        this.pendingJob = undefined;
        this.instantOpen = false;
        if (!this.failure) {
          this.failure = {
            atUs: this.nowUs,
            code:
              error instanceof DominantSearchError ||
              error instanceof ControlTransportError
                ? error.code
                : "simulation-failed",
            message: error instanceof Error ? error.message : String(error),
            ...(error instanceof DominantSearchError
              ? { search: structuredClone(error.search) }
              : {}),
          };
          this.metrics.record({
            atUs: this.nowUs,
            type: "simulation-failed",
            reason: this.failure.code,
          });
        }
        throw error;
      }
    }
    const done = !this.queue.peek() || this.queue.peek().atUs > targetUs;
    if (done) this.nowUs = targetUs;
    return done;
  }
  step() {
    if (this.failure) throw new Error(this.failure.message);
    const next = this.queue.peek();
    if (next) this.advanceTo(next.atUs);
    else this.nowUs = this.scenario.durationUs;
  }
  progress() {
    const p = positions(
      this.scenario.config,
      this.nowUs / SECOND,
      this.scenario.epochMs,
    );
    const ground = this.groundView();
    const currentPathMetrics = this.currentPathMetrics(p);
    return {
      failure: structuredClone(this.failure),
      timeUs: this.nowUs,
      version: this.version,
      stateRevision: this.stateRevision,
      path: [...this.installed],
      pathValid: this.validPath(),
      routingSource:
        this.groundAccess && this.groundAccess.source === null
          ? null
          : this.sourceNode,
      routingTarget:
        this.groundAccess && this.groundAccess.target === null
          ? null
          : this.targetNode,
      ground: structuredClone(ground),
      groundService: this.groundMetrics?.summary(this.nowUs, 6),
      groundAccessEvents: structuredClone(this.groundAccess?.events.slice(-6)),
      groundPropagationDelayMs: ground?.available
        ? Math.round(
            (((ground.ut.distanceM! + ground.gs.distanceM!) / 299792458) *
              1000 +
              (currentPathMetrics.candidate?.propagationDelayMs ?? 0)) *
              1e9,
          ) / 1e9
        : null,
      length: pathLength(this.installed, p),
      routingAlgorithm: this.strategy.name,
      mcsr: structuredClone(this.mcsrView()),
      routingAnalysis: structuredClone(this.analysis),
      currentPathMetrics,
      routingStages: this.metrics.events
        .slice(-24)
        .filter((e) =>
          /notification|route-|reserve-|link-detected|srd-|csib-/.test(e.type),
        )
        .slice(-8),
      installedEvaluation: structuredClone(this.installedEvaluation),
      physicalLinkCount: this.physical.size,
      ...this.metrics.summary(
        this.nowUs,
        !this.failure && this.nowUs === this.scenario.durationUs,
        6,
      ),
    };
  }
  snapshot() {
    return {
      ...this.progress(),
      links: this.checkpoint().links,
      scenario: structuredClone(this.scenario),
    };
  }
  result() {
    if (this.needsWork)
      throw new Error("현재 논리 시각의 계산이 완료되지 않았습니다.");
    return {
      modelVersion: MODEL_VERSION,
      ...(this.groundAccess
        ? {
            ground: structuredClone(this.groundView()),
            groundPropagationDelayMs: this.progress().groundPropagationDelayMs,
            groundService: this.groundMetrics!.result(this.nowUs),
            groundAccessEvents: structuredClone(this.groundAccess.events),
          }
        : {}),
      routingAlgorithm: this.strategy.name,
      routingEvaluations: structuredClone(this.routingEvaluations),
      routingAnalyses: structuredClone(this.analyses),
      ...(this.mcsr
        ? {
            mcsr: {
              ...this.mcsr.exportState(),
              ...(this.control ? { control: this.control.exportState() } : {}),
            },
          }
        : {}),
      delayModel: {
        kind: this.control
          ? "isl-control-with-configured-processing"
          : "configured-logical-delays",
        controlTransport: structuredClone(this.scenario.controlTransport),
        notificationDelayUs: this.scenario.notificationDelayUs,
        computeDelayUs: this.scenario.computeDelayUs,
        switchDelayUs: this.scenario.switchDelayUs,
        installDelayUs: this.scenario.installDelayUs,
      },
      installedEvaluation: structuredClone(this.installedEvaluation),
      currentPathMetrics: this.currentPathMetrics(
        positions(
          this.scenario.config,
          this.nowUs / SECOND,
          this.scenario.epochMs,
        ),
      ),
      timeUs: this.nowUs,
      completed: !this.failure && this.nowUs === this.scenario.durationUs,
      validForAnalysis: !this.failure,
      failure: structuredClone(this.failure),
      path: [...this.installed],
      ...this.metrics.result(
        this.nowUs,
        !this.failure && this.nowUs === this.scenario.durationUs,
      ),
    };
  }
}
export type SimulationFrame = ReturnType<SimulationEngine["progress"]> & {
  scenario: Scenario;
};
