import math
from datetime import date, timedelta

import pytest

from market_data.indicators import realized_volatility, rsi_wilder, sma, support_resistance, technicals, trailing_returns
from market_data.sources import PriceHistory

# Wilder RSI reference series and values from StockCharts' "Relative Strength Index" worked example.
RSI_CLOSES = [44.3389, 44.0902, 44.1497, 43.6124, 44.3278, 44.8264, 45.0955, 45.4245, 45.8433, 46.0826,
              45.8931, 46.0328, 45.6140, 46.2820, 46.2820, 46.0028, 46.0328, 46.4116, 46.2222]
RSI_EXPECTED = {15: 70.53, 16: 66.32, 17: 66.55, 18: 69.41, 19: 66.36}


def test_sma_uses_last_n_values_and_needs_enough_data():
    assert sma([1, 2, 3, 4, 5], 3) == 4
    assert sma([1, 2], 3) is None


@pytest.mark.parametrize("length,expected", RSI_EXPECTED.items())
def test_rsi_matches_wilder_reference(length, expected):
    assert rsi_wilder(RSI_CLOSES[:length]) == pytest.approx(expected, abs=0.01)


def test_rsi_edge_cases():
    assert rsi_wilder(list(range(1, 20))) == 100.0
    assert rsi_wilder([1, 2, 3]) is None


def test_realized_volatility_of_constant_growth_is_zero_and_known_series_annualizes():
    assert realized_volatility([100 * 1.01 ** i for i in range(40)]) == pytest.approx(0, abs=1e-12)
    alternating = [100 * (1.01 if i % 2 else 1.0) for i in range(31)]
    daily = math.log(1.01)
    assert realized_volatility(alternating) == pytest.approx(daily * math.sqrt(252), rel=1e-6)


def zigzag(lows_at, highs_at, length=120, base=100.0):
    """Flat series with swing lows/highs injected at given indices."""
    highs = [base + 1] * length
    lows = [base - 1] * length
    for i, level in lows_at.items():
        lows[i] = level
    for i, level in highs_at.items():
        highs[i] = level
    return highs, lows


def test_support_is_nearest_swing_low_cluster_below_price():
    highs, lows = zigzag({20: 90.0, 60: 90.8, 90: 95.0}, {40: 110.0, 100: 112.0})
    levels = support_resistance(highs, lows, price=100.0, high52=115.0, low52=85.0)
    assert levels["majorSupport"] == 95.0
    assert levels["secondarySupport"] == pytest.approx(90.4)  # 90.0 and 90.8 merge into one cluster
    assert levels["majorResistance"] == 110.0
    assert levels["supportMethod"] == "swing_low_cluster"


def test_support_falls_back_to_52_week_extremes_without_swings():
    highs, lows = [101.0] * 60, [99.0] * 60
    levels = support_resistance(highs, lows, price=200.0, high52=210.0, low52=80.0)
    assert levels["supportMethod"] == "52w_low_fallback" and levels["majorSupport"] == 80.0
    assert levels["resistanceMethod"] == "52w_high_fallback"
    assert levels["majorResistance"] == 210.0


def test_technicals_builds_engine_fields_from_bars():
    days = [date(2025, 1, 1) + timedelta(days=i) for i in range(260)]
    closes = [100 + i * 0.5 for i in range(260)]
    bars = PriceHistory("test", days, [c + 1 for c in closes], [c - 1 for c in closes], closes, [1000] * 260, closes[-1], "t")
    t = technicals(bars)
    assert t["price"] == closes[-1]
    assert t["sma50"] == pytest.approx(sum(closes[-50:]) / 50, abs=0.01)
    assert t["high52"] == closes[-1] + 1
    assert t["low52"] == closes[-252] - 1
    assert t["rsi14"] == 100.0
    assert len(t["historicalSeries"]) == 120
    assert t["historicalStart"] == days[-120].isoformat()


def test_trailing_returns_compare_with_the_close_n_sessions_back():
    closes = [100.0] * 40 + [110.0] * 23
    returns = trailing_returns(closes, 121.0)
    assert returns["return1m"] == pytest.approx(0.1)      # 21 sessions back is still 110
    assert returns["return3m"] is None                   # needs 64 closes
    assert trailing_returns(closes + [110.0], 121.0)["return3m"] == pytest.approx(0.21)
