/**
 * "What's happening" summaries built only from structured fields in data/market.json: the latest reported quarter
 * and capital returns (SEC XBRL), 8-K item numbers (SEC filing index) and keyword-toned headlines (Yahoo RSS).
 * Nothing here interprets text, so every statement traces to a number or a form item the company filed.
 */

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

// 8-K item 2.02 duplicates the quarter summary, so it isn't listed as an action.
const RESULTS_ITEM = "2.02";

export function compactAmount(value, currency = "USD") {
  const abs = Math.abs(value);
  const [div, suffix] = abs >= 1e12 ? [1e12, "T"] : abs >= 1e9 ? [1e9, "B"] : abs >= 1e6 ? [1e6, "M"] : [1e3, "K"];
  const digits = abs / div >= 100 ? 0 : 1;
  const text = `${(abs / div).toFixed(digits)}${suffix}`;
  return currency === "USD" ? `$${text}` : `${currency} ${text}`;
}

const shortDate = (iso) => new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const signedPct = (v) => `${v >= 0 ? "+" : "−"}${Math.abs(v * 100).toFixed(0)}%`;

/** e.g. "Quarter ended Jun 27: revenue $16.1B (+25% YoY), net loss $11.0B (was a $2.9B loss)." or null. */
export function quarterSummary(item) {
  const q = item.fundamentals?.latestQuarter;
  if (!q || !isNum(q.revenue)) return null;
  const amount = (v) => compactAmount(v, q.currency);
  const parts = [];

  const revenueYoY = isNum(q.revenuePriorYear) && q.revenuePriorYear > 0 ? q.revenue / q.revenuePriorYear - 1 : null;
  parts.push(`revenue ${amount(q.revenue)}${isNum(revenueYoY) ? ` (${signedPct(revenueYoY)} YoY)` : ""}`);

  if (isNum(q.netIncome)) {
    const now = q.netIncome < 0 ? `net loss ${amount(q.netIncome)}` : `net income ${amount(q.netIncome)}`;
    const prior = q.netIncomePriorYear;
    let then = "";
    if (isNum(prior)) {
      if (prior < 0) then = ` (was a ${amount(prior)} loss)`;
      else if (q.netIncome < 0) then = ` (was ${amount(prior)} profit)`;
      else if (prior > 0) then = ` (${signedPct(q.netIncome / prior - 1)} YoY)`;
    }
    parts.push(now + then);
  }
  return `Quarter ended ${shortDate(q.periodEnd)}: ${parts.join(", ")}.`;
}

/** Distinct 8-K actions (newest filing per item), negative ones first, excluding routine results releases. */
export function filingActions(item) {
  const byCode = new Map();
  for (const event of item.filingEvents ?? []) {
    for (const it of event.items) {
      if (it.code === RESULTS_ITEM) continue;
      const known = byCode.get(it.code);
      if (!known || event.date > known.date) byCode.set(it.code, { ...it, date: event.date, url: event.url });
    }
  }
  return [...byCode.values()].sort((a, b) => (a.tone === "negative" ? 0 : 1) - (b.tone === "negative" ? 0 : 1) || b.date.localeCompare(a.date));
}

/** e.g. "Returned $31.7B in buybacks and $17.3B in dividends over 12 months." or null. */
export function capitalReturns(item) {
  const f = item.fundamentals;
  if (!f) return null;
  const currency = f.reportingCurrency ?? "USD";
  const parts = [];
  if (isNum(f.buybacksTTM) && f.buybacksTTM > 0) parts.push(`${compactAmount(f.buybacksTTM, currency)} in buybacks`);
  if (isNum(f.dividendsTTM) && f.dividendsTTM > 0) parts.push(`${compactAmount(f.dividendsTTM, currency)} in dividends`);
  return parts.length ? `Returned ${parts.join(" and ")} over 12 months.` : null;
}

export function headlineCounts(item) {
  const counts = { positive: 0, negative: 0, neutral: 0, total: 0 };
  for (const h of item.headlines ?? []) {
    counts[h.tone]++;
    counts.total++;
  }
  return counts;
}

/**
 * One short line for the table row plus a tone and a sort key.
 * @returns {{text: string, tone: "neg"|"warn"|"", negatives: number} | null} null when there is nothing to say
 */
export function developmentsLine(item) {
  const q = item.fundamentals?.latestQuarter;
  const actions = filingActions(item);
  const news = headlineCounts(item);
  const parts = [];

  if (q && isNum(q.revenue)) {
    const yoy = isNum(q.revenuePriorYear) && q.revenuePriorYear > 0 ? ` ${signedPct(q.revenue / q.revenuePriorYear - 1)}` : "";
    const profit = isNum(q.netIncome) ? (q.netIncome < 0 ? `, loss ${compactAmount(q.netIncome, q.currency)}` : `, profit ${compactAmount(q.netIncome, q.currency)}`) : "";
    parts.push(`Q ${shortDate(q.periodEnd)}: rev${yoy}${profit}`);
  }
  if (actions.length) {
    const shown = actions.slice(0, 2).map(a => `${a.short} ${shortDate(a.date)}`);
    parts.push(shown.join("; ") + (actions.length > 2 ? ` +${actions.length - 2}` : ""));
  }
  if (news.positive || news.negative) parts.push(`news ${news.positive}+ ${news.negative}−`);
  if (!parts.length) return null;

  const negativeFilings = actions.filter(a => a.tone === "negative").length;
  const tone = negativeFilings ? "neg" : news.negative > news.positive || (isNum(q?.netIncome) && q.netIncome < 0) ? "warn" : "";
  return { text: parts.join(" · "), tone, negatives: negativeFilings * 2 + news.negative };
}
