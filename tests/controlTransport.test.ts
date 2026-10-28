import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ControlTransport,
  ControlTransportError,
} from "../src/controlTransport.ts";
import type { DomainAdvertisement } from "../src/mcsr.ts";
import type { RoutingGraph } from "../src/routing.ts";
function harness(timeout = 100, processing = 0, ds = [0, 2]) {
  let now = 0,
    sequence = 0;
  const queue: { at: number; p: number; s: number; run: () => void }[] = [],
    links = new Map<string, { up: boolean; token: number }>();
  const known: RoutingGraph = {
    nodeCount: 3,
    links: [
      {
        id: "0:1",
        sourceId: 0,
        targetId: 1,
        knownAvailable: true,
        metrics: {
          propagationDelayMs: 0.01,
          availableBufferRatio: 1,
          jitterMs: 0,
        },
      },
      {
        id: "1:2",
        sourceId: 1,
        targetId: 2,
        knownAvailable: true,
        metrics: {
          propagationDelayMs: 0.01,
          availableBufferRatio: 1,
          jitterMs: 0,
        },
      },
    ],
  };
  for (const l of known.links) links.set(l.id, { up: true, token: 0 });
  const versions = [0, 0],
    applied: { at: number; revision: number }[] = [];
  const env = {
    nowUs: () => now,
    schedule: (at: number, p: number, run: () => void) =>
      queue.push({ at, p, s: sequence++, run }),
    graph: () => known,
    physical: (a: number, b: number) => {
      const l = links.get(`${Math.min(a, b)}:${Math.max(a, b)}`)!;
      return { available: l.up, token: l.token, delayUs: 10 };
    },
    receive: (ad: DomainAdvertisement, recipient: number) => {
      if (ad.revision <= versions[recipient]) return false;
      versions[recipient] = ad.revision;
      applied.push({ at: now, revision: ad.revision });
      return true;
    },
  };
  const c = new ControlTransport(ds, processing, timeout, env);
  const run = (until: number) => {
    while (true) {
      queue.sort((a, b) => a.at - b.at || a.p - b.p || a.s - b.s);
      if (!queue.length || queue[0].at > until) break;
      const e = queue.shift()!;
      now = e.at;
      e.run();
    }
    now = until;
  };
  const set = (id: string, up: boolean) => {
    const l = links.get(id)!;
    l.up = up;
    l.token++;
  };
  const ad = (revision = 1): DomainAdvertisement => ({
    domainId: 0,
    revision,
    atUs: now,
    segments: [],
    crossings: [],
  });
  return {
    c,
    run,
    set,
    ad,
    applied,
    known,
    versions,
    queue,
    addShortcut: () => {
      links.set("0:2", { up: true, token: 0 });
      known.links.push({
        id: "0:2",
        sourceId: 0,
        targetId: 2,
        knownAvailable: true,
        metrics: {
          propagationDelayMs: 0.01,
          availableBufferRatio: 1,
          jitterMs: 0,
        },
      });
    },
  };
}
test("multi-hop update and ACK consume propagation and processing time", () => {
  const h = harness(100, 5);
  h.c.publish(h.ad());
  h.run(24);
  assert.equal(h.applied.length, 0);
  h.run(25);
  assert.deepEqual(h.applied, [{ at: 25, revision: 1 }]);
  assert.equal(h.c.view().pending.length, 1);
  h.run(50);
  assert.equal(h.c.view().pending.length, 0);
  assert.equal(h.c.view().stats.acknowledged, 1);
  h.run(200);
  assert.equal(h.c.view().stats.retries, 0);
});
test("unrecognized failure is not avoided using physical truth", () => {
  const h = harness();
  h.set("1:2", false);
  h.c.publish(h.ad());
  h.run(30);
  assert.equal(h.c.view().stats.dropped, 1);
  assert.equal(h.applied.length, 0);
  assert.deepEqual(
    h.c.events.find((e) => e.type === "dropped")!.path,
    [0, 1, 2],
  );
});
test("a hop interrupted and restored before arrival still fails", () => {
  const h = harness();
  h.c.publish(h.ad());
  h.run(3);
  h.set("0:1", false);
  h.run(5);
  h.set("0:1", true);
  h.run(10);
  assert.equal(h.c.events.at(-1)!.reason, "link-interrupted");
  assert.equal(h.applied.length, 0);
});
test("lost ACK triggers retransmission, duplicate delivery and a new ACK", () => {
  const h = harness();
  h.c.publish(h.ad());
  h.run(20);
  h.set("1:2", false);
  h.run(30);
  assert.equal(h.applied.length, 1);
  assert.equal(h.c.view().pending.length, 1);
  h.run(90);
  h.set("1:2", true);
  h.run(140);
  assert.equal(h.applied.length, 1);
  assert.equal(h.c.view().stats.retries, 1);
  assert.ok(h.c.events.some((e) => e.type === "duplicate"));
  assert.equal(h.c.view().pending.length, 0);
});
test("an old attempt ACK cannot acknowledge a newer pending version", () => {
  const h = harness();
  h.c.publish(h.ad(1));
  h.run(25);
  h.c.publish(h.ad(2));
  h.run(40);
  assert.equal(h.c.view().pending[0].revision, 2);
  assert.ok(h.c.events.some((e) => e.type === "ack-ignored"));
  h.run(65);
  assert.equal(h.c.view().pending.length, 0);
  assert.deepEqual(
    h.applied.map((a) => a.revision),
    [1, 2],
  );
});
test("an ACK arriving exactly at the deadline wins over timeout", () => {
  const h = harness(40);
  h.c.publish(h.ad());
  h.run(40);
  assert.equal(h.c.view().pending.length, 0);
  assert.equal(h.c.view().stats.retries, 0);
});
test("partition retries latest state and reconnects without an omniscient delivery signal", () => {
  const h = harness();
  h.known.links[1].knownAvailable = false;
  h.set("1:2", false);
  h.c.publish(h.ad());
  h.run(205);
  assert.equal(h.applied.length, 0);
  assert.equal(h.c.view().stats.retries, 2);
  h.set("1:2", true);
  h.known.links[1].knownAvailable = true;
  h.run(340);
  assert.equal(h.c.view().pending.length, 0);
  assert.deepEqual(h.applied, [{ at: 320, revision: 1 }]);
});
test("expired attempts cannot mutate a receiver and event budget is enforced", () => {
  const h = harness(5);
  h.c.publish(h.ad());
  h.run(25);
  assert.equal(h.applied.length, 0);
  assert.ok(h.c.view().stats.expired > 0);
  const limited = harness(1);
  assert.throws(() => {
    limited.c.publish(limited.ad());
    limited.run(100000);
  }, ControlTransportError);
  assert.equal(limited.c.events.length, 100000);
});

test("a newer version arriving first prevents an older in-flight update from overwriting it", () => {
  const h = harness();
  h.c.publish(h.ad(1));
  h.run(5);
  h.addShortcut();
  h.c.publish(h.ad(2));
  h.run(50);
  assert.deepEqual(h.applied, [{ at: 15, revision: 2 }]);
  assert.equal(h.versions[1], 2);
  assert.ok(h.c.events.some((e) => e.type === "duplicate" && e.revision === 1));
});
