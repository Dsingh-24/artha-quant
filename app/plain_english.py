"""Business-Model-Aware Plain-English Reasoning Engine (Approach A) & Local AI Analyst Memo Helper.

Translates multi-factor financial ratios into everyday, jargon-free human explanations across
6 explicit business archetypes, with 100% deterministic parity with `static/standalone_engine.js`.
"""

from __future__ import annotations

import json
import logging
import math
import os
import re
from typing import Any, Dict, List, Optional

import httpx

logger = logging.getLogger("arthaquant.plain_english")

OIL_AND_COMMODITY_KEYWORDS = (
    "oil & gas e&p",
    "oil & gas integrated",
    "oil & gas refining",
    "oil & gas equipment",
    "petroleum",
    "coal",
    "exxon",
    "chevron",
    "conocophillips",
    "occidental",
    "valero",
    "phillips 66",
    "marathon",
    "halliburton",
    "schlumberger",
    "baker hughes",
    "devon",
    "diamondback",
    "eog ",
    "reliance",
    "oil india",
    "natural gas corpn",
)

PIOTROSKI_PLAIN_MAP: Dict[str, str] = {
    "Positive Net Profit (PAT > 0)": "Made a net profit this year",
    "Healthy Banking ROE (>= 12%)": "Earned healthy returns on shareholder money (12%+)",
    "Strong Banking ROA (>= 1.0%)": "Earned solid profit on total lending assets",
    "Positive Operating Cash Flow (CFO > 0)": "Generated positive cash from day-to-day operations",
    "Clean Accrual Quality (CFO >= 0.9x PAT)": "Reported profits are backed by real bank cash",
    "Stable/Improving Return on Assets": "Profitability on company assets held steady or improved",
    "Controlled Balance Sheet Leverage": "Kept debt levels controlled vs last year",
    "Healthy Liquidity Trend": "Maintained a healthy short-term cash cushion",
    "No Material Equity Dilution": "Did not dilute shareholders with extra shares",
    "Resilient Operating Margin": "Protected profit margins on sales vs last year",
    "Stable/Improving Asset Turnover": "Generated steady or higher sales from company assets",
}


def _sfloat(val: Any, fallback: float = 0.0) -> float:
    if val is None or val == "":
        return fallback
    try:
        out = float(val)
        return fallback if (math.isnan(out) or math.isinf(out)) else out
    except (TypeError, ValueError):
        return fallback


def _sint(val: Any, fallback: int = 0) -> int:
    if val is None or val == "":
        return fallback
    try:
        out = float(val)
        return fallback if (math.isnan(out) or math.isinf(out)) else int(round(out))
    except (TypeError, ValueError):
        return fallback


def _r_int(val: float) -> int:
    r = int(math.floor(float(val) + 0.5))
    return 0 if r == 0 else r


def _r_dec(val: float, decimals: int = 1) -> float:
    f = 10.0 ** decimals
    res = math.floor(float(val) * f + 0.5) / f
    return 0.0 if res == 0.0 else res


def _fmt(val: float, decimals: int = 1) -> str:
    if decimals <= 0:
        return str(_r_int(val))
    v = _r_dec(val, decimals)
    if abs(v - 99.9) < 1e-6:
        v = 100.0
    return f"{v:.{decimals}f}"


def _sfmt(val: float, decimals: int = 1) -> str:
    if decimals <= 0:
        iv = _r_int(val)
        return f"+{iv}" if iv >= 0 else str(iv)
    v = _r_dec(val, decimals)
    if abs(v - 99.9) < 1e-6:
        v = 100.0
    sign = "+" if v >= 0 else ""
    return f"{sign}{v:.{decimals}f}"


def _verdict_tag(score_100: float) -> str:
    if score_100 >= 75.0:
        return "Standout"
    if score_100 >= 58.0:
        return "Solid"
    if score_100 >= 42.0:
        return "Mixed"
    return "Weak / Expensive"


def _translate_penalty_reason(raw_reason: str, is_fin: bool) -> str:
    low = raw_reason.lower()
    if "loss-making" in low:
        return "unprofitable in the latest year"
    if "inconsistent profitability" in low:
        m = re.search(r"\((\d+/\d+)\s+profitable", raw_reason)
        yr_txt = m.group(1) if m else "fewer"
        return f"inconsistent yearly profits ({yr_txt} profitable years)"
    if "widespread sell-side eps cuts" in low:
        return "covering bank analysts recently cut profit forecasts"
    if "negative net worth" in low:
        return "negative shareholder net worth"
    if "high corporate debt" in low:
        return "heavy balance-sheet debt load" if is_fin else "heavy corporate debt load"
    if "weak 5y cumulative cash conversion" in low:
        return "weak conversion of paper profits into real cash"
    if "structural multi-year profit contraction" in low:
        return "multi-year decline in annual profits"
    if "recent 2q earnings slowdown" in low:
        return "recent quarterly profit and sales slowdown"
    if "promoter/institutional exit" in low:
        return "recent selling by founders or institutional investors"
    if "elevated banking npas" in low:
        return "elevated bad loans on the lending book"
    if "commodity cyclicality risk" in low:
        return "wide profit swings across commodity cycles"
    if "weak piotroski" in low:
        return "weak annual financial health checklist score"
    if "valuation rich" in low:
        return "stretched stock price relative to fair value"
    return "fundamental caution flag"


def translate_piotroski_checks(checks: List[str]) -> List[str]:
    out: List[str] = []
    for chk in checks:
        mapped = PIOTROSKI_PLAIN_MAP.get(chk)
        if mapped:
            out.append(mapped)
    return out


