"""
Build data/market.json: real market data for the core universe plus tickers users added to their watchlists.

Usage:
  SEC_USER_AGENT="Your Name you@example.com" python scripts/build_market_data.py [--only AAPL,SPY] [--skip-requests]
      [--previous-earnings PATH]

Without SEC_USER_AGENT, SEC fundamentals are skipped (SEC requires a contact email in the User-Agent).
The output file is only written when SPY, QQQ and at least 80% of the core universe succeed, so a bad run
never replaces good data.
"""
import argparse
import json
import os
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timezone
from pathlib import Path

from market_data import analyst
from market_data.earnings import earnings_history
from market_data.http_client import FetchError, HttpClient
from market_data.indicators import technicals
from market_data.replay import FIELDS as REPLAY_FIELDS, replay
from market_data.snapshot import build_stock_record, failed_checks, price_history
from market_data.sources import CboeOptions, NasdaqAnalyst, NasdaqHistory, Providers, SecEdgar, YahooChart, YahooNews

ROOT = Path(__file__).resolve().parent.parent
UNIVERSE_FILE = ROOT / "data" / "universe.json"
# Picks from the weekly two-tier screen (scripts/screen_universe.py), analysed like any tracked stock.
SCREEN_FILE = ROOT / "data" / "screen.json"
SCREEN_MAX_AGE_DAYS = 14
SYMBOLS_FILE = ROOT / "data" / "symbols.json"
OUTPUT_FILE = ROOT / "data" / "market.json"
# Weekly point-in-time technicals and five years of daily candles for the simulator page's backtests. A separate file
# because it is several times the size of market.json and only that page reads it.
REPLAY_FILE = ROOT / "data" / "replay.json"
# Past earnings release sessions per replayed stock (also embedded in replay.json). Deployed with the site so the next
# build can start from it instead of paging back through years of EDGAR filings.
EARNINGS_FILE = ROOT / "data" / "earnings.json"
FIREBASE_CONFIG_FILE = ROOT / "firebase-config.js"

REGIME_TICKERS = ("SPY", "QQQ")
MAX_TICKERS = 250
MIN_CORE_SUCCESS = 0.8
WORKERS = 4


def load_symbol_directory():
    data = json.loads(SYMBOLS_FILE.read_text(encoding="utf-8"))
    return {s: {"name": n, "exchange": ex, "etf": bool(etf)} for s, n, ex, etf in data["symbols"]}


def screened_tickers(directory):
    """The screen's picks, if data/screen.json exists and is under SCREEN_MAX_AGE_DAYS old; else []."""
    try:
        screen = json.loads(SCREEN_FILE.read_text(encoding="utf-8"))
        made = datetime.fromisoformat(screen["generatedAt"])
    except (OSError, ValueError, KeyError, TypeError):
        return []
    if (datetime.now(timezone.utc) - made).days > SCREEN_MAX_AGE_DAYS:
        print(f"WARNING: {SCREEN_FILE.name} is from {screen['generatedAt']}; skipping its picks")
        return []
    return [p["ticker"] for p in screen.get("picks", []) if p.get("ticker") in directory]


def requested_tickers(http, directory):
    """Tickers users added, read from the public Firestore `tickerRequests` collection, newest first."""
    config = FIREBASE_CONFIG_FILE.read_text(encoding="utf-8")
    api_key = re.search(r'apiKey:\s*"([^"]+)"', config).group(1)
    project = re.search(r'projectId:\s*"([^"]+)"', config).group(1)
    base = f"https://firestore.googleapis.com/v1/projects/{project}/databases/(default)/documents/tickerRequests"

    requests, page_token = [], ""
    while True:
        payload = http.get_json(f"{base}?pageSize=300&key={api_key}" + (f"&pageToken={page_token}" if page_token else ""))
        for doc in payload.get("documents", []):
            ticker = doc["name"].rsplit("/", 1)[-1]
            requested_at = doc.get("fields", {}).get("requestedAt", {}).get("timestampValue", "")
            if ticker in directory:
                requests.append((requested_at, ticker))
        page_token = payload.get("nextPageToken")
        if not page_token:
            break
    return [t for _, t in sorted(requests, reverse=True)]


