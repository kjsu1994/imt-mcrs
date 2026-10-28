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
  membership: number[];
  domains: (SrdDomain & { revision: number; receivedVersions: number[] })[];
  events: CsibEvent[];
}
export interface McsrAnalysis {
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
function summary(): DominantSearchSummary {
  return {
    complete: false,
    expandedStates: 0,
    completedPaths: 0,
    frontierSize: 0,
    removedPaths: 0,
    prunedSamples: [],
  };
}
function abort(
  code: DominantSearchError["code"],
  message: string,
  search: DominantSearchSummary,
): never {
  throw new DominantSearchError(code, message, structuredClone(search));
}
// shortcut: reliable direct DS broadcasts use configured delays; model control transport when packet-level validation is needed.
export class McsrController {
  readonly partition: SrdPartition;
  readonly sourceDomain: number;
  readonly events: CsibEvent[] = [];
  private owned: DomainAdvertisement[];
  private csibs: DomainAdvertisement[][];
  private signatures: string[];
  private nodeCount: number;
  private verificationGraph: RoutingGraph;
  lastAnalysis: McsrAnalysis | undefined;
  constructor(
    config: Pick<Config, "planes" | "perPlane">,
    settings: SrdSettings,
    graph: RoutingGraph,
    source: number,
  ) {
    if (
      !Number.isInteger(config.planes) ||
      !Number.isInteger(config.perPlane) ||
      config.planes < 1 ||
      config.perPlane < 1 ||
      config.planes * config.perPlane !== graph.nodeCount
    )
      throw new Error("SRD 성좌와 그래프의 노드 수가 일치해야 합니다.");
    if (graph.nodeCount > DOMINANT_NODE_LIMIT)
      abort(
        "node-limit",
        "MCSR 검증 모드는 16기 이하에서 지원합니다.",
        summary(),
      );
    // Validate graph structure without using the reference search to choose a route.
    findDominantPaths(
      {
        ...graph,
        links: graph.links.map((l) => ({ ...l, knownAvailable: false })),
      },
      source,
      source,
    );
    this.nodeCount = graph.nodeCount;
    this.verificationGraph = structuredClone(graph);
    this.partition = partitionSrds(config, settings, graph.links);
    this.sourceDomain = this.partition.membership[source];
    this.signatures = this.partition.domains.map((d) =>
      fingerprint(this.ownerLinks(graph, d.id)),
    );
    this.owned = this.partition.domains.map((d) =>
      this.advertise(graph, d.id, 0, 0),
    );
    // Initial synchronized bootstrap, before the measured experiment begins.
    this.csibs = this.owned.map(() => [...this.owned]);
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
    const segments: Segment[] = [];
    const search = summary();
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
      this.csibs[d.id][d.id] = next;
      this.events.push({
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
  receive(ad: DomainAdvertisement, recipient: number, atUs: number) {
    const current = this.csibs[recipient][ad.domainId];
    const accepted = ad.revision > current.revision;
    if (accepted) this.csibs[recipient][ad.domainId] = ad;
    this.events.push({
      atUs,
      type: accepted ? "csib-received" : "csib-discarded",
      origin: ad.domainId,
      recipient,
      revision: ad.revision,
    });
    return accepted;
  }
  view(): McsrView {
    return {
      sourceDomain: this.sourceDomain,
      membership: [...this.partition.membership],
      domains: this.partition.domains.map((d) => ({
        ...structuredClone(d),
        revision: this.owned[d.id].revision,
        receivedVersions: this.csibs[d.id].map((a) => a.revision),
      })),
      events: structuredClone(this.events.slice(-24)),
    };
  }
  exportState() {
    return {
      ...this.view(),
      events: structuredClone(this.events),
      csibs: this.csibs.map((entries, domainId) => ({
        domainId,
        entries: structuredClone(entries),
      })),
    };
  }
  graph(): RoutingGraph {
    const links = new Map<string, NetworkLink>();
    const ads = this.csibs[this.sourceDomain];
    for (const ad of ads) {
      for (const segment of ad.segments)
        for (const hop of segment.hops) links.set(hop.id, hop);
      // Local observations win; remote crossings use the newest report, then the lower domain id.
      for (const l of ad.crossings) {
        const a = this.partition.membership[l.sourceId],
          b = this.partition.membership[l.targetId];
        const newer =
          this.sourceDomain === a || this.sourceDomain === b
            ? this.sourceDomain
            : ads[a].atUs > ads[b].atUs
              ? a
              : ads[b].atUs > ads[a].atUs
                ? b
                : Math.min(a, b);
        if (ad.domainId === newer) links.set(l.id, l);
      }
    }
    return {
      nodeCount: this.nodeCount,
      links: structuredClone(
        [...links.values()].sort((a, b) =>
          a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
        ),
      ),
    };
  }
  inputKey() {
    const graph = this.graph(),
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
    return fingerprint(
      graph.links.filter(
        (l) => reachable.has(l.sourceId) || reachable.has(l.targetId),
      ),
    );
  }
  describe(candidates: PathCandidate[]): McsrAnalysis {
    const ads = this.csibs[this.sourceDomain],
      graph = this.graph();
    const used = new Set<number>([this.sourceDomain]);
    // Include alternative reachable domains, not just the currently selected path.
    const reachable = new Set<number>(
      this.partition.domains[this.sourceDomain].nodes,
    );
    for (let i = 0; i < this.nodeCount; i++)
      for (const l of graph.links)
        if (
          l.knownAvailable &&
          (reachable.has(l.sourceId) || reachable.has(l.targetId))
        ) {
          reachable.add(l.sourceId);
          reachable.add(l.targetId);
        }
    for (const l of graph.links)
      if (reachable.has(l.sourceId) || reachable.has(l.targetId)) {
        used.add(this.partition.membership[l.sourceId]);
        used.add(this.partition.membership[l.targetId]);
      }
    return {
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
  calculate(
    source: number,
    target: number,
    report?: (s: DominantSearchSummary) => void,
  ): PathCandidate[] {
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
    const graph = this.graph(),
      ads = this.csibs[this.sourceDomain],
      stats = summary();
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
