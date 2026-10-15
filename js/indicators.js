/**
 * Chart indicators for the Forecaster. Pure functions over candles [{ t, o, h, l, c, v }] in time order; every value
 * at index i uses candles 0..i only, so nothing on the chart looks ahead. Missing values are null.
 *
 * Volume profile follows auction-market practice: volume by price, the point of control (POC, the busiest price),
 * the value area (the band around the POC holding 70% of volume, grown one row at a time toward the busier side),
 * high-volume nodes (where trading clustered, which tends to be "sticky") and low-volume nodes (thin prices the market
 * tends to move through quickly). Daily candles say how much traded each day but not at which prices, so each
 * candle's volume is spread evenly across its low-high range: an approximation that sharpens with shorter candles.
 */

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/** Simple moving average of `values` over `n`; null until n values exist. */
export function sma(values, n) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

/** Exponential moving average (α = 2/(n+1)), seeded with the first n-value simple average. */
export function ema(values, n) {
  const out = new Array(values.length).fill(null);
  if (values.length < n) return out;
  const a = 2 / (n + 1);
  let e = values.slice(0, n).reduce((s, v) => s + v, 0) / n;
  out[n - 1] = e;
  for (let i = n; i < values.length; i++) out[i] = e = a * values[i] + (1 - a) * e;
  return out;
}

/** Bollinger bands: the n-period mean ± k population standard deviations. Returns { mid, upper, lower }. */
export function bollinger(values, n = 20, k = 2) {
  const mid = sma(values, n);
  const upper = new Array(values.length).fill(null), lower = new Array(values.length).fill(null);
  for (let i = n - 1; i < values.length; i++) {
    let ss = 0;
    for (let j = i - n + 1; j <= i; j++) ss += (values[j] - mid[i]) ** 2;
    const sd = Math.sqrt(ss / n);
    upper[i] = mid[i] + k * sd;
    lower[i] = mid[i] - k * sd;
  }
  return { mid, upper, lower };
}

