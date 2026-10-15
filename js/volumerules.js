/**
 * Tests of the volume rules from the volume-profile video (notes/transcript.md) on the replay's daily candles.
 *
 * Each rule is stated as a claim with a direction, measured against a control (the same situation without the rule,
 * or a mirror level), and judged by the difference's z-score: "supports" or "contradicts" at |z| ≥ 2, otherwise
 * "inconclusive". Events are thinned per stock so one stock's outcome windows never overlap; events on the same date
 * across stocks still share the market's move, so the standard errors are somewhat optimistic. Returns are over SPY.
 *
 * Daily candles limit two rules: volume profiles spread each day's volume across its range (approximate), and the
 * value-area re-entry rule, an intraday rule in the video, is tested on weekly value areas instead.
 */
import { volumeProfile, volumeReadings } from "./indicators.js";

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/** The value area of the five sessions before candle i (the daily stand-in for the video's prior-session profile), or null. */
export function weeklyValueArea(candles, i) {
  if (i < 5) return null;
  const prof = volumeProfile(candles, i - 5, i - 1, 40);
  return prof && prof.vah > prof.val ? prof : null;
}

/**
 * The video's re-entry setup on candle i: it opened outside the prior value area and closed back inside, in the outer
 * third on the side it came from (accepted inside, not a wick). Returns { from: "above" | "below", target, val, vah }
 * where target is the far edge, or null.
 */
export function reentryAt(candles, i, prof = weeklyValueArea(candles, i)) {
  if (!prof) return null;
  const k = candles[i], width = prof.vah - prof.val;
  if (k.c > prof.vah || k.c < prof.val) return null;
  if (k.o > prof.vah && k.c >= prof.vah - width / 3) return { from: "above", target: prof.val, val: prof.val, vah: prof.vah };
  if (k.o < prof.val && k.c <= prof.val + width / 3) return { from: "below", target: prof.vah, val: prof.val, vah: prof.vah };
  return null;
}

function meanSE(xs) {
  const n = xs.length;
  if (n < 2) return { mean: n ? xs[0] : null, se: null, n };
  const mean = xs.reduce((s, v) => s + v, 0) / n;
  return { mean, se: Math.sqrt(xs.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1) / n), n };
}
const share = (hits) => ({ p: hits.length ? hits.filter(Boolean).length / hits.length : null, n: hits.length });

/** A difference of two means (or shares) with its standard error, z, and the verdict for a claim of sign `want`. */
function verdict(diff, se, want) {
  const z = isNum(diff) && se > 0 ? diff / se : null;
  return { diff, se, z, verdict: z === null ? "too few" : z * want >= 2 ? "supports" : z * want <= -2 ? "contradicts" : "inconclusive" };
}

/**
 * Runs every rule. `replay` is decodeReplay() output. Returns [{ key, label, claim, test, unit, want, groups: [{ label,
 * value, se?, n }], diff, se, z, verdict }]. `unit` is "return" (fractions) or "share" (probabilities); `diff` is the
 * first group minus the second, and `want` is the sign the video's claim predicts for it.
 */
