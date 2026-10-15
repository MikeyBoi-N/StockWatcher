"""
Weekly two-tier screen for stocks outside the hand-picked list, written to data/screen.json.

Tier 1 is one request: Nasdaq's screener lists every US-listed stock with its price, market value, volume and sector.
It keeps US companies' common stock priced at $5 or more and worth at least $300M, drops the tracked and research
lists, and takes the POOL_SIZE largest by market value. Tier 2 fetches two years of daily prices for each of those and
ranks them on two documented price signals: 12-month momentum skipping the last month (Jegadeesh & Titman 1993) and
closeness to the 52-week high (George & Hwang 2004), among stocks above their 200-day average that trade at least
$10M a day. The top PICKS, at most SECTOR_CAP per sector, get the full analysis in the next data build.

Neither signal cleared the noise in this app's own replay, and stocks picked today on their past year cannot be
backtested honestly on that same past, so build_market_data.py keeps them out of every backtest; the live record is
what will judge them. The screen sees only today's listings, so it is survivor-biased too.

Usage:
  python scripts/screen_universe.py [--previous PATH] [--max-age-days 6] [--force]

--previous is the last deployed screen.json; when it (or the committed data/screen.json) is younger than
--max-age-days, it is kept and nothing is fetched, so the screen runs once a week however often the build runs.
Each new screen carries the earlier weeks' picks forward in `history` and scores them against SPY in `record`: the
only test of the screen that is free of hindsight.
"""
import argparse
import json
import math
import statistics
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

from market_data.http_client import FetchError, HttpClient
from market_data.sources import YahooChart

ROOT = Path(__file__).resolve().parent.parent
UNIVERSE_FILE = ROOT / "data" / "universe.json"
SYMBOLS_FILE = ROOT / "data" / "symbols.json"
OUTPUT_FILE = ROOT / "data" / "screen.json"
SCREENER_URL = "https://api.nasdaq.com/api/screener/stocks?tableonly=true&download=true"

POOL_SIZE = 1500
PICKS = 50
SECTOR_CAP = 6
MIN_PRICE = 5.0
MIN_MARKET_CAP = 300e6
MIN_DOLLAR_VOLUME = 10e6
WORKERS = 6
METHOD = {
    "pool": f"US companies' common stock, price ≥ ${MIN_PRICE:.0f}, market value ≥ ${MIN_MARKET_CAP / 1e6:.0f}M, "
            f"not on the tracked or research lists; the {POOL_SIZE:,} largest by market value",
    "gates": f"above the 200-day average; median daily dollar volume over 20 days ≥ ${MIN_DOLLAR_VOLUME / 1e6:.0f}M; a year of prices",
    "rank": "average percentile of 12-month momentum skipping the last month and closeness to the 52-week high",
    "picks": f"top {PICKS}, at most {SECTOR_CAP} per sector",
    "caveat": "Neither signal cleared the noise in this app's replay. Picks are kept out of backtests (chosen on the "
              "past year, so testing them on it would be hindsight) and judged by the live record from the week they are picked.",
}


def number(text):
    """'$1,234.50' or '12.3%' -> float, or None."""
    try:
        return float(str(text).replace("$", "").replace(",", "").replace("%", ""))
    except ValueError:
        return None


def tier_one(rows, directory, exclude, pool_size=POOL_SIZE):
    """
    Nasdaq screener rows -> the pool: [{ticker, name, sector, industry, price, marketCap}], largest first.
    Keeps symbols in the directory that are not ETFs (the directory already drops warrants, units and preferreds).
    """
    pool = []
    for row in rows:
        ticker = (row.get("symbol") or "").strip().upper().replace("/", ".")
        entry = directory.get(ticker)
        if not entry or entry["etf"] or ticker in exclude or row.get("country") != "United States":
            continue
        price, cap = number(row.get("lastsale")), number(row.get("marketCap"))
        if price is None or cap is None or price < MIN_PRICE or cap < MIN_MARKET_CAP:
            continue
        pool.append({"ticker": ticker, "name": entry["name"], "sector": row.get("sector") or None,
                     "industry": row.get("industry") or None, "price": price, "marketCap": cap})
    pool.sort(key=lambda s: -s["marketCap"])
    return pool[:pool_size]


