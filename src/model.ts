export const EARTH_RADIUS = 6378137,
  MU = 3.986004418e14,
  DAY = 86400;
const TAU = Math.PI * 2;
export type Vec3 = { x: number; y: number; z: number };
export type Config = {
  planes: number;
  perPlane: number;
  altitude: number;
  inclination: number;
  phase: number;
};
export const PRESETS = [
  {
    name: "Demo / 72 satellites",
    config: {
      planes: 6,
      perPlane: 12,
      altitude: 550,
      inclination: 53,
      phase: 1,
    },
  },
  {
    name: "Starlink S1 / 1,584 satellites",
    config: {
      planes: 72,
      perPlane: 22,
      altitude: 550,
      inclination: 53,
      phase: 1,
    },
  },
];
export function validate(c: Config): string | null {
  if (
    !Number.isInteger(c.planes) ||
    !Number.isInteger(c.perPlane) ||
    c.planes < 1 ||
    c.perPlane < 1 ||
    c.planes * c.perPlane > 1584
  )
    return "궤도 수와 위성 수는 양의 정수, 총 위성은 1,584기 이하여야 합니다.";
  if (!Number.isFinite(c.altitude) || c.altitude < 160 || c.altitude > 2000)
    return "고도는 160~2,000 km 범위여야 합니다.";
  if (
    !Number.isFinite(c.inclination) ||
    c.inclination < 0 ||
    c.inclination > 90
  )
    return "경사각은 0~90도 범위여야 합니다.";
  if (!Number.isInteger(c.phase) || c.phase < 0 || c.phase >= c.planes)
    return "위상 인자는 0 이상, 궤도 수 미만의 정수여야 합니다.";
  return null;
}
export function period(c: Config) {
  return TAU * Math.sqrt((EARTH_RADIUS + c.altitude * 1000) ** 3 / MU);
}
export function gmst(ms: number) {
  const jd = ms / 86400000 + 2440587.5,
    t = (jd - 2451545) / 36525;
  return (
    (((280.46061837 +
      360.98564736629 * (jd - 2451545) +
      0.000387933 * t * t -
      (t * t * t) / 38710000) %
      360) *
      Math.PI) /
    180
  );
}
export function inertial(
  c: Config,
  plane: number,
  slot: number,
  seconds: number,
  result: Vec3 = { x: 0, y: 0, z: 0 },
): Vec3 {
  const r = EARTH_RADIUS + c.altitude * 1000,
    node = (TAU * plane) / c.planes,
    u =
      (TAU * slot) / c.perPlane +
      (TAU * c.phase * plane) / (c.planes * c.perPlane) +
      (TAU * seconds) / period(c),
    inc = (c.inclination * Math.PI) / 180;
  result.x =
    r *
    (Math.cos(node) * Math.cos(u) -
      Math.sin(node) * Math.sin(u) * Math.cos(inc));
  result.y =
    r *
    (Math.sin(node) * Math.cos(u) +
      Math.cos(node) * Math.sin(u) * Math.cos(inc));
  result.z = r * Math.sin(u) * Math.sin(inc);
  return result;
}
export function fixed(
  v: Vec3,
  a: number,
  result: Vec3 = { x: 0, y: 0, z: 0 },
): Vec3 {
  const x = v.x * Math.cos(a) + v.y * Math.sin(a),
    y = -v.x * Math.sin(a) + v.y * Math.cos(a);
  result.x = x;
  result.y = y;
  result.z = v.z;
  return result;
}
export function position(
  c: Config,
  id: number,
  seconds: number,
  startMs: number,
): Vec3 {
  return fixed(
    inertial(c, Math.floor(id / c.perPlane), id % c.perPlane, seconds),
    gmst(startMs + seconds * 1000),
  );
}
export function positions(
  c: Config,
  seconds: number,
  startMs: number,
  result: Vec3[] = [],
): Vec3[] {
  const a = gmst(startMs + seconds * 1000);
  result.length = c.planes * c.perPlane;
  for (let id = 0; id < result.length; id++) {
    const out = (result[id] ??= { x: 0, y: 0, z: 0 });
    inertial(c, Math.floor(id / c.perPlane), id % c.perPlane, seconds, out);
    fixed(out, a, out);
  }
  return result;
}
export function distance(a: Vec3, b: Vec3) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
export function visible(a: Vec3, b: Vec3) {
  const dx = b.x - a.x,
    dy = b.y - a.y,
    dz = b.z - a.z,
    n = dx * dx + dy * dy + dz * dz;
  if (!n) return false;
  const t = Math.max(0, Math.min(1, -(a.x * dx + a.y * dy + a.z * dz) / n));
  return (
    Math.hypot(a.x + t * dx, a.y + t * dy, a.z + t * dz) > EARTH_RADIUS + 1000
  );
}
// shortcut: fixed mesh with Earth occlusion; dynamic ISL handover requires a separate topology model.
export function mesh(c: Config): [number, number][] {
  const edges: [number, number][] = [],
    seen = new Set<string>();
  const add = (a: number, b: number) => {
    const k = `${Math.min(a, b)}:${Math.max(a, b)}`;
    if (a !== b && !seen.has(k)) {
      seen.add(k);
      edges.push([a, b]);
    }
  };
  for (let p = 0; p < c.planes; p++)
    for (let s = 0; s < c.perPlane; s++) {
      const id = p * c.perPlane + s;
      add(id, p * c.perPlane + ((s + 1) % c.perPlane));
      if (p + 1 < c.planes) add(id, (p + 1) * c.perPlane + s);
    }
  return edges;
}
export function activeEdges(edges: [number, number][], pos: Vec3[]) {
  return edges.filter(([a, b]) => visible(pos[a], pos[b]));
}
export function route(
  count: number,
  edges: [number, number][],
  source: number,
  target: number,
): number[] {
  if (source < 0 || target < 0 || source >= count || target >= count) return [];
  const adj: number[][] = Array.from({ length: count }, () => []);
  for (const [a, b] of edges) {
    adj[a].push(b);
    adj[b].push(a);
  }
  const parent = new Int32Array(count).fill(-1),
    q = [source];
  parent[source] = source;
  for (let i = 0; i < q.length && parent[target] === -1; i++)
    for (const n of adj[q[i]])
      if (parent[n] === -1) {
        parent[n] = q[i];
        q.push(n);
      }
  if (parent[target] === -1) return [];
  const result = [target];
  while (result[result.length - 1] !== source)
    result.push(parent[result[result.length - 1]]);
  return result.reverse();
}
export function pathLength(path: number[], pos: Vec3[]) {
  return path
    .slice(1)
    .reduce((sum, id, i) => sum + distance(pos[path[i]], pos[id]), 0);
}