/** Wilder's RSI over n periods (0-100). */
export function rsi(values, n = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length <= n) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = values[i] - values[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  gain /= n; loss /= n;
  out[n] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = n + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

/** MACD: EMA(fast) − EMA(slow), its EMA(signal), and the histogram between them. */
export function macd(values, fast = 12, slow = 26, signal = 9) {
  const f = ema(values, fast), s = ema(values, slow);
  const line = values.map((_, i) => isNum(f[i]) && isNum(s[i]) ? f[i] - s[i] : null);
  const start = line.findIndex(isNum);
  const sig = new Array(values.length).fill(null);
  if (start >= 0) ema(line.slice(start), signal).forEach((v, k) => { sig[start + k] = v; });
  return { line, signal: sig, hist: line.map((v, i) => isNum(v) && isNum(sig[i]) ? v - sig[i] : null) };
}

/** Volume-weighted average price from candle `from` onward, using each candle's typical price (h + l + c) / 3. */
export function anchoredVwap(candles, from) {
  const out = new Array(candles.length).fill(null);
  let pv = 0, vol = 0;
  for (let i = Math.max(0, from); i < candles.length; i++) {
    const k = candles[i], v = k.v ?? 0;
    pv += v * (k.h + k.l + k.c) / 3;
    vol += v;
    out[i] = vol > 0 ? pv / vol : null;
  }
  return out;
}

/**
 * Volume against its own recent average, and the video's three volume readings for each candle:
 *   ratio       volume ÷ the previous 20 candles' average
 *   absorption  heavy volume (≥ 2× average) on a small range (≤ 0.6× the average range): effort without result
 *   noSupply    the price moved (range ≥ average) on light volume (≤ 0.6× average): nobody in the way
 */
export function volumeReadings(candles, n = 20) {
  const vols = candles.map(k => k.v ?? 0), ranges = candles.map(k => k.h - k.l);
  const avgV = sma(vols, n), avgR = sma(ranges, n);
  return candles.map((k, i) => {
    const pv = i > 0 ? avgV[i - 1] : null, pr = i > 0 ? avgR[i - 1] : null;
    if (!(pv > 0) || !(pr > 0)) return { ratio: null, absorption: false, noSupply: false };
    const ratio = vols[i] / pv, range = ranges[i] / pr;
    return { ratio, absorption: ratio >= 2 && range <= 0.6, noSupply: ratio <= 0.6 && range >= 1 };
  });
}

/**
 * Volume profile of candles from..to (inclusive) in `rows` price rows.
 * Returns { lo, hi, rows: [{ lo, hi, volume }], poc, vah, val, hvn: [price], lvn: [price], shape, total } or null
 * without volume. `shape` is the video's reading: "P" (volume heavy at the top: bullish), "b" (heavy at the bottom:
 * bearish), "D" (heavy in the middle: balanced) or "thin" (spread out with no centre: a fast trend).
 */
export function volumeProfile(candles, from, to, rows = 120) {
  let lo = Infinity, hi = -Infinity, total = 0;
  for (let i = from; i <= to; i++) { lo = Math.min(lo, candles[i].l); hi = Math.max(hi, candles[i].h); total += candles[i].v ?? 0; }
  if (!(total > 0) || !(hi > lo)) return null;
  const step = (hi - lo) / rows;
  const vol = new Float64Array(rows);
  for (let i = from; i <= to; i++) {
    const k = candles[i], v = k.v ?? 0;
    if (!(v > 0)) continue;
    const a = Math.min(rows - 1, Math.floor((k.l - lo) / step)), b = Math.min(rows - 1, Math.floor((k.h - lo) / step));
    for (let r = a; r <= b; r++) vol[r] += v / (b - a + 1);
  }
  const mid = (r) => lo + (r + 0.5) * step;
  let pocRow = 0;
  for (let r = 1; r < rows; r++) if (vol[r] > vol[pocRow]) pocRow = r;

  // Value area: from the POC, add whichever neighbouring row is busier until 70% of the volume is inside.
  let up = pocRow, down = pocRow, inside = vol[pocRow];
  while (inside < 0.7 * total && (up < rows - 1 || down > 0)) {
    const above = up < rows - 1 ? vol[up + 1] : -1, below = down > 0 ? vol[down - 1] : -1;
    if (above >= below) inside += vol[++up]; else inside += vol[--down];
  }

  // Nodes on a lightly smoothed profile: local peaks well above the median, local troughs well below it.
  const smooth = Array.from(vol, (_, r) => {
    let s = 0, w = 0;
    for (let d = -2; d <= 2; d++) if (r + d >= 0 && r + d < rows) { s += vol[r + d] * (3 - Math.abs(d)); w += 3 - Math.abs(d); }
    return s / w;
  });
  const median = [...smooth].sort((a, b) => a - b)[rows >> 1];
  const hvn = [], lvn = [];
  for (let r = 3; r < rows - 3; r++) {
    const peak = smooth[r] >= smooth[r - 3] && smooth[r] >= smooth[r + 3] && smooth[r] >= smooth[r - 1] && smooth[r] >= smooth[r + 1];
    const trough = smooth[r] <= smooth[r - 3] && smooth[r] <= smooth[r + 3] && smooth[r] <= smooth[r - 1] && smooth[r] <= smooth[r + 1];
    if (peak && smooth[r] >= 1.3 * median && !hvn.some(p => Math.abs(p - mid(r)) < 4 * step)) hvn.push(mid(r));
    if (trough && smooth[r] <= 0.6 * median && !lvn.some(p => Math.abs(p - mid(r)) < 4 * step)) lvn.push(mid(r));
  }

  const poc = mid(pocRow), vah = lo + (up + 1) * step, val = lo + down * step;
  const pocPos = (poc - lo) / (hi - lo), spread = (vah - val) / (hi - lo);
  const shape = spread > 0.62 ? "thin" : pocPos > 0.62 ? "P" : pocPos < 0.38 ? "b" : "D";
  return {
    lo, hi, total, poc, vah, val, hvn, lvn, shape,
    rows: Array.from(vol, (volume, r) => ({ lo: lo + r * step, hi: lo + (r + 1) * step, volume }))
  };
}

/** One sentence per profile shape, as the transcript describes it; the shape is a reading, not a proven signal. */
export const SHAPE_NOTES = {
  P: "P-shape: volume heavy near the top. The video reads it as bullish: buy pullbacks to the POC.",
  b: "b-shape: volume heavy near the bottom. The video reads it as bearish: sell bounces into the POC.",
  D: "D-shape: volume heavy in the middle, a balanced market. The video fades the edges toward the POC.",
  thin: "Thin profile: volume spread out with no centre, a fast trend. The video buys or sells small clusters on pullbacks."
};
