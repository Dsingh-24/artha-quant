"""Long-Term Fundamental & Multi-Factor Scoring Engine (QGLP / GARP / Coffee-Can / Magic Formula).

Designed for long-term Indian equity investors with strict point-in-time (`as_of_date`) discipline:
- Multi-year moat longevity: Evaluates 5-Year Median ROCE/ROE, 5/5-year profit consistency,
  and 5-Year Cumulative CFO/EBITDA cash conversion (preventing 1-year cyclical spikes from
  masquerading as structural compounders).
- GARP Valuation discipline: Uses PEG ratio, Earnings Yield, FCF Yield, and a Quality-Adjusted
  Fair P/E anchor — capping overextended >58x P/E stocks (`PEG > 2.2`) at `Hold (Wait for Dip)`.
- Point-in-time backtest safety: Enforces `reported_date <= as_of_date` (60-day SEBI LODR lag).
"""

from __future__ import annotations

import math
import statistics
from typing import Any, Dict, List, Optional, Tuple

import pandas as pd

PRESET_WEIGHTS: Dict[str, Dict[str, float]] = {
    "qglp_compounder": {"quality": 45.0, "value": 20.0, "growth": 25.0, "momentum": 10.0},
    "artha_blend": {"quality": 35.0, "value": 25.0, "growth": 20.0, "momentum": 20.0},
    "coffee_can": {"quality": 55.0, "value": 10.0, "growth": 30.0, "momentum": 5.0},
    "magic_formula": {"quality": 45.0, "value": 45.0, "growth": 5.0, "momentum": 5.0},
    "value_momentum": {"quality": 10.0, "value": 45.0, "growth": 5.0, "momentum": 40.0},
}


def resolve_weights(preset: str, custom: Optional[Dict[str, float]] = None) -> Dict[str, float]:
    if preset == "custom" and custom:
        raw = {
            "quality": max(0.0, float(custom.get("quality", 45.0))),
            "value": max(0.0, float(custom.get("value", 20.0))),
            "growth": max(0.0, float(custom.get("growth", 25.0))),
            "momentum": max(0.0, float(custom.get("momentum", 10.0))),
        }
    else:
        raw = dict(PRESET_WEIGHTS.get(preset, PRESET_WEIGHTS["qglp_compounder"]))

    total = sum(raw.values())
    if total <= 0:
        return {"quality": 0.45, "value": 0.20, "growth": 0.25, "momentum": 0.10}
    return {k: v / total for k, v in raw.items()}


def _clamp(val: float, lo: float = 0.0, hi: float = 100.0) -> float:
    return max(lo, min(hi, val))


def _linear_score(val: float, bad: float, good: float) -> float:
    if math.isnan(val) or good == bad:
        return 50.0
    return _clamp(((val - bad) / (good - bad)) * 100.0, 0.0, 100.0)


def _compute_cagr(records: List[Dict[str, Any]], field: str, lookback_years: int) -> float:
    if len(records) < 2:
        return 8.0
    latest = records[-1]
    target_idx = max(0, len(records) - 1 - lookback_years)
    base = records[target_idx]
    yrs = max(1, int(latest["fiscal_year"]) - int(base["fiscal_year"]))
    end_val = float(latest[field])
    start_val = float(base[field])
    if end_val <= 0:
        return -20.0
    if start_val <= 0:
        return 18.0
    return ((end_val / start_val) ** (1.0 / yrs) - 1.0) * 100.0


