import test from "node:test";
import assert from "node:assert/strict";

import { arg, flag, mapLimit, parseCsv } from "./lib.js";

test("parseCsv handles quotes, escapes, embedded newlines, BOM, blank rows", () => {
  const grid = parseCsv('﻿a,b\n"x ""y""","line1\nline2"\n,\n');
  assert.deepEqual(grid, [
    ["a", "b"],
    ['x "y"', "line1\nline2"],
  ]);
});

test("mapLimit preserves order and honours the limit", async () => {
  let inFlight = 0;
  let peak = 0;
  const out = await mapLimit([30, 10, 20], 2, async (ms, i) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, ms));
    inFlight--;
    return `${i}:${ms}`;
  });
  assert.deepEqual(out, ["0:30", "1:10", "2:20"]);
  assert.ok(peak <= 2, `ran ${peak} at once`);
});

test("arg and flag read argv", () => {
  process.argv.push("--base", "http://x", "--cheap", "--deep");
  try {
    assert.equal(arg("base"), "http://x");
    assert.equal(arg("absent", "d"), "d");
    assert.equal(arg("absent"), undefined);
    assert.equal(flag("cheap"), true);
    assert.equal(flag("absent"), false);
    // A bare switch, or one followed by another flag, falls back to the
    // default instead of eating the next token (the --approve EISDIR bug).
    assert.equal(arg("cheap", "d"), "d");
    assert.equal(arg("deep", "d"), "d");
  } finally {
    process.argv.length -= 4;
  }
});
