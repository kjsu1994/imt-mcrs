import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PRESETS,
  validate,
  positions,
  inertial,
  fixed,
  period,
  EARTH_RADIUS,
  mesh,
  activeEdges,
  route,
  visible,
  distance,
  gmst,
} from "../src/model.ts";
const c = PRESETS[0].config;
test("configuration trust boundary", () => {
  assert.equal(validate(c), null);
  for (const v of [
    { ...c, planes: 0 },
    { ...c, perPlane: 1.5 },
    { ...c, altitude: NaN },
    { ...c, phase: 6 },
    { ...c, inclination: 91 },
    { ...c, planes: 100, perPlane: 100 },
  ])
    assert.ok(validate(v));
  assert.equal(validate({ ...c, planes: 1, perPlane: 1, phase: 0 }), null);
});
test("circular orbit radius and period", () => {
  const a = inertial(c, 2, 3, 0);
  assert.ok(distance(a, inertial(c, 2, 3, period(c))) < 1e-6);
  for (const t of [0, 100, 5000]) {
    const v = inertial(c, 2, 3, t);
    assert.ok(
      Math.abs(Math.hypot(v.x, v.y, v.z) - EARTH_RADIUS - c.altitude * 1000) <
        1e-6,
    );
  }
});
test("Walker spacing and phase", () => {
  const eq = { ...c, inclination: 0 },
    a = inertial(eq, 0, 0, 0),
    b = inertial(eq, 0, 1, 0);
  assert.ok(
    Math.abs(
      Math.acos(
        (a.x * b.x + a.y * b.y) / (Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y)),
      ) -
        (2 * Math.PI) / c.perPlane,
    ) < 1e-10,
  );
  const other = inertial(eq, 1, 0, 0);
  assert.ok(
    Math.abs(
      Math.atan2(other.y, other.x) -
        ((2 * Math.PI) / c.planes +
          (2 * Math.PI * c.phase) / (c.planes * c.perPlane)),
    ) < 1e-10,
  );
});
test("Earth rotation and deterministic epochs", () => {
  const v = fixed({ x: 1, y: 0, z: 2 }, Math.PI / 2);
  assert.ok(Math.abs(v.x) < 1e-10);
  assert.equal(v.y, -1);
  assert.equal(v.z, 2);
  assert.ok(
    Math.abs(gmst(Date.UTC(2000, 0, 1, 12)) - (280.46061837 * Math.PI) / 180) <
      1e-9,
  );
  assert.deepEqual(positions(c, 200, 0), positions(c, 200, 0));
  assert.notDeepEqual(positions(c, 0, 0), positions(c, 0, 100000));
});
test("mesh is unique, Earth-occluded links removed", () => {
  assert.equal(
    visible({ x: 7000000, y: 0, z: 0 }, { x: -7000000, y: 0, z: 0 }),
    false,
  );
  const edges = mesh(c);
  assert.equal(
    new Set(edges.map((e) => [...e].sort((a, b) => a - b).join(":"))).size,
    edges.length,
  );
  assert.ok(edges.every(([a, b]) => a !== b));
  assert.deepEqual(mesh({ ...c, planes: 1, perPlane: 1, phase: 0 }), []);
  const p = positions(c, 0, 0);
  assert.ok(activeEdges(edges, p).every(([a, b]) => visible(p[a], p[b])));
});
test("BFS shortest path, unreachable and identity", () => {
  const e: [number, number][] = [
    [0, 1],
    [1, 2],
    [2, 3],
    [0, 3],
  ];
  assert.deepEqual(route(5, e, 0, 3), [0, 3]);
  assert.deepEqual(route(5, e, 0, 4), []);
  assert.deepEqual(route(5, e, 2, 2), [2]);
  assert.deepEqual(route(5, e, -1, 2), []);
});
