import { test } from "node:test";
import assert from "node:assert/strict";
import { McsrController } from "../src/mcsr.ts";
import { searchDefaults } from "../src/boundedSearch.ts";
import { makeCsibDelta, applyCsibDelta } from "../src/csibDelta.ts";
import { ControlTransport } from "../src/controlTransport.ts";
const graph = () => ({
  nodeCount: 4,
  links: [0, 1, 2].map((a) => ({
    id: `${a}:${a + 1}`,
    sourceId: a,
    targetId: a + 1,
    knownAvailable: true,
    metrics: { propagationDelayMs: 1, availableBufferRatio: 1, jitterMs: 0 },
  })),
});
function controller() {
  const g = graph();
  return {
    g,
    c: new McsrController(
      { planes: 1, perPlane: 4 },
      { planesPerDomain: 1, satellitesPerDomain: 2 },
      g,
      0,
      searchDefaults(4, "bounded"),
      3,
    ),
  };
}
test("CSIB changes reconstruct the full advertisement and reuse immutable reconstruction", () => {
  const { g, c } = controller(),
    before = c.initialAdvertisement(0);
  g.links[0].metrics.availableBufferRatio = 0.2;
  const [next] = c.update(g, 100),
    delta = makeCsibDelta(before, next),
    applied = applyCsibDelta(before, delta);
  assert.deepEqual(applied, next);
  assert.equal(applyCsibDelta(before, delta), applied);
  assert.equal(makeCsibDelta(before, next), delta);
  assert.equal(delta.changedLinks.length, 1);
  assert.equal(c.receiveDelta(delta, 1, 200), true);
  assert.equal(c.receiveDelta(delta, 1, 210), false);
  assert.equal(c.graph(1).links[0].metrics.availableBufferRatio, 0.2);
  g.links[0].knownAvailable = false;
  const [down] = c.update(g, 300),
    downDelta = makeCsibDelta(next, down);
  assert.ok(downDelta.removedSegments.length > 0);
  assert.deepEqual(applyCsibDelta(next, downDelta), down);
});
test("missing CSIB base cannot partially modify links, paths or revision", () => {
  const { g, c } = controller();
  g.links[0].metrics.availableBufferRatio = 0.5;
  const [first] = c.update(g, 100);
  g.links[0].metrics.availableBufferRatio = 0.1;
  const [second] = c.update(g, 200),
    delta = makeCsibDelta(first, second),
    before = c.graph(1);
  assert.equal(c.receiveDelta(delta, 1, 300), null);
  assert.deepEqual(c.graph(1), before);
  assert.equal(c.view().domains[1].receivedVersions[0], 0);
  assert.equal(c.receive(second, 1, 400), true);
  assert.equal(c.receiveDelta(delta, 1, 500), false);
});
test("a base mismatch sends a real return request, then a checkpoint; unapplied deltas are never acknowledged", () => {
  const { g, c } = controller();
  let now = 0,
    seq = 0,
    forceMismatch = true;
  const queue: { at: number; p: number; s: number; run: () => void }[] = [];
  const transport = new ControlTransport(
    [1, 3],
    0,
    1000,
    {
      nowUs: () => now,
      schedule: (at, p, run) => queue.push({ at, p, s: seq++, run }),
      graph: (domain) => c.graph(domain, false),
      initialAdvertisement: (domain) => c.initialAdvertisement(domain),
      physical: () => ({ available: true, token: 0, delayUs: 10 }),
      receive: (ad, recipient) => c.receive(ad, recipient, now),
      receiveDelta: (delta, recipient) => {
        if (forceMismatch) {
          forceMismatch = false;
          return null;
        }
        return c.receiveDelta(delta, recipient, now);
      },
    },
    { eventLimit: 10000, traceLimit: 10000, focusDomain: 0 },
  );
  g.links[0].metrics.availableBufferRatio = 0.2;
  const [ad] = c.update(g, 0);
  transport.publish(ad);
  while (queue.length) {
    queue.sort((a, b) => a.at - b.at || a.p - b.p || a.s - b.s);
    const event = queue.shift()!;
    now = event.at;
    event.run();
  }
  const v = transport.view();
  assert.equal(v.stats.acknowledged, 1);
  assert.equal(v.pendingTotal, 0);
  assert.deepEqual(v.payloadStats, {
    deltas: 1,
    checkpoints: 1,
    resyncRequests: 1,
  });
  const request = transport.events.find((e) => e.type === "resync-requested")!,
    checkpoint = transport.events.filter(
      (e) => e.type === "sent" && e.kind === "update",
    )[1];
  assert.ok(checkpoint.atUs > request.atUs);
  assert.equal(c.view().domains[1].receivedVersions[0], 1);
});

test("incremental CSIB graphs equal a fresh reconstruction across metric, outage and reverse-version updates", () => {
  const g = {
    nodeCount: 8,
    links: [
      ...graph().links,
      {
        id: "3:4",
        sourceId: 3,
        targetId: 4,
        knownAvailable: true,
        metrics: {
          propagationDelayMs: 1,
          availableBufferRatio: 1,
          jitterMs: 0,
        },
      },
      ...[4, 5, 6].map((a) => ({
        id: `${a}:${a + 1}`,
        sourceId: a,
        targetId: a + 1,
        knownAvailable: true,
        metrics: {
          propagationDelayMs: 1,
          availableBufferRatio: 1,
          jitterMs: 0,
        },
      })),
    ],
  };
  const c = new McsrController(
      { planes: 2, perPlane: 4 },
      { planesPerDomain: 1, satellitesPerDomain: 2 },
      g,
      0,
      searchDefaults(8, "bounded"),
      7,
    ),
    old = [] as ReturnType<McsrController["update"]>;
  for (let d = 0; d < 4; d++) c.graph(d);
  const availability = c.availabilityKey(0);
  g.links[0].metrics.availableBufferRatio = 0.3;
  c.update(g, 1);
  assert.equal(c.availabilityKey(0), availability);
  for (let i = 0; i < 20; i++) {
    const l = g.links[i % g.links.length];
    l.metrics.propagationDelayMs = i + 2;
    l.metrics.availableBufferRatio = ((i % 9) + 1) / 10;
    l.knownAvailable = i % 3 !== 0;
    const updates = c.update(g, 100 + i),
      messages = i % 2 ? [...old, ...updates] : [...updates, ...old];
    for (const ad of messages)
      for (let d = 0; d < 4; d++) {
        c.receive(ad, d, 200 + i);
        const cached = c.graph(d);
        (c as any).graphCache.delete(d);
        assert.deepEqual(c.graph(d), cached);
        assert.equal(cached.links.length, g.links.length);
      }
    old.splice(0, old.length, ...updates);
  }
});
