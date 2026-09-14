"""Summarizes a Cboe delayed options chain into the at-the-money contract metrics the engine uses."""
import math
import re
from datetime import date

OCC_SYMBOL = re.compile(r"^(?P<root>.+?)(?P<expiry>\d{6})(?P<kind>[CP])(?P<strike>\d{8})$")
TARGET_DTE = 52          # middle of the preferred 45-60 DTE window
PREFERRED_DTE = range(40, 71)
FALLBACK_DTE = range(21, 121)


def parse_occ(symbol):
    """'AAPL261218P00260000' -> (date(2026, 12, 18), 'P', 260.0), or None if malformed."""
    match = OCC_SYMBOL.match(symbol)
    if not match:
        return None
    expiry = date(2000 + int(match["expiry"][:2]), int(match["expiry"][2:4]), int(match["expiry"][4:]))
    return expiry, match["kind"], int(match["strike"]) / 1000


def is_monthly(expiry):
    """Standard monthly expiration: third Friday, or the Thursday before when that Friday is a holiday."""
    return (expiry.weekday() == 4 and 15 <= expiry.day <= 21) or (expiry.weekday() == 3 and 14 <= expiry.day <= 20)


def choose_expiration(expirations, as_of):
    """
    Expiration closest to TARGET_DTE inside the 40-70 DTE window, else inside 21-120 DTE. Monthly expirations
    are preferred within each window because they carry most of the open interest (tighter, more reliable quotes).
    """
    for window in (PREFERRED_DTE, FALLBACK_DTE):
        candidates = [e for e in expirations if (e - as_of).days in window]
        monthly = [e for e in candidates if is_monthly(e)]
        pool = monthly or candidates
        if pool:
            return min(pool, key=lambda e: abs((e - as_of).days - TARGET_DTE))
    return None


def summarize_chain(chain, price, as_of, hv30):
    """
    chain: Cboe JSON. Returns ATM call metrics for the chosen expiration plus ATM implied volatility,
    IV / 30-day realized volatility ratio, and the expected move to expiration. None if no usable contract.
    """
    contracts = []
    for option in chain.get("data", {}).get("options", []):
        parsed = parse_occ(option["option"])
        if parsed:
            contracts.append((*parsed, option))
    expiration = choose_expiration({c[0] for c in contracts}, as_of)
    if expiration is None:
        return None

    at_expiry = [c for c in contracts if c[0] == expiration]
    calls = [c for c in at_expiry if c[1] == "C" and c[3].get("ask", 0) > 0]
    if not calls:
        return None
    _, _, strike, call = min(calls, key=lambda c: abs(c[2] - price))
    put = next((c[3] for c in at_expiry if c[1] == "P" and c[2] == strike), None)

    ivs = [o["iv"] for o in (call, put) if o and o.get("iv", 0) > 0]
    atm_iv = sum(ivs) / len(ivs) if ivs else None
    dte = (expiration - as_of).days

    return {
        "source": "Cboe delayed quotes",
        "quoteTime": chain.get("timestamp"),
        "expiration": expiration.isoformat(),
        "daysToExpiration": dte,
        "atmCallStrike": strike,
        "atmCallBid": call.get("bid"),
        "atmCallAsk": call.get("ask"),
        "atmCallVolume": int(call.get("volume") or 0),
        "atmCallOpenInterest": int(call.get("open_interest") or 0),
        "atmCallDelta": call.get("delta"),
        "atmCallTheta": call.get("theta"),
        "impliedVolatility": round(atm_iv, 4) if atm_iv else None,
        "ivHvRatio": round(atm_iv / hv30, 2) if atm_iv and hv30 else None,
        "expectedMovePct": round(atm_iv * math.sqrt(dte / 365), 4) if atm_iv else None,
    }
