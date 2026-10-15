from datetime import date

import pytest

from market_data import analyst
from market_data.options import choose_expiration, is_monthly, parse_occ, summarize_chain, surface


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


def test_surface_reads_term_structure_and_earnings_from_a_real_chain(fixture):
    chain = fixture("cboe_aapl.json")
    price = chain["data"]["current_price"]
    summary = summarize_chain(chain, price, date(2026, 9, 14), hv30=0.30, earnings_date="2026-10-29")
    assert 0.15 < summary["iv30"] < summary["iv60"] < 0.40, "the expirations spanning earnings carry more volatility"
    assert 0.01 < summary["earningsMove"] < 0.10
    assert summary["earningsStraddle"] > summary["earningsMove"], "the straddle also prices the ordinary days"
    assert summarize_chain(chain, price, date(2026, 9, 14), hv30=0.30)["earningsMove"] is None


def _quote(expiry, kind, strike, iv, delta, bid=1.0):
    return (expiry, kind, strike, {"iv": iv, "delta": delta, "bid": bid, "ask": bid + 0.1})


def test_surface_interpolates_total_variance_and_reads_the_smile_by_delta():
    as_of, e19, e40 = date(2026, 9, 14), date(2026, 10, 3), date(2026, 10, 24)
    contracts = [
        _quote(e19, "C", 100, 0.20, 0.50), _quote(e19, "P", 100, 0.20, -0.50),
        _quote(e40, "C", 100, 0.30, 0.50), _quote(e40, "P", 100, 0.30, -0.50),
        _quote(e40, "P", 90, 0.40, -0.20), _quote(e40, "P", 95, 0.34, -0.30),
        _quote(e40, "P", 80, 0.60, -0.05, bid=0),   # no bid: its IV is not trusted
        _quote(e40, "C", 110, 0.26, 0.20), _quote(e40, "C", 105, 0.28, 0.30),
    ]
    s = surface(contracts, 100, as_of)
    assert s["iv30"] == pytest.approx(((0.04 * 19 + (0.09 * 40 - 0.04 * 19) * 11 / 21) / 30) ** 0.5, abs=1e-4)
    assert s["iv60"] is None, "no extrapolation past the last expiration"
    assert s["smileDte"] == 40
    assert s["put25Iv"] == pytest.approx(0.37) and s["call25Iv"] == pytest.approx(0.27)
    assert s["put10Iv"] is None and s["call10Iv"] is None


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