export function testVolumeRules(replay, { minHistory = 80 } = {}) {
  const spy = replay.tickers.SPY?.candles;
  if (!spy) return [];
  const spyAt = new Map(spy.map((k, i) => [k.t, i]));
  /** Return over SPY from bar i's close to bar i + h's close, or null past either series. */
  const excess = (candles, i, h) => {
    const a = spyAt.get(candles[i].t), j = i + h;
    if (a === undefined || j >= candles.length) return null;
    const b = spyAt.get(candles[j].t);
    if (b === undefined) return null;
    return candles[j].c / candles[i].c - spy[b].c / spy[a].c;
  };
  const touches = (candles, i, h, level) => {
    for (let k = i + 1; k <= Math.min(i + h, candles.length - 1); k++) if (candles[k].l <= level && level <= candles[k].h) return true;
    return i + h < candles.length ? false : null;
  };

  const g = {
    highShrink: [], highExpand: [], lowShrink: [], lowExpand: [],
    absorb: [], allAgainst: [], healthy: [], allWith: [], noSupply: [],
    pocTouch: [], mirrorTouch: [], reentry: [], nearEdge: [], shapeP: [], shapeB: [], shapeD: [], edgeTrade: [], allWith10: []
  };
  const last = new Map();
  /** Thinning: at most one event per stock and rule per `gap` bars. */
  const take = (key, ticker, i, gap) => {
    const id = `${key}|${ticker}`;
    if (last.has(id) && i - last.get(id) < gap) return false;
    last.set(id, i);
    return true;
  };

  for (const [ticker, s] of Object.entries(replay.tickers)) {
    if (s.etf) continue;
    const c = s.candles;
    if (c.length < minHistory + 30 || !c.some(k => k.v > 0)) continue;
    const vr = volumeReadings(c);
    for (let i = minHistory; i < c.length - 1; i++) {
      const k = c[i], r = vr[i];
      if (!isNum(r.ratio)) continue;
      const dir = k.c >= k.o ? 1 : -1;

      // 1-2. Volume divergence at 20-day closing highs and lows.
      let hi = -Infinity, lo = Infinity;
      for (let j = i - 20; j < i; j++) { hi = Math.max(hi, c[j].c); lo = Math.min(lo, c[j].c); }
      const fwd21 = excess(c, i, 21);
      if (isNum(fwd21) && k.c > hi && take("high", ticker, i, 21)) {
        if (r.ratio < 0.8) g.highShrink.push(fwd21); else if (r.ratio > 1.2) g.highExpand.push(fwd21);
      }
      if (isNum(fwd21) && k.c < lo && take("low", ticker, i, 21)) {
        if (r.ratio < 0.8) g.lowShrink.push(fwd21); else if (r.ratio > 1.2) g.lowExpand.push(fwd21);
      }

      // 3-5. Effort and result: absorption (expect reversal), healthy moves and no-supply moves (expect continuation).
      const fwd5 = excess(c, i, 5);
      if (isNum(fwd5)) {
        if (take("all", ticker, i, 5)) { g.allAgainst.push(-dir * fwd5); g.allWith.push(dir * fwd5); }
        const range = k.h - k.l;
        let avgRange = 0;
        for (let j = i - 20; j < i; j++) avgRange += (c[j].h - c[j].l) / 20;
        if (r.absorption && take("absorb", ticker, i, 5)) g.absorb.push(-dir * fwd5);
        if (r.ratio >= 1.5 && range >= 1.5 * avgRange && take("healthy", ticker, i, 5)) g.healthy.push(dir * fwd5);
        if (r.noSupply && take("nosupply", ticker, i, 5)) g.noSupply.push(dir * fwd5);
      }

      // 6, 8. Sixty-session profiles, sampled weekly: the POC as a magnet, and the profile's shape.
      if (i % 5 === 0 && i + 21 < c.length) {
        const prof = volumeProfile(c, i - 59, i, 80);
        if (prof) {
          if ((k.c > prof.vah || k.c < prof.val) && take("poc", ticker, i, 10)) {
            g.pocTouch.push(touches(c, i, 10, prof.poc));
            g.mirrorTouch.push(touches(c, i, 10, 2 * k.c - prof.poc));
          }
          // 9. The video's trade: at the value area's edge, a reversal candle that closes back inside on more volume than
          // the one before (a hammer at the low edge, a shooting star at the high edge). Stop past the edge, target the far edge.
          const fwd10 = excess(c, i, 10);
          if (isNum(fwd10)) {
            const range = k.h - k.l, body = Math.abs(k.c - k.o), moreVolume = k.v > c[i - 1].v;
            const hammer = k.l <= prof.val && k.c > prof.val && Math.min(k.o, k.c) - k.l >= 0.5 * range && body <= 0.4 * range;
            const star = k.h >= prof.vah && k.c < prof.vah && k.h - Math.max(k.o, k.c) >= 0.5 * range && body <= 0.4 * range;
            if (take("all10", ticker, i, 10)) g.allWith10.push(dir * fwd10);
            if (range > 0 && moreVolume && (hammer || star) && take("edgeTrade", ticker, i, 10)) g.edgeTrade.push((hammer ? 1 : -1) * fwd10);
          }
          if (isNum(fwd21) && take("shape", ticker, i, 21)) {
            if (prof.shape === "P") g.shapeP.push(fwd21); else if (prof.shape === "b") g.shapeB.push(fwd21); else if (prof.shape === "D") g.shapeD.push(fwd21);
          }
        }
      }

      // 7. Value-area re-entry on the previous five sessions' profile: open outside, close back inside.
      if (i + 5 < c.length) {
        const prof = weeklyValueArea(c, i), re = prof && reentryAt(c, i, prof);
        if (re && take("reentry", ticker, i, 5)) g.reentry.push(touches(c, i, 5, re.target));
        else if (prof && !re && k.o <= prof.vah && k.o >= prof.val) {
          // Control: opened inside, closed in the same outer third a re-entry lands in, moving the same way.
          const width = prof.vah - prof.val;
          const target = k.c >= prof.vah - width / 3 && k.c <= prof.vah && k.c < k.o ? prof.val
            : k.c <= prof.val + width / 3 && k.c >= prof.val && k.c > k.o ? prof.vah : null;
          if (target !== null && take("edge", ticker, i, 5)) g.nearEdge.push(touches(c, i, 5, target));
        }
      }
    }
  }

  const means = (label, xs) => ({ label, ...((m) => ({ value: m.mean, se: m.se, n: m.n }))(meanSE(xs)) });
  const diffMeans = (a, b) => {
    const x = meanSE(a), y = meanSE(b);
    return isNum(x.mean) && isNum(y.mean) && x.se && y.se ? [x.mean - y.mean, Math.sqrt(x.se ** 2 + y.se ** 2)] : [null, null];
  };
  const shares = (label, xs) => ({ label, value: share(xs.filter(v => v !== null)).p, n: xs.filter(v => v !== null).length });
  const diffShares = (a, b) => {
    const x = share(a.filter(v => v !== null)), y = share(b.filter(v => v !== null));
    return isNum(x.p) && isNum(y.p) && x.n && y.n ? [x.p - y.p, Math.sqrt(x.p * (1 - x.p) / x.n + y.p * (1 - y.p) / y.n)] : [null, null];
  };
  const rule = (key, label, claim, test, unit, groups, [diff, se], want) => ({ key, label, claim, test, unit, want, groups, ...verdict(diff, se, want) });

  return [
    rule("divergenceHigh", "Divergence at highs", "New highs on shrinking volume warn of a reversal.", "21-day return over SPY after a 20-day closing high on light volume (under 0.8× average) minus on heavy volume (over 1.2×).", "return",
      [means("Shrinking volume", g.highShrink), means("Expanding volume", g.highExpand)], diffMeans(g.highShrink, g.highExpand), -1),
    rule("divergenceLow", "Divergence at lows", "New lows on shrinking volume mark a bottom.", "21-day return over SPY after a 20-day closing low on light volume minus on heavy volume.", "return",
      [means("Shrinking volume", g.lowShrink), means("Expanding volume", g.lowExpand)], diffMeans(g.lowShrink, g.lowExpand), 1),
    rule("absorption", "Absorption", "Absorption (heavy volume, small candle) is a hidden wall: price reverses.", "5-day return over SPY against the candle's direction, after absorption candles versus after any candle.", "return",
      [means("After absorption", g.absorb), means("After any candle", g.allAgainst)], diffMeans(g.absorb, g.allAgainst), 1),
    rule("healthy", "Big candle, big volume", "A big candle on big volume is a real move: it continues.", "5-day return over SPY in the candle's direction, after candles with 1.5× range and 1.5× volume versus after any candle.", "return",
      [means("After big candle + volume", g.healthy), means("After any candle", g.allWith)], diffMeans(g.healthy, g.allWith), 1),
    rule("noSupply", "No supply", "A move on light volume means no sellers in the way: it continues.", "5-day return over SPY in the candle's direction, after normal-range candles on light volume versus after any candle.", "return",
      [means("After no-supply candle", g.noSupply), means("After any candle", g.allWith)], diffMeans(g.noSupply, g.allWith), 1),
    rule("pocMagnet", "POC magnet", "Price tends to come back to the point of control.", "Outside the 60-day value area: chance of touching the POC within 10 sessions versus touching a level equally far on the other side.", "share",
      [shares("Touches the POC", g.pocTouch), shares("Touches the mirror level", g.mirrorTouch)], diffShares(g.pocTouch, g.mirrorTouch), 1),
    rule("reentry", "Value-area re-entry", "Opening outside value and closing back inside crosses to the far edge (the 80% rule).", "Weekly value area: chance of reaching the far edge within 5 sessions after a re-entry versus after a day that opened inside and closed in the same outer third, moving the same way.", "share",
      [shares("After re-entry", g.reentry), shares("Same spot, no re-entry", g.nearEdge)], diffShares(g.reentry, g.nearEdge), 1),
    rule("shape", "Profile shape", "A P-shaped profile is bullish and a b-shaped one bearish.", "21-day return over SPY after a 60-day P-shaped profile minus after a b-shaped one.", "return",
      [means("P-shape", g.shapeP), means("b-shape", g.shapeB), means("D-shape", g.shapeD)], diffMeans(g.shapeP, g.shapeB), 1),
    rule("edgeTrade", "Edge reversal trade", "A higher-volume hammer or shooting star at the value area's edge starts a move to the far edge.", "60-day value area, sampled weekly: 10-day return over SPY in the trade's direction versus any candle's 10-day return in its own direction.", "return",
      [means("After the edge reversal", g.edgeTrade), means("After any candle", g.allWith10)], diffMeans(g.edgeTrade, g.allWith10), 1)
  ];
}
