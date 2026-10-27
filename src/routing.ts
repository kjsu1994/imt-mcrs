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
  // Candidates are ordered by preference; the engine installs the first.
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
