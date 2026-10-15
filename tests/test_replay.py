import math
from datetime import date, timedelta

from market_data.indicators import technicals
from market_data.replay import FIELDS, WARMUP, replay, week_ends
from market_data.sources import PriceHistory


def weekday_bars(n, with_open=True):
    days, d = [], date(2021, 1, 4)
    while len(days) < n:
        if d.weekday() < 5:
            days.append(d)
        d += timedelta(days=1)
    closes = [100 * math.exp(0.02 * math.sin(i / 7) + 0.0005 * i) for i in range(n)]
    opens = [closes[i - 1] if i else closes[0] for i in range(n)] if with_open else None
    return PriceHistory("test", days, [c * 1.01 for c in closes], [c * 0.99 for c in closes], closes, [1000 + i for i in range(n)],
                        closes[-1], "t", opens)


def test_week_ends_picks_each_weeks_last_session_and_the_latest_bar():
    bars = weekday_bars(13)  # Mon 4 Jan .. Wed 20 Jan 2021
    assert [bars.dates[i].isoformat() for i in week_ends(bars.dates)] == ["2021-01-08", "2021-01-15", "2021-01-20"]


def test_each_row_matches_technicals_on_the_bars_up_to_that_week_and_no_later():
    bars = weekday_bars(WARMUP + 30)
    out = replay(bars)
    assert out["rows"], "rows start once a year of bars exists"
    assert all(row[0] + 1 >= WARMUP for row in out["rows"])
    for row in (out["rows"][0], out["rows"][-1]):
        i = row[0]
        cut = PriceHistory("test", bars.dates[:i + 1], bars.high[:i + 1], bars.low[:i + 1], bars.close[:i + 1], bars.volume[:i + 1],
                           bars.close[i], None)
        expected = technicals(cut)
        assert row[1:] == [expected[f] for f in FIELDS]


def test_bars_are_compact_parallel_lists():
    bars = weekday_bars(WARMUP + 5)
    out = replay(bars)["bars"]
    assert out["d"][0] == 20210104
    assert len(out["d"]) == len(out["c"]) == len(out["o"]) == len(out["v"])
    assert replay(weekday_bars(40, with_open=False))["bars"]["o"] is None