def compute_piotroski_f_score(
    latest: Dict[str, Any],
    prev: Optional[Dict[str, Any]],
    is_financial: bool = False,
) -> Tuple[int, List[str]]:
    """Compute 9-point Piotroski F-Score (with bank loan-book adaptation for financials)."""
    score = 0
    checks: List[str] = []

    tot_assets = max(1.0, float(latest["total_assets_cr"]))
    pat_cur = float(latest["net_profit_cr"])
    roa_cur = pat_cur / tot_assets
    cfo_cur = float(latest["cfo_cr"])

    if pat_cur > 0:
        score += 1
        checks.append("Positive Net Profit (PAT > 0)")

    if is_financial:
        if float(latest["roe_pct"]) >= 12.0:
            score += 1
            checks.append("Healthy Banking ROE (>= 12%)")
        if roa_cur >= 0.01:
            score += 1
            checks.append("Strong Banking ROA (>= 1.0%)")
    else:
        if cfo_cur > 0:
            score += 1
            checks.append("Positive Operating Cash Flow (CFO > 0)")
        if cfo_cur >= pat_cur * 0.90 and cfo_cur > 0:
            score += 1
            checks.append("Clean Accrual Quality (CFO >= 0.9x PAT)")

    if prev is None:
        score += 3
        return score, checks

    prev_assets = max(1.0, float(prev["total_assets_cr"]))
    roa_prev = float(prev["net_profit_cr"]) / prev_assets

    if roa_cur >= roa_prev - 0.002:
        score += 1
        checks.append("Stable/Improving Return on Assets")

    lev_cur = float(latest["total_debt_cr"]) / tot_assets
    lev_prev = float(prev["total_debt_cr"]) / prev_assets
    if lev_cur <= lev_prev + 0.015:
        score += 1
        checks.append("Controlled Balance Sheet Leverage")

    cr_cur = float(latest["current_assets_cr"]) / max(1.0, float(latest["current_liabilities_cr"]))
    cr_prev = float(prev["current_assets_cr"]) / max(1.0, float(prev["current_liabilities_cr"]))
    if cr_cur >= cr_prev - 0.08:
        score += 1
        checks.append("Healthy Liquidity Trend")

    if float(latest["shares_cr"]) <= float(prev["shares_cr"]) * 1.02:
        score += 1
        checks.append("No Material Equity Dilution")

    if float(latest["op_margin_pct"]) >= float(prev["op_margin_pct"]) - 0.6:
        score += 1
        checks.append("Resilient Operating Margin")

    at_cur = float(latest["revenue_cr"]) / tot_assets
    at_prev = float(prev["revenue_cr"]) / prev_assets
    if at_cur >= at_prev - 0.025:
        score += 1
        checks.append("Stable/Improving Asset Turnover")

    return score, checks


