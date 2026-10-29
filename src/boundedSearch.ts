import {
  DominantSearchError,
  candidateId,
  dominates,
  extendMetrics,
} from "./routing";
import type {
  DominantSearchSummary,
  LinkMetrics,
  PathCandidate,
} from "./routing";

export interface McsrSearchSettings {
  mode: "reference" | "bounded";
  localCandidates: number;
  labelsPerBoundary: number;
  endCandidates: number;
  expansionLimit: number;
  delayPublishIntervalUs: number;
  metricCoalesceUs: number;
  traceLimit: number;
  controlEventLimit: number;
}
export function searchDefaults(
  nodeCount: number,
  mode: McsrSearchSettings["mode"] = nodeCount <= 16 ? "reference" : "bounded",
): McsrSearchSettings {
  return {
    mode,
    localCandidates: 4,
    labelsPerBoundary: 16,
    endCandidates: 8,
    expansionLimit: nodeCount <= 72 ? 200000 : 2000000,
    delayPublishIntervalUs: 30000000,
    metricCoalesceUs: 100000,
    traceLimit: 10000,
    controlEventLimit: 50000000,
  };
}
export const emptySearch = (): DominantSearchSummary => ({
  complete: false,
  expandedStates: 0,
  completedPaths: 0,
  frontierSize: 0,
  removedPaths: 0,
  prunedSamples: [],
});
export interface SearchArc extends LinkMetrics {
  nodes: number[];
}
const keys = new WeakMap<PathCandidate, string>();
class Label implements PathCandidate {
  private materialized?: number[];
  constructor(
    readonly parent: Label | undefined,
    readonly suffix: number[],
    readonly tail: number,
    readonly visited: bigint,
    readonly propagationDelayMs: number,
    readonly availableBufferRatio: number,
    readonly jitterMs: number,
    readonly pathKey: string,
  ) {}
  get nodes(): number[] {
    return (this.materialized ??= this.parent
      ? [...this.parent.nodes, ...this.suffix]
      : this.suffix);
  }
}
const key = (p: PathCandidate) => {
  if (p instanceof Label) return p.pathKey;
  let value = keys.get(p);
  if (value === undefined) {
    value = candidateId(p.nodes);
    keys.set(p, value);
  }
  return value;
};
const metricOrder = (axis: number, a: LinkMetrics, b: LinkMetrics) =>
  (axis === 0
    ? a.propagationDelayMs - b.propagationDelayMs
    : axis === 1
      ? b.availableBufferRatio - a.availableBufferRatio
      : a.jitterMs - b.jitterMs) ||
  a.propagationDelayMs - b.propagationDelayMs ||
  b.availableBufferRatio - a.availableBufferRatio ||
  a.jitterMs - b.jitterMs;
