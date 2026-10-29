import { applyCsibDelta } from "./csibDelta";
import type { CsibDelta } from "./csibDelta";
import { route } from "./model";
import {
  searchDefaults,
  boundedLabels,
  finishBounded,
  runSearch,
  emptySearch,
} from "./boundedSearch";
import type { McsrSearchSettings, SearchArc } from "./boundedSearch";
import type { Config } from "./model";
import {
  DOMINANT_NODE_LIMIT,
  DOMINANT_EXPANSION_LIMIT,
  DOMINANT_CANDIDATE_LIMIT,
  DominantSearchError,
  candidateId,
  dominates,
  extendMetrics,
  findDominantPaths,
  evaluatePath,
  validateCandidates,
  validateRoutingGraph,
} from "./routing";
import type {
  RoutingGraph,
  NetworkLink,
  PathCandidate,
  DominantSearchSummary,
} from "./routing";

export interface SrdSettings {
  planesPerDomain: number;
  satellitesPerDomain: number;
}
export interface SrdDomain {
  id: number;
  nodes: number[];
  boundaryNodes: number[];
  ds: number;
}
export interface SrdPartition {
  domains: SrdDomain[];
  membership: number[];
}
export function partitionSrds(
  config: Pick<Config, "planes" | "perPlane">,
  settings: SrdSettings,
  links: NetworkLink[],
): SrdPartition {
  for (const [value, max] of [
    [settings.planesPerDomain, config.planes],
    [settings.satellitesPerDomain, config.perPlane],
  ])
    if (!Number.isInteger(value) || value < 1 || value > max)
      throw new Error("SRD 크기는 성좌 범위 내의 양의 정수여야 합니다.");
  const domains: SrdDomain[] = [],
    membership: number[] = [];
  for (let p = 0; p < config.planes; p += settings.planesPerDomain)
    for (let s = 0; s < config.perPlane; s += settings.satellitesPerDomain) {
      const nodes: number[] = [],
        id = domains.length;
      for (
        let i = p;
        i < Math.min(config.planes, p + settings.planesPerDomain);
        i++
      )
        for (
          let j = s;
          j < Math.min(config.perPlane, s + settings.satellitesPerDomain);
          j++
        ) {
          const node = i * config.perPlane + j;
          nodes.push(node);
          membership[node] = id;
        }
      domains.push({ id, nodes, boundaryNodes: [], ds: nodes.at(-1)! });
    }
  for (const l of links)
    if (membership[l.sourceId] !== membership[l.targetId]) {
      for (const node of [l.sourceId, l.targetId]) {
        const boundary = domains[membership[node]].boundaryNodes;
        if (!boundary.includes(node)) boundary.push(node);
      }
    }
  domains.forEach((d) => d.boundaryNodes.sort((a, b) => a - b));
  return { domains, membership };
}
interface Segment extends PathCandidate {
  hops: NetworkLink[];
}
export interface DomainAdvertisement {
  domainId: number;
  revision: number;
  atUs: number;
  segments: Segment[];
  crossings: NetworkLink[];
  links?: NetworkLink[];
  search?: { expandedStates: number; boundedPruned: number };
}
export interface CsibEvent {
  atUs: number;
  type: "local-update" | "csib-received" | "csib-discarded";
  origin: number;
  recipient: number;
  revision: number;
}
export interface McsrView {
  sourceDomain: number;
  control?: import("./controlTransport").ControlView;
  membership: number[];
  domains: (SrdDomain & { revision: number; receivedVersions: number[] })[];
  events: CsibEvent[];
}
export interface McsrAnalysis {
  coverage?: "bounded";
  allCandidatesGuaranteed?: false;
  dependencies: { domainId: number; revision: number }[];
  synchronized: boolean;
  comparison: { matched: boolean; missing: string[]; extra: string[] } | null;
  segments: {
    candidateId: string;
    domains: number[];
    runs: { domainId: number; nodes: number[] }[];
  }[];
}
const identity = {
  propagationDelayMs: 0,
  availableBufferRatio: 1,
  jitterMs: 0,
};
const fingerprint = (links: NetworkLink[]) =>
  JSON.stringify(
    links.map((l) => [
      l.id,
      l.knownAvailable,
      l.metrics.availableBufferRatio,
      l.metrics.jitterMs,
      l.metrics.propagationDelayMs,
    ]),
  );
