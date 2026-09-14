import { test } from "node:test";
import assert from "node:assert/strict";
import { capitalReturns, compactAmount, developmentsLine, filingActions, quarterSummary } from "../js/developments.js";

const quarter = (overrides = {}) => ({
  periodEnd: "2026-06-27", currency: "USD", revenue: 16.128e9, revenuePriorYear: 12.859e9,
  operatingIncome: 1.796e9, operatingIncomePriorYear: -3.176e9, netIncome: -11.033e9, netIncomePriorYear: -2.918e9, ...overrides
});
const filing = (date, code, label, short, tone, url = `https://www.sec.gov/${date}-${code}`) => ({ date, form: "8-K", url, items: [{ code, label, short, tone }] });

test("quarter summary states the loss and the prior-year comparison", () => {
  assert.equal(quarterSummary({ fundamentals: { latestQuarter: quarter() } }),
    "Quarter ended Jun 27: revenue $16.1B (+25% YoY), net loss $11.0B (was a $2.9B loss).");
  assert.equal(quarterSummary({ fundamentals: { latestQuarter: quarter({ netIncome: 6.9e9, netIncomePriorYear: 5.0e9 }) } }),
    "Quarter ended Jun 27: revenue $16.1B (+25% YoY), net income $6.9B (+38% YoY).");
  assert.match(quarterSummary({ fundamentals: { latestQuarter: quarter({ netIncome: -1e8, netIncomePriorYear: 2e8 }) } }), /net loss \$100M \(was \$200M profit\)/);
  assert.equal(quarterSummary({ fundamentals: null }), null);
});

test("amounts keep the reporting currency", () => {
  assert.equal(compactAmount(-2.5e9), "$2.5B");
  assert.equal(compactAmount(8.3e11, "TWD"), "TWD 830B");
});

test("filing actions skip results releases, keep the newest per item, and list negatives first", () => {
  const item = { filingEvents: [
    filing("2026-09-01", "5.02", "Executive or director change", "Leadership change", "neutral"),
    filing("2026-08-20", "2.02", "Released results or a financial update", "Results", "neutral"),
    filing("2026-08-12", "2.05", "Restructuring (layoffs, closures or exit costs)", "Restructuring", "negative"),
    filing("2026-07-01", "5.02", "Executive or director change", "Leadership change", "neutral")
  ] };
  assert.deepEqual(filingActions(item).map(a => `${a.short} ${a.date}`), ["Restructuring 2026-08-12", "Leadership change 2026-09-01"]);
  const line = developmentsLine({ ...item, fundamentals: { latestQuarter: quarter() }, headlines: [{ tone: "negative" }, { tone: "neutral" }] });
  assert.equal(line.text, "Q Jun 27: rev +25%, loss $11.0B · Restructuring Aug 12; Leadership change Sep 1 · news 0+ 1−");
  assert.equal(line.tone, "neg");
});

test("stocks with no data produce no line, and capital returns only list what was paid", () => {
  assert.equal(developmentsLine({ fundamentals: null, filingEvents: null, headlines: null }), null);
  assert.equal(capitalReturns({ fundamentals: { reportingCurrency: "USD", buybacksTTM: 3.167e10, dividendsTTM: null } }), "Returned $31.7B in buybacks over 12 months.");
  assert.equal(capitalReturns({ fundamentals: { reportingCurrency: "USD", buybacksTTM: 0, dividendsTTM: null } }), null);
});