def measures(bars):
    """
    A year of daily bars -> {momentum, high52, aboveSma200, dollarVolume} or None with too little history.
    Uses dividend-adjusted closes for returns when the source gave them.
    """
    closes = bars.adj_close if bars.adj_close and None not in bars.adj_close[-253:] else bars.close
    if len(closes) < 253:
        return None
    raw = bars.close
    sma200 = sum(raw[-200:]) / 200
    dollar = [c * v for c, v in zip(raw[-20:], bars.volume[-20:])]
    return {
        "close": raw[-1],
        "momentum": closes[-22] / closes[-253] - 1,
        "high52": raw[-1] / max(bars.high[-252:]) - 1,
        "aboveSma200": raw[-1] > sma200,
        "dollarVolume": statistics.median(dollar),
    }


def percentile_ranks(values):
    """Each value's rank among `values`, scaled 0 (lowest) to 1 (highest); ties share the average rank."""
    order = sorted(range(len(values)), key=lambda i: values[i])
    ranks = [0.0] * len(values)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and values[order[j + 1]] == values[order[i]]:
            j += 1
        for k in range(i, j + 1):
            ranks[order[k]] = (i + j) / 2 / max(1, len(values) - 1)
        i = j + 1
    return ranks


def tier_two(candidates, picks=PICKS, sector_cap=SECTOR_CAP):
    """
    Candidates with measures -> the picks, best first, each with its score (0-1). Candidates that fail a gate are
    dropped before ranking, so the percentiles are among eligible stocks only.
    """
    eligible = [c for c in candidates if c["aboveSma200"] and c["dollarVolume"] >= MIN_DOLLAR_VOLUME
                and math.isfinite(c["momentum"]) and math.isfinite(c["high52"])]
    if not eligible:
        return []
    mom = percentile_ranks([c["momentum"] for c in eligible])
    high = percentile_ranks([c["high52"] for c in eligible])
    scored = sorted(({**c, "score": (m + h) / 2} for c, m, h in zip(eligible, mom, high)), key=lambda c: -c["score"])
    chosen, per_sector = [], {}
    for c in scored:
        sector = c["sector"] or "Unknown"
        if per_sector.get(sector, 0) >= sector_cap:
            continue
        per_sector[sector] = per_sector.get(sector, 0) + 1
        chosen.append(c)
        if len(chosen) == picks:
            break
    return chosen


def track_record(history, prices, spy_now, today, min_days=7):
    """
    How each earlier week's picks have done since: [{date, picks, priced, return, spy, excess}] for weeks at least
    min_days old, newest first. `history` is [{date, spy, picks: [[ticker, price]]}]; `prices` maps ticker -> today's
    price. A pick with no price today (delisted, or a failed fetch) is counted in `picks` but not `priced`, so a
    shrinking `priced` shows what the average leaves out.
    """
    out = []
    for week in history:
        if (today - datetime.fromisoformat(week["date"]).date()).days < min_days or not week.get("spy"):
            continue
        returns = [prices[t] / p - 1 for t, p in week["picks"] if p and prices.get(t)]
        if not returns:
            continue
        mean = sum(returns) / len(returns)
        spy = spy_now / week["spy"] - 1
        out.append({"date": week["date"], "picks": len(week["picks"]), "priced": len(returns),
                    "return": round(mean, 4), "spy": round(spy, 4), "excess": round(mean - spy, 4)})
    return sorted(out, key=lambda w: w["date"], reverse=True)