const order = (axis: number, a: PathCandidate, b: PathCandidate) =>
  metricOrder(axis, a, b) || (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
// shortcut: bounded labels cannot prove the complete Pareto set; use reference mode on small graphs for that guarantee.
export function balancedCandidates<T extends PathCandidate>(
  candidates: T[],
  limit: number,
): T[] {
  if (candidates.length <= limit) return candidates;
  const lists = [0, 1, 2].map((axis) =>
    [...candidates].sort((a, b) => order(axis, a, b)),
  );
  const selected = new Set<T>();
  for (let i = 0; selected.size < limit; i++)
    for (const list of lists) {
      if (list[i]) selected.add(list[i]);
      if (selected.size === limit) break;
    }
  return [...selected];
}
const rankings = new WeakMap<PathCandidate[], PathCandidate[][]>();
function offer(
  prior: PathCandidate[],
  next: PathCandidate,
  limit: number,
): PathCandidate[] {
  if (prior.length < limit) return [...prior, next];
  let lists = rankings.get(prior);
  if (!lists) {
    lists = [0, 1, 2].map((axis) =>
      [...prior].sort((a, b) => order(axis, a, b)),
    );
    rankings.set(prior, lists);
  }
  if (lists.every((list, axis) => order(axis, next, list.at(-1)!) >= 0))
    return prior;
  const expanded = lists.map((list, axis) => {
    const out = [...list];
    let lo = 0,
      hi = out.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (order(axis, out[mid], next) <= 0) lo = mid + 1;
      else hi = mid;
    }
    out.splice(lo, 0, next);
    return out;
  });
  const chosen = new Set<PathCandidate>();
  for (let i = 0; chosen.size < limit; i++)
    for (const list of expanded) {
      chosen.add(list[i]);
      if (chosen.size === limit) break;
    }
  if (!chosen.has(next)) return prior;
  const retained = [...chosen];
  rankings.set(
    retained,
    expanded.map((list) => list.filter((p) => chosen.has(p))),
  );
  return retained;
}
class Heap<T> {
  private values: T[] = [];
  constructor(private compare: (a: T, b: T) => number) {}
  push(value: T) {
    const a = this.values;
    let i = a.length;
    a.push(value);
    while (i) {
      const p = (i - 1) >> 1;
      if (this.compare(a[p], value) <= 0) break;
      a[i] = a[p];
      i = p;
    }
    a[i] = value;
  }
  pop(): T | undefined {
    const a = this.values,
      first = a[0],
      last = a.pop();
    if (a.length) {
      let i = 0;
      while (i * 2 + 1 < a.length) {
        let c = i * 2 + 1;
        if (c + 1 < a.length && this.compare(a[c + 1], a[c]) < 0) c++;
        if (this.compare(last!, a[c]) <= 0) break;
        a[i] = a[c];
        i = c;
      }
      a[i] = last!;
    }
    return first;
  }
}
export function* boundedLabels(
  adjacency: Map<number, SearchArc[]>,
  source: number,
  labelLimit: number,
  expansionLimit: number,
  stats = emptySearch(),
  target?: number,
): Generator<void, Map<number, PathCandidate[]>> {
  const prepared = new Map(
    [...adjacency].map(([node, arcs]) => [
      node,
      arcs.map((arc) => {
        const suffix = arc.nodes.slice(1);
        return {
          arc,
          suffix,
          tail: arc.nodes.at(-1)!,
          key: suffix.join(":"),
          mask: suffix.reduce((mask, n) => mask | (1n << BigInt(n)), 0n),
        };
      }),
    ]),
  );
  const labels = new Map<number, PathCandidate[]>();
  const heap = new Heap<Label>((a, b) => order(0, a, b));
  const initial = new Label(
    undefined,
    [source],
    source,
    1n << BigInt(source),
    0,
    1,
    0,
    String(source),
  );
  labels.set(source, [initial]);
  heap.push(initial);
  let current: Label | undefined;
  while ((current = heap.pop())) {
    const node = current.tail;
    if (!labels.get(node)?.includes(current)) continue;
    if (stats.expandedStates >= expansionLimit)
      throw new DominantSearchError(
        "expansion-limit",
        "MCSR 제한 탐색 예산을 초과했습니다. 부분 결과는 설치하지 않습니다.",
        structuredClone(stats),
      );
    stats.expandedStates++;
    if (stats.expandedStates % 64 === 0) yield;
    if (node === target) {
      stats.completedPaths++;
      continue;
    }
    for (const { arc, suffix, tail, key: suffixKey, mask } of prepared.get(
      node,
    ) ?? []) {
      if (!suffix.length || (current.visited & mask) !== 0n) continue;
      const prior = labels.get(tail) ?? [],
        metrics = extendMetrics(current, arc);
      const ranks = rankings.get(prior);
      if (
        prior.length === labelLimit &&
        ranks?.every(
          (list, axis) => metricOrder(axis, metrics, list.at(-1)!) > 0,
        )
      ) {
        stats.boundedPruned = (stats.boundedPruned ?? 0) + 1;
        if ((stats.limitedSamples?.length ?? 0) < 20)
          (stats.limitedSamples ??= []).push({
            nodes: [...current.nodes, ...suffix],
            reason: "label-limit",
          });
        continue;
      }
      const next = new Label(
        current,
        suffix,
        tail,
        current.visited | mask,
        metrics.propagationDelayMs,
        metrics.availableBufferRatio,
        metrics.jitterMs,
        `${current.pathKey}:${suffixKey}`,
      );
      if (prior.some((p) => key(p) === key(next))) continue;
      const retained = offer(prior, next, labelLimit);
      stats.boundedPruned =
        (stats.boundedPruned ?? 0) + prior.length + 1 - retained.length;
      if (
        retained.length < prior.length + 1 &&
        (stats.limitedSamples?.length ?? 0) < 20
      ) {
        const omitted = [...prior, next].find((p) => !retained.includes(p))!;
        (stats.limitedSamples ??= []).push({
          nodes: omitted.nodes,
          reason: "label-limit",
        });
      }
      labels.set(tail, retained);
      if (retained.includes(next)) heap.push(next);
    }
  }
  return new Map(
    [...labels]
      .filter(([node]) => target === undefined || node === target)
      .map(([node, paths]) => [
        node,
        paths.map((p) => ({
          nodes: p.nodes,
          propagationDelayMs: p.propagationDelayMs,
          availableBufferRatio: p.availableBufferRatio,
          jitterMs: p.jitterMs,
        })),
      ]),
  );
}
export function finishBounded(
  candidates: PathCandidate[],
  limit: number,
  stats: DominantSearchSummary,
) {
  const frontier = candidates.filter(
    (c) => !candidates.some((p) => dominates(p, c)),
  );
  stats.removedPaths += candidates.length - frontier.length;
  for (const c of candidates) {
    const by = candidates.find((p) => dominates(p, c));
    if (by && stats.prunedSamples.length < 20)
      stats.prunedSamples.push({
        candidate: c,
        dominatedBy: candidateId(by.nodes),
      });
  }
  const retained = balancedCandidates(frontier, limit);
  stats.boundedPruned =
    (stats.boundedPruned ?? 0) + frontier.length - retained.length;
  for (const c of frontier)
    if (!retained.includes(c) && (stats.limitedSamples?.length ?? 0) < 20)
      (stats.limitedSamples ??= []).push({
        nodes: c.nodes,
        reason: "end-candidate-limit",
      });
  retained.sort((a, b) =>
    candidateId(a.nodes) < candidateId(b.nodes) ? -1 : 1,
  );
  stats.complete = true;
  stats.frontierSize = retained.length;
  return retained;
}
export function runSearch<T>(job: Generator<void, T>): T {
  let step = job.next();
  while (!step.done) step = job.next();
  return step.value;
}
