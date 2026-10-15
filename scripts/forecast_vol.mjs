/**
 * Adds a GJR-GARCH volatility forecast to every stock in data/market.json, from the five years of daily candles in
 * data/replay.json (both written by scripts/build_market_data.py in the same build). The engine compares an option's
 * implied volatility with this forecast to decide whether options are cheap or expensive, and the Strategy prices
 * options at it for their expected value.
 *
 * Each stock gets volForecast = { model, vol21, diffusive21, volToExpiry, sessionsToExpiry, earningsInWindow }:
 *   vol21        annualized volatility expected over the next 21 sessions
 *   diffusive21  the same without earnings gaps: what a position that exits before earnings lives through
 *   volToExpiry  the same over the life of the option the engine reads (its daysToExpiration), counting a scheduled
 *                earnings release inside it as one of the stock's typical earnings-day moves; null without options
 * Stocks without five months of candles, and ETFs' earnings, are left without the parts they can't support.
 *
 * It also adds `beta`: the stock's one-year beta to SPY from daily total returns, shrunk a third toward 1 (trailingBeta
 * in js/replay.js, the same measure the scorecard uses). The Portfolio page splits risk into market and stock-specific
 * parts with it. Null with fewer than 120 shared days.
 *
 * Usage: node scripts/forecast_vol.mjs [market.json] [replay.json]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { decodeReplay, trailingBeta } from "../js/replay.js";
import { earningsEvents, forecastVolatility, prepare } from "../js/simulator.js";

const marketFile = process.argv[2] ?? new URL("../data/market.json", import.meta.url);
const replayFile = process.argv[3] ?? new URL("../data/replay.json", import.meta.url);
if (!existsSync(replayFile)) {
  console.log(`NOTICE: ${replayFile} is missing; no volatility forecasts this build.`);
  process.exit(0);
}

const market = JSON.parse(readFileSync(marketFile, "utf8"));
const replay = decodeReplay(JSON.parse(readFileSync(replayFile, "utf8")));
const calendarToSessions = (days) => Math.max(1, Math.round(days * 252 / 365));
const spy = replay.tickers.SPY?.candles ?? [];
const spyIndex = new Map(spy.map((k, i) => [k.t, i]));

let written = 0;
for (const [ticker, record] of Object.entries(market.stocks)) {
  delete record.volForecast;
  delete record.beta;
  const source = replay.tickers[ticker] ?? replay.screened[ticker];
  if (!source) continue;
  const beta = spy.length ? trailingBeta(source.candles, source.candles.length - 1, spy, spyIndex) : null;
  if (Number.isFinite(beta)) record.beta = Math.round(beta * 1000) / 1000;
  const prep = prepare(source.candles);
  // The next release may be newer than the filings history; the build's own earnings date fills it in.
  const history = source.earnings && record.catalysts?.nextEarningsDate && !source.earnings.dates.includes(record.catalysts.nextEarningsDate)
    ? { ...source.earnings, dates: [...source.earnings.dates, record.catalysts.nextEarningsDate] }
    : source.earnings;
  const forecast = (sessions) => forecastVolatility(prep, sessions, history ? earningsEvents(prep, history, prep.n - 1, sessions) : null);
  const near = forecast(21);
  if (!near) continue;
  const dte = record.options?.daysToExpiration;
  const toExpiry = Number.isFinite(dte) && dte > 0 ? forecast(calendarToSessions(dte)) : null;
  record.volForecast = {
    model: history ? "GJR-GARCH(1,1) with earnings gaps" : "GJR-GARCH(1,1)",
    vol21: Math.round(near.vol * 1e4) / 1e4,
    diffusive21: Math.round(near.diffusive * 1e4) / 1e4,
    volToExpiry: toExpiry ? Math.round(toExpiry.vol * 1e4) / 1e4 : null,
    sessionsToExpiry: toExpiry ? calendarToSessions(dte) : null,
    earningsInWindow: toExpiry ? toExpiry.earningsDays > 0 : null
  };
  written++;
}
writeFileSync(marketFile, JSON.stringify(market));
console.log(`Wrote volatility forecasts for ${written} of ${Object.keys(market.stocks).length} stocks, and betas.`);
