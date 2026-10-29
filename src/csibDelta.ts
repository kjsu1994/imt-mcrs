import type { DomainAdvertisement } from "./mcsr";
import { candidateId } from "./routing";
export interface CsibDelta {
  domainId: number;
  baseRevision: number;
  revision: number;
  atUs: number;
  changedLinks: NonNullable<DomainAdvertisement["links"]>;
  changedSegments: DomainAdvertisement["segments"];
  removedSegments: string[];
  crossings: DomainAdvertisement["crossings"];
  search?: DomainAdvertisement["search"];
}
const cache = new WeakMap<
  DomainAdvertisement,
  WeakMap<DomainAdvertisement, CsibDelta>
>();
export function makeCsibDelta(
  previous: DomainAdvertisement,
  next: DomainAdvertisement,
): CsibDelta {
  if (
    !previous.links ||
    !next.links ||
    previous.domainId !== next.domainId ||
    previous.revision >= next.revision
  )
    throw new Error("잘못된 CSIB 변경분 기준입니다.");
  let entries = cache.get(previous);
  if (!entries) {
    entries = new WeakMap();
    cache.set(previous, entries);
  }
  const cached = entries.get(next);
  if (cached) return cached;
  const links = new Map(previous.links.map((l) => [l.id, l]));
  const segments = new Map(
    previous.segments.map((p) => [candidateId(p.nodes), p]),
  );
  const ids = new Set(next.segments.map((p) => candidateId(p.nodes)));
  const delta: CsibDelta = {
    domainId: next.domainId,
    baseRevision: previous.revision,
    revision: next.revision,
    atUs: next.atUs,
    changedLinks: next.links.filter(
      (l) => JSON.stringify(l) !== JSON.stringify(links.get(l.id)),
    ),
    changedSegments: next.segments.filter(
      (p) =>
        JSON.stringify(p) !==
        JSON.stringify(segments.get(candidateId(p.nodes))),
    ),
    removedSegments: [...segments.keys()].filter((id) => !ids.has(id)),
    crossings: next.crossings,
    search: next.search,
  };
  entries.set(next, delta);
  return delta;
}
const appliedCache = new WeakMap<
  DomainAdvertisement,
  WeakMap<CsibDelta, DomainAdvertisement>
>();
export function applyCsibDelta(
  previous: DomainAdvertisement,
  delta: CsibDelta,
): DomainAdvertisement | null {
  if (
    previous.domainId !== delta.domainId ||
    previous.revision !== delta.baseRevision
  )
    return null;
  const cached = appliedCache.get(previous)?.get(delta);
  if (cached) return cached;
  if (!previous.links || delta.revision <= delta.baseRevision)
    throw new Error("잘못된 CSIB 리비전입니다.");
  const links = new Map(previous.links.map((l) => [l.id, l]));
  for (const l of delta.changedLinks) {
    if (!links.has(l.id)) throw new Error("알 수 없는 CSIB 링크 변경입니다.");
    links.set(l.id, l);
  }
  const segments = new Map(
    previous.segments.map((p) => [candidateId(p.nodes), p]),
  );
  for (const id of delta.removedSegments) segments.delete(id);
  for (const p of delta.changedSegments) segments.set(candidateId(p.nodes), p);
  const result = {
    domainId: delta.domainId,
    revision: delta.revision,
    atUs: delta.atUs,
    links: [...links.values()],
    crossings: delta.crossings,
    search: delta.search,
    segments: [...segments.values()].sort((a, b) =>
      candidateId(a.nodes) < candidateId(b.nodes) ? -1 : 1,
    ),
  };
  let entries = appliedCache.get(previous);
  if (!entries) {
    entries = new WeakMap();
    appliedCache.set(previous, entries);
  }
  entries.set(delta, result);
  return result;
}