function abort(
  code: DominantSearchError["code"],
  message: string,
  search: DominantSearchSummary,
): never {
  throw new DominantSearchError(code, message, structuredClone(search));
}
export class McsrController {
  readonly partition: SrdPartition;
  sourceDomain: number;
  readonly events: CsibEvent[] = [];
  private owned: DomainAdvertisement[];
  private bootstrap: DomainAdvertisement[];
  private csibs: DomainAdvertisement[][];
  private signatures: string[];
  private nodeCount: number;
  private sourceNode: number;
  private targetEndpointRevision = 0;
  private verificationGraph: RoutingGraph;
  lastAnalysis: McsrAnalysis | undefined;
  viewRevision = 0;
  private cachedView?: { revision: number; view: McsrView };
  traceOmitted = 0;
  private availabilityKeys = new WeakMap<RoutingGraph, string>();
  private graphCache = new Map<number, RoutingGraph>();
  private linkIndices = new Map<string, number>();
  private knownRevisions = new Map<number, number>();
  private inputCache?: string;
  private viewRows = new Map<number, McsrView["domains"][number]>();
  constructor(
    config: Pick<Config, "planes" | "perPlane">,
    settings: SrdSettings,
    graph: RoutingGraph,
    source: number,
    private search: McsrSearchSettings = searchDefaults(
      graph.nodeCount,
      "reference",
    ),
    private target = source,
  ) {
    if (
      !Number.isInteger(config.planes) ||
      !Number.isInteger(config.perPlane) ||
      config.planes < 1 ||
      config.perPlane < 1 ||
      config.planes * config.perPlane !== graph.nodeCount
    )
      throw new Error("SRD 성좌와 그래프의 노드 수가 일치해야 합니다.");
    if (search.mode === "reference" && graph.nodeCount > DOMINANT_NODE_LIMIT)
      abort(
        "node-limit",
        "MCSR 검증 모드는 16기 이하에서 지원합니다.",
        emptySearch(),
      );
    validateRoutingGraph(graph, source, this.target);
    this.nodeCount = graph.nodeCount;
    this.sourceNode = source;
    this.verificationGraph = structuredClone(graph);
    this.partition = partitionSrds(config, settings, graph.links);
    [...graph.links]
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .forEach((l, i) => this.linkIndices.set(l.id, i));
    this.sourceDomain = this.partition.membership[source];
    this.signatures = this.partition.domains.map((d) =>
      fingerprint(this.ownerLinks(graph, d.id)),
    );
    this.owned = this.partition.domains.map((d) =>
      this.advertise(graph, d.id, 0, 0),
    );
    this.bootstrap = [...this.owned];
    // Initial synchronized bootstrap, before the measured experiment begins.
    this.csibs = this.owned.map(() => [...this.owned]);
  }
  setEndpoints(source: number, target: number) {
    validateRoutingGraph(this.graph(undefined, false), source, target);
    if (source === this.sourceNode && target === this.target) return;
    for (const node of [this.sourceNode, this.target, source, target])
      this.signatures[this.partition.membership[node]] = "";
    this.sourceNode = source;
    this.target = target;
    this.targetEndpointRevision =
      this.owned[this.partition.membership[target]].revision + 1;
    this.sourceDomain = this.partition.membership[source];
    this.inputCache = undefined;
    this.lastAnalysis = undefined;
    this.viewRevision++;
  }
  get endpointSummariesReady(): boolean {
    return (
      this.search.mode === "reference" ||
      this.csibs[this.sourceDomain][this.partition.membership[this.target]]
        .revision >= this.targetEndpointRevision
    );
  }
  private ownerLinks(graph: RoutingGraph, domainId: number) {
    return graph.links.filter(
      (l) =>
        this.partition.membership[l.sourceId] === domainId ||
        this.partition.membership[l.targetId] === domainId,
    );
  }
  private advertise(
    graph: RoutingGraph,
    domainId: number,
    revision: number,
    atUs: number,
  ): DomainAdvertisement {
    const membership = this.partition.membership;
    const links = this.ownerLinks(graph, domainId),
      internal = links.filter(
        (l) =>
          membership[l.sourceId] === membership[l.targetId] && l.knownAvailable,
      );
    if (this.search.mode === "bounded") {
      const adjacency = new Map<number, SearchArc[]>();
      for (const l of internal)
        for (const [a, b] of [
          [l.sourceId, l.targetId],
          [l.targetId, l.sourceId],
        ]) {
          if (!adjacency.has(a)) adjacency.set(a, []);
          adjacency.get(a)!.push({ nodes: [a, b], ...l.metrics });
        }
      const domain = this.partition.domains[domainId];
      const endpoints = new Set([
        ...domain.boundaryNodes,
        ...[this.sourceNode, this.target].filter(
          (n) => membership[n] === domainId,
        ),
      ]);
      const segments: Segment[] = [],
        localSearch = {
          ...emptySearch(),
          coverage: "bounded" as const,
          boundedPruned: 0,
        };
      for (const start of [...endpoints].sort((a, b) => a - b)) {
        const labels = runSearch(
          boundedLabels(
            adjacency,
            start,
            this.search.localCandidates,
            this.search.expansionLimit,
            localSearch,
          ),
        );
        for (const end of endpoints)
          for (const path of labels.get(end) ?? [])
            segments.push({ ...path, hops: [] });
      }
      segments.sort((a, b) =>
        candidateId(a.nodes) < candidateId(b.nodes) ? -1 : 1,
      );
      return {
        domainId,
        revision,
        atUs,
        segments,
        crossings: links.filter(
          (l) => membership[l.sourceId] !== membership[l.targetId],
        ),
        links: structuredClone(links),
        search: {
          expandedStates: localSearch.expandedStates,
          boundedPruned: localSearch.boundedPruned,
        },
      };
    }
    const segments: Segment[] = [];
    const search = emptySearch();
    for (const start of this.partition.domains[domainId].nodes) {
      const nodes = [start],
        hops: NetworkLink[] = [];
      const walk = (node: number, metrics: typeof identity) => {
        if (++search.expandedStates > DOMINANT_EXPANSION_LIMIT)
          abort(
            "expansion-limit",
            "SRD 내부 경로 탐색 한도를 초과했습니다. 부분 결과는 사용하지 않습니다.",
            search,
          );
        if (segments.length >= DOMINANT_EXPANSION_LIMIT)
          abort(
            "candidate-limit",
            "SRD 내부 경로 탐색 한도를 초과했습니다. 부분 결과는 사용하지 않습니다.",
            search,
          );
        segments.push({ nodes: [...nodes], ...metrics, hops: [...hops] });
        for (const l of internal) {
          const next =
            l.sourceId === node
              ? l.targetId
              : l.targetId === node
                ? l.sourceId
                : -1;
          if (next < 0 || nodes.includes(next)) continue;
          nodes.push(next);
          hops.push(l);
          walk(next, extendMetrics(metrics, l.metrics));
          hops.pop();
          nodes.pop();
        }
      };
      walk(start, identity);
    }
    return structuredClone({
      domainId,
      revision,
      atUs,
      segments,
      crossings: links.filter(
        (l) => membership[l.sourceId] !== membership[l.targetId],
      ),
    });
  }
  update(graph: RoutingGraph, atUs: number): DomainAdvertisement[] {
    const updates: DomainAdvertisement[] = [];
    for (const d of this.partition.domains) {
      const key = fingerprint(this.ownerLinks(graph, d.id));
      if (key === this.signatures[d.id]) continue;
      const next = this.advertise(
        graph,
        d.id,
        this.owned[d.id].revision + 1,
        atUs,
      );
      this.signatures[d.id] = key;
      this.owned[d.id] = next;
      this.setAdvertisement(d.id, next);
      if (d.id === this.sourceDomain) this.inputCache = undefined;
      this.record({
        atUs,
        type: "local-update",
        origin: d.id,
        recipient: d.id,
        revision: next.revision,
      });
      updates.push(next);
    }
    this.verificationGraph = structuredClone(graph);
    return updates;
  }
  private crossingOwner(
    link: NetworkLink,
    ads: DomainAdvertisement[],
    recipient: number,
  ) {
    const a = this.partition.membership[link.sourceId],
      b = this.partition.membership[link.targetId];
    return recipient === a || recipient === b
      ? recipient
      : ads[a].atUs > ads[b].atUs
        ? a
        : ads[b].atUs > ads[a].atUs
          ? b
          : Math.min(a, b);
  }
  private setAdvertisement(recipient: number, ad: DomainAdvertisement) {
    const previous = this.csibs[recipient][ad.domainId],
      cached = this.graphCache.get(recipient);
    this.csibs[recipient][ad.domainId] = ad;
    if (this.search.mode !== "bounded" || !ad.links || !previous.links) {
      this.graphCache.delete(recipient);
      return;
    }
    let availabilityChanged = false;
    if (cached) {
      const links = [...cached.links],
        ads = this.csibs[recipient];
      for (const l of ad.links) {
        const index = this.linkIndices.get(l.id)!;
        const owner =
          this.partition.membership[l.sourceId] ===
          this.partition.membership[l.targetId]
            ? ad.domainId
            : this.crossingOwner(l, ads, recipient);
        const next =
          owner === ad.domainId
            ? l
            : ads[owner].links!.find((p) => p.id === l.id)!;
        if (!next) throw new Error("CSIB 링크 관측이 누락되었습니다.");
        availabilityChanged ||=
          links[index].knownAvailable !== next.knownAvailable;
        links[index] = next;
      }
      this.graphCache.set(recipient, { nodeCount: this.nodeCount, links });
    } else {
      const before = new Map(
        previous.links.map((l) => [l.id, l.knownAvailable]),
      );
      availabilityChanged = ad.links.some(
        (l) => before.get(l.id) !== l.knownAvailable,
      );
    }
    if (availabilityChanged)
      this.knownRevisions.set(
        recipient,
        (this.knownRevisions.get(recipient) ?? 0) + 1,
      );
  }
  initialAdvertisement(domainId: number) {
    return this.bootstrap[domainId];
  }
  receiveDelta(
    delta: CsibDelta,
    recipient: number,
    atUs: number,
  ): boolean | null {
    const current = this.csibs[recipient]?.[delta.domainId];
    if (!current) throw new Error("잘못된 CSIB 수신 영역입니다.");
    if (current.revision >= delta.revision)
      return this.receive(
        { ...current, revision: delta.revision },
        recipient,
        atUs,
      );
    const next = applyCsibDelta(current, delta);
    return next ? this.receive(next, recipient, atUs) : null;
  }
  receive(ad: DomainAdvertisement, recipient: number, atUs: number) {
    const current = this.csibs[recipient][ad.domainId];
    const accepted = ad.revision > current.revision;
    if (accepted) {
      this.setAdvertisement(recipient, ad);
      if (recipient === this.sourceDomain) this.inputCache = undefined;
    }
    this.record({
      atUs,
      type: accepted ? "csib-received" : "csib-discarded",
      origin: ad.domainId,
      recipient,
      revision: ad.revision,
    });
    return accepted;
  }
  private record(event: CsibEvent) {
    this.viewRevision++;
    this.events.push(event);
    if (
      this.search.mode === "bounded" &&
      this.events.length > this.search.traceLimit
    ) {
      const removed = Math.max(1, Math.floor(this.search.traceLimit / 10));
      this.events.splice(0, removed);
      this.traceOmitted += removed;
    }
  }
  view(copy = true): McsrView {
    if (this.cachedView?.revision === this.viewRevision)
      return copy
        ? structuredClone(this.cachedView.view)
        : this.cachedView.view;
    const view = {
      sourceDomain: this.sourceDomain,
      membership: [...this.partition.membership],
      domains: this.partition.domains.map((d) => {
        const revision = this.owned[d.id].revision,
          versions = this.csibs[d.id].map((a) => a.revision),
          cached = this.viewRows.get(d.id);
        if (
          cached &&
          cached.revision === revision &&
          versions.every((v, i) => v === cached.receivedVersions[i])
        )
          return cached;
        const row = { ...d, revision, receivedVersions: versions };
        this.viewRows.set(d.id, row);
        return row;
      }),
      events: this.events.slice(-24),
    };
    this.cachedView = { revision: this.viewRevision, view };
    return copy ? structuredClone(view) : view;
  }
  exportState() {
    if (this.search.mode === "bounded") {
      const advertisements = new Map<string, DomainAdvertisement>();
      for (const row of this.csibs)
        for (const ad of row)
          advertisements.set(`${ad.domainId}:${ad.revision}`, ad);
      return {
        ...this.view(),
        search: structuredClone(this.search),
        traceOmitted: this.traceOmitted,
        events: structuredClone(this.events),
        advertisements: structuredClone([...advertisements.values()]),
        csibs: this.csibs.map((entries, domainId) => ({
          domainId,
          versions: entries.map((a) => a.revision),
        })),
      };
    }
    return {
      ...this.view(),
      events: structuredClone(this.events),
      csibs: this.csibs.map((entries, domainId) => ({
        domainId,
        entries: structuredClone(entries),
      })),
    };
  }
  graph(domainId = this.sourceDomain, copy = true): RoutingGraph {
    const cached = this.graphCache.get(domainId);
    if (cached) return copy ? structuredClone(cached) : cached;
    const links = new Map<string, NetworkLink>();
    const ads = this.csibs[domainId];
    for (const ad of ads) {
      if (ad.links) {
        for (const l of ad.links) {
          if (
            this.partition.membership[l.sourceId] ===
              this.partition.membership[l.targetId] ||
            this.crossingOwner(l, ads, domainId) === ad.domainId
          )
            links.set(l.id, l);
        }
        continue;
      }
      for (const segment of ad.segments)
        for (const hop of segment.hops) links.set(hop.id, hop);
      // Local observations win; remote crossings use the newest report, then the lower domain id.
      for (const l of ad.crossings) {
        const newer = this.crossingOwner(l, ads, domainId);
        if (ad.domainId === newer) links.set(l.id, l);
      }
    }
    const result = {
      nodeCount: this.nodeCount,
      links: [...links.values()].sort((a, b) =>
        a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
      ),
    };
    this.graphCache.set(domainId, result);
    return copy ? structuredClone(result) : result;
  }
  availabilityKey(domainId: number) {
    if (this.search.mode === "bounded")
      return String(this.knownRevisions.get(domainId) ?? 0);
    const graph = this.graph(domainId, false);
    let key = this.availabilityKeys.get(graph);
    if (key === undefined) {
      key = graph.links
        .filter((l) => l.knownAvailable)
        .map((l) => l.id)
        .join("|");
      this.availabilityKeys.set(graph, key);
    }
    return key;
  }
  inputKey() {
    if (this.inputCache !== undefined) return this.inputCache;
    const graph = this.graph(undefined, false),
      reachable = new Set([this.partition.domains[this.sourceDomain].nodes[0]]);
    // All nodes in the source SRD are locally observable, even when that SRD splits.
    this.partition.domains[this.sourceDomain].nodes.forEach((n) =>
      reachable.add(n),
    );
    let changed = true;
    while (changed) {
      changed = false;
      for (const l of graph.links)
        if (
          l.knownAvailable &&
          (reachable.has(l.sourceId) || reachable.has(l.targetId))
        )
          for (const n of [l.sourceId, l.targetId])
            if (!reachable.has(n)) {
              reachable.add(n);
              changed = true;
            }
    }
    const ads = this.csibs[this.sourceDomain];
    // An endpoint-only advertisement can change available segments without changing any link observation.
    return (this.inputCache =
      fingerprint(
        graph.links.filter(
          (l) => reachable.has(l.sourceId) || reachable.has(l.targetId),
        ),
      ) +
      `|${this.sourceNode}:${this.target}:${ads[this.sourceDomain].revision}:${ads[this.partition.membership[this.target]].revision}`);
  }

