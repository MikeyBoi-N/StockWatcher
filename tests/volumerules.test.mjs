import { test } from "node:test";
import assert from "node:assert/strict";
import { reentryAt, testVolumeRules, weeklyValueArea } from "../js/volumerules.js";

const candle = (t, o, c, { v = 1000, wick = 0.5 } = {}) => ({ t, o, h: Math.max(o, c) + wick, l: Math.min(o, c) - wick, c, v });

/** A seeded random walk with volume, so the tests are repeatable. */
function walk(n, seed, start = 100) {
  let s = seed, p = start;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  return Array.from({ length: n }, (_, i) => {
    const o = p, c = o * (1 + (rand() - 0.5) * 0.04);
    p = c;
    return { t: 86400 * i, o, h: Math.max(o, c) * (1 + rand() * 0.01), l: Math.min(o, c) * (1 - rand() * 0.01), c, v: Math.round(5e5 + rand() * 1e6) };
  });
}

test("re-entry: open above last week's value area, close back inside near the top; the target is the far edge", () => {
  const week = [100, 101, 100, 99, 100].map((c, i) => candle(i, c, c, { wick: 1 }));
  const va = weeklyValueArea([...week, candle(5, 103, 100.5)], 5);
  assert.ok(va && va.val < 100 && va.vah > 100);
  const re = reentryAt([...week, candle(5, va.vah + 2, va.vah - 0.1)], 5);
  assert.equal(re.from, "above");
  assert.equal(re.target, va.val);
  assert.equal(reentryAt([...week, candle(5, va.vah + 2, va.vah + 1)], 5), null, "still outside: no re-entry");
  assert.equal(reentryAt([...week, candle(5, 100, va.vah - 0.1)], 5), null, "opened inside: no re-entry");
  assert.equal(reentryAt([...week, candle(5, va.val - 2, va.val + 0.1)], 5).from, "below");
});

test("volume rules: every rule reports its groups, a z-score and a verdict on a replay", () => {
  const replay = { tickers: { SPY: { etf: true, candles: walk(600, 1) }, AAA: { candles: walk(600, 2) }, BBB: { candles: walk(600, 3, 50) } } };
  const rules = testVolumeRules(replay);
  assert.equal(rules.length, 9);
  for (const r of rules) {
    assert.ok(r.label && r.claim && r.test, r.key);
    assert.ok(["return", "share"].includes(r.unit));
    assert.ok([1, -1].includes(r.want));
    assert.ok(["supports", "contradicts", "inconclusive", "too few"].includes(r.verdict));
    if (r.verdict !== "too few") assert.ok(Math.abs(r.z - r.diff / r.se) < 1e-9);
  }
  assert.ok(rules.find(r => r.key === "reentry").groups.every(g => g.n > 0));
  assert.deepEqual(testVolumeRules({ tickers: {} }), [], "no SPY, no tests");
});
