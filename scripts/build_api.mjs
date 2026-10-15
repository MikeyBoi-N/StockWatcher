/**
 * Writes the public developer API (see js/api.js) from data/market.json into api/v1/, which the deploy workflow then
 * publishes with the rest of the site, so the API always matches the data the page shows.
 *
 * api/v1/ is cleared first so a stock that stopped being tracked doesn't leave a stale file behind. The folder is
 * generated and gitignored.
 *
 * Usage: node scripts/build_api.mjs
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { apiDocuments } from "../js/api.js";

const MARKET_FILE = new URL("../data/market.json", import.meta.url);
const OUT_DIR = new URL("../api/v1/", import.meta.url);

const market = JSON.parse(readFileSync(MARKET_FILE, "utf8"));
const { index, stocks } = apiDocuments(market);

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(new URL("stocks/", OUT_DIR), { recursive: true });
writeFileSync(new URL("stocks.json", OUT_DIR), JSON.stringify(index));
for (const [ticker, doc] of stocks) writeFileSync(new URL(`stocks/${ticker}.json`, OUT_DIR), JSON.stringify(doc));

console.log(`Wrote api/v1: stocks.json and ${stocks.size} stock files (build ${market.generatedAt}, regime ${index.market.regime}).`);