def load(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return None


def fresh(path, max_age_days):
    """The screen at `path` if it parses, has picks and is younger than max_age_days; else None."""
    try:
        screen = json.loads(Path(path).read_text(encoding="utf-8"))
        made = datetime.fromisoformat(screen["generatedAt"])
    except (OSError, ValueError, KeyError, TypeError):
        return None
    young = datetime.now(timezone.utc) - made < timedelta(days=max_age_days)
    return screen if young and screen.get("picks") else None


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--previous", type=Path, help="the last deployed screen.json")
    parser.add_argument("--max-age-days", type=float, default=6)
    parser.add_argument("--force", action="store_true", help="screen even if a recent screen exists")
    args = parser.parse_args()

    if not args.force:
        for path in (args.previous, OUTPUT_FILE):
            screen = path and fresh(path, args.max_age_days)
            if screen:
                if path != OUTPUT_FILE:
                    OUTPUT_FILE.write_text(json.dumps(screen, separators=(",", ":")), encoding="utf-8")
                print(f"Screen from {screen['generatedAt']} is recent; keeping its {len(screen['picks'])} picks")
                return

    universe = json.loads(UNIVERSE_FILE.read_text(encoding="utf-8"))
    exclude = set(universe["primary"] + universe["secondary"] + universe.get("research", []))
    directory = {s: {"name": n, "etf": bool(etf)} for s, n, _, etf in json.loads(SYMBOLS_FILE.read_text(encoding="utf-8"))["symbols"]}
    http = HttpClient(min_interval_by_host={"query1.finance.yahoo.com": 0.15})

    rows = ((http.get_json(SCREENER_URL).get("data") or {}).get("rows")) or []
    pool = tier_one(rows, directory, exclude)
    if len(pool) < PICKS:
        sys.exit(f"Screener gave {len(rows)} rows and only {len(pool)} passed tier one; keeping the previous screen")
    print(f"Tier one: {len(pool)} of {len(rows)} listings")

    prices = YahooChart(http)

    def measure(stock):
        try:
            m = measures(prices.price_history(stock["ticker"], years=2))
        except FetchError as err:
            return stock["ticker"], None, str(err)
        return stock["ticker"], m, None

    candidates, failed = [], 0
    by_ticker = {s["ticker"]: s for s in pool}
    with ThreadPoolExecutor(max_workers=WORKERS) as executor:
        for ticker, m, err in executor.map(measure, pool):
            if m is None:
                failed += 1
                continue
            candidates.append({**by_ticker[ticker], **m})
    if len(candidates) < 0.8 * len(pool):
        sys.exit(f"Only {len(candidates)} of {len(pool)} price histories loaded; keeping the previous screen")

    picks = tier_two(candidates)
    round4 = lambda v: round(v, 4)

    # The track record: every earlier week's picks at their prices then, measured against SPY to today.
    previous = next((s for s in (args.previous and load(args.previous), load(OUTPUT_FILE)) if s), None) or {}
    history = previous.get("history", [])
    today = datetime.now(timezone.utc).date()
    spy_now = prices.price_history("SPY", years=1).close[-1]
    now_prices = {c["ticker"]: c["close"] for c in candidates}
    for ticker in {t for week in history for t, _ in week["picks"]} - now_prices.keys():
        try:
            now_prices[ticker] = prices.price_history(ticker, years=1).close[-1]
        except (FetchError, IndexError):
            pass
    history = [w for w in history if w["date"] != today.isoformat()]
    history.append({"date": today.isoformat(), "spy": round(spy_now, 4), "picks": [[c["ticker"], round4(c["close"])] for c in picks]})
    history = history[-104:]
    OUTPUT_FILE.write_text(json.dumps({
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "method": METHOD,
        "counts": {"listings": len(rows), "pool": len(pool), "measured": len(candidates),
                   "eligible": sum(c["aboveSma200"] and c["dollarVolume"] >= MIN_DOLLAR_VOLUME for c in candidates)},
        "picks": [{"ticker": c["ticker"], "name": c["name"], "sector": c["sector"], "industry": c["industry"],
                   "marketCap": round(c["marketCap"]), "momentum": round4(c["momentum"]), "high52": round4(c["high52"]),
                   "dollarVolume": round(c["dollarVolume"]), "score": round4(c["score"])} for c in picks],
        "record": track_record(history, now_prices, spy_now, today),
        "history": history,
    }, separators=(",", ":")), encoding="utf-8")
    print(f"Tier two: {len(candidates)} measured ({failed} failed); wrote {len(picks)} picks to {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
