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
  ): PathCandidate[];
}
export function linkMetrics(
  a: Vec3,
  b: Vec3,
  load: Readonly<LinkLoad>,
): LinkMetrics {
  return {
    propagationDelayMs: (distance(a, b) / LIGHT_SPEED_M_S) * 1000,
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
  algorithm: "bfs" | "candidate-paths";
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
): RoutingStrategy {
  if (settings.algorithm === "bfs") return bfsStrategy;
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
