"""Network adapters, one per data provider. Each method returns parsed data or raises FetchError."""
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

from .http_client import FetchError

HISTORY_YEARS = 5


@dataclass
class PriceHistory:
    """Daily bars, oldest first."""
    source: str
    dates: list
    high: list
    low: list
    close: list
    volume: list
    last_price: float
    last_time: str


def _bars(source, rows, last_price, last_time):
    by_date = {}
    for row in rows:
        by_date[row[0]] = row
    ordered = [by_date[d] for d in sorted(by_date)]
    if len(ordered) < 30:
        raise FetchError(f"{source}: only {len(ordered)} daily bars")
    return PriceHistory(
        source=source,
        dates=[r[0] for r in ordered],
        high=[r[1] for r in ordered],
        low=[r[2] for r in ordered],
        close=[r[3] for r in ordered],
        volume=[r[4] for r in ordered],
        last_price=last_price if last_price else ordered[-1][3],
        last_time=last_time,
    )


class YahooChart:
    name = "Yahoo Finance"

    def __init__(self, http):
        self.http = http

    def price_history(self, symbol):
        url = (f"https://query1.finance.yahoo.com/v8/finance/chart/{quote(symbol.replace('.', '-'))}"
               f"?range={HISTORY_YEARS}y&interval=1d&includePrePost=false")
        result = (self.http.get_json(url).get("chart") or {}).get("result")
        if not result or not result[0].get("timestamp"):
            raise FetchError(f"Yahoo returned no chart data for {symbol}")
        chart = result[0]
        meta, quotes = chart["meta"], chart["indicators"]["quote"][0]
        offset = timedelta(seconds=meta.get("gmtoffset", 0))
        rows = [
            ((datetime.fromtimestamp(ts, timezone.utc) + offset).date(), h, l, c, v or 0)
            for ts, h, l, c, v in zip(chart["timestamp"], quotes["high"], quotes["low"], quotes["close"], quotes["volume"])
            if None not in (h, l, c)
        ]
        market_time = meta.get("regularMarketTime")
        last_time = datetime.fromtimestamp(market_time, timezone.utc).isoformat() if market_time else None
        return _bars(self.name, rows, meta.get("regularMarketPrice"), last_time)


class NasdaqHistory:
    name = "Nasdaq.com"

    def __init__(self, http):
        self.http = http

    def price_history(self, symbol, is_etf, today):
        start = today - timedelta(days=365 * HISTORY_YEARS)
        url = (f"https://api.nasdaq.com/api/quote/{quote(symbol)}/historical?assetclass={'etf' if is_etf else 'stocks'}"
               f"&fromdate={start.isoformat()}&todate={today.isoformat()}&limit=9999")
        table = ((self.http.get_json(url).get("data") or {}).get("tradesTable") or {}).get("rows") or []

        def num(text):
            return float(str(text).replace("$", "").replace(",", ""))

        rows = []
        for r in table:
            try:
                rows.append((datetime.strptime(r["date"], "%m/%d/%Y").date(), num(r["high"]), num(r["low"]), num(r["close"]), int(num(r["volume"]))))
            except (KeyError, ValueError):
                continue
        if not rows:
            raise FetchError(f"Nasdaq returned no price history for {symbol}")
        latest = max(rows)
        return _bars(self.name, rows, latest[3], latest[0].isoformat())


class CboeOptions:
    name = "Cboe delayed quotes"

    def __init__(self, http):
        self.http = http

    def chain(self, symbol):
        return self.http.get_json(f"https://cdn.cboe.com/api/global/delayed_quotes/options/{quote(symbol)}.json")


class SecEdgar:
    name = "SEC EDGAR"

    def __init__(self, http, user_agent):
        self.http = http
        self.headers = {"User-Agent": user_agent}
        self._ciks = None

    def cik(self, symbol):
        if self._ciks is None:
            payload = self.http.get_json("https://www.sec.gov/files/company_tickers.json", self.headers)
            self._ciks = {row["ticker"]: int(row["cik_str"]) for row in payload.values()}
        return self._ciks.get(symbol.replace(".", "-"))

    def company_facts(self, symbol):
        cik = self.cik(symbol)
        if cik is None:
            return None
        return self.http.get_json(f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik:010d}.json", self.headers)


class NasdaqAnalyst:
    name = "Nasdaq.com (Zacks consensus)"

    def __init__(self, http):
        self.http = http

    def _get(self, path):
        return self.http.get_json(f"https://api.nasdaq.com/api/{path}")

    def summary(self, symbol, is_etf):
        return self._get(f"quote/{quote(symbol)}/summary?assetclass={'etf' if is_etf else 'stocks'}")

    def earnings_date(self, symbol):
        return self._get(f"analyst/{quote(symbol)}/earnings-date")

    def forecast(self, symbol):
        return self._get(f"analyst/{quote(symbol)}/earnings-forecast")

    def peg(self, symbol):
        return self._get(f"analyst/{quote(symbol)}/peg-ratio")


@dataclass
class Providers:
    """Injected into the snapshot builder so sources can be swapped or faked in tests."""
    prices: YahooChart
    prices_fallback: NasdaqHistory
    options: CboeOptions
    filings: SecEdgar | None
    analyst: NasdaqAnalyst

