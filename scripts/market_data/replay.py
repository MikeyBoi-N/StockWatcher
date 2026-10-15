"""
Point-in-time replay: the technical fields the build would have produced at the end of each past week.

Each row runs the same technicals() the live build runs, on the bars up to and including that week's last session and
nothing after it, so a backtest of the scoring engine sees exactly what the engine would have seen then. Only price
data can be replayed this way: fundamentals, analyst estimates, earnings dates and options are today's values and
would leak the future, so they are left out and the engine scores them as missing.
"""
from dataclasses import replace

from .indicators import TRADING_DAYS_PER_YEAR, technicals

# A year of bars plus one, so the 12-month return, 200-day SMA and 52-week range are all defined from the first row.
WARMUP = TRADING_DAYS_PER_YEAR + 1
# Numeric engine inputs kept per row; the 120-close chart series is redundant with the full bars.
FIELDS = [
    "price", "prevClose", "high52", "low52", "sma20", "sma50", "sma50Prior", "close21Prior", "sma200", "rsi14", "hv30",
    "volume", "avgVolume20", "majorSupport", "secondarySupport", "majorResistance", "entrySupport",
    "rangeHigh60", "rangeLow60", "return5d", "return1m", "return3m", "return6m", "return12m",
]


def week_ends(dates):
    """Indices of each ISO week's last bar (the latest bar always counts, even mid-week)."""
    return [i for i, d in enumerate(dates) if i + 1 == len(dates) or dates[i + 1].isocalendar()[:2] != d.isocalendar()[:2]]


def replay(bars, warmup=WARMUP):
    """
    bars: PriceHistory. Returns {"bars": {...}, "rows": [[bar index, *FIELDS values]]}, rows oldest first.
    `bars` holds the daily candles as parallel lists (dates as YYYYMMDD integers; `o` is null when the source gave
    no opens), so the page can draw them, and `a` the dividend-adjusted closes (null when the source gave none), so
    what followed each row is measured as total return: a stock paying 6% a year would otherwise look 0.5% a month
    worse than it did.
    """
    rows = []
    for i in week_ends(bars.dates):
        if i + 1 < warmup:
            continue
        end = i + 1
        cut = replace(bars, dates=bars.dates[:end], high=bars.high[:end], low=bars.low[:end], close=bars.close[:end],
                      volume=bars.volume[:end], open=bars.open[:end] if bars.open else None,
                      adj_close=bars.adj_close[:end] if bars.adj_close else None,
                      last_price=bars.close[i], last_time=None)
        tech = technicals(cut)
        rows.append([i] + [tech.get(f) for f in FIELDS])
    return {
        "bars": {
            "d": [int(d.strftime("%Y%m%d")) for d in bars.dates],
            "o": [round(v, 2) for v in bars.open] if bars.open else None,
            "h": [round(v, 2) for v in bars.high],
            "l": [round(v, 2) for v in bars.low],
            "c": [round(v, 2) for v in bars.close],
            "a": [round(v, 4) for v in bars.adj_close] if bars.adj_close else None,
            "v": [int(v) for v in bars.volume],
        },
        "rows": rows,
    }