def score_universe_point_in_time(
    companies: List[Dict[str, Any]],
    fundamentals_df: pd.DataFrame,
    price_matrix: pd.DataFrame,
    as_of_date: str,
    preset: str = "qglp_compounder",
    custom_weights: Optional[Dict[str, float]] = None,
    stage1_lookup: Optional[Dict[str, Dict[str, Any]]] = None,
    quarterly_signals: Optional[Dict[str, Dict[str, Any]]] = None,
) -> List[Dict[str, Any]]:
    """Evaluate all deep-scored companies strictly using data available on or before `as_of_date`."""
    weights = resolve_weights(preset, custom_weights)
    results: List[Dict[str, Any]] = []

    if price_matrix.empty or fundamentals_df.empty:
        return results

    avail_prices = price_matrix.loc[price_matrix.index <= as_of_date]
    if avail_prices.empty:
        return results

    avail_funds = fundamentals_df[fundamentals_df["reported_date"] <= as_of_date]
    if avail_funds.empty:
        return results

    commodity_keywords = (
        "aluminium", "copper", "steel", "zinc", "coal", "mining",
        "metal", "vedanta", "hindalco", "nmdc", "iron", "petroleum",
    )

    for comp in companies:
        tk = comp["ticker"]
        if tk not in avail_prices.columns:
            continue

        px_series = avail_prices[tk].dropna()
        if len(px_series) < 65:
            continue

        cur_price = float(px_series.iloc[-1])
        if cur_price <= 0:
            continue

        tk_funds = avail_funds[avail_funds["ticker"] == tk].sort_values("fiscal_year")
        if tk_funds.empty:
            continue

        fund_records = tk_funds.to_dict("records")
        window_8y = fund_records[-8:]
        window_5y = fund_records[-5:]
        latest = fund_records[-1]
        prev = fund_records[-2] if len(fund_records) >= 2 else None
        is_fin = bool(comp.get("is_financial"))
        promoter_pct = float(comp.get("promoter_pct") or 0.0)
        inst_pct = float(comp.get("inst_pct") or 0.0)

        # Point-in-time check for live/recent quarterly & shareholding signals
        qsig = (quarterly_signals or {}).get(tk)
        use_live_qtr = bool(
            qsig and str(qsig.get("signals_reported_date", "9999-12-31")) <= as_of_date
        )

        shares_cr = max(0.01, float(latest["shares_cr"]))
        market_cap_cr = cur_price * shares_cr
        net_debt_cr = float(latest["total_debt_cr"]) - (float(latest["current_assets_cr"]) * 0.25)
        ev_cr = max(market_cap_cr * 0.5, market_cap_cr + (0.0 if is_fin else net_debt_cr))

        pat_fy_cr = float(latest["net_profit_cr"])
        ttm_pat_cr = float(qsig.get("ttm_pat_cr", 0.0)) if use_live_qtr and qsig else 0.0
        # Use fresh TTM PAT when available as of `as_of_date`, else latest audited FY PAT
        pat_cr = ttm_pat_cr if (use_live_qtr and ttm_pat_cr != 0.0) else pat_fy_cr

        ebit_cr = float(latest["ebit_cr"])
        ebitda_cr = float(latest["ebitda_cr"])
        fcf_cr = float(latest["fcf_cr"])
        equity_cr = float(latest["total_equity_cr"])
        tot_assets_cr = max(1.0, float(latest["total_assets_cr"]))

        pe_ratio = (market_cap_cr / pat_cr) if pat_cr > 0 else 99.9
        pb_ratio = (market_cap_cr / equity_cr) if equity_cr > 0 else 25.0
        ev_ebitda = (ev_cr / ebitda_cr) if ebitda_cr > 0 else 50.0
        earnings_yield_pct = ((pat_cr if is_fin else ebit_cr) / ev_cr) * 100.0 if ev_cr > 0 else 0.0
        fcf_yield_pct = (fcf_cr / market_cap_cr) * 100.0 if market_cap_cr > 0 else 0.0
        roa_pct = (pat_fy_cr / tot_assets_cr) * 100.0

        # Multi-Year Consistency & Moat Longevity (5Y + Full 8Y Anti-Cyclicality Window)
        roce_cur = float(latest["roce_pct"])
        roe_cur = float(latest["roe_pct"])
        opm_cur = float(latest["op_margin_pct"])
        de_cur = float(latest["debt_to_equity"])

        med_5y_roce = float(statistics.median([float(r["roce_pct"]) for r in window_5y]))
        med_5y_roe = float(statistics.median([float(r["roe_pct"]) for r in window_5y]))
        profitable_yrs = sum(1 for r in window_5y if float(r["net_profit_cr"]) > 0)
        profit_consistency_pct = (profitable_yrs / max(1, len(window_5y))) * 100.0

        # Upgrade 1: Full-Cycle Moat Stability (6Y-8Y Cycle Floor & Margin Volatility)
        window_6y = fund_records[-6:]
        floor_rets = [float(r["roe_pct"] if is_fin else r["roce_pct"]) for r in window_6y]
        cycle_rets = [float(r["roe_pct"] if is_fin else r["roce_pct"]) for r in window_8y]
        cycle_opms = [float(r["op_margin_pct"]) for r in window_8y]
        sorted_floor_rets = sorted(floor_rets)
        # Second-lowest return across 6Y cycle (forgives 1 black-swan COVID year while catching multi-year cyclical troughs)
        cycle_floor_ret = sorted_floor_rets[1] if len(sorted_floor_rets) >= 4 else sorted_floor_rets[0]
        ret_std_8y = float(statistics.pstdev(cycle_rets)) if len(cycle_rets) >= 3 else 3.5
        opm_std_8y = float(statistics.pstdev(cycle_opms)) if len(cycle_opms) >= 3 else 2.0

        if is_fin:
            moat_stability = _clamp(
                0.65 * _linear_score(cycle_floor_ret, 4.0, 14.5)
                + 0.35 * _linear_score(ret_std_8y, 8.5, 1.5)
            )
        else:
            moat_stability = _clamp(
                0.45 * _linear_score(cycle_floor_ret, 6.0, 18.0)
                + 0.35 * _linear_score(opm_std_8y, 8.5, 1.8)
                + 0.20 * _linear_score(ret_std_8y, 12.0, 2.5)
            )

        nm_low = comp["name"].lower()
        is_commodity_biz = (not is_fin) and any(k in nm_low for k in commodity_keywords)
        is_cyclical_profile = is_commodity_biz or (
            (not is_fin) and (opm_std_8y >= 6.0 or ret_std_8y >= 10.5 or cycle_floor_ret < 8.5)
        )

        sum_cfo_5y = sum(float(r["cfo_cr"]) for r in window_5y)
        sum_ebitda_5y = sum(max(0.0, float(r["ebitda_cr"])) for r in window_5y)
        cum_cfo_ebitda_5y = (
            (sum_cfo_5y / sum_ebitda_5y) * 100.0
            if (not is_fin and sum_ebitda_5y > 1.0)
            else float(latest["cfo_to_ebitda_pct"])
        )
        cum_cfo_ebitda_5y = _clamp(cum_cfo_ebitda_5y, -25.0, 140.0)

        # Sustainable 3Y & 5Y Compounding CAGRs
        rev_cagr_3y = _compute_cagr(fund_records, "revenue_cr", 3)
        rev_cagr_5y = _compute_cagr(fund_records, "revenue_cr", 5)
        pat_cagr_3y = _compute_cagr(fund_records, "net_profit_cr", 3)
        pat_cagr_5y = _compute_cagr(fund_records, "net_profit_cr", 5)

        blended_rev_cagr = 0.55 * rev_cagr_5y + 0.45 * rev_cagr_3y
        blended_pat_cagr = 0.50 * pat_cagr_5y + 0.50 * pat_cagr_3y
        # Normalize credit-cycle / commodity trough-recovery base effects for Fair P/E estimation
        normalized_pat_cagr = (
            min(blended_pat_cagr, 19.0)
            if (cycle_floor_ret < 9.5 and blended_pat_cagr > 25.0)
            else blended_pat_cagr
        )

        # Upgrade 2 & 3 Signals (Quarterly YoY Trajectory, Shareholding Conviction & Bank NPAs)
        has_qtr_data = bool(use_live_qtr and qsig and qsig.get("has_qtr_data"))
        has_sh_trend = bool(use_live_qtr and qsig and qsig.get("has_sh_trend"))
        qtr_rev_yoy = float(qsig["qtr_rev_yoy_pct"]) if has_qtr_data and qsig else blended_rev_cagr
        qtr_pat_yoy = float(qsig["qtr_pat_yoy_pct"]) if has_qtr_data and qsig else blended_pat_cagr
        qtr_opm_delta = float(qsig["qtr_opm_delta_pct"]) if has_qtr_data and qsig else 0.0
        promoter_chg_1y = float(qsig["promoter_chg_1y_pct"]) if has_sh_trend and qsig else 0.0
        inst_chg_1y = float(qsig["inst_chg_1y_pct"]) if has_sh_trend and qsig else 0.0
        gnpa_pct = float(qsig["gnpa_pct"]) if (use_live_qtr and qsig) else 0.0
        nnpa_pct = float(qsig["nnpa_pct"]) if (use_live_qtr and qsig) else 0.0
        latest_qtr_label = str(qsig.get("latest_qtr_label", "")) if (use_live_qtr and qsig) else ""

        # Trailing Price Trend & Piotroski Health
        ret_6m_pct = ((cur_price / float(px_series.iloc[-min(len(px_series), 126)])) - 1.0) * 100.0
        if len(px_series) >= 252:
            px_1m_ago = float(px_series.iloc[-21])
            px_12m_ago = float(px_series.iloc[-252])
            mom_12_1_pct = ((px_1m_ago / px_12m_ago) - 1.0) * 100.0
        else:
            mom_12_1_pct = ret_6m_pct

        dma_200 = float(px_series.tail(200).mean())
        above_200dma = cur_price >= dma_200 * 0.96

        daily_rets = px_series.tail(252).pct_change().dropna()
        vol_annual_pct = float(daily_rets.std() * math.sqrt(252.0) * 100.0) if len(daily_rets) > 20 else 25.0
        risk_adj_mom = mom_12_1_pct / max(12.0, vol_annual_pct)

        f_score, f_checks = compute_piotroski_f_score(latest, prev, is_financial=is_fin)

        # --- Pillar 1: Long-Term Quality, Cash Conversion & Anti-Cyclical Moat ---
        sustained_roce = 0.60 * med_5y_roce + 0.40 * roce_cur
        sustained_roe = 0.60 * med_5y_roe + 0.40 * roe_cur

        if is_fin:
            q_return = 0.60 * _linear_score(sustained_roe, 8.0, 19.0) + 0.40 * _linear_score(roa_pct, 0.5, 2.2)
            q_lev = _linear_score(de_cur, 11.0, 2.0)
            q_cash = profit_consistency_pct
            if gnpa_pct > 0:
                q_asset_qual = 0.55 * _linear_score(nnpa_pct, 1.8, 0.25) + 0.45 * _linear_score(gnpa_pct, 5.0, 1.3)
                q_margin = 0.50 * _linear_score(opm_cur, 8.0, 28.0) + 0.50 * q_asset_qual
            else:
                q_margin = _linear_score(opm_cur, 8.0, 28.0)
        else:
            q_return = 0.55 * _linear_score(sustained_roce, 8.0, 30.0) + 0.45 * _linear_score(sustained_roe, 8.0, 26.0)
            q_lev = _linear_score(de_cur, 1.8, 0.05)
            q_cash = 0.65 * _linear_score(cum_cfo_ebitda_5y, 50.0, 95.0) + 0.35 * profit_consistency_pct
            q_margin = _linear_score(opm_cur, 8.0, 26.0)

        quality_score = _clamp(
            0.34 * q_return
            + 0.22 * moat_stability
            + 0.16 * q_lev
            + 0.18 * q_cash
            + 0.10 * q_margin
        )

        # --- Pillar 2: GARP Valuation & Cyclicality-Aware Fair P/E ---
        effective_growth_anchor = _clamp(
            0.70 * normalized_pat_cagr + 0.30 * (qtr_pat_yoy if has_qtr_data else pat_cagr_3y),
            5.0,
            28.0 if not is_cyclical_profile else 16.0,
        )
        peg_ratio = (pe_ratio / effective_growth_anchor) if pat_cr > 0 else 9.9

        if is_fin:
            fair_pe = (
                10.0
                + _clamp((sustained_roe - 10.0) * 1.0, 0.0, 9.5)
                + _clamp(normalized_pat_cagr * 0.32, 0.0, 6.5)
            )
            if cycle_floor_ret < 9.0:
                fair_pe = min(fair_pe, 15.5)
        else:
            fair_pe = (
                13.0
                + _clamp((sustained_roce - 12.0) * 0.52, 0.0, 12.5)
                + _clamp(normalized_pat_cagr * 0.52, 0.0, 12.5)
            )
            if is_commodity_biz:
                fair_pe = min(fair_pe, 15.5)
            elif is_cyclical_profile:
                fair_pe = min(fair_pe, 20.0)
        fair_pe = round(_clamp(fair_pe, 10.0, 38.0), 1)

        v_peg = _linear_score(peg_ratio, 3.0, 0.95) if pat_cr > 0 else 0.0
        v_ey = _linear_score(earnings_yield_pct, 2.0, 9.0)
        v_pe_rel = _linear_score(pe_ratio / max(8.0, fair_pe), 1.75, 0.75) if pat_cr > 0 else 0.0
        v_pb = _linear_score(pb_ratio, 4.5, 1.1) if equity_cr > 0 else 0.0
        v_fcf = _linear_score(fcf_yield_pct, 0.5, 5.5)

        if is_fin:
            value_score = _clamp(0.35 * v_pb + 0.35 * v_pe_rel + 0.30 * v_peg)
        else:
            value_score = _clamp(0.35 * v_peg + 0.30 * v_pe_rel + 0.20 * v_ey + 0.15 * v_fcf)

        if pat_cr <= 0 or pe_ratio > fair_pe * 1.55 or (pe_ratio > 55.0 and peg_ratio > 2.2):
            valuation_zone = "Overvalued / Wait for Dip"
        elif pe_ratio <= fair_pe * 0.90:
            valuation_zone = "Undervalued (Margin of Safety)"
        elif pe_ratio <= fair_pe * 1.20:
            valuation_zone = "Fair GARP Price"
        else:
            valuation_zone = "Slightly Rich (Stagger SIP)"

        # --- Pillar 3: Multi-Year Compounding + Latest 2-Quarter Earnings Inflection ---
        g_rev = _linear_score(blended_rev_cagr, 4.0, 20.0)
        g_pat = _linear_score(normalized_pat_cagr, 5.0, 23.0)
        annual_growth_score = _clamp(0.42 * g_rev + 0.58 * g_pat)

        if has_qtr_data:
            q_g_rev = _linear_score(qtr_rev_yoy, -4.0, 20.0)
            q_g_pat = _linear_score(qtr_pat_yoy, -6.0, 24.0)
            q_g_opm = _linear_score(qtr_opm_delta, -2.5, 2.5)
            qtr_growth_score = _clamp(0.40 * q_g_rev + 0.45 * q_g_pat + 0.15 * q_g_opm)
            growth_score = _clamp(0.68 * annual_growth_score + 0.32 * qtr_growth_score)
        else:
            growth_score = annual_growth_score

        # --- Pillar 4: Piotroski Health, 4Q Institutional/Promoter Conviction & Trend ---
        m_piotroski = (f_score / 9.0) * 100.0
        smart_money_chg = promoter_chg_1y + inst_chg_1y
        if has_sh_trend:
            ownership_score = _clamp(
                0.55 * _linear_score(smart_money_chg, -4.0, 2.5)
                + 0.45 * _linear_score(promoter_pct + inst_pct, 45.0, 82.0)
            )
        else:
            ownership_score = _linear_score(promoter_pct + inst_pct, 40.0, 80.0) if (promoter_pct + inst_pct) > 0 else 60.0

        if preset in {"qglp_compounder", "coffee_can"}:
            m_trend = 75.0 if above_200dma else 35.0
            m_steady = _linear_score(mom_12_1_pct, -18.0, 28.0)
            momentum_score = _clamp(
                0.45 * m_piotroski + 0.30 * ownership_score + 0.15 * m_steady + 0.10 * m_trend
            )
        else:
            m_12_1 = _linear_score(mom_12_1_pct, -12.0, 38.0)
            m_risk_adj = _linear_score(risk_adj_mom, -0.4, 1.5)
            momentum_score = _clamp(0.35 * m_12_1 + 0.25 * m_risk_adj + 0.25 * m_piotroski + 0.15 * ownership_score)

        # --- Forensic, Governance, Quarterly Inflection & Valuation Guardrails ---
        red_flags: List[str] = []
        strengths: List[str] = []
        penalty = 0.0
        valuation_capped = False

        if pat_cr <= 0 or pat_fy_cr <= 0:
            red_flags.append("Loss-making in latest fiscal year or TTM (PAT <= 0)")
            penalty += 20.0
        if profitable_yrs < max(1, len(window_5y) - 1):
            red_flags.append(f"Inconsistent profitability ({profitable_yrs}/{len(window_5y)} profitable years)")
            penalty += 10.0
        if equity_cr <= 0:
            red_flags.append("Negative net worth / eroded book equity")
            penalty += 15.0
        if not is_fin and de_cur > 1.8:
            red_flags.append(f"High corporate debt load (D/E {de_cur:.2f}x)")
            penalty += 12.0
        if not is_fin and cum_cfo_ebitda_5y < 55.0:
            red_flags.append(f"Weak 5Y cumulative cash conversion ({cum_cfo_ebitda_5y:.0f}% CFO/EBITDA)")
            penalty += 10.0
        if pat_cagr_3y < -10.0 and pat_cagr_5y < -5.0:
            red_flags.append(f"Structural multi-year profit contraction ({pat_cagr_3y:.1f}% 3Y PAT CAGR)")
            penalty += 10.0
        if has_qtr_data and (qtr_pat_yoy <= -15.0 or (qtr_rev_yoy <= -6.0 and qtr_pat_yoy < 0.0)):
            red_flags.append(
                f"Recent 2Q earnings slowdown ({qtr_pat_yoy:+.1f}% YoY PAT, {qtr_rev_yoy:+.1f}% YoY Sales in {latest_qtr_label})"
            )
            penalty += 9.0
        if has_sh_trend and (
            (smart_money_chg <= -4.5 and (promoter_pct + inst_pct) < 72.0)
            or (promoter_chg_1y <= -3.5 and inst_chg_1y < 0.5)
        ):
            red_flags.append(
                f"4Q Promoter/Institutional exit ({promoter_chg_1y:+.1f}% Promoter, {inst_chg_1y:+.1f}% FII+DII)"
            )
            penalty += 7.0
        if is_fin and gnpa_pct > 0 and (nnpa_pct > 1.5 or gnpa_pct > 4.5):
            red_flags.append(f"Elevated banking NPAs (Gross NPA {gnpa_pct:.2f}%, Net NPA {nnpa_pct:.2f}%)")
            penalty += 10.0
        if is_commodity_biz and moat_stability < 55.0:
            red_flags.append(
                f"Commodity cyclicality risk (8Y ROCE swung {cycle_floor_ret:.0f}%–{max(cycle_rets):.0f}%)"
            )
            penalty += 5.0
        if f_score <= 3:
            red_flags.append(f"Weak Piotroski financial health ({f_score}/9)")
            penalty += 10.0
        if (pe_ratio > 56.0 and peg_ratio > 2.1) or (is_cyclical_profile and pe_ratio > fair_pe * 1.75):
            red_flags.append(
                f"Valuation rich at {pe_ratio:.1f}x P/E (Fair ~{fair_pe}x, PEG {peg_ratio:.1f}x) — wait for pullback"
            )
            penalty += 8.0
            valuation_capped = True

        # Bull Thesis Explanations
        if is_fin and sustained_roe >= 14.5:
            npa_note = f", Net NPA {nnpa_pct:.2f}%" if gnpa_pct > 0 else ""
            strengths.append(
                f"Consistent banking compounder (5Y Med ROE {med_5y_roe:.1f}%, Cycle Floor {cycle_floor_ret:.0f}%{npa_note})"
            )
        elif not is_fin and sustained_roce >= 18.0 and moat_stability >= 65.0:
            strengths.append(
                f"All-weather moat (5Y Med ROCE {med_5y_roce:.1f}%, 8Y Cycle Floor {cycle_floor_ret:.0f}%, Stability {moat_stability:.0f}/100)"
            )
        elif not is_fin and sustained_roce >= 18.0:
            strengths.append(
                f"Strong capital return (5Y Med ROCE {med_5y_roce:.1f}%, Latest {roce_cur:.1f}%, {profitable_yrs}/{len(window_5y)} yrs profitable)"
            )
        if has_qtr_data and qtr_pat_yoy >= 12.0 and qtr_rev_yoy >= 8.0:
            strengths.append(
                f"Healthy latest 2Q trajectory ({qtr_pat_yoy:+.1f}% YoY PAT, {qtr_rev_yoy:+.1f}% YoY Sales through {latest_qtr_label})"
            )
        if not is_fin and cum_cfo_ebitda_5y >= 82.0:
            strengths.append(f"Clean 5Y cash-flow conversion ({cum_cfo_ebitda_5y:.0f}% cumulative CFO/EBITDA)")
        if not is_fin and de_cur <= 0.25 and equity_cr > 0:
            strengths.append(f"Fortress balance sheet with minimal debt (D/E {de_cur:.2f}x)")
        if pat_cr > 0 and pe_ratio <= fair_pe * 1.10:
            strengths.append(
                f"Reasonable GARP entry price ({pe_ratio:.1f}x P/E vs Fair ~{fair_pe}x, PEG {peg_ratio:.2f}x)"
            )
        if has_sh_trend and inst_chg_1y >= 1.0 and promoter_chg_1y >= -0.4:
            strengths.append(
                f"Institutional accumulation ({inst_chg_1y:+.1f}% FII+DII stake added over 4Q; Total Prom+Inst {promoter_pct + inst_pct:.1f}%)"
            )
        elif (promoter_pct + inst_pct) >= 65.0:
            strengths.append(
                f"High institutional & promoter skin-in-the-game ({promoter_pct:.1f}% Promoter + {inst_pct:.1f}% FII/DII)"
            )

        raw_composite = (
            weights["quality"] * quality_score
            + weights["value"] * value_score
            + weights["growth"] * growth_score
            + weights["momentum"] * momentum_score
        )
        composite_score = round(_clamp(raw_composite - penalty), 1)

        if valuation_capped and composite_score >= 45.0 and pat_cr > 0:
            rating = "Hold"
            conviction = "Great Business, Rich Price — Buy on Dip"
        elif composite_score >= 68.0 and len(red_flags) == 0:
            rating = "Strong Buy"
            conviction = "Core Long-Term Compounder"
        elif composite_score >= 57.0 and pat_cr > 0 and profitable_yrs >= len(window_5y) - 1:
            rating = "Buy"
            conviction = "Accumulate for 3-5Y+"
        elif composite_score >= 45.0 and pat_cr > 0:
            rating = "Hold"
            conviction = "Watchlist / Hold Existing"
        else:
            rating = "Avoid"
            conviction = "Fundamental / Balance-Sheet Caution"

        if not strengths:
            strengths.append("Established NSE Nifty-200 operating franchise")

        s1_info = (stage1_lookup or {}).get(tk, {})

        results.append(
            {
                "ticker": tk,
                "name": comp["name"],
                "sector": comp["sector"],
                "cap_tier": comp.get("cap_tier", "Large Cap"),
                "data_source": comp.get("data_source", "real_nse_screener"),
                "is_financial": is_fin,
                "is_cyclical": is_cyclical_profile,
                "price": round(cur_price, 2),
                "market_cap_cr": round(market_cap_cr, 0),
                "composite_score": composite_score,
                "stage1_rank": s1_info.get("stage1_rank"),
                "stage1_score": s1_info.get("stage1_score"),
                "rating": rating,
                "conviction": conviction,
                "valuation_zone": valuation_zone,
                "pillars": {
                    "quality": round(quality_score, 1),
                    "value": round(value_score, 1),
                    "growth": round(growth_score, 1),
                    "momentum": round(momentum_score, 1),
                },
                "metrics": {
                    "roce_pct": round(roe_cur if is_fin else roce_cur, 1),
                    "med_5y_roce_pct": round(med_5y_roe if is_fin else med_5y_roce, 1),
                    "cycle_floor_roce_pct": round(cycle_floor_ret, 1),
                    "moat_stability_score": round(moat_stability, 0),
                    "roe_pct": round(roe_cur, 1),
                    "roa_pct": round(roa_pct, 2),
                    "op_margin_pct": round(opm_cur, 1),
                    "debt_to_equity": round(de_cur, 2),
                    "cfo_to_ebitda_pct": round(cum_cfo_ebitda_5y, 1),
                    "profit_consistency": f"{profitable_yrs}/{len(window_5y)}",
                    "pe_ratio": round(pe_ratio, 1),
                    "fair_pe": fair_pe,
                    "peg_ratio": round(peg_ratio, 2),
                    "pb_ratio": round(pb_ratio, 2),
                    "ev_ebitda": round(ev_ebitda, 1),
                    "earnings_yield_pct": round(earnings_yield_pct, 2),
                    "fcf_yield_pct": round(fcf_yield_pct, 2),
                    "rev_cagr_3y_pct": round(rev_cagr_3y, 1),
                    "rev_cagr_5y_pct": round(rev_cagr_5y, 1),
                    "pat_cagr_3y_pct": round(pat_cagr_3y, 1),
                    "pat_cagr_5y_pct": round(pat_cagr_5y, 1),
                    "qtr_rev_yoy_pct": round(qtr_rev_yoy, 1),
                    "qtr_pat_yoy_pct": round(qtr_pat_yoy, 1),
                    "qtr_opm_delta_pct": round(qtr_opm_delta, 1),
                    "latest_qtr_label": latest_qtr_label,
                    "promoter_chg_1y_pct": round(promoter_chg_1y, 2),
                    "inst_chg_1y_pct": round(inst_chg_1y, 2),
                    "gnpa_pct": round(gnpa_pct, 2),
                    "nnpa_pct": round(nnpa_pct, 2),
                    "ret_6m_pct": round(ret_6m_pct, 1),
                    "mom_12_1_pct": round(mom_12_1_pct, 1),
                    "volatility_pct": round(vol_annual_pct, 1),
                    "piotroski_f_score": f_score,
                    "promoter_pct": round(promoter_pct, 1),
                    "inst_pct": round(inst_pct, 1),
                    "latest_fy": int(latest["fiscal_year"]),
                },
                "strengths": strengths[:4],
                "red_flags": red_flags[:4],
                "piotroski_checks": f_checks,
            }
        )

    results.sort(key=lambda item: item["composite_score"], reverse=True)
    for rank_idx, item in enumerate(results, start=1):
        item["rank"] = rank_idx
    return results
