/**
 * Candle sources for the simulator. Each returns candles in time order as [{ t, o, h, l, c, v }] (t in epoch ms),
 * so the simulator never knows where they came from.
 *
 *   Coinbase Exchange  Live crypto candles, keyless and CORS-enabled. Binance.com refuses US visitors (HTTP 451) and
 *                      Binance.US 1-minute BTC trades too thinly to draw real candles, so Coinbase is the source.
 *   data/replay.json   The site's build: five years of daily stock candles (decoded by js/replay.js).
 *   data/market.json   The site's build: the latest 120 daily closes per stock, used only if replay.json is missing.
 *                      Closes only, so these candles open at the previous close and have no wicks or volume.
 *   Firestore          The verdicts each build published, for scoring the app's live record.
 */

export const CRYPTO_PRODUCTS = ["BTC-USD", "ETH-USD", "SOL-USD"];

export const TIMEFRAMES = [
  { key: "1m", label: "1m", seconds: 60 },
  { key: "5m", label: "5m", seconds: 300 },
  { key: "15m", label: "15m", seconds: 900 },
  { key: "1h", label: "1h", seconds: 3600 },
  { key: "1d", label: "1D", seconds: 86400 }
];

const COINBASE = "https://api.exchange.coinbase.com";
/** Coinbase returns at most 300 candles per request. */
const PAGE = 300;

/**
 * The latest `count` closed candles of a Coinbase product at `seconds` per candle, paging backwards.
 * The candle still forming is dropped, so a simulation never starts from a half-finished bar.
 */
export async function coinbaseCandles(product, seconds, count = 3000, fetchFn = fetch) {
  const byTime = new Map();
  let end = Math.floor(Date.now() / 1000 / seconds) * seconds;
  while (byTime.size < count) {
    const start = end - PAGE * seconds;
    const url = `${COINBASE}/products/${encodeURIComponent(product)}/candles?granularity=${seconds}`
      + `&start=${new Date(start * 1000).toISOString()}&end=${new Date(end * 1000).toISOString()}`;
    const res = await fetchFn(url);
    if (!res.ok) throw new Error(`Coinbase answered ${res.status} for ${product}`);
    const rows = await res.json();
    if (!Array.isArray(rows) || !rows.length) break;
    for (const [t, low, high, open, close, volume] of rows) byTime.set(t, { t: t * 1000, o: open, h: high, l: low, c: close, v: volume });
    end = start;
  }
  const now = Date.now();
  return [...byTime.values()]
    .filter(k => k.t + seconds * 1000 <= now)
    .sort((a, b) => a.t - b.t)
    .slice(-count);
}

/** Weekdays stepping back from `last`; market holidays are not known here, so early dates can be a day or two off. */
function weekdaysBack(last, count) {
  const days = [];
  const d = new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), last.getUTCDate()));
  while (days.length < count) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) days.push(d.getTime());
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return days.reverse();
}

/** One stock from data/market.json as daily candles built from its closes. */
export function marketJsonCandles(stock) {
  const closes = stock.historicalSeries ?? [];
  const times = weekdaysBack(new Date(stock.asOf), closes.length);
  return closes.map((c, i) => ({ t: times[i], o: i ? closes[i - 1] : c, h: null, l: null, c, v: null }));
}

/** Coinbase's current bid/ask spread for a product, in basis points of the mid price. */
export async function coinbaseSpreadBps(product, fetchFn = fetch) {
  const res = await fetchFn(`${COINBASE}/products/${encodeURIComponent(product)}/ticker`);
  if (!res.ok) throw new Error(`Coinbase answered ${res.status} for ${product}`);
  const { bid, ask } = await res.json();
  const b = Number(bid), a = Number(ask);
  if (!(b > 0 && a >= b)) throw new Error(`No usable quote for ${product}`);
  return (a - b) / ((a + b) / 2) * 10000;
}

/** A Firestore REST value as plain JSON (integers become numbers, timestamps stay ISO strings). */
function fromFirestore(v) {
  if ("mapValue" in v) return Object.fromEntries(Object.entries(v.mapValue.fields ?? {}).map(([k, x]) => [k, fromFirestore(x)]));
  if ("arrayValue" in v) return (v.arrayValue.values ?? []).map(fromFirestore);
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("stringValue" in v) return v.stringValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("timestampValue" in v) return v.timestampValue;
  return null;
}

/**
 * Every published snapshot (the verdicts each data build recorded) from the public Firestore `snapshots` collection,
 * read over REST with the site's public web config. Only the fields the live record needs.
 */
export async function firestoreSnapshots(config, fetchFn = fetch) {
  const base = `https://firestore.googleapis.com/v1/projects/${config.projectId}/databases/(default)/documents/snapshots`;
  const snapshots = [];
  let pageToken = "";
  do {
    const url = `${base}?pageSize=300&key=${encodeURIComponent(config.apiKey)}&mask.fieldPaths=day&mask.fieldPaths=at&mask.fieldPaths=tickers`
      + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
    const res = await fetchFn(url);
    if (!res.ok) throw new Error(`Firestore answered ${res.status}`);
    const page = await res.json();
    for (const doc of page.documents ?? []) snapshots.push({ id: doc.name.split("/").pop(), ...fromFirestore({ mapValue: { fields: doc.fields ?? {} } }) });
    pageToken = page.nextPageToken ?? "";
  } while (pageToken);
  return snapshots;
}
