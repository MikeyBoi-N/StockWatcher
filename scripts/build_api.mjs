/**
 * Writes the public developer API (see js/api.js) from data/market.json into api/v1/, which the deploy workflow then
 * publishes with the rest of the site, so the API always matches the data the page shows.
 *
 * api/v1/ is cleared first so a stock that stopped being tracked doesn't leave a stale file behind. The folder is
 * generated and gitignored.
 *
 * With --page it also writes a static summary of stocks.json between index.html's snapshot markers, so clients that
 * don't run JavaScript see the readings. Only the deploy workflow passes it: the committed index.html keeps the markers
 * empty, and the edited copy is what gets published.
 *
 * Usage: node scripts/build_api.mjs [--page]
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { apiDocuments, snapshotHtml } from "../js/api.js";
import { frozenModel } from "../js/edge.js";

const MARKET_FILE = new URL("../data/market.json", import.meta.url);
const OUT_DIR = new URL("../api/v1/", import.meta.url);
const PAGE_FILE = new URL("../index.html", import.meta.url);
const REGISTRY_FILE = new URL("../data/paper/registry.json", import.meta.url);
const SNAPSHOT_MARKERS = /(<!-- snapshot:start -->)[\s\S]*?(<!-- snapshot:end -->)/;

const market = JSON.parse(readFileSync(MARKET_FILE, "utf8"));
const model = existsSync(REGISTRY_FILE) ? frozenModel(JSON.parse(readFileSync(REGISTRY_FILE, "utf8"))) : null;
const { index, stocks } = apiDocuments(market, { model });

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(new URL("stocks/", OUT_DIR), { recursive: true });
writeFileSync(new URL("stocks.json", OUT_DIR), JSON.stringify(index));
for (const [ticker, doc] of stocks) writeFileSync(new URL(`stocks/${ticker}.json`, OUT_DIR), JSON.stringify(doc));

if (process.argv.includes("--page")) {
  const page = readFileSync(PAGE_FILE, "utf8");
  if (!SNAPSHOT_MARKERS.test(page)) throw new Error("index.html has no snapshot markers");
  // A replacer function, so a "$" in the data is never read as a replacement pattern.
  writeFileSync(PAGE_FILE, page.replace(SNAPSHOT_MARKERS, (_, start, end) => `${start}\n    ${snapshotHtml(index)}\n    ${end}`));
  console.log("Wrote the readings snapshot into index.html.");
}

console.log(`Wrote api/v1: stocks.json and ${stocks.size} stock files (build ${market.generatedAt}, regime ${index.market.regime}).`);