SECTOR_FIELDS = ("price", "sma50", "sma200", "return1m", "return3m", "return6m", "return12m")


def build_sector_benchmarks(sector_etfs, providers):
    """{sector name: {"etf", price, SMAs, returns}} from sector ETF price history; a sector that fails is left out."""
    sectors = {}
    for sector, etf in sector_etfs.items():
        try:
            bars = providers.prices.price_history(etf)
        except FetchError as err:
            print(f"  sector {etf}: {err}")
            continue
        tech = technicals(bars)
        sectors[sector] = {"etf": etf, **{k: tech[k] for k in SECTOR_FIELDS}}
    print(f"Sector benchmarks: {len(sectors)}/{len(sector_etfs)}")
    return sectors


def build_earnings(replays, edgar, previous_file):
    """
    {ticker: earnings_history()} for every replayed stock, from the start of its candles; None without SEC access.
    A stock whose lookup fails is left out rather than given a list that might be missing its latest release.
    """
    if edgar is None:
        return None
    previous = {}
    if previous_file and previous_file.exists():
        try:
            previous = json.loads(previous_file.read_text(encoding="utf-8"))["tickers"]
        except (ValueError, KeyError) as err:
            print(f"WARNING: ignoring unreadable {previous_file} ({err})")
    result = {}
    for ticker, entry in replays.items():
        if entry["etf"]:
            continue
        first = str(entry["bars"]["d"][0])
        since = date(int(first[:4]), int(first[4:6]), int(first[6:]))
        try:
            history = earnings_history(edgar, ticker, since, previous.get(ticker))
        except (FetchError, KeyError, TypeError, ValueError) as err:
            print(f"  earnings {ticker}: {err}")
            continue
        if history is not None:
            result[ticker] = history
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--only", help="comma-separated tickers to build (for local testing; output still validated)")
    parser.add_argument("--skip-requests", action="store_true", help="don't read user-requested tickers from Firestore")
    parser.add_argument("--previous-earnings", type=Path, help="the last build's earnings.json, to avoid refetching old filings")
    args = parser.parse_args()

    universe = json.loads(UNIVERSE_FILE.read_text(encoding="utf-8"))
    core = universe["primary"] + universe["secondary"]
    directory = load_symbol_directory()
    http = HttpClient(min_interval_by_host={"data.sec.gov": 0.15, "www.sec.gov": 0.15, "cdn.cboe.com": 0.2})

    requested = []
    if not args.skip_requests and not args.only:
        try:
            requested = requested_tickers(http, directory)
        except (FetchError, AttributeError) as err:
            print(f"WARNING: could not read requested tickers from Firestore ({err}); building core universe only")

    # Screened picks come last, so the cap trims them before anything a user asked for.
    screened = [] if args.only else [t for t in screened_tickers(directory) if t not in core and t not in requested]
    tickers = args.only.upper().split(",") if args.only else list(dict.fromkeys(core + requested + screened))[:MAX_TICKERS]
    unknown = [t for t in tickers if t not in directory]
    if unknown:
        sys.exit(f"Not in data/symbols.json: {', '.join(unknown)}")

    sec_user_agent = os.environ.get("SEC_USER_AGENT", "").strip()
    if not sec_user_agent:
        print("WARNING: SEC_USER_AGENT not set; skipping SEC fundamentals")
    providers = Providers(
        prices=YahooChart(http),
        prices_fallback=NasdaqHistory(http),
        options=CboeOptions(http),
        filings=SecEdgar(http, sec_user_agent) if sec_user_agent else None,
        analyst=NasdaqAnalyst(http),
        news=YahooNews(http),
    )

    as_of = datetime.now(timezone.utc).date()
    print(f"Building {len(tickers)} tickers ({len(requested)} user-requested, {len(screened)} screened) as of {as_of}")

    bars_by_ticker = {}

    def build(ticker):
        return ticker, *build_stock_record(ticker, directory[ticker], providers, as_of,
                                           on_bars=lambda bars: bars_by_ticker.__setitem__(ticker, bars))

    stocks, failures = {}, {}
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        for ticker, record, errors in pool.map(build, tickers):
            if record is None:
                failures[ticker] = errors
                print(f"  FAIL {ticker}: {'; '.join(errors)}")
                continue
            stocks[ticker] = record
            flags = failed_checks(record)
            notes = [f"{len(errors)} source error(s)"] if errors else []
            notes += [f"check {k}={v}%" for k, v in flags.items()]
            print(f"  ok   {ticker:6} ${record['price']:>9.2f}  {'; '.join(notes)}")
            for err in errors:
                print(f"         - {err}")

    sectors = {} if args.only else build_sector_benchmarks(universe.get("sectorEtfs", {}), providers)

    expected_core = [t for t in tickers if t in core]
    core_ok = [t for t in expected_core if t in stocks]
    missing_regime = [t for t in REGIME_TICKERS if t in expected_core and t not in stocks]
    if missing_regime or (expected_core and len(core_ok) / len(expected_core) < MIN_CORE_SUCCESS):
        sys.exit(f"Refusing to write {OUTPUT_FILE.name}: core {len(core_ok)}/{len(expected_core)} succeeded, missing regime tickers {missing_regime}")

    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "universe": universe,
        "requested": [t for t in requested if t in stocks],
        "screened": [t for t in screened if t in stocks],
        "sectors": sectors,
        "stocks": stocks,
        "failures": failures,
    }
    OUTPUT_FILE.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {len(stocks)} stocks to {OUTPUT_FILE} ({OUTPUT_FILE.stat().st_size // 1024} KB); {len(failures)} failed")

    # Screened picks are flagged so every backtest leaves them out: they were chosen on their past year, so testing
    # them on that year would be hindsight. Their candles still serve the volatility forecast and the Forecaster chart.
    screened_set = set(payload["screened"])
    replays = {
        t: {"etf": stocks[t]["etf"], "sector": stocks[t]["sector"], "research": False, **({"screened": True} if t in screened_set else {}),
            **replay(bars_by_ticker[t])}
        for t in stocks if t in bars_by_ticker
    }

    # The research list: roughly today's S&P 100 members, so the simulator's backtests are not limited to the
    # hand-picked tracked list. Prices and sector only; they never appear in market.json or the API. Being today's
    # members, they are survivors too: chosen for being large now.
    research = [] if args.only else [t for t in universe.get("research", []) if t in directory and t not in replays]

    def research_replay(ticker):
        errors = []
        is_etf = directory[ticker]["etf"]
        bars = price_history(ticker, is_etf, providers, as_of, errors)
        if not bars:
            return ticker, None, None, errors
        # The sector lets the page compare a stock with its sector peers; a failed lookup only loses that.
        try:
            sector = analyst.parse_summary(providers.analyst.summary(ticker, is_etf))["sector"]
        except FetchError as err:
            errors.append(f"sector: {err}")
            sector = None
        return ticker, replay(bars), sector, errors

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        for ticker, entry, sector, errors in pool.map(research_replay, research):
            if entry is None:
                print(f"  research {ticker}: {'; '.join(errors)}")
                continue
            if errors:
                print(f"  research {ticker}: {'; '.join(errors)}")
            replays[ticker] = {"etf": directory[ticker]["etf"], "sector": sector, "research": True, **entry}

    earnings = build_earnings(replays, providers.filings, args.previous_earnings)
    if earnings is not None:
        for ticker, entry in earnings.items():
            replays[ticker]["earnings"] = entry
        EARNINGS_FILE.write_text(json.dumps({"generatedAt": payload["generatedAt"], "tickers": earnings}, separators=(",", ":")),
                                 encoding="utf-8")
        print(f"Wrote earnings history for {len(earnings)} stocks to {EARNINGS_FILE}")
    REPLAY_FILE.write_text(json.dumps({"generatedAt": payload["generatedAt"], "fields": REPLAY_FIELDS, "tickers": replays},
                                      separators=(",", ":")), encoding="utf-8")
    print(f"Wrote replay history for {len(replays)} stocks ({sum(r['research'] for r in replays.values())} research-only) "
          f"to {REPLAY_FILE} ({REPLAY_FILE.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
