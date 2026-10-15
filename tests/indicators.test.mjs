import { test } from "node:test";
import assert from "node:assert/strict";
import { anchoredVwap, bollinger, ema, macd, rsi, sma, volumeProfile, volumeReadings } from "../js/indicators.js";

const close = (n, f) => Array.from({ length: n }, (_, i) => f(i));
const candle = (i, c, { v = 1000, range = 1 } = {}) => ({ t: i, o: c, h: c + range / 2, l: c - range / 2, c, v });

test("moving averages: SMA averages the window, EMA starts from it and leans toward recent values", () => {
  const xs = [1, 2, 3, 4, 5, 6];
  assert.deepEqual(sma(xs, 3), [null, null, 2, 3, 4, 5]);
  const e = ema(xs, 3);
  assert.equal(e[2], 2);
  assert.ok(e[5] > sma(xs, 3)[5] - 1e-12 && e[5] < 6, "an EMA of a rising series sits between the SMA and the last value");
});

test("Bollinger bands are symmetric around the mean, two standard deviations wide each side", () => {
  const xs = close(40, i => 100 + (i % 2 ? 1 : -1));
  const { mid, upper, lower } = bollinger(xs, 20, 2);
  assert.equal(mid[39], 100);
  assert.ok(Math.abs(upper[39] - 102) < 1e-12 && Math.abs(lower[39] - 98) < 1e-12);
  assert.equal(upper[18], null);
});

test("RSI is 100 when a series only rises, 0 when it only falls, near 50 when it alternates", () => {
  assert.equal(rsi(close(30, i => i), 14)[29], 100);
  assert.equal(rsi(close(30, i => -i), 14)[29], 0);
  assert.ok(Math.abs(rsi(close(60, i => 100 + (i % 2)), 14)[59] - 50) < 5);
});

test("MACD is positive in an uptrend, and its histogram is the gap to the signal line", () => {
  const { line, signal, hist } = macd(close(80, i => 100 * 1.01 ** i));
  assert.ok(line[79] > 0);
  assert.ok(Math.abs(hist[79] - (line[79] - signal[79])) < 1e-12);
  assert.equal(line[10], null);
});

test("anchored VWAP weights each candle's typical price by its volume, from the anchor on", () => {
  const ks = [candle(0, 10, { v: 100 }), candle(1, 20, { v: 300 }), candle(2, 40, { v: 0 })];
  const v = anchoredVwap(ks, 0);
  assert.equal(v[0], 10);
  assert.equal(v[1], (10 * 100 + 20 * 300) / 400);
  assert.equal(v[2], v[1], "a no-volume candle leaves it unchanged");
  assert.equal(anchoredVwap(ks, 1)[1], 20);
});

test("volume readings flag absorption (heavy volume, small range) and no supply (a move on light volume)", () => {
  const ks = [...close(25, i => candle(i, 100, { v: 1000, range: 2 })), candle(25, 100, { v: 3000, range: 0.5 }), candle(26, 100, { v: 400, range: 3 })];
  const r = volumeReadings(ks);
  assert.ok(r[25].absorption && !r[25].noSupply);
  assert.ok(r[26].noSupply && !r[26].absorption);
  assert.ok(Math.abs(r[25].ratio - 3) < 1e-9);
});

test("volume profile: the POC sits where most volume traded, the value area holds 70%, and the shape follows", () => {
  // Most trading near 110 with a thin tail down to 90: a P-shape.
  const ks = [
    ...close(40, i => candle(i, 110 + (i % 3 - 1), { v: 1000, range: 2 })),
    ...close(6, i => candle(40 + i, 92 + 3 * i, { v: 100, range: 3 }))
  ];
  const p = volumeProfile(ks, 0, ks.length - 1, 80);
  assert.ok(Math.abs(p.poc - 110) < 1.5, `POC ${p.poc}`);
  assert.ok(p.val <= p.poc && p.poc <= p.vah);
  const inside = p.rows.filter(r => r.lo >= p.val - 1e-9 && r.hi <= p.vah + 1e-9).reduce((s, r) => s + r.volume, 0);
  assert.ok(inside >= 0.7 * p.total - 1e-6, "the value area holds at least 70% of the volume");
  assert.equal(p.shape, "P");
  assert.equal(volumeProfile(ks.map(k => ({ ...k, v: 0 })), 0, 10), null, "no volume, no profile");
});