  describe(candidates: PathCandidate[]): McsrAnalysis {
    const ads = this.csibs[this.sourceDomain],
      graph = this.graph(undefined, false);
    const used = new Set<number>([this.sourceDomain]);
    // Include alternative reachable domains, not just the currently selected path.
    const reachable = new Set<number>(
      this.partition.domains[this.sourceDomain].nodes,
    );
    const adjacency = new Map<number, number[]>();
    for (const l of graph.links)
      if (l.knownAvailable)
        for (const [a, b] of [
          [l.sourceId, l.targetId],
          [l.targetId, l.sourceId],
        ]) {
          if (!adjacency.has(a)) adjacency.set(a, []);
          adjacency.get(a)!.push(b);
        }
    const queue = [...reachable];
    for (let i = 0; i < queue.length; i++)
      for (const n of adjacency.get(queue[i]) ?? [])
        if (!reachable.has(n)) {
          reachable.add(n);
          queue.push(n);
        }
    for (const l of graph.links)
      if (reachable.has(l.sourceId) || reachable.has(l.targetId)) {
        used.add(this.partition.membership[l.sourceId]);
        used.add(this.partition.membership[l.targetId]);
      }
    return {
      ...(this.search.mode === "bounded"
        ? {
            coverage: "bounded" as const,
            allCandidatesGuaranteed: false as const,
          }
        : {}),
      dependencies: [...used]
        .sort((a, b) => a - b)
        .map((domainId) => ({ domainId, revision: ads[domainId].revision })),
      synchronized: ads.every((a, i) => a.revision === this.owned[i].revision),
      comparison: null,
      segments: candidates.map((c) => {
        const runs: { domainId: number; nodes: number[] }[] = [];
        for (const node of c.nodes) {
          const domainId = this.partition.membership[node];
          if (runs.at(-1)?.domainId === domainId) runs.at(-1)!.nodes.push(node);
          else runs.push({ domainId, nodes: [node] });
        }
        return {
          candidateId: candidateId(c.nodes),
          domains: runs.map((r) => r.domainId),
          runs,
        };
      }),
    };
  }
  *calculateSteps(
    source: number,
    target: number,
    report?: (s: DominantSearchSummary) => void,
  ): Generator<void, PathCandidate[]> {
    if (this.search.mode === "reference")
      return this.calculate(source, target, report);
    if (
      !Number.isInteger(source) ||
      !Number.isInteger(target) ||
      source < 0 ||
      target < 0 ||
      source >= this.nodeCount ||
      target >= this.nodeCount ||
      this.partition.membership[source] !== this.sourceDomain
    )
      throw new Error("잘못된 MCSR 출발·도착 노드입니다.");
    const graph = this.graph(undefined, false);
    const stats: DominantSearchSummary = {
      ...emptySearch(),
      coverage: "bounded",
      boundedPruned: 0,
    };
    const adjacency = new Map<number, SearchArc[]>();
    const add = (arc: SearchArc) => {
      const start = arc.nodes[0];
      if (!adjacency.has(start)) adjacency.set(start, []);
      adjacency.get(start)!.push(arc);
    };
    for (const ad of this.csibs[this.sourceDomain])
      for (const segment of ad.segments)
        if (segment.nodes.length > 1) add(segment);
    for (const l of graph.links)
      if (
        l.knownAvailable &&
        this.partition.membership[l.sourceId] !==
          this.partition.membership[l.targetId]
      )
        for (const [a, b] of [
          [l.sourceId, l.targetId],
          [l.targetId, l.sourceId],
        ])
          add({ nodes: [a, b], ...l.metrics });
    for (const ad of this.csibs[this.sourceDomain]) {
      stats.localExpandedStates =
        (stats.localExpandedStates ?? 0) + (ad.search?.expandedStates ?? 0);
      stats.localBoundedPruned =
        (stats.localBoundedPruned ?? 0) + (ad.search?.boundedPruned ?? 0);
    }
    const labels = yield* boundedLabels(
      adjacency,
      source,
      this.search.labelsPerBoundary,
      this.search.expansionLimit,
      stats,
      target,
    );
    const candidates = (labels.get(target) ?? []).map((c) =>
      evaluatePath(c.nodes, graph.links)!,
    );
    if (
      !candidates.length &&
      route(
        graph.nodeCount,
        graph.links
          .filter((l) => l.knownAvailable)
          .map((l) => [l.sourceId, l.targetId]),
        source,
        target,
      ).length
    )
      throw new DominantSearchError(
        "bounded-no-candidate",
        "연결은 있지만 제한 탐색에서 경로를 찾지 못했습니다. SRD 또는 탐색 한도를 조정하세요.",
        stats,
      );
    const frontier = finishBounded(
      candidates,
      this.search.endCandidates,
      stats,
    );
    validateCandidates(frontier, graph, source, target);
    this.lastAnalysis = this.describe(frontier);
    report?.(structuredClone(stats));
    return frontier;
  }
  calculate(
    source: number,
    target: number,
    report?: (s: DominantSearchSummary) => void,
  ): PathCandidate[] {
    if (this.search.mode === "bounded")
      return runSearch(this.calculateSteps(source, target, report));
    if (
      !Number.isInteger(source) ||
      !Number.isInteger(target) ||
      source < 0 ||
      target < 0 ||
      source >= this.nodeCount ||
      target >= this.nodeCount ||
      this.partition.membership[source] !== this.sourceDomain
    )
      throw new Error("MCSR 출발·도착 범위 또는 출발 영역이 잘못되었습니다.");
    const graph = this.graph(undefined, false),
      ads = this.csibs[this.sourceDomain],
      stats = emptySearch();
    const frontier: PathCandidate[] = [],
      membership = this.partition.membership;
    const paths = new Map<number, Segment[]>();
    for (const ad of ads)
      for (const p of ad.segments) {
        const start = p.nodes[0];
        if (!paths.has(start)) paths.set(start, []);
        paths.get(start)!.push(p);
      }
    const crossings = graph.links.filter(
      (l) =>
        l.knownAvailable && membership[l.sourceId] !== membership[l.targetId],
    );
    const remove = (c: PathCandidate, by: PathCandidate) => {
      stats.removedPaths++;
      if (stats.prunedSamples.length < 20)
        stats.prunedSamples.push({
          candidate: structuredClone(c),
          dominatedBy: candidateId(by.nodes),
        });
    };
    const finish = (nodes: number[]) => {
      stats.completedPaths++;
      const c = evaluatePath(nodes, graph.links)!;
      const better = frontier.find((p) => dominates(p, c));
      if (better) {
        remove(c, better);
        return;
      }
      for (let i = frontier.length - 1; i >= 0; i--)
        if (dominates(c, frontier[i])) {
          remove(frontier[i], c);
          frontier.splice(i, 1);
        }
      if (frontier.length >= DOMINANT_CANDIDATE_LIMIT)
        abort(
          "candidate-limit",
          "MCSR 종단 후보 한도(2,048개)를 초과했습니다.",
          stats,
        );
      frontier.push(c);
      stats.frontierSize = frontier.length;
    };
    const walk = (nodes: number[], metrics: typeof identity) => {
      if (++stats.expandedStates > DOMINANT_EXPANSION_LIMIT)
        abort(
          "expansion-limit",
          "MCSR 영역 간 탐색 한도(100,000회)를 초과했습니다.",
          stats,
        );
      const node = nodes.at(-1)!;
      if (node === target) {
        finish(nodes);
        return;
      }
      for (const segment of paths.get(node) ?? []) {
        if (segment.nodes.slice(1).some((n) => nodes.includes(n))) continue;
        const tail = segment.nodes.at(-1)!,
          combined = [...nodes, ...segment.nodes.slice(1)];
        const nextMetrics = extendMetrics(metrics, segment);
        if (tail === target) {
          finish(combined);
          continue;
        }
        if (segment.nodes.includes(target)) continue;
        for (const l of crossings) {
          const next =
            l.sourceId === tail
              ? l.targetId
              : l.targetId === tail
                ? l.sourceId
                : -1;
          if (next < 0 || combined.includes(next)) continue;
          walk([...combined, next], extendMetrics(nextMetrics, l.metrics));
        }
      }
    };
    walk([source], identity);
    frontier.sort((a, b) =>
      candidateId(a.nodes) < candidateId(b.nodes) ? -1 : 1,
    );
    validateCandidates(frontier, graph, source, target);
    const analysis = this.describe(frontier);
    // Verification is independent of route construction and never supplies replacement candidates.
    if (analysis.synchronized) {
      const reference = findDominantPaths(
          this.verificationGraph,
          source,
          target,
        ),
        expected = new Set(reference.map((p) => candidateId(p.nodes))),
        actual = new Set(frontier.map((p) => candidateId(p.nodes)));
      analysis.comparison = {
        matched: true,
        missing: [...expected].filter((id) => !actual.has(id)),
        extra: [...actual].filter((id) => !expected.has(id)),
      };
      analysis.comparison.matched =
        !analysis.comparison.missing.length &&
        !analysis.comparison.extra.length;
      if (!analysis.comparison.matched)
        throw new Error(
          `MCSR frontier mismatch: ${JSON.stringify(analysis.comparison)}`,
        );
    }
    this.lastAnalysis = analysis;
    stats.complete = true;
    stats.frontierSize = frontier.length;
    report?.(structuredClone(stats));
    return frontier;
  }
}