def build_plain_english(ctx: Dict[str, Any]) -> Dict[str, Any]:
    """Build the Business-Model-Aware Plain-English Reasoning object for a scored stock."""
    comp_name = str(ctx.get("name") or ctx.get("ticker") or "This company").strip()
    comp_sector = str(ctx.get("sector") or "Diversified").strip()
    industry_str = str(ctx.get("industry") or "").strip()
    raw_summary = str(ctx.get("business_summary") or "").strip()
    market_code = str(ctx.get("market_code") or "IN")
    currency = str(ctx.get("currency") or ("USD" if market_code == "US" else "INR"))
    ccy_sym = "$" if currency == "USD" else "₹"
    hundred_unit = f"{ccy_sym}100"

    is_fin = bool(ctx.get("is_fin"))
    is_commodity_biz = bool(ctx.get("is_commodity_biz"))
    is_cyclical = bool(ctx.get("is_cyclical"))
    buyback_equity = bool(ctx.get("buyback_distorted_equity"))

    pat_cr = _sfloat(ctx.get("pat_cr"), 0.0)
    pat_fy_cr = _sfloat(ctx.get("pat_fy_cr"), 0.0)
    equity_cr = _sfloat(ctx.get("equity_cr"), 0.0)

    pe_ratio = _r_dec(_sfloat(ctx.get("pe_ratio"), 99.9), 1)
    fair_pe = _r_dec(_sfloat(ctx.get("fair_pe"), 18.0), 1)
    peg_ratio = _r_dec(_sfloat(ctx.get("peg_ratio"), 9.9), 2)
    pb_ratio = _r_dec(_sfloat(ctx.get("pb_ratio"), 25.0), 2)
    fcf_yield_pct = _r_dec(_sfloat(ctx.get("fcf_yield_pct"), 0.0), 2)
    earnings_yield_pct = _r_dec(_sfloat(ctx.get("earnings_yield_pct"), 0.0), 2)

    roce_cur = _r_dec(_sfloat(ctx.get("roce_cur"), 0.0), 1)
    med_5y_roce = _r_dec(_sfloat(ctx.get("med_5y_roce"), 0.0), 1)
    roe_cur = _r_dec(_sfloat(ctx.get("roe_cur"), 0.0), 1)
    med_5y_roe = _r_dec(_sfloat(ctx.get("med_5y_roe"), 0.0), 1)
    sustained_roce = _r_dec(_sfloat(ctx.get("sustained_roce"), med_5y_roce), 1)
    roa_pct = _r_dec(_sfloat(ctx.get("roa_pct"), 0.0), 2)
    cycle_floor_ret = _r_dec(_sfloat(ctx.get("cycle_floor_ret"), 0.0), 1)
    moat_stability = float(_r_int(_sfloat(ctx.get("moat_stability"), 50.0)))
    opm_cur = _r_dec(_sfloat(ctx.get("opm_cur"), 0.0), 1)
    de_cur = _r_dec(_sfloat(ctx.get("de_cur"), 0.0), 2)
    cum_cfo_ebitda_5y = _r_dec(_sfloat(ctx.get("cum_cfo_ebitda_5y"), 0.0), 1)
    cfo_to_debt_pct = _r_dec(_sfloat(ctx.get("cfo_to_debt_pct"), 0.0), 1)

    profitable_yrs = _sint(ctx.get("profitable_yrs"), 0)
    w5_len = max(1, _sint(ctx.get("window_5y_len"), 5))

    rev_cagr_3y = _r_dec(_sfloat(ctx.get("rev_cagr_3y"), 0.0), 1)
    rev_cagr_5y = _r_dec(_sfloat(ctx.get("rev_cagr_5y"), 0.0), 1)
    pat_cagr_3y = _r_dec(_sfloat(ctx.get("pat_cagr_3y"), 0.0), 1)
    pat_cagr_5y = _r_dec(_sfloat(ctx.get("pat_cagr_5y"), 0.0), 1)

    has_qtr_data = bool(ctx.get("has_qtr_data"))
    qtr_rev_yoy = _r_dec(_sfloat(ctx.get("qtr_rev_yoy"), 0.0), 1)
    qtr_pat_yoy = _r_dec(_sfloat(ctx.get("qtr_pat_yoy"), 0.0), 1)
    latest_qtr_label = str(ctx.get("latest_qtr_label") or "").strip()

    gnpa_pct = _r_dec(_sfloat(ctx.get("gnpa_pct"), 0.0), 2)
    nnpa_pct = _r_dec(_sfloat(ctx.get("nnpa_pct"), 0.0), 2)

    f_score = _sint(ctx.get("f_score"), 0)
    f_checks: List[str] = list(ctx.get("f_checks") or [])
    promoter_pct = _r_dec(_sfloat(ctx.get("promoter_pct"), 0.0), 1)
    inst_pct = _r_dec(_sfloat(ctx.get("inst_pct"), 0.0), 1)
    mom_12_1_pct = _r_dec(_sfloat(ctx.get("mom_12_1_pct"), 0.0), 1)
    above_200dma = bool(ctx.get("above_200dma"))

    composite_score = _r_dec(_sfloat(ctx.get("composite_score"), 0.0), 1)
    rating = str(ctx.get("rating") or "Hold")
    valuation_zone = str(ctx.get("valuation_zone") or "Fair GARP Price")
    valuation_capped = bool(ctx.get("valuation_capped"))

    pillars = ctx.get("pillars") or {}
    quality_score = _r_dec(_sfloat(pillars.get("quality"), 0.0), 1)
    value_score = _r_dec(_sfloat(pillars.get("value"), 0.0), 1)
    growth_score = _r_dec(_sfloat(pillars.get("growth"), 0.0), 1)
    momentum_score = _r_dec(_sfloat(pillars.get("momentum"), 0.0), 1)

    sb = ctx.get("score_breakdown") or {}
    weights_pct = sb.get("weights_pct") or {}
    contributions = sb.get("contributions") or {}
    raw_composite = _r_dec(_sfloat(sb.get("raw_composite"), composite_score), 1)
    total_penalty = _r_dec(_sfloat(sb.get("total_penalty"), 0.0), 1)
    penalty_items: List[Dict[str, Any]] = list(sb.get("penalty_items") or [])

    street = ctx.get("street") or {}
    st_has_cov = bool(street.get("has_coverage")) and int(street.get("analyst_count") or 0) > 0
    st_analyst_cnt = int(street.get("analyst_count") or 0)
    st_buy_pct = _r_dec(float(street.get("consensus_buy_pct") or 0.0), 1)
    st_target_mean = _r_dec(float(street.get("target_mean") or 0.0), 2)
    st_upside_pct = _r_dec(float(street.get("target_upside_pct") or 0.0), 1)
    st_fwd_fy1 = _r_dec(float(street.get("fwd_eps_growth_fy1_pct") or 0.0), 1)
    st_up30 = int(street.get("eps_rev_up_30d") or 0)
    st_dn30 = int(street.get("eps_rev_down_30d") or 0)
    st_up90 = int(street.get("eps_rev_up_90d") or 0)
    st_dn90 = int(street.get("eps_rev_down_90d") or 0)
    st_rev_breadth = _r_dec(float(street.get("rev_breadth_pct") or 0.0), 1)

    # --- 1. Determine Business Archetype (6 Explicit Archetypes) ---
    ind_low = industry_str.lower()
    nm_low = comp_name.lower()
    is_regulated_infra = (
        not is_fin
        and not is_commodity_biz
        and (
            comp_sector == "Power & Energy"
            or (
                comp_sector == "Energy, Oil & Power"
                and (
                    "utilities" in ind_low
                    or "midstream" in ind_low
                    or (not ind_low and not any(kw in nm_low for kw in OIL_AND_COMMODITY_KEYWORDS))
                )
            )
        )
    )

    is_unprofitable_now = (pat_cr <= 0.0) or (pat_fy_cr <= 0.0)
    is_loss_or_no_pe = is_unprofitable_now or (pe_ratio >= 99.0)

    if is_loss_or_no_pe:
        archetype_code = "loss_turnaround"
        archetype_label = "Unprofitable / Turnaround"
    elif buyback_equity:
        archetype_code = "buyback_compounder"
        archetype_label = "Share-Buyback Cash Cow"
    elif is_fin:
        archetype_code = "financial_lender"
        archetype_label = "Banking & Financial Leader"
    elif is_regulated_infra:
        archetype_code = "regulated_infra"
        archetype_label = "Regulated Infrastructure"
    elif is_cyclical:
        archetype_code = "cyclical_commodity"
        archetype_label = "Cyclical / Commodity Business"
    else:
        archetype_code = "secular_compounder"
        archetype_label = (
            "Cash-Rich Compounder"
            if (sustained_roce >= 18.0 and de_cur <= 0.50)
            else "Steady Operating Business"
        )

    # --- 2. Crisp Plain-English "What It Does" ---
    mkt_adj = "US" if market_code == "US" else "Indian"
    if raw_summary:
        what_it_does = raw_summary
    elif industry_str:
        what_it_does = f"{comp_name} is an established {mkt_adj} {industry_str.lower()} business operating in the {comp_sector} sector."
    else:
        what_it_does = f"{comp_name} is an established {mkt_adj} enterprise operating across the {comp_sector} sector."

    # --- 3. One-Line Verdict for Leaderboard & Top-3 Podium ---
    if archetype_code == "loss_turnaround":
        if is_unprofitable_now:
            one_line_verdict = "Currently unprofitable — wait for steady profits before investing"
        else:
            one_line_verdict = "Priced far ahead of current profits — high expectations baked in"
    elif archetype_code == "buyback_compounder":
        if pe_ratio <= fair_pe * 1.15 and composite_score >= 65.0:
            one_line_verdict = "Cash-rich share-buyback leader at a reasonable entry price"
        elif pe_ratio > fair_pe * 1.35 or valuation_zone == "Overvalued / Wait for Dip":
            one_line_verdict = "World-class cash generator, but stock price looks expensive today"
        else:
            one_line_verdict = "Strong cash-generating buyback compounder — accumulate on dips"
    elif archetype_code == "financial_lender":
        if composite_score >= 68.0 and pe_ratio <= fair_pe * 1.15:
            one_line_verdict = "Consistent financial compounder at a reasonable valuation"
        elif quality_score >= 70.0 and pe_ratio > fair_pe * 1.30:
            one_line_verdict = "Well-run financial franchise, though shares trade at a premium"
        elif composite_score >= 57.0:
            one_line_verdict = "Steady financial institution at a sensible long-term price"
        else:
            one_line_verdict = "Mixed financial track record — stronger lenders available"
    elif archetype_code == "regulated_infra":
        if composite_score >= 60.0 and pe_ratio <= fair_pe * 1.15:
            one_line_verdict = "Steady utility & infrastructure operator at a sensible price"
        elif pe_ratio > fair_pe * 1.30:
            one_line_verdict = "Predictable utility business, but stock price leaves little upside"
        else:
            one_line_verdict = "Contracted infrastructure operator carrying long-term project debt"
    elif archetype_code == "cyclical_commodity":
        if composite_score >= 65.0 and pe_ratio <= fair_pe * 1.05:
            one_line_verdict = "Strong cyclical business at a fair price — mind industry swings"
        elif pe_ratio > fair_pe * 1.30:
            one_line_verdict = "Cyclical business trading at an expensive point in the cycle"
        else:
            one_line_verdict = "Profits move with industry cycles — demand a wide safety margin"
    else:
        if quality_score >= 75.0 and de_cur <= 0.25 and pe_ratio <= fair_pe * 1.05 and composite_score >= 68.0:
            one_line_verdict = "Strong, debt-free business at an attractive price"
        elif quality_score >= 72.0 and pe_ratio <= fair_pe * 1.15 and composite_score >= 65.0:
            one_line_verdict = "High-quality compounder trading at a sensible price"
        elif quality_score >= 70.0 and (pe_ratio > fair_pe * 1.30 or value_score < 40.0):
            one_line_verdict = "World-class business, but stock price is expensive today"
        elif composite_score >= 57.0:
            one_line_verdict = "Solid operating business with steady long-term fundamentals"
        elif composite_score >= 45.0:
            one_line_verdict = "Decent business with mixed growth or price trade-offs"
        else:
            one_line_verdict = "Weak business fundamentals or stretched balance sheet — be cautious"

    # --- 4. Bottom-Line Summary (3 Tailored Plain-English Sentences) ---
    roce_i = _r_int(med_5y_roce)
    roe_i = _r_int(med_5y_roe)
    floor_i = _r_int(cycle_floor_ret)

    # Sentence 1: Business strength & safety
    if archetype_code == "loss_turnaround":
        if is_unprofitable_now:
            s1 = (
                f"{comp_name} is currently unprofitable — cannot be valued on current profits yet, "
                f"having earned a net profit in {profitable_yrs} of the last {w5_len} years."
            )
        elif is_fin:
            e_verb = (
                f"earns {ccy_sym}{roe_i} per {hundred_unit}"
                if roe_i >= 0
                else f"loses {ccy_sym}{abs(roe_i)} per {hundred_unit}"
            )
            s1 = (
                f"{comp_name} {e_verb} of shareholder equity over a 5-year median, "
                f"but current net profits are still tiny relative to its market value — cannot be valued on current profits yet."
            )
        else:
            e_verb = (
                f"earns {ccy_sym}{roce_i} per {hundred_unit}"
                if roce_i >= 0
                else f"loses {ccy_sym}{abs(roce_i)} per {hundred_unit}"
            )
            s1 = (
                f"{comp_name} {e_verb} invested in the business over a 5-year median, "
                f"but current net profits are still tiny relative to its market value — cannot be valued on current profits yet."
            )
    elif archetype_code == "financial_lender":
        if gnpa_pct > 0.0:
            loan_phrase = (
                "very clean loan quality"
                if nnpa_pct <= 0.80
                else ("manageable bad-loan levels" if nnpa_pct <= 1.50 else "elevated bad loans requiring caution")
            )
            s1 = (
                f"{comp_name} earns {ccy_sym}{roe_i} per {hundred_unit} of shareholder equity over a 5-year median "
                f"with {loan_phrase} ({_fmt(nnpa_pct, 2)}% net bad loans) and stayed profitable in {profitable_yrs} of {w5_len} years."
            )
        else:
            s1 = (
                f"{comp_name} earns {ccy_sym}{roe_i} per {hundred_unit} of shareholder equity over a 5-year median "
                f"(generating {ccy_sym}{_fmt(roa_pct, 2)} profit per {hundred_unit} of total assets) across {profitable_yrs} of {w5_len} profitable years."
            )
    elif archetype_code == "buyback_compounder":
        ret_buyback = roe_i if is_fin else roce_i
        s1 = (
            f"{comp_name} earns {ccy_sym}{ret_buyback} per {hundred_unit} invested — "
            f"book equity looks small/negative only because of years of share buybacks, while strong annual cash flow comfortably covers {_fmt(cfo_to_debt_pct, 0)}% of total debt."
        )
    elif archetype_code == "regulated_infra":
        s1 = (
            f"{comp_name} earns a steady {ccy_sym}{roce_i} per {hundred_unit} invested across regulated or contracted infrastructure assets, "
            f"where long-term project borrowing ({_fmt(de_cur, 2)}x equity) is supported by predictable utility cash flows."
        )
    elif archetype_code == "cyclical_commodity":
        floor_phrase = (
            f"dipping to {ccy_sym}{floor_i} per {hundred_unit}"
            if floor_i >= 0
            else f"swinging to a {ccy_sym}{abs(floor_i)} loss per {hundred_unit}"
        )
        s1 = (
            f"{comp_name} earns {ccy_sym}{roce_i} per {hundred_unit} invested over a 5-year median, "
            f"but profits move with commodity and industry cycles ({floor_phrase} in tougher years), so even a low valuation during peak profits needs cycle caution."
        )
    else:
        if de_cur <= 0.15:
            debt_phrase = "with virtually zero debt"
        elif de_cur <= 0.50:
            debt_phrase = "with very low debt"
        elif de_cur <= 1.20:
            debt_phrase = "with manageable debt"
        else:
            debt_phrase = "though carrying noticeable debt"
        cash_i = _r_int(cum_cfo_ebitda_5y)
        cash_phrase = (
            f"turning {cash_i}% of operating profits into real bank cash"
            if cash_i >= 70
            else f"converting {cash_i}% of operating profits into cash"
        )
        e_verb = (
            f"earns {ccy_sym}{roce_i} per {hundred_unit} invested"
            if roce_i >= 0
            else f"loses {ccy_sym}{abs(roce_i)} per {hundred_unit} invested"
        )
        s1 = (
            f"{comp_name} {e_verb} over a 5-year median {debt_phrase}, "
            f"{cash_phrase} across {profitable_yrs} of {w5_len} profitable years."
        )

    # Sentence 2: Exact diagnostic of WHY the score landed at composite_score
    q_int = _r_int(quality_score)
    v_int = _r_int(value_score)
    g_int = _r_int(growth_score)
    pen_int = _r_int(total_penalty)

    if archetype_code == "loss_turnaround":
        if is_unprofitable_now:
            s2 = (
                f"Its overall score landed at {_fmt(composite_score, 1)}/100 ({rating}) because current losses "
                f"trigger a {pen_int}-point safety deduction and leave no profit cushion to value the shares on."
            )
        else:
            ded_str = f" plus a {pen_int}-point caution deduction" if pen_int > 0 else ""
            s2 = (
                f"Its overall score landed at {_fmt(composite_score, 1)}/100 ({rating}) because the stock price already bakes in "
                f"years of high optimism relative to today's small profit base (price-value score {v_int}/100{ded_str})."
            )
    elif quality_score >= 70.0 and (pe_ratio > fair_pe * 1.35 or value_score < 35.0):
        cap_note = (
            f" and triggered an {pen_int}-point rich-price guardrail deduction"
            if (valuation_capped and pen_int > 0)
            else (f" alongside a {pen_int}-point caution deduction" if pen_int > 0 else "")
        )
        s2 = (
            f"Its score landed at {_fmt(composite_score, 1)}/100 ({rating}) mainly because an expensive stock valuation "
            f"({_fmt(pe_ratio, 1)}x annual profits vs a fair range near ~{_fmt(fair_pe, 1)}x) pulled its price-value score down to {v_int}/100{cap_note}, "
            f"holding back an otherwise standout {q_int}/100 business."
        )
    elif pe_ratio <= fair_pe * 0.92 and composite_score >= 65.0:
        s2 = (
            f"It earned a high {_fmt(composite_score, 1)}/100 ({rating}) because strong business quality ({q_int}/100) "
            f"pairs with an attractive bargain price at {_fmt(pe_ratio, 1)}x annual profits versus a fair value range near ~{_fmt(fair_pe, 1)}x."
        )
    elif pen_int > 0 and len(penalty_items) > 0:
        top_reason = _translate_penalty_reason(str(penalty_items[0].get("reason") or ""), is_fin)
        s2 = (
            f"Starting from a raw score of {_fmt(raw_composite, 1)}/100, a {pen_int}-point safety deduction "
            f"({top_reason}) brought the final score to {_fmt(composite_score, 1)}/100 ({rating})."
        )
    elif composite_score >= 68.0:
        s2 = (
            f"It earned a strong {_fmt(composite_score, 1)}/100 ({rating}) by combining high business quality ({q_int}/100) "
            f"and steady growth ({g_int}/100) at a sensible {_fmt(pe_ratio, 1)}x profits (fair range ~{_fmt(fair_pe, 1)}x) with zero caution flags."
        )
    else:
        if value_score < quality_score and value_score < growth_score:
            drag_phrase = f"a somewhat rich stock price at {_fmt(pe_ratio, 1)}x profits (vs ~{_fmt(fair_pe, 1)}x fair range)"
        elif growth_score < quality_score:
            drag_phrase = f"slower multi-year growth ({g_int}/100)"
        else:
            drag_phrase = f"moderate business returns ({q_int}/100)"
        lead_phrase = (
            f"solid business quality ({q_int}/100)"
            if quality_score >= growth_score
            else f"healthy sales & profit growth ({g_int}/100)"
        )
        s2 = (
            f"Its {_fmt(composite_score, 1)}/100 ({rating}) score reflects {lead_phrase} "
            f"balanced against {drag_phrase}."
        )

    # Sentence 3: Growth track record + covering bank analyst view
    rev_5y_phrase = (
        f"grew {_fmt(rev_cagr_5y, 1)}% a year"
        if rev_cagr_5y >= 0.0
        else f"shrank {_fmt(abs(rev_cagr_5y), 1)}% a year"
    )
    pat_5y_phrase = (
        f"profits compounded at {_fmt(pat_cagr_5y, 1)}% a year"
        if pat_cagr_5y >= 0.0
        else f"profits declined {_fmt(abs(pat_cagr_5y), 1)}% a year"
    )
    if st_has_cov and st_analyst_cnt >= 3:
        buy_i = _r_int(st_buy_pct)
        if st_target_mean > 0.0:
            up_phrase = (
                f"{_fmt(st_upside_pct, 1)}% implied upside"
                if st_upside_pct >= 0.0
                else f"{_fmt(abs(st_upside_pct), 1)}% below current price"
            )
            analyst_tail = (
                f"while {st_analyst_cnt} covering bank analysts hold a {buy_i}% Buy view "
                f"with an average target of {ccy_sym}{_fmt(st_target_mean, 0)} ({up_phrase})."
            )
        else:
            analyst_tail = f"while {st_analyst_cnt} covering bank analysts hold a {buy_i}% Buy consensus."
    elif market_code == "US":
        analyst_tail = f"backed by {_fmt(inst_pct, 1)}% long-term institutional ownership."
    else:
        analyst_tail = (
            f"backed by {_fmt(promoter_pct, 1)}% founder/promoter and {_fmt(inst_pct, 1)}% institutional ownership."
        )
    s3 = f"Over the past 5 years, annual sales {rev_5y_phrase} and {pat_5y_phrase}, {analyst_tail}"

    # --- 5. Build 4 Plain-English Receipt Steps & Question Cards ---
    # Card 1: Quality
    if is_fin and not buyback_equity:
        q_plain_why = (
            f"Earns {ccy_sym}{roe_i} per {hundred_unit} of shareholder money over a 5-year median "
            f"with {profitable_yrs}/{w5_len} profitable years."
            if roe_i >= 0
            else f"Shareholder returns have been negative recently ({profitable_yrs}/{w5_len} profitable years)."
        )
        roe_simple = (
            f"Earns {ccy_sym}{roe_i} per {hundred_unit} equity"
            if roe_i >= 0
            else f"Loses {ccy_sym}{abs(roe_i)} per {hundred_unit} equity"
        )
        roe_tone = "good" if med_5y_roe >= 14.0 else ("neutral" if med_5y_roe >= 10.0 else ("warn" if med_5y_roe > 0.0 else "bad"))
        roa_simple = (
            f"{ccy_sym}{_fmt(roa_pct, 2)} profit per {hundred_unit} of assets"
            if roa_pct >= 0.0
            else f"Loss of {ccy_sym}{_fmt(abs(roa_pct), 2)} per {hundred_unit} of assets"
        )
        roa_tone = "good" if roa_pct >= 1.2 else ("neutral" if roa_pct >= 0.7 else ("warn" if roa_pct > 0.0 else "bad"))

        if gnpa_pct > 0.0:
            row3_fin = {
                "simple_label": "Unrecovered bad loans",
                "pro_label": "Net NPA % (Gross NPA %)",
                "simple_value": f"{_fmt(nnpa_pct, 2)}% net bad loans",
                "pro_value": f"{_fmt(nnpa_pct, 2)}% NNPA ({_fmt(gnpa_pct, 2)}% GNPA)",
                "target_hint": "Below 1.0% shows clean lending quality",
                "tone": "good" if nnpa_pct <= 1.0 else ("neutral" if nnpa_pct <= 1.5 else "bad"),
            }
        else:
            row3_fin = {
                "simple_label": "Toughest-year equity return",
                "pro_label": "6Y Cycle-Floor ROE",
                "simple_value": f"{_fmt(cycle_floor_ret, 1)}% in toughest recent year",
                "pro_value": f"{_fmt(cycle_floor_ret, 1)}% Cycle Floor (Stability {_fmt(moat_stability, 0)}/100)",
                "target_hint": "Staying above 10% in downturns is resilient",
                "tone": "good" if cycle_floor_ret >= 11.0 else ("neutral" if cycle_floor_ret >= 7.0 else "warn"),
            }

        quality_rows = [
            {
                "simple_label": "Return on shareholder money",
                "pro_label": "5Y Median ROE (Latest ROE)",
                "simple_value": roe_simple,
                "pro_value": f"{_fmt(med_5y_roe, 1)}% 5Y Med ({_fmt(roe_cur, 1)}% Latest)",
                "target_hint": "14%+ is strong for banks & financial leaders",
                "tone": roe_tone,
            },
            {
                "simple_label": "Profit earned on total assets",
                "pro_label": "Return on Total Assets (ROA)",
                "simple_value": roa_simple,
                "pro_value": f"{_fmt(roa_pct, 2)}% ROA",
                "target_hint": "1.2%+ signals high lending & asset quality",
                "tone": roa_tone,
            },
            row3_fin,
            {
                "simple_label": "Consistent yearly profits",
                "pro_label": "5-Year Profit Consistency",
                "simple_value": f"Profitable in {profitable_yrs} of last {w5_len} years",
                "pro_value": f"{profitable_yrs}/{w5_len} FYs Profitable (Margin {_fmt(opm_cur, 1)}%)",
                "target_hint": "5 out of 5 profitable years is ideal",
                "tone": "good" if profitable_yrs == w5_len else ("neutral" if profitable_yrs >= w5_len - 1 else "bad"),
            },
        ]
    elif buyback_equity:
        ret_med_b = med_5y_roe if is_fin else med_5y_roce
        ret_lat_b = roe_cur if is_fin else roce_cur
        ret_b_i = _r_int(ret_med_b)
        cash_b_i = _r_int(cum_cfo_ebitda_5y)
        q_plain_why = (
            f"Earns {ccy_sym}{ret_b_i} per {hundred_unit} invested; book equity looks small because of share buybacks "
            f"while cash flow covers {_fmt(cfo_to_debt_pct, 0)}% of total debt."
        )
        quality_rows = [
            {
                "simple_label": f"Profit per {hundred_unit} invested",
                "pro_label": "5Y Median Return on Capital" if is_fin else "5Y Median ROCE (Latest)",
                "simple_value": f"Earns {ccy_sym}{ret_b_i} per {hundred_unit} invested",
                "pro_value": f"{_fmt(ret_med_b, 1)}% 5Y Med ({_fmt(ret_lat_b, 1)}% Latest)",
                "target_hint": "18%+ signals a powerful business moat",
                "tone": "good",
            },
            {
                "simple_label": "Debt safety (cash flow vs debt)",
                "pro_label": "Annual Operating Cash Flow / Debt",
                "simple_value": f"Annual cash covers {_fmt(cfo_to_debt_pct, 0)}% of total debt",
                "pro_value": f"{_fmt(cfo_to_debt_pct, 1)}% CFO/Debt (Buyback-adjusted)",
                "target_hint": "35%+ yearly cash coverage comfortably services debt",
                "tone": "good" if cfo_to_debt_pct >= 50.0 else "neutral",
            },
            {
                "simple_label": "Real cash collected from profits",
                "pro_label": "Operating Cash Conversion" if is_fin else "5Y Cumulative CFO / EBITDA",
                "simple_value": f"Turns {cash_b_i}% of operating profit into cash",
                "pro_value": f"{cash_b_i}% Cash Conversion" if is_fin else f"{cash_b_i}% 5Y CFO/EBITDA",
                "target_hint": "80%+ means profits arrive as real cash",
                "tone": "good" if cum_cfo_ebitda_5y >= 80.0 else ("neutral" if cum_cfo_ebitda_5y >= 60.0 else "warn"),
            },
            {
                "simple_label": "Operating profit kept per sale",
                "pro_label": "Operating Margin & 5Y Consistency",
                "simple_value": f"Keeps {ccy_sym}{_r_int(opm_cur)} per {hundred_unit} of sales ({profitable_yrs}/{w5_len} yrs profitable)",
                "pro_value": f"{_fmt(opm_cur, 1)}% OPM ({profitable_yrs}/{w5_len} FYs Profitable)",
                "target_hint": "15%+ margin with 5/5 profitable years is strong",
                "tone": "good" if (opm_cur >= 15.0 and profitable_yrs == w5_len) else "neutral",
            },
        ]
    else:
        cash_i = _r_int(cum_cfo_ebitda_5y)
        if archetype_code == "regulated_infra":
            q_plain_why = (
                f"Earns {ccy_sym}{roce_i} per {hundred_unit} invested across regulated infrastructure assets "
                f"with {profitable_yrs}/{w5_len} profitable years."
            )
        elif archetype_code == "cyclical_commodity":
            q_plain_why = (
                f"Earns {ccy_sym}{roce_i} per {hundred_unit} on average, though returns swing to "
                f"{ccy_sym}{floor_i} in industry downturns."
            )
        elif med_5y_roce <= 0.0:
            q_plain_why = f"Operations have struggled to earn positive returns on invested money ({profitable_yrs}/{w5_len} profitable years)."
        else:
            q_plain_why = (
                f"Earns {ccy_sym}{roce_i} per {hundred_unit} invested in the business and converts "
                f"{cash_i}% of operating profit into real cash."
            )

        roce_simple = (
            f"Earns {ccy_sym}{roce_i} per {hundred_unit} invested"
            if roce_i >= 0
            else f"Loses {ccy_sym}{abs(roce_i)} per {hundred_unit} invested"
        )
        if archetype_code == "regulated_infra":
            roce_tone = "good" if med_5y_roce >= 9.5 else ("neutral" if med_5y_roce >= 6.5 else "warn")
            roce_hint = "8–14% is normal for regulated utilities"
        else:
            roce_tone = (
                "good"
                if med_5y_roce >= 18.0
                else ("neutral" if med_5y_roce >= 11.0 else ("warn" if med_5y_roce > 0.0 else "bad"))
            )
            roce_hint = "18%+ signals a strong competitive moat"

        if equity_cr <= 0.0:
            debt_simple = "Negative book net worth"
            debt_pro = "Equity <= 0"
            debt_tone = "bad"
        elif de_cur <= 0.10:
            debt_simple = "Virtually debt-free"
            debt_pro = f"{_fmt(de_cur, 2)}x D/E"
            debt_tone = "good"
        elif de_cur <= 0.50:
            debt_simple = f"Low debt ({_fmt(de_cur, 2)}x shareholder equity)"
            debt_pro = f"{_fmt(de_cur, 2)}x D/E"
            debt_tone = "good"
        elif archetype_code == "regulated_infra" and de_cur <= 2.20:
            debt_simple = f"Long-term project debt ({_fmt(de_cur, 2)}x equity)"
            debt_pro = f"{_fmt(de_cur, 2)}x D/E (Infra)"
            debt_tone = "neutral"
        elif de_cur <= 1.20:
            debt_simple = f"Moderate debt ({_fmt(de_cur, 2)}x equity)"
            debt_pro = f"{_fmt(de_cur, 2)}x D/E"
            debt_tone = "neutral"
        elif de_cur <= 1.80:
            debt_simple = f"Elevated debt ({_fmt(de_cur, 2)}x equity)"
            debt_pro = f"{_fmt(de_cur, 2)}x D/E"
            debt_tone = "warn"
        else:
            debt_simple = f"Heavy debt load ({_fmt(de_cur, 2)}x equity)"
            debt_pro = f"{_fmt(de_cur, 2)}x D/E"
            debt_tone = "bad"

        quality_rows = [
            {
                "simple_label": f"Profit per {hundred_unit} invested",
                "pro_label": "5Y Median ROCE (Latest ROCE)",
                "simple_value": roce_simple,
                "pro_value": f"{_fmt(med_5y_roce, 1)}% 5Y Med ({_fmt(roce_cur, 1)}% Latest)",
                "target_hint": roce_hint,
                "tone": roce_tone,
            },
            {
                "simple_label": "Debt vs company net worth",
                "pro_label": "Corporate Debt-to-Equity (D/E)",
                "simple_value": debt_simple,
                "pro_value": debt_pro,
                "target_hint": (
                    "Utilities commonly carry 1.0x–2.2x project debt"
                    if archetype_code == "regulated_infra"
                    else "Under 0.5x means a conservative balance sheet"
                ),
                "tone": debt_tone,
            },
            {
                "simple_label": "Real cash collected from profits",
                "pro_label": "5Y Cumulative CFO / EBITDA",
                "simple_value": (
                    f"Turns {cash_i}% of operating profit into cash"
                    if cash_i >= 0
                    else "Operating cash flow is negative"
                ),
                "pro_value": f"{cash_i}% 5Y CFO/EBITDA",
                "target_hint": "75%+ means reported profits arrive as real cash",
                "tone": "good" if cum_cfo_ebitda_5y >= 75.0 else ("neutral" if cum_cfo_ebitda_5y >= 55.0 else "bad"),
            },
            {
                "simple_label": "Steady profits across tough years",
                "pro_label": "5Y Profit Consistency & Moat Stability",
                "simple_value": f"Profitable in {profitable_yrs}/{w5_len} years (toughest year {floor_i}%)",
                "pro_value": f"{profitable_yrs}/{w5_len} FYs Profitable • Stability {_fmt(moat_stability, 0)}/100",
                "target_hint": "5/5 profitable years without deep slumps",
                "tone": (
                    "good"
                    if (profitable_yrs == w5_len and moat_stability >= 65.0)
                    else ("neutral" if profitable_yrs >= w5_len - 1 else "bad")
                ),
            },
        ]

    # Card 2: Growth
    s_dir = f"grew {_fmt(rev_cagr_5y, 1)}%/yr" if rev_cagr_5y >= 0.0 else f"declined {_fmt(abs(rev_cagr_5y), 1)}%/yr"
    p_dir = f"grew {_fmt(pat_cagr_5y, 1)}%/yr" if pat_cagr_5y >= 0.0 else f"declined {_fmt(abs(pat_cagr_5y), 1)}%/yr"
    g_plain_why = f"Over 5 years, annual sales {s_dir} while net profits {p_dir}."

    q_lbl_sfx = f" ({latest_qtr_label})" if (has_qtr_data and latest_qtr_label) else ""
    has_fwd = st_has_cov and st_analyst_cnt >= 3 and st_fwd_fy1 != 0.0
    growth_rows = [
        {
            "simple_label": "5-year annual sales growth",
            "pro_label": "5Y & 3Y Revenue CAGR",
            "simple_value": f"{_sfmt(rev_cagr_5y, 1)}% per year",
            "pro_value": f"{_sfmt(rev_cagr_5y, 1)}% (5Y) • {_sfmt(rev_cagr_3y, 1)}% (3Y)",
            "target_hint": "10%+ annual sales growth is healthy",
            "tone": (
                "good"
                if rev_cagr_5y >= 10.0
                else ("neutral" if rev_cagr_5y >= 4.0 else ("warn" if rev_cagr_5y >= 0.0 else "bad"))
            ),
        },
        {
            "simple_label": "5-year annual profit growth",
            "pro_label": "5Y & 3Y Net Profit CAGR",
            "simple_value": f"{_sfmt(pat_cagr_5y, 1)}% per year",
            "pro_value": f"{_sfmt(pat_cagr_5y, 1)}% (5Y) • {_sfmt(pat_cagr_3y, 1)}% (3Y)",
            "target_hint": "12%+ steady profit compounding builds wealth",
            "tone": (
                "good"
                if pat_cagr_5y >= 12.0
                else ("neutral" if pat_cagr_5y >= 5.0 else ("warn" if pat_cagr_5y >= 0.0 else "bad"))
            ),
        },
        {
            "simple_label": f"Recent quarterly profit trend{q_lbl_sfx}",
            "pro_label": "Latest YoY Quarterly Profit & Sales",
            "simple_value": (
                f"{_sfmt(qtr_pat_yoy, 1)}% profit, {_sfmt(qtr_rev_yoy, 1)}% sales vs last year"
                if has_qtr_data
                else f"Tracking ~{_sfmt(pat_cagr_3y, 1)}% recent annual pace"
            ),
            "pro_value": (
                f"{_sfmt(qtr_pat_yoy, 1)}% YoY Profit • {_sfmt(qtr_rev_yoy, 1)}% YoY Sales"
                if has_qtr_data
                else "Annualized trajectory"
            ),
            "target_hint": "Positive recent growth confirms business momentum",
            "tone": (
                "good"
                if qtr_pat_yoy >= 10.0
                else ("neutral" if qtr_pat_yoy >= 0.0 else ("warn" if qtr_pat_yoy > -12.0 else "bad"))
            ),
        },
        {
            "simple_label": "Expected profit growth next year",
            "pro_label": "Consensus FY1 Forward EPS Growth",
            "simple_value": (
                f"Analysts expect {_sfmt(st_fwd_fy1, 1)}% profit growth"
                if has_fwd
                else "Scored on verified multi-year history"
            ),
            "pro_value": f"{_sfmt(st_fwd_fy1, 1)}% FY1 Consensus EPS" if has_fwd else "Historical CAGR anchor",
            "target_hint": "10%+ expected growth supports future returns",
            "tone": ("good" if st_fwd_fy1 >= 10.0 else ("neutral" if st_fwd_fy1 >= 0.0 else "warn")) if has_fwd else "neutral",
        },
    ]

    # Card 3: Value (STRICTLY ZERO "99.9" or numeric P/E claims on loss_turnaround!)
    if archetype_code == "loss_turnaround":
        unprof_msg = (
            "Currently unprofitable — cannot be valued on current profits yet"
            if is_unprofitable_now
            else "Current profits are too small — cannot be valued on current profits yet"
        )
        v_plain_why = f"{unprof_msg}; wait for earnings to normalize before judging price value."
        if is_fin:
            v_row3 = {
                "simple_label": "Price vs shareholder book value",
                "pro_label": "Price-to-Book Ratio (P/B)",
                "simple_value": (
                    f"{_fmt(pb_ratio, 2)}x shareholder book value"
                    if (equity_cr > 0.0 and pb_ratio < 24.9)
                    else "Book value compressed"
                ),
                "pro_value": f"{_fmt(pb_ratio, 2)}x P/B" if (equity_cr > 0.0 and pb_ratio < 24.9) else "N/M (Compressed equity)",
                "target_hint": "1.0x–2.5x book value is typical for lenders",
                "tone": "neutral" if pb_ratio <= 2.5 else "warn",
            }
        else:
            v_row3 = {
                "simple_label": "Free cash generated vs stock price",
                "pro_label": "Free Cash Flow (FCF) Yield",
                "simple_value": (
                    f"{_fmt(fcf_yield_pct, 1)}% yearly free cash yield"
                    if fcf_yield_pct > 0.0
                    else "Burning free cash flow currently"
                ),
                "pro_value": f"{_fmt(fcf_yield_pct, 2)}% FCF Yield",
                "target_hint": "3%+ free cash yield offers valuation support",
                "tone": "good" if fcf_yield_pct >= 3.0 else ("neutral" if fcf_yield_pct > 0.0 else "bad"),
            }
        value_rows = [
            {
                "simple_label": "Stock price vs annual profit",
                "pro_label": "Trailing Earnings Valuation",
                "simple_value": unprof_msg,
                "pro_value": "N/M (Unprofitable / Turnaround)",
                "target_hint": "Needs steady positive profits for a fair multiple",
                "tone": "bad",
            },
            {
                "simple_label": "Price paid for expected growth",
                "pro_label": "Growth-Adjusted Valuation",
                "simple_value": "Not meaningful until profits stabilize",
                "pro_value": "N/M (Turnaround earnings base)",
                "target_hint": "Evaluated once annual profits normalize",
                "tone": "bad",
            },
            v_row3,
            {
                "simple_label": "Buying price comfort",
                "pro_label": "GARP Valuation Zone",
                "simple_value": "High risk — wait for profit recovery",
                "pro_value": valuation_zone,
                "target_hint": "Look for profitable margin of safety",
                "tone": "bad",
            },
        ]
    else:
        if pe_ratio <= fair_pe * 0.90:
            v_plain_why = f"Trades at a bargain {_fmt(pe_ratio, 1)}x annual profits versus a fair range near ~{_fmt(fair_pe, 1)}x."
        elif pe_ratio <= fair_pe * 1.20:
            v_plain_why = f"Trades at {_fmt(pe_ratio, 1)}x annual profits, reasonably aligned with its ~{_fmt(fair_pe, 1)}x fair value range."
        elif pe_ratio <= fair_pe * 1.55:
            v_plain_why = f"Trades at {_fmt(pe_ratio, 1)}x annual profits — above its ~{_fmt(fair_pe, 1)}x fair range, favoring staggered buying."
        else:
            v_plain_why = f"Trades at an expensive {_fmt(pe_ratio, 1)}x annual profits versus a fair range near ~{_fmt(fair_pe, 1)}x."
        if archetype_code == "cyclical_commodity":
            v_plain_why = f"{v_plain_why} Cyclical multiples can look low near peak profits, so keep extra caution."

        if peg_ratio <= 1.25:
            peg_simple = "Attractive price for its growth speed"
        elif peg_ratio <= 1.85:
            peg_simple = "Reasonable price for its growth"
        elif peg_ratio <= 2.40:
            peg_simple = "Priced slightly ahead of growth"
        else:
            peg_simple = "Expensive relative to its growth speed"

        if is_fin and not buyback_equity:
            v_row3 = {
                "simple_label": "Price vs shareholder book value",
                "pro_label": "Price-to-Book Ratio (P/B)",
                "simple_value": f"{_fmt(pb_ratio, 2)}x shareholder book value",
                "pro_value": f"{_fmt(pb_ratio, 2)}x P/B",
                "target_hint": "1.0x–3.0x is reasonable for strong banks",
                "tone": "good" if pb_ratio <= 2.5 else ("neutral" if pb_ratio <= 4.0 else "warn"),
            }
        else:
            v_row3 = {
                "simple_label": f"Free cash earned per {hundred_unit} of stock",
                "pro_label": "Free Cash Flow Yield & Earnings Yield",
                "simple_value": (
                    f"{ccy_sym}{_fmt(fcf_yield_pct, 1)} free cash per {hundred_unit} at today's price"
                    if fcf_yield_pct >= 0.0
                    else "Heavy reinvestment reducing free cash this year"
                ),
                "pro_value": f"{_fmt(fcf_yield_pct, 2)}% FCF Yield ({_fmt(earnings_yield_pct, 2)}% EY)",
                "target_hint": "3%+ cash yield rewards patient holders",
                "tone": "good" if fcf_yield_pct >= 3.0 else ("neutral" if fcf_yield_pct >= 1.2 else "warn"),
            }

        if valuation_zone == "Undervalued (Margin of Safety)":
            vz_simple = "Good bargain with margin of safety"
            vz_tone = "good"
        elif valuation_zone == "Fair GARP Price":
            vz_simple = "Fair price for long-term buyers"
            vz_tone = "good"
        elif valuation_zone == "Slightly Rich (Stagger SIP)":
            vz_simple = "Slightly rich — stagger purchases slowly"
            vz_tone = "warn"
        else:
            vz_simple = "Expensive today — better to wait for a dip"
            vz_tone = "bad"

        value_rows = [
            {
                "simple_label": "Stock price vs annual profit",
                "pro_label": "Trailing P/E vs Quality-Adjusted Fair P/E",
                "simple_value": f"Pays {_fmt(pe_ratio, 1)}x profits (fair range ~{_fmt(fair_pe, 1)}x)",
                "pro_value": f"{_fmt(pe_ratio, 1)}x P/E vs ~{_fmt(fair_pe, 1)}x Fair P/E",
                "target_hint": "At or below fair range gives a safety cushion",
                "tone": (
                    "good"
                    if pe_ratio <= fair_pe * 1.05
                    else ("neutral" if pe_ratio <= fair_pe * 1.25 else ("warn" if pe_ratio <= fair_pe * 1.55 else "bad"))
                ),
            },
            {
                "simple_label": "Price paid for expected growth",
                "pro_label": "GARP PEG Ratio",
                "simple_value": peg_simple,
                "pro_value": f"{_fmt(peg_ratio, 2)}x PEG",
                "target_hint": "Under 1.5x means growth isn't overpriced",
                "tone": (
                    "good"
                    if peg_ratio <= 1.35
                    else ("neutral" if peg_ratio <= 1.90 else ("warn" if peg_ratio <= 2.40 else "bad"))
                ),
            },
            v_row3,
            {
                "simple_label": "Buying price comfort",
                "pro_label": "GARP Valuation Zone",
                "simple_value": vz_simple,
                "pro_value": valuation_zone,
                "target_hint": "Avoid overpaying even for great companies",
                "tone": vz_tone,
            },
        ]

    # Card 4: Financial Health & Expert View (Momentum / Piotroski / Ownership / Street)
    own_sum = _r_dec(promoter_pct + inst_pct, 1)
    buy_i = _r_int(st_buy_pct)
    if st_has_cov and st_analyst_cnt >= 3:
        m_plain_why = (
            f"Passes {f_score} of 9 annual safety checks, with {buy_i}% Buy ratings "
            f"across {st_analyst_cnt} covering bank analysts."
        )
    else:
        m_plain_why = (
            f"Passes {f_score} of 9 annual financial safety checks with {_fmt(own_sum, 0)}% "
            f"long-term insider and institutional backing."
        )

    use_30d = (st_up30 + st_dn30) >= 3
    r_up = st_up30 if use_30d else st_up90
    r_dn = st_dn30 if use_30d else st_dn90
    r_tot = r_up + r_dn
    trend_word = "steady uptrend" if above_200dma else "below 200-day average"

    momentum_rows = [
        {
            "simple_label": "Annual financial safety score",
            "pro_label": "Piotroski F-Score (9-Point)",
            "simple_value": f"Passed {f_score} out of 9 safety checks",
            "pro_value": f"{f_score} / 9 F-Score",
            "target_hint": "7/9 or higher shows improving financial health",
            "tone": "good" if f_score >= 7 else ("neutral" if f_score >= 5 else "bad"),
        },
        {
            "simple_label": "Bank & Wall Street analyst view",
            "pro_label": "Sell-Side Consensus & Target Upside",
            "simple_value": (
                f"{buy_i}% Buy ({st_analyst_cnt} analysts, {_sfmt(st_upside_pct, 1)}% to target)"
                if (st_has_cov and st_target_mean > 0.0)
                else (f"{buy_i}% Buy across {st_analyst_cnt} analysts" if st_has_cov else "Limited analyst coverage")
            ),
            "pro_value": (
                f"{buy_i}% Buy (N={st_analyst_cnt}) • Target {ccy_sym}{_fmt(st_target_mean, 0)} ({_sfmt(st_upside_pct, 1)}%)"
                if (st_has_cov and st_target_mean > 0.0)
                else (f"{buy_i}% Buy (N={st_analyst_cnt})" if st_has_cov else "Uncovered")
            ),
            "target_hint": "Broad analyst support adds conviction",
            "tone": ("good" if buy_i >= 65 else ("neutral" if buy_i >= 40 else "warn")) if st_has_cov else "neutral",
        },
        {
            "simple_label": "Recent analyst profit forecast changes",
            "pro_label": "Street EPS Revision Breadth",
            "simple_value": (
                f"{r_up} raised vs {r_dn} cut profit forecasts recently"
                if (st_has_cov and r_tot >= 3)
                else ("Profit forecasts holding steady" if st_has_cov else "Tracked via quarterly results")
            ),
            "pro_value": (
                f"{r_up} Up / {r_dn} Down ({_sfmt(st_rev_breadth, 0)}% Breadth)"
                if (st_has_cov and r_tot >= 3)
                else "Neutral / Steady Revisions"
            ),
            "target_hint": "More upgrades than cuts is a positive sign",
            "tone": (
                ("good" if st_rev_breadth >= 25.0 else ("bad" if st_rev_breadth <= -40.0 else "neutral"))
                if (st_has_cov and r_tot >= 3)
                else "neutral"
            ),
        },
        {
            "simple_label": "Big-investor backing & price trend",
            "pro_label": "Institutional/Promoter Stake & 200-DMA Trend",
            "simple_value": (
                f"{_fmt(inst_pct, 0)}% institutional backing ({trend_word})"
                if market_code == "US"
                else f"{_fmt(own_sum, 0)}% founder + institutional stake ({trend_word})"
            ),
            "pro_value": (
                f"{_fmt(inst_pct, 1)}% Inst + {_fmt(promoter_pct, 1)}% Insider • 1Y Mom {_sfmt(mom_12_1_pct, 1)}%"
                if market_code == "US"
                else f"{_fmt(promoter_pct, 1)}% Prom + {_fmt(inst_pct, 1)}% FII/DII • 1Y Mom {_sfmt(mom_12_1_pct, 1)}%"
            ),
            "target_hint": "High long-term ownership aligns incentives",
            "tone": "good" if (own_sum >= 60.0 and above_200dma) else ("neutral" if own_sum >= 45.0 else "warn"),
        },
    ]

    receipt_steps = [
        {
            "key": "quality",
            "simple_title": "1. Is it a strong, safe business?",
            "pro_title": "1. Business Quality & Moat Longevity",
            "score_100": _r_int(quality_score),
            "weight_pct": _r_dec(_sfloat(weights_pct.get("quality"), 45.0), 1),
            "points_added": _r_dec(_sfloat(contributions.get("quality"), 0.0), 1),
            "verdict_tag": _verdict_tag(quality_score),
            "plain_why": q_plain_why,
            "rows": quality_rows,
        },
        {
            "key": "growth",
            "simple_title": "2. Are sales & profits growing?",
            "pro_title": "2. Multi-Year & Quarterly Growth",
            "score_100": _r_int(growth_score),
            "weight_pct": _r_dec(_sfloat(weights_pct.get("growth"), 25.0), 1),
            "points_added": _r_dec(_sfloat(contributions.get("growth"), 0.0), 1),
            "verdict_tag": _verdict_tag(growth_score),
            "plain_why": g_plain_why,
            "rows": growth_rows,
        },
        {
            "key": "value",
            "simple_title": "3. Is the stock fairly priced today?",
            "pro_title": "3. GARP Valuation & Margin of Safety",
            "score_100": _r_int(value_score),
            "weight_pct": _r_dec(_sfloat(weights_pct.get("value"), 20.0), 1),
            "points_added": _r_dec(_sfloat(contributions.get("value"), 0.0), 1),
            "verdict_tag": _verdict_tag(value_score),
            "plain_why": v_plain_why,
            "rows": value_rows,
        },
        {
            "key": "momentum",
            "simple_title": "4. Financial health & expert view",
            "pro_title": "4. Financial Health, Ownership & Street Revisions",
            "score_100": _r_int(momentum_score),
            "weight_pct": _r_dec(_sfloat(weights_pct.get("momentum"), 10.0), 1),
            "points_added": _r_dec(_sfloat(contributions.get("momentum"), 0.0), 1),
            "verdict_tag": _verdict_tag(momentum_score),
            "plain_why": m_plain_why,
            "rows": momentum_rows,
        },
    ]

    return {
        "archetype_code": archetype_code,
        "archetype_label": archetype_label,
        "one_line_verdict": one_line_verdict,
        "what_it_does": what_it_does,
        "bottom_line_summary": [s1, s2, s3],
        "receipt_steps": receipt_steps,
        "safety_checks_plain": translate_piotroski_checks(f_checks),
    }


