from datetime import date

import pytest

from market_data import analyst
from market_data.options import choose_expiration, is_monthly, parse_occ, summarize_chain


def test_parse_occ_symbol():
    assert parse_occ("AAPL261218P00260000") == (date(2026, 12, 18), "P", 260.0)
    assert parse_occ("BRK.B261120C00512500") == (date(2026, 11, 20), "C", 512.5)
    assert parse_occ("garbage") is None


def test_monthly_expirations_are_preferred_inside_window():
    as_of = date(2026, 9, 14)
    weekly_on_target = date(2026, 11, 6)      # 53 DTE, not monthly
    monthly = date(2026, 11, 20)              # 67 DTE, third Friday
    assert is_monthly(monthly) and not is_monthly(weekly_on_target)
    assert choose_expiration({weekly_on_target, monthly}, as_of) == monthly


def test_expiration_falls_back_when_window_is_empty():
    as_of = date(2026, 9, 14)
    assert choose_expiration({date(2026, 10, 16)}, as_of) == date(2026, 10, 16)   # 32 DTE
    assert choose_expiration({date(2026, 9, 18)}, as_of) is None                   # 4 DTE is too short


def test_real_chain_summary_is_atm_and_self_consistent(fixture):
    chain = fixture("cboe_aapl.json")
    price = chain["data"]["current_price"]
    summary = summarize_chain(chain, price, date(2026, 9, 14), hv30=0.30)
    assert summary is not None
    assert is_monthly(date.fromisoformat(summary["expiration"]))
    assert abs(summary["atmCallStrike"] - price) <= 5
    assert summary["atmCallBid"] <= summary["atmCallAsk"]
    assert 0.3 < summary["atmCallDelta"] < 0.7
    assert summary["ivHvRatio"] == pytest.approx(summary["impliedVolatility"] / 0.30, abs=0.01)
    assert summary["atmCallOpenInterest"] > 0


def test_earnings_date_parsing(fixture):
    iso, estimated = analyst.parse_earnings_date(fixture("nasdaq_aapl_earnings_date.json"))
    assert iso == "2026-10-29" and estimated is True
    assert analyst.parse_earnings_date(fixture("nasdaq_brkb_earnings_date.json")) == (None, None)


def test_forecast_parsing_sums_next_four_quarters(fixture):
    payload = fixture("nasdaq_aapl_forecast.json")
    rows = payload["data"]["quarterlyForecast"]["rows"][:4]
    parsed = analyst.parse_forecast(payload)
    assert parsed["ntmEps"] == pytest.approx(sum(r["consensusEPSForecast"] for r in rows), abs=0.01)
    assert parsed["analystCount"] >= 1
    assert analyst.parse_forecast(fixture("nasdaq_spy_forecast.json")) is None


def test_peg_and_summary_parsing(fixture):
    assert analyst.parse_peg(fixture("nasdaq_aapl_peg.json")) == pytest.approx(2.88)
    summary = analyst.parse_summary(fixture("nasdaq_aapl_summary.json"))
    assert summary["sector"] == "Technology"
    assert summary["marketCap"] > 1e12
    assert summary["high52"] > summary["low52"] > 0
    assert analyst.parse_summary(None)["marketCap"] is None


def test_number_parsing_handles_currency_and_missing_values():
    assert analyst._number("$1,234.50") == 1234.5
    assert analyst._number("N/A") is None
    assert analyst._number(None) is None
