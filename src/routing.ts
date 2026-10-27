import { route } from "./model";
export function computeRoute(
  count: number,
  edges: [number, number][],
  source: number,
  target: number,
) {
  const started = performance.now();
  const path = route(count, edges, source, target);
  return { path, wallMs: performance.now() - started };
}
