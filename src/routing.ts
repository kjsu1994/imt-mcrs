import { route, distance } from "./model";
import type { Vec3 } from "./model";

export interface LinkMetrics {
  propagationDelayMs: number;
  availableBufferRatio: number;
  jitterMs: number;
}
export interface LinkLoad {
  bufferCapacityPackets: number;
  queuedPackets: number;
  jitterMs: number;
}
export const DEFAULT_LINK_LOAD: Readonly<LinkLoad> = Object.freeze({
  bufferCapacityPackets: 1000,
  queuedPackets: 0,
  jitterMs: 0,
});
export const LIGHT_SPEED_M_S = 299792458;
export interface NetworkLink {
  id: string;
  sourceId: number;
  targetId: number;
  knownAvailable: boolean;
  metrics: LinkMetrics;
}
export interface RoutingGraph {
  nodeCount: number;
  links: NetworkLink[];
}
export interface PathCandidate extends LinkMetrics {
  nodes: number[];
}
export interface RoutingStrategy {
  readonly name: string;
  readonly reactsToMetrics?: boolean;
  // The engine independently validates and ranks candidates for the service.
  calculate(
    graph: RoutingGraph,
    source: number,
    target: number,
    reportSearch?: (summary: DominantSearchSummary) => void,
  ): PathCandidate[];
}
export function linkMetrics(
  a: Vec3,
  b: Vec3,
  load: Readonly<LinkLoad>,
): LinkMetrics {
  return {
    // Picosecond resolution removes platform math roundoff from routing decisions.
    propagationDelayMs: Number(
      ((distance(a, b) / LIGHT_SPEED_M_S) * 1000).toFixed(9),
    ),
    availableBufferRatio:
      (load.bufferCapacityPackets - load.queuedPackets) /
      load.bufferCapacityPackets,
    jitterMs: load.jitterMs,
  };
}
export function extendMetrics(
  path: LinkMetrics,
  link: LinkMetrics,
): LinkMetrics {
  return {
    propagationDelayMs: path.propagationDelayMs + link.propagationDelayMs,
    availableBufferRatio: Math.min(
      path.availableBufferRatio,
      link.availableBufferRatio,
    ),
    jitterMs: Math.max(path.jitterMs, link.jitterMs),
  };
}
export function evaluatePath(
  nodes: number[],
  links: NetworkLink[],
): PathCandidate | null {
  if (!nodes.length) return null;
  const byPair = new Map(links.map((l) => [pairId(l.sourceId, l.targetId), l]));
  let metrics: LinkMetrics = {
    propagationDelayMs: 0,
    availableBufferRatio: 1,
    jitterMs: 0,
  };
  for (let i = 1; i < nodes.length; i++) {
    const link = byPair.get(pairId(nodes[i - 1], nodes[i]));
    if (!link?.knownAvailable) return null;
    metrics = extendMetrics(metrics, link.metrics);
  }
  return { nodes: [...nodes], ...metrics };
}
const pairId = (a: number, b: number) => `${Math.min(a, b)}:${Math.max(a, b)}`;
export const bfsStrategy: RoutingStrategy = {
  name: "BFS",
  reactsToMetrics: false,
  calculate(graph, source, target) {
    const nodes = route(
      graph.nodeCount,
      graph.links
        .filter((l) => l.knownAvailable)
        .map((l) => [l.sourceId, l.targetId]),
      source,
      target,
    );
    const candidate = evaluatePath(nodes, graph.links);
    return candidate ? [candidate] : [];
  },
};

