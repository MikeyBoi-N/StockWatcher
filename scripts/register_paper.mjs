/**
 * Adds a registration to the paper record (data/paper/registry.json; see js/paper.js): the hypotheses, the frozen
 * model's weights, the stock list and the fingerprints of the code they depend on, all fixed from the data available
 * now. Entries are never edited afterwards; commit the registry right away, since the commit is the registration's
 * timestamp. Needs a fresh data/replay.json (python scripts/build_market_data.py).
 *
 * Usage: node scripts/register_paper.mjs [--dry-run]
 *   --dry-run  print the registration instead of writing it
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { marketDay } from "../js/history.js";
import { newRegistration } from "../js/paper.js";
import { decodeReplay, replayStates } from "../js/replay.js";
import { buildPanel, fitCompleted } from "../js/signals.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const REPLAY_FILE = `${root}data/replay.json`;
const REGISTRY_FILE = `${root}data/paper/registry.json`;
const dryRun = process.argv.includes("--dry-run");

if (!existsSync(REPLAY_FILE)) {
  console.error(`${REPLAY_FILE} is missing; run python scripts/build_market_data.py first.`);
  process.exit(1);
}
const replay = decodeReplay(JSON.parse(readFileSync(REPLAY_FILE, "utf8")));
const states = replayStates(replay);
const spy = replay.tickers.SPY.candles;
const dataThrough = new Date(spy.at(-1).t).toISOString().slice(0, 10);
const registeredOn = marketDay();
if (registeredOn < dataThrough) {
  console.error(`The replay runs to ${dataThrough}, after today (${registeredOn}); check the system clock.`);
  process.exit(1);
}

const universe = Object.entries(replay.tickers).filter(([, s]) => !s.etf).map(([t]) => t).sort();
const panel = buildPanel(replay, states, { sessions: 21, include: (t) => universe.includes(t), benchmark: "beta" });
const fit = fitCompleted(panel, spy.length - 1);
if (!fit) {
  console.error("Not enough replayed history to fit the model.");
  process.exit(1);
}
const entry = newRegistration({ registeredOn, dataThrough, universe, fit });

const registry = existsSync(REGISTRY_FILE) ? JSON.parse(readFileSync(REGISTRY_FILE, "utf8")) : { entries: [] };
if (registry.entries.some(e => e.id === entry.id)) {
  console.error(`A registration for ${entry.id} already exists; entries are never replaced.`);
  process.exit(1);
}
if (dryRun) {
  console.log(JSON.stringify(entry, null, 2));
  process.exit(0);
}
registry.entries.push(entry);
mkdirSync(dirname(REGISTRY_FILE), { recursive: true });
writeFileSync(REGISTRY_FILE, `${JSON.stringify(registry, null, 2)}\n`);
console.log(`Registered ${entry.id}: ${entry.hypotheses.length} hypotheses, ${universe.length} stocks, data through ${dataThrough}. Commit ${REGISTRY_FILE} now.`);
