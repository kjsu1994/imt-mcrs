import { test } from "node:test";
import assert from "node:assert/strict";
import { DisplayClock } from "../src/displayClock.ts";
test("display interpolation fills snapshot gaps without exceeding received time", () => {
  const c = new DisplayClock();
  c.receive(1000000, 0, false);
  c.receive(2000000, 100, true);
  assert.equal(c.at(125), 1250000);
  assert.equal(c.at(150), 1500000);
  assert.equal(c.at(200), 2000000);
  assert.equal(c.at(5000), 2000000);
  c.receive(3000000, 175, true);
  assert.equal(c.at(175), 1750000);
  assert.ok(c.at(200) > 1750000);
});
test("pause, seeks and new runs snap to authoritative time", () => {
  const c = new DisplayClock();
  c.receive(5000000, 0, false);
  c.receive(6000000, 100, true);
  c.receive(6000000, 125, false);
  assert.equal(c.at(125), 6000000);
  c.receive(0, 150, false);
  assert.equal(c.at(150), 0);
  c.receive(1000000, 200, false);
  c.receive(500000, 225, true);
  assert.equal(c.at(225), 500000);
});