def _extract_json_object(raw_text: str) -> Optional[Dict[str, Any]]:
    cleaned = raw_text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
        cleaned = re.sub(r"\s*```$", "", cleaned)
    try:
        obj = json.loads(cleaned)
        return obj if isinstance(obj, dict) else None
    except ValueError:
        match = re.search(r"\{[\s\S]*\}", cleaned)
        if match:
            try:
                obj = json.loads(match.group(0))
                return obj if isinstance(obj, dict) else None
            except ValueError:
                return None
    return None


def generate_local_ai_memo(
    company: Dict[str, Any],
    scorecard: Dict[str, Any],
    as_of_date: str,
) -> Dict[str, Any]:
    """Generate a plain-English AI analyst memo locally if GEMINI_API_KEY or OPENAI_API_KEY is set."""
    ticker = str(company["ticker"])
    company_name = str(company["name"])

    gemini_key = (os.environ.get("GEMINI_API_KEY") or "").strip()
    openai_key = (os.environ.get("OPENAI_API_KEY") or "").strip()

    if not gemini_key and not openai_key:
        return {
            "available": False,
            "ticker": ticker,
            "reason": "No local GEMINI_API_KEY set — open the live Netlify deployment where Netlify AI Gateway is active out-of-the-box.",
        }

    pe_block = scorecard.get("plain_english") or {}
    metrics = scorecard.get("metrics") or {}
    street = scorecard.get("street") or {}
    ccy_sym = "$" if scorecard.get("currency") == "USD" else "₹"

    verified_facts = {
        "ticker": ticker,
        "company_name": company_name,
        "sector": company.get("sector"),
        "industry": company.get("industry"),
        "market_label": scorecard.get("market_label"),
        "currency_symbol": ccy_sym,
        "price": scorecard.get("price"),
        "composite_score": scorecard.get("composite_score"),
        "rating": scorecard.get("rating"),
        "archetype": pe_block.get("archetype_label"),
        "what_it_does": pe_block.get("what_it_does"),
        "bottom_line_summary": pe_block.get("bottom_line_summary"),
        "pillars": scorecard.get("pillars"),
        "pe_ratio": None if pe_block.get("archetype_code") == "loss_turnaround" else metrics.get("pe_ratio"),
        "fair_pe": metrics.get("fair_pe"),
        "rev_cagr_5y_pct": metrics.get("rev_cagr_5y_pct"),
        "pat_cagr_5y_pct": metrics.get("pat_cagr_5y_pct"),
        "safety_score_out_of_9": metrics.get("piotroski_f_score"),
        "analyst_count": street.get("analyst_count"),
        "consensus_buy_pct": street.get("consensus_buy_pct"),
        "target_mean": street.get("target_mean"),
        "target_upside_pct": street.get("target_upside_pct"),
        "red_flags": scorecard.get("red_flags"),
    }

    system_prompt = (
        "You are a warm, crystal-clear investment educator writing for an everyday long-term investor. "
        "Explain this stock in plain English using ONLY the verified numbers provided. "
        "NEVER use unexplained finance acronyms like ROCE, EBITDA, PEG, Piotroski, or PAT — translate everything "
        "into everyday money terms (e.g. 'earns $28 on every $100 invested', 'trades at 27x annual profits'). "
        "Return STRICT JSON with exactly these 5 string keys: "
        "headline, business_overview, why_score_lands_here, key_risks_to_watch, bottom_line_for_investor."
    )
    user_prompt = f"Verified stock data as of {as_of_date}:\n{json.dumps(verified_facts, ensure_ascii=False)}"

    parsed: Optional[Dict[str, Any]] = None
    model_used = ""

    if gemini_key:
        model_used = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
        base_url = (os.environ.get("GOOGLE_GEMINI_BASE_URL") or "https://generativelanguage.googleapis.com").rstrip("/")
        url = f"{base_url}/v1beta/models/{model_used}:generateContent"
        try:
            with httpx.Client(timeout=20.0) as client:
                resp = client.post(
                    url,
                    headers={"x-goog-api-key": gemini_key, "Content-Type": "application/json"},
                    json={
                        "systemInstruction": {"parts": [{"text": system_prompt}]},
                        "contents": [{"role": "user", "parts": [{"text": user_prompt}]}],
                        "generationConfig": {
                            "temperature": 0.25,
                            "responseMimeType": "application/json",
                        },
                    },
                )
                if resp.status_code == 200:
                    data = resp.json()
                    cand_text = (
                        data.get("candidates", [{}])[0]
                        .get("content", {})
                        .get("parts", [{}])[0]
                        .get("text", "")
                    )
                    parsed = _extract_json_object(cand_text)
        except Exception as exc:
            logger.warning("Local Gemini AI memo request failed for %s: %s", ticker, type(exc).__name__)

    if parsed is None and openai_key:
        model_used = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
        base_url = (os.environ.get("OPENAI_BASE_URL") or "https://api.openai.com/v1").rstrip("/")
        url = f"{base_url}/chat/completions"
        try:
            with httpx.Client(timeout=20.0) as client:
                resp = client.post(
                    url,
                    headers={"Authorization": f"Bearer {openai_key}", "Content-Type": "application/json"},
                    json={
                        "model": model_used,
                        "temperature": 0.25,
                        "response_format": {"type": "json_object"},
                        "messages": [
                            {"role": "system", "content": system_prompt},
                            {"role": "user", "content": user_prompt},
                        ],
                    },
                )
                if resp.status_code == 200:
                    data = resp.json()
                    msg_text = data.get("choices", [{}])[0].get("message", {}).get("content", "")
                    parsed = _extract_json_object(msg_text)
        except Exception as exc:
            logger.warning("Local OpenAI AI memo request failed for %s: %s", ticker, type(exc).__name__)

    required_keys = (
        "headline",
        "business_overview",
        "why_score_lands_here",
        "key_risks_to_watch",
        "bottom_line_for_investor",
    )
    if not parsed or not all(isinstance(parsed.get(k), str) and parsed.get(k).strip() for k in required_keys):
        return {
            "available": False,
            "ticker": ticker,
            "reason": "Local AI provider could not complete the memo right now — please retry or open the Netlify deployment.",
        }

    return {
        "available": True,
        "cached": False,
        "ticker": ticker,
        "company_name": company_name,
        "as_of_date": as_of_date,
        "model_used": model_used,
        "headline": str(parsed["headline"]).strip(),
        "business_overview": str(parsed["business_overview"]).strip(),
        "why_score_lands_here": str(parsed["why_score_lands_here"]).strip(),
        "key_risks_to_watch": str(parsed["key_risks_to_watch"]).strip(),
        "bottom_line_for_investor": str(parsed["bottom_line_for_investor"]).strip(),
    }
