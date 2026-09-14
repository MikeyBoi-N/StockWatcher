"""Deterministic technical indicators computed from daily bars. All inputs are oldest-first lists."""
import math
from statistics import pstdev

TRADING_DAYS_PER_YEAR = 252


def sma(values, period):
    if len(values) < period:
        return None
    return sum(values[-period:]) / period


def rsi_wilder(closes, period=14):
    """Wilder's RSI over the full series (seeded with a simple average, then smoothed)."""
    if len(closes) <= period:
        return None
    changes = [b - a for a, b in zip(closes, closes[1:])]
    avg_gain = sum(max(c, 0) for c in changes[:period]) / period
    avg_loss = sum(max(-c, 0) for c in changes[:period]) / period
    for change in changes[period:]:
        avg_gain = (avg_gain * (period - 1) + max(change, 0)) / period
        avg_loss = (avg_loss * (period - 1) + max(-change, 0)) / period
    if avg_loss == 0:
        return 100.0
    return 100 - 100 / (1 + avg_gain / avg_loss)


def realized_volatility(closes, period=30):
    """Annualized standard deviation of daily log returns over the last `period` returns."""
    if len(closes) <= period:
        return None
    window = closes[-(period + 1):]
    returns = [math.log(b / a) for a, b in zip(window, window[1:]) if a > 0 and b > 0]
    if len(returns) < period:
        return None
    return pstdev(returns) * math.sqrt(TRADING_DAYS_PER_YEAR)


def range_52w(highs, lows):
    window = TRADING_DAYS_PER_YEAR
    return max(highs[-window:]), min(lows[-window:])


def _swing_points(values, k, pick):
    """
    Indices whose value is the extreme (pick=min or max) of the surrounding +/- k bars. Only the first bar of a
    tied extreme counts, so flat stretches don't register as swings.
    """
    points = []
    for i in range(k, len(values) - k):
        window = values[i - k:i + k + 1]
        if values[i] == pick(window) and window.index(values[i]) == k:
            points.append(i)
    return points


def _cluster(levels, tolerance):
    """Merge price levels within `tolerance` (fractional) of each other; returns [(level, touches)]."""
    clusters = []
    for level in sorted(levels):
        if clusters and level <= clusters[-1][0] * (1 + tolerance):
            total, touches = clusters[-1][0] * clusters[-1][1] + level, clusters[-1][1] + 1
            clusters[-1] = (total / touches, touches)
        else:
            clusters.append((level, 1))
    return clusters


def support_resistance(highs, lows, price, high52, low52, lookback=TRADING_DAYS_PER_YEAR, k=15, tolerance=0.015):
    """
    Major swing points are the lowest low / highest high within +/- k bars (k=15 is roughly a six-week window)
    over the last year; nearby swings within `tolerance` are merged into one level.
    Support = nearest swing-low level at least 1% below price; secondary = next level at least 3% lower.
    Resistance = nearest swing-high level at least 1% above price. Falls back to the 52-week extremes when
    no swing qualifies. Returns levels plus the method used so the UI can disclose it.
    """
    highs, lows = highs[-lookback:], lows[-lookback:]
    swing_lows = _cluster([lows[i] for i in _swing_points(lows, k, min)], tolerance)
    swing_highs = _cluster([highs[i] for i in _swing_points(highs, k, max)], tolerance)

    below = [lvl for lvl, _ in swing_lows if lvl < price * 0.99]
    above = [lvl for lvl, _ in swing_highs if lvl > price * 1.01]

    major_support = max(below) if below else low52
    lower = [lvl for lvl in below if lvl <= major_support * 0.97]
    secondary_support = max(lower) if lower else min(low52, major_support * 0.92)
    major_resistance = min(above) if above else max(high52, price)

    return {
        "majorSupport": round(major_support, 2),
        "secondarySupport": round(secondary_support, 2),
        "majorResistance": round(major_resistance, 2),
        "supportMethod": "swing_low_cluster" if below else "52w_low_fallback",
        "resistanceMethod": "swing_high_cluster" if above else "52w_high_fallback",
    }


def technicals(bars):
    """bars: PriceHistory. Returns the technical fields the scoring engine consumes."""
    closes, highs, lows, volumes = bars.close, bars.high, bars.low, bars.volume
    price = bars.last_price
    high52, low52 = range_52w(highs, lows)
    high52, low52 = max(high52, price), min(low52, price)
    return {
        "price": round(price, 2),
        "prevClose": round(closes[-2], 2) if len(closes) > 1 else None,
        "high52": round(high52, 2),
        "low52": round(low52, 2),
        "sma20": _round(sma(closes, 20)),
        "sma50": _round(sma(closes, 50)),
        "sma200": _round(sma(closes, 200)),
        "rsi14": _round(rsi_wilder(closes, 14), 1),
        "hv30": _round(realized_volatility(closes, 30), 4),
        "volume": volumes[-1],
        "avgVolume20": round(sma(volumes, 20)) if len(volumes) >= 20 else None,
        **support_resistance(highs, lows, price, high52, low52),
        "historicalSeries": [round(c, 2) for c in closes[-120:]],
        "historicalStart": bars.dates[-min(120, len(closes))].isoformat(),
    }


def _round(value, digits=2):
    return None if value is None else round(value, digits)