export type ServiceType = "LS" | "TS" | "HR";
export type RoutingSettings = {
  algorithm: "bfs" | "candidate-paths" | "dominant-paths" | "mcsr";
  service: ServiceType;
  candidatePaths: number[][];
};
export type CandidateDecision = {
  id: string;
  nodes: number[];
  metrics: LinkMetrics | null;
  status:
    "selected" | "eligible" | "dominated" | "jitter-limit" | "unavailable";
  reason: string;
};
export type RoutingAnalysis = {
  status: "pending" | "installed" | "retained" | "discarded";
  id: number;
  atUs: number;
  inputRevision: number;
  algorithm: string;
  service: ServiceType;
  mode: "initial" | "recalculate" | "reserve";
  trigger: string;
  selectedId: string | null;
  candidates: CandidateDecision[];
  search?: DominantSearchSummary;
  mcsr?: import("./mcsr").McsrAnalysis;
};
export const candidateId = (nodes: number[]) => nodes.join(":");
export function pathProblem(
  nodes: number[],
  graph: RoutingGraph,
  source: number,
  target: number,
): string | null {
  if (!Array.isArray(nodes) || !nodes.length) return "empty-path";
  if (nodes.some((n) => !Number.isInteger(n) || n < 0 || n >= graph.nodeCount))
    return "node-range";
  if (nodes[0] !== source || nodes.at(-1) !== target) return "endpoints";
  if (new Set(nodes).size !== nodes.length) return "cycle";
  if (!evaluatePath(nodes, graph.links)) return "unavailable-link";
  return null;
}
export function validateCandidates(
  input: PathCandidate[],
  graph: RoutingGraph,
  source: number,
  target: number,
): PathCandidate[] {
  if (!Array.isArray(input))
    throw new Error("Routing strategy must return an array of candidates.");
  const seen = new Set<string>();
  const result: PathCandidate[] = [];
  for (const candidate of input) {
    const problem =
      candidate && pathProblem(candidate.nodes, graph, source, target);
    if (!candidate || problem)
      throw new Error(
        `Invalid routing candidate: ${problem ?? "missing-candidate"}`,
      );
    const actual = evaluatePath(candidate.nodes, graph.links)!;
    for (const key of [
      "propagationDelayMs",
      "availableBufferRatio",
      "jitterMs",
    ] as const) {
      if (
        !Number.isFinite(candidate[key]) ||
        candidate[key] < 0 ||
        (key === "availableBufferRatio" && candidate[key] > 1) ||
        Math.abs(candidate[key] - actual[key]) >
          1e-9 * Math.max(1, Math.abs(actual[key]))
      )
        throw new Error(`Invalid routing candidate: metric-mismatch (${key})`);
    }
    const id = candidateId(actual.nodes);
    if (!seen.has(id)) {
      seen.add(id);
      result.push(actual);
    }
  }
  return result;
}
export function dominates(a: LinkMetrics, b: LinkMetrics): boolean {
  return (
    a.propagationDelayMs <= b.propagationDelayMs &&
    a.availableBufferRatio >= b.availableBufferRatio &&
    a.jitterMs <= b.jitterMs &&
    (a.propagationDelayMs < b.propagationDelayMs ||
      a.availableBufferRatio > b.availableBufferRatio ||
      a.jitterMs < b.jitterMs)
  );
}
export function analyseCandidates(
  candidates: PathCandidate[],
  service: ServiceType,
) {
  const eligible = candidates.filter(
    (c) => service !== "HR" || c.jitterMs < 15,
  );
  const frontier = eligible.filter(
    (c) => !eligible.some((other) => dominates(other, c)),
  );
  const ranked = [...frontier].sort(
    (a, b) =>
      (service === "LS"
        ? a.propagationDelayMs - b.propagationDelayMs ||
          b.availableBufferRatio - a.availableBufferRatio
        : b.availableBufferRatio - a.availableBufferRatio ||
          a.propagationDelayMs - b.propagationDelayMs) ||
      a.jitterMs - b.jitterMs ||
      (candidateId(a.nodes) < candidateId(b.nodes)
        ? -1
        : candidateId(a.nodes) > candidateId(b.nodes)
          ? 1
          : 0),
  );
  const selected = ranked[0] ?? null;
  const decisions: CandidateDecision[] = candidates.map((c) => {
    const excluded = service === "HR" && c.jitterMs >= 15;
    const dominator = eligible.find((other) => dominates(other, c));
    return {
      id: candidateId(c.nodes),
      nodes: [...c.nodes],
      metrics: {
        propagationDelayMs: c.propagationDelayMs,
        availableBufferRatio: c.availableBufferRatio,
        jitterMs: c.jitterMs,
      },
      status:
        c === selected
          ? "selected"
          : excluded
            ? "jitter-limit"
            : dominator
              ? "dominated"
              : "eligible",
      reason:
        c === selected
          ? `${service}-preference`
          : excluded
            ? "J must be < 15 ms"
            : dominator
              ? `dominated by ${candidateId(dominator.nodes)}`
              : "reserve-candidate",
    };
  });
  return { selected, decisions };
}
export function createRoutingStrategy(
  settings: RoutingSettings,
  mcsr?: RoutingStrategy,
): RoutingStrategy {
  if (settings.algorithm === "mcsr") {
    if (!mcsr) throw new Error("MCSR 영역 상태가 필요합니다.");
    return mcsr;
  }
  if (settings.algorithm === "bfs") return bfsStrategy;
  if (settings.algorithm === "dominant-paths")
    return {
      name: "Dominant paths (reference)",
      reactsToMetrics: true,
      calculate: findDominantPaths,
    };
  return {
    name: "Configured candidates",
    reactsToMetrics: true,
    calculate(graph, source, target) {
      return settings.candidatePaths
        .filter((nodes) => !pathProblem(nodes, graph, source, target))
        .map((nodes) => evaluatePath(nodes, graph.links)!);
    },
  };
}

