from datetime import date

import pytest

from market_data.fundamentals import (
    Fact, business_direction, compute_fundamentals, concept_facts, quarterly_values, trailing_totals,
)

AS_OF = date(2026, 9, 14)


def fact(start, end, val):
    return Fact(date.fromisoformat(start), date.fromisoformat(end), val, "2026-01-01", "a", "10-Q")


def test_quarters_derived_from_year_to_date_cash_flow_periods():
    facts = [
        fact("2025-01-01", "2025-03-31", 10),   # Q1 (discrete)
        fact("2025-01-01", "2025-06-30", 25),   # H1 YTD -> Q2 = 15
        fact("2025-01-01", "2025-09-30", 45),   # 9M YTD -> Q3 = 20
        fact("2025-01-01", "2025-12-31", 70),   # FY -> Q4 = 25
    ]
    assert quarterly_values(facts) == {
        date(2025, 3, 31): 10, date(2025, 6, 30): 15, date(2025, 9, 30): 20, date(2025, 12, 31): 25,
    }


def test_trailing_totals_uses_four_quarters_and_prior_year():
    facts = []
    for year, base in ((2024, 10), (2025, 12)):
        facts += [fact(f"{year}-01-01", f"{year}-03-31", base), fact(f"{year}-04-01", f"{year}-06-30", base),
                  fact(f"{year}-07-01", f"{year}-09-30", base), fact(f"{year}-10-01", f"{year}-12-31", base)]
    end, ttm, prior = trailing_totals(facts)
    assert (end, ttm, prior) == (date(2025, 12, 31), 48, 40)


@pytest.mark.parametrize("revenue_growth,margin_change,earnings_growth,expected", [
    (0.20, 0.02, 0.30, "getting_stronger"),
    (-0.05, -0.02, -0.10, "getting_weaker"),
    (0.03, 0.0, 0.05, "roughly_unchanged"),
    (None, None, None, "roughly_unchanged"),
])
def test_business_direction_votes(revenue_growth, margin_change, earnings_growth, expected):
    assert business_direction(revenue_growth, margin_change, earnings_growth) == expected


def test_apple_quarterly_revenue_matches_reported_figures(fixture):
    unit, facts = concept_facts(fixture("sec_aapl.json"), "revenue")
    quarters = quarterly_values(facts)
    assert unit == "USD"
    # Apple 10-Q/10-K reported net sales (fiscal Q4 FY24 through Q4 FY25; Q4 is derived as FY minus 9 months).
    reported = {date(2024, 9, 28): 94.930e9, date(2024, 12, 28): 124.300e9, date(2025, 3, 29): 95.359e9,
                date(2025, 6, 28): 94.036e9, date(2025, 9, 27): 102.466e9}
    for end, value in reported.items():
        assert quarters[end] == pytest.approx(value, abs=0.001e9)


def test_derived_quarters_reconcile_to_annual_cash_flow(fixture):
    _, facts = concept_facts(fixture("sec_aapl.json"), "operating_cash_flow")
    annual = next(f.val for f in facts if f.end == date(2025, 9, 27) and (f.end - f.start).days > 350)
    quarters = quarterly_values(facts)
    fiscal_2025 = [v for end, v in quarters.items() if date(2024, 9, 29) <= end <= date(2025, 9, 27)]
    assert len(fiscal_2025) == 4
    assert sum(fiscal_2025) == pytest.approx(annual)


def test_apple_fundamentals_are_complete_and_consistent(fixture):
    result = compute_fundamentals(fixture("sec_aapl.json"), 332.27, lambda d: 200.0, AS_OF)
    assert result["reportingCurrency"] == "USD" and result["foreignFiler"] is False
    assert result["periodEnd"] == "2026-06-27"
    assert 0 < result["operatingMargin"] < 1
    assert result["trailingPe"] == pytest.approx(332.27 / result["epsTTM"], abs=0.1)
    assert result["historical5yPe"] is not None
    assert result["netDebtToEbitda"] is not None
    assert result["direction"] in {"getting_stronger", "roughly_unchanged", "getting_weaker"}


def test_stale_foreign_filer_is_excluded(fixture):
    assert compute_fundamentals(fixture("sec_tsm.json"), 433.24, lambda d: 300.0, AS_OF) is None


def test_foreign_filer_skips_per_share_price_ratios(fixture):
    result = compute_fundamentals(fixture("sec_tsm.json"), 433.24, lambda d: 300.0, date(2025, 6, 1))
    assert result["foreignFiler"] is True
    assert result["trailingPe"] is None and result["historical5yPe"] is None and result["epsTTM"] is None
    assert result["revenueGrowthYoY"] is not None


def test_bank_without_operating_income_reports_na_margin(fixture):
    result = compute_fundamentals(fixture("sec_jpm.json"), 356.23, lambda d: 250.0, AS_OF)
    assert result["operatingMargin"] is None and result["netDebtToEbitda"] is None
    assert result["revenueGrowthYoY"] is not None and result["trailingPe"] is not None
