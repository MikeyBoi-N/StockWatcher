from datetime import date

import pytest

from screen_universe import MIN_DOLLAR_VOLUME, percentile_ranks, tier_one, tier_two, track_record

DIRECTORY = {"AAA": {"name": "Aaa Inc.", "etf": False}, "BBB": {"name": "Bbb Corp.", "etf": False},
             "ETF": {"name": "Some ETF", "etf": True}, "CCC": {"name": "Ccc Ltd.", "etf": False},
             "DDD": {"name": "Ddd Co.", "etf": False}, "BRK.B": {"name": "Berkshire", "etf": False}}


def row(symbol, price, cap, country="United States", sector="Technology"):
    return {"symbol": symbol, "lastsale": f"${price}", "marketCap": str(cap), "country": country, "sector": sector, "industry": "x"}


def test_tier_one_keeps_large_enough_us_common_stocks_outside_the_lists_largest_first():
    rows = [row("AAA", 20, 5e9), row("BBB", 4, 9e9), row("ETF", 50, 9e9), row("CCC", 30, 1e8), row("DDD", 30, 8e9),
            row("ZZZ", 30, 8e9), row("BRK/B", 400, 9e11), row("AAA", 20, 5e9, country="Canada")]
    pool = tier_one(rows, DIRECTORY, exclude={"BRK.B"})
    # BBB too cheap, ETF an ETF, CCC too small, ZZZ not in the directory, BRK.B already tracked.
    assert [s["ticker"] for s in pool] == ["DDD", "AAA"]
    assert tier_one(rows, DIRECTORY, exclude=set(), pool_size=1)[0]["ticker"] == "BRK.B"


def test_percentile_ranks_run_zero_to_one_and_share_ties():
    assert percentile_ranks([3, 1, 2]) == [1.0, 0.0, 0.5]
    assert percentile_ranks([1, 1, 2]) == [0.25, 0.25, 1.0]


def candidate(ticker, momentum, high52, sector="Tech", above=True, dollars=2 * MIN_DOLLAR_VOLUME):
    return {"ticker": ticker, "sector": sector, "momentum": momentum, "high52": high52, "aboveSma200": above, "dollarVolume": dollars}


def test_tier_two_gates_then_ranks_on_momentum_and_the_52_week_high_with_a_sector_cap():
    cands = [candidate("A", 0.5, -0.01), candidate("B", 0.4, -0.02), candidate("C", 0.3, -0.03, sector="Energy"),
             candidate("D", 0.9, 0.0, above=False), candidate("E", 0.9, 0.0, dollars=1e6)]
    picks = tier_two(cands, picks=5, sector_cap=1)
    assert [p["ticker"] for p in picks] == ["A", "C"], "D below its 200-day, E illiquid, B over the Tech cap"
    assert picks[0]["score"] == pytest.approx(1.0)


def test_track_record_measures_each_old_week_against_spy_and_counts_missing_prices():
    history = [
        {"date": "2026-09-01", "spy": 100, "picks": [["A", 10], ["B", 20], ["GONE", 5]]},
        {"date": "2026-10-12", "spy": 110, "picks": [["A", 12]]},  # too recent to judge
    ]
    record = track_record(history, {"A": 12, "B": 22}, spy_now=110, today=date(2026, 10, 15))
    assert len(record) == 1
    week = record[0]
    assert (week["picks"], week["priced"]) == (3, 2)
    assert week["return"] == pytest.approx(0.15)
    assert week["spy"] == pytest.approx(0.10)
    assert week["excess"] == pytest.approx(0.05)