export const DOMINANT_NODE_LIMIT = 16;
export const DOMINANT_EXPANSION_LIMIT = 100000;
export const DOMINANT_CANDIDATE_LIMIT = 2048;
export interface DominantSearchSummary {
  complete: boolean;
  coverage?: "bounded";
  boundedPruned?: number;
  localExpandedStates?: number;
  localBoundedPruned?: number;
  limitedSamples?: {
    nodes: number[];
    reason: "label-limit" | "end-candidate-limit";
  }[];
  expandedStates: number;
  completedPaths: number;
  frontierSize: number;
  removedPaths: number;
  prunedSamples: { candidate: PathCandidate; dominatedBy: string }[];
}
export class DominantSearchError extends Error {
  constructor(
    public readonly code:
      | "node-limit"
      | "expansion-limit"
      | "candidate-limit"
      | "invalid-graph"
      | "bounded-no-candidate",
    message: string,
    public readonly search: DominantSearchSummary,
  ) {
    super(message);
    this.name = "DominantSearchError";
  }
}
export function validateRoutingGraph(
  graph: RoutingGraph,
  source: number,
  target: number,
) {
  const abort = (_code: "invalid-graph", message: string): never => {
    throw new DominantSearchError("invalid-graph", message, {
      complete: false,
      expandedStates: 0,
      completedPaths: 0,
      frontierSize: 0,
      removedPaths: 0,
      prunedSamples: [],
    });
  };
  if (!Number.isInteger(graph.nodeCount) || graph.nodeCount < 1)
    abort("invalid-graph", "잘못된 그래프 노드 수입니다.");
  if (
    !Number.isInteger(source) ||
    !Number.isInteger(target) ||
    source < 0 ||
    target < 0 ||
    source >= graph.nodeCount ||
    target >= graph.nodeCount
  )
    abort("invalid-graph", "출발·도착 노드 범위가 잘못되었습니다.");
  const adjacent: { node: number; metrics: LinkMetrics }[][] = Array.from(
    { length: graph.nodeCount },
    () => [],
  );
  const seen = new Set<string>(),
    seenIds = new Set<string>();
  for (const link of graph.links) {
    const a = link.sourceId,
      b = link.targetId,
      m = link.metrics,
      key = pairId(a, b);
    if (
      !Number.isInteger(a) ||
      !Number.isInteger(b) ||
      a < 0 ||
      b < 0 ||
      a >= graph.nodeCount ||
      b >= graph.nodeCount ||
      a === b ||
      typeof link.id !== "string" ||
      !link.id ||
      seenIds.has(link.id) ||
      seen.has(key) ||
      typeof link.knownAvailable !== "boolean" ||
      !m ||
      ![m.propagationDelayMs, m.availableBufferRatio, m.jitterMs].every(
        Number.isFinite,
      ) ||
      m.propagationDelayMs < 0 ||
      m.availableBufferRatio < 0 ||
      m.availableBufferRatio > 1 ||
      m.jitterMs < 0
    )
      abort("invalid-graph", "잘못되었거나 중복된 그래프 링크입니다.");
    seen.add(key);
    seenIds.add(link.id);
    if (link.knownAvailable) {
      adjacent[a].push({ node: b, metrics: m });
      adjacent[b].push({ node: a, metrics: m });
    }
  }
  adjacent.forEach((neighbors) => neighbors.sort((a, b) => a.node - b.node));
  return adjacent;
}
// Reference search for small graphs; no prefix pruning that could discard distinct spare paths.
export function findDominantPaths(
  graph: RoutingGraph,
  source: number,
  target: number,
  reportSearch?: (summary: DominantSearchSummary) => void,
): PathCandidate[] {
  const summary: DominantSearchSummary = {
    complete: false,
    expandedStates: 0,
    completedPaths: 0,
    frontierSize: 0,
    removedPaths: 0,
    prunedSamples: [],
  };
  let frontier: PathCandidate[] = [];
  const abort = (code: DominantSearchError["code"], message: string): never => {
    summary.frontierSize = frontier.length;
    throw new DominantSearchError(code, message, structuredClone(summary));
  };
  if (graph.nodeCount > DOMINANT_NODE_LIMIT)
    abort("node-limit", "자동 우세 경로는 16기 이하에서 지원합니다.");
  const adjacent = validateRoutingGraph(graph, source, target);
  const removed = (candidate: PathCandidate, by: PathCandidate) => {
    summary.removedPaths++;
    if (summary.prunedSamples.length < 20)
      summary.prunedSamples.push({
        candidate: structuredClone(candidate),
        dominatedBy: candidateId(by.nodes),
      });
  };
  const nodes = [source],
    visited = new Set(nodes);
  function visit(node: number, metrics: LinkMetrics) {
    if (node === target) {
      summary.completedPaths++;
      const candidate: PathCandidate = { nodes: [...nodes], ...metrics };
      const dominator = frontier.find((other) => dominates(other, candidate));
      if (dominator) {
        removed(candidate, dominator);
        return;
      }
      frontier = frontier.filter((other) => {
        if (dominates(candidate, other)) {
          removed(other, candidate);
          return false;
        }
        return true;
      });
      if (frontier.length >= DOMINANT_CANDIDATE_LIMIT)
        abort(
          "candidate-limit",
          "자동 우세 경로 후보 한도(2,048개)를 초과했습니다. 부분 결과는 사용하지 않습니다.",
        );
      frontier.push(candidate);
      return;
    }
    for (const next of adjacent[node]) {
      if (visited.has(next.node)) continue;
      if (summary.expandedStates >= DOMINANT_EXPANSION_LIMIT)
        abort(
          "expansion-limit",
          "자동 우세 경로 탐색 한도(100,000회)를 초과했습니다. 부분 결과는 사용하지 않습니다.",
        );
      summary.expandedStates++;
      visited.add(next.node);
      nodes.push(next.node);
      visit(next.node, extendMetrics(metrics, next.metrics));
      nodes.pop();
      visited.delete(next.node);
    }
  }
  visit(source, {
    propagationDelayMs: 0,
    availableBufferRatio: 1,
    jitterMs: 0,
  });
  frontier.sort((a, b) =>
    candidateId(a.nodes) < candidateId(b.nodes)
      ? -1
      : candidateId(a.nodes) > candidateId(b.nodes)
        ? 1
        : 0,
  );
  summary.complete = true;
  summary.frontierSize = frontier.length;
  reportSearch?.(structuredClone(summary));
  return frontier;
}
