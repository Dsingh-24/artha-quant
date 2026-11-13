"""Long-Term Indian Capital Deployment Advisor, SIP & Portfolio Planner.

Built specifically to answer:
  "If I invest ₹5,00,000 today as a long-term fundamental investor, WHERE should I invest,
   HOW MUCH in each company, HOW should I stagger entry, and WHY?"
"""

from __future__ import annotations

import math
from typing import Any, Dict, List

import numpy as np

RISK_PROFILES: Dict[str, Dict[str, Any]] = {
    "equity_direct": {
        "label": "100% Direct Long-Term NSE Compounder Basket (Buy & Hold 5Y+)",
        "allocation": [
            {"asset": "Core QGLP / Coffee-Can Compounders", "pct": 65.0, "expected_return": 14.5},
            {"asset": "GARP Growth & Value Leaders", "pct": 35.0, "expected_return": 16.0},
        ],
        "blended_mu": 0.148,
        "blended_sigma": 0.165,
    },
    "moderate": {
        "label": "Moderate Multi-Asset (70% NSE Equity / 20% India Debt / 10% Gold)",
        "allocation": [
            {"asset": "Core QGLP / Coffee-Can Compounders", "pct": 45.0, "expected_return": 14.0},
            {"asset": "GARP Growth & Value Leaders", "pct": 25.0, "expected_return": 15.8},
            {"asset": "India G-Sec / Target Maturity Debt", "pct": 20.0, "expected_return": 7.2},
            {"asset": "Gold ETF / Sovereign Gold", "pct": 10.0, "expected_return": 8.5},
        ],
        "blended_mu": 0.125,
        "blended_sigma": 0.128,
    },
    "aggressive": {
        "label": "Aggressive Wealth Builder (85% NSE Equity / 10% Liquid Reserve / 5% Gold)",
        "allocation": [
            {"asset": "Core QGLP / Coffee-Can Compounders", "pct": 50.0, "expected_return": 14.2},
            {"asset": "GARP Growth & Value Leaders", "pct": 35.0, "expected_return": 16.2},
            {"asset": "Liquid / T-Bill Opportunity Reserve", "pct": 10.0, "expected_return": 6.8},
            {"asset": "Gold ETF Hedge", "pct": 5.0, "expected_return": 8.5},
        ],
        "blended_mu": 0.139,
        "blended_sigma": 0.152,
    },
    "conservative": {
        "label": "Conservative (45% NSE Equity / 40% India Debt / 15% Gold)",
        "allocation": [
            {"asset": "Core QGLP / Coffee-Can Compounders", "pct": 30.0, "expected_return": 13.5},
            {"asset": "GARP Value Leaders", "pct": 15.0, "expected_return": 15.0},
            {"asset": "India G-Sec / Corporate Bond Fund", "pct": 40.0, "expected_return": 7.2},
            {"asset": "Gold ETF / Sovereign Gold", "pct": 15.0, "expected_return": 8.5},
        ],
        "blended_mu": 0.104,
        "blended_sigma": 0.088,
    },
}


def _classify_portfolio_role(stock: Dict[str, Any]) -> str:
    p = stock["pillars"]
    m = stock["metrics"]
    if stock["is_financial"]:
        return "Core Financial Compounder"
    if p["quality"] >= 78 and m["debt_to_equity"] <= 0.35:
        return "Fortress Moat Compounder"
    if p["growth"] >= 72 and m["peg_ratio"] <= 1.8:
        return "GARP Growth Leader"
    if p["value"] >= 72:
        return "High-Cash-Yield Value Anchor"
    return "Quality Sector Leader"


def _build_why_buy_memo(stock: Dict[str, Any]) -> str:
    m = stock["metrics"]
    stab = int(m.get("moat_stability_score", 70))
    if stock["is_financial"]:
        npa_str = f", NNPA {m['nnpa_pct']}%" if m.get("gnpa_pct", 0) > 0 else ""
        cap_str = f"5Y Med ROE {m['med_5y_roce_pct']}% (Floor {m.get('cycle_floor_roce_pct', m['med_5y_roce_pct'])}%{npa_str})"
    else:
        cap_str = (
            f"5Y Med ROCE {m['med_5y_roce_pct']}% (8Y Stab {stab}/100, D/E {m['debt_to_equity']}x)"
        )
    qtr_str = (
        f"2Q PAT {m['qtr_pat_yoy_pct']:+.1f}% YoY"
        if m.get("latest_qtr_label")
        else f"5Y PAT CAGR {m['pat_cagr_5y_pct']}%"
    )
    inst_chg = m.get("inst_chg_1y_pct", 0.0)
    own_str = f"4Q Inst {inst_chg:+.1f}%" if inst_chg != 0.0 else f"Piotroski {m['piotroski_f_score']}/9"
    return (
        f"{cap_str} • {qtr_str} • "
        f"P/E {m['pe_ratio']}x (Fair ~{m['fair_pe']}x, PEG {m['peg_ratio']}x) • "
        f"{own_str}"
    )


def build_investment_plan(
    ranked_stocks: List[Dict[str, Any]],
    lump_sum_inr: float,
    monthly_sip_inr: float,
    horizon_years: int,
    target_corpus_inr: float,
    risk_profile: str = "equity_direct",
    max_stocks: int = 8,
) -> Dict[str, Any]:
    prof = RISK_PROFILES.get(risk_profile, RISK_PROFILES["equity_direct"])
    equity_share = (
        sum(
            a["pct"]
            for a in prof["allocation"]
            if any(k in a["asset"] for k in ("Compounders", "Leaders", "Equity"))
        )
        / 100.0
    )

    equity_lump_inr = lump_sum_inr * equity_share
    equity_sip_inr = monthly_sip_inr * equity_share

    # Strict Long-Term Selection Filter:
    # Pass 1: Non-cyclical Strong Buy / Buy compounders with Quality >= 58, Moat Stability >= 52, max 2 per sector
    # Pass 2: Allow remaining Strong Buy / Buy (max 1 cyclical stock total so commodities never dominate)
    # Pass 3: Relax if universe is small
    tier1 = [
        s
        for s in ranked_stocks
        if s["rating"] in {"Strong Buy", "Buy"}
        and s["pillars"]["quality"] >= 58.0
        and s["metrics"].get("moat_stability_score", 70) >= 52
        and not s.get("is_cyclical", False)
    ]
    tier2 = [s for s in ranked_stocks if s["rating"] in {"Strong Buy", "Buy"} and s not in tier1]
    tier3 = [s for s in ranked_stocks if s["rating"] != "Avoid" and s not in tier1 and s not in tier2]

    selected: List[Dict[str, Any]] = []
    sector_counts: Dict[str, int] = {}
    cyclical_count = 0
    max_per_sector = 2 if max_stocks <= 10 else 3

    for pool, sec_cap, cyc_cap in ((tier1, max_per_sector, 0), (tier2, max_per_sector, 1), (tier1 + tier2 + tier3, max_per_sector + 1, 2)):
        if len(selected) >= max_stocks:
            break
        for stock in pool:
            if stock in selected:
                continue
            if equity_lump_inr > 0 and float(stock["price"]) > equity_lump_inr * 0.22:
                continue
            if stock.get("is_cyclical", False) and cyclical_count >= cyc_cap:
                continue
            sec = stock["sector"]
            if sector_counts.get(sec, 0) >= sec_cap:
                continue
            selected.append(stock)
            sector_counts[sec] = sector_counts.get(sec, 0) + 1
            if stock.get("is_cyclical", False):
                cyclical_count += 1
            if len(selected) >= max_stocks:
                break

    if selected:
        raw_w = np.array([max(12.0, float(s["composite_score"]) - 42.0) for s in selected], dtype=float)
        weights = raw_w / raw_w.sum()
        cap = max(0.16, 1.0 / len(selected) + 0.025)
        for _ in range(5):
            excess = np.maximum(0.0, weights - cap)
            if excess.sum() <= 1e-6:
                break
            weights = np.minimum(weights, cap)
            uncapped = weights < cap
            if uncapped.any():
                weights[uncapped] += excess.sum() * (weights[uncapped] / weights[uncapped].sum())
        weights = weights / weights.sum()
    else:
        weights = np.array([], dtype=float)

    stock_basket: List[Dict[str, Any]] = []
    sector_exposure: Dict[str, float] = {}
    deployed_equity_inr = 0.0
    immediate_tranche_inr = 0.0

    for idx, s in enumerate(selected):
        w = float(weights[idx])
        target_alloc = equity_lump_inr * w
        alloc_sip = equity_sip_inr * w
        px = max(1.0, float(s["price"]))
        remaining_budget = max(0.0, equity_lump_inr - deployed_equity_inr)
        shares_qty = int(math.floor(min(target_alloc * 1.03, remaining_budget) / px))
        if shares_qty * px > remaining_budget and shares_qty > 0:
            shares_qty = int(math.floor(remaining_budget / px))
        actual_inr = round(shares_qty * px, 0)
        deployed_equity_inr += actual_inr

        m = s["metrics"]
        if m["pe_ratio"] <= m["fair_pe"] * 1.08:
            entry_plan = f"Buy 100% Now ({shares_qty} sh)"
            immediate_tranche_inr += actual_inr
        else:
            now_sh = max(1, math.ceil(shares_qty * 0.6))
            later_sh = max(0, shares_qty - now_sh)
            entry_plan = (
                f"Stagger: {now_sh} sh Now + {later_sh} sh on 6-8% dip"
                if later_sh > 0
                else f"Buy {shares_qty} sh Now"
            )
            immediate_tranche_inr += round(now_sh * px, 0)

        sector_exposure[s["sector"]] = round(sector_exposure.get(s["sector"], 0.0) + w * 100.0, 1)

        stock_basket.append(
            {
                "ticker": s["ticker"],
                "name": s["name"],
                "sector": s["sector"],
                "role": _classify_portfolio_role(s),
                "rating": s["rating"],
                "composite_score": s["composite_score"],
                "price": s["price"],
                "fair_pe": m["fair_pe"],
                "pe_ratio": m["pe_ratio"],
                "equity_weight_pct": round(w * 100.0, 1),
                "total_portfolio_weight_pct": round(w * equity_share * 100.0, 1),
                "lump_sum_inr": actual_inr if equity_lump_inr > 0 else round(target_alloc, 0),
                "est_shares": shares_qty,
                "monthly_sip_inr": round(alloc_sip, 0),
                "entry_guidance": entry_plan,
                "why_buy": _build_why_buy_memo(s),
                "strength_highlight": s["strengths"][0] if s["strengths"] else "",
            }
        )

    unallocated_cash_inr = max(0.0, round(equity_lump_inr - deployed_equity_inr, 0))

    # 1,000-path monthly stochastic simulation for long-term horizon
    n_sims = 1000
    months = horizon_years * 12
    mu_m = (prof["blended_mu"] - 0.5 * (prof["blended_sigma"] ** 2)) / 12.0
    sig_m = prof["blended_sigma"] / math.sqrt(12.0)

    rng = np.random.default_rng(202611)
    shocks = rng.normal(loc=mu_m, scale=sig_m, size=(n_sims, months))
    growth_factors = np.exp(shocks)

    wealth_paths = np.full(n_sims, lump_sum_inr, dtype=float)
    projections: List[Dict[str, Any]] = [
        {
            "year": 0,
            "invested_inr": round(lump_sum_inr, 0),
            "bear_10_inr": round(lump_sum_inr, 0),
            "base_50_inr": round(lump_sum_inr, 0),
            "bull_90_inr": round(lump_sum_inr, 0),
        }
    ]

    for m_idx in range(months):
        wealth_paths = wealth_paths * growth_factors[:, m_idx] + monthly_sip_inr
        if (m_idx + 1) % 12 == 0:
            yr = (m_idx + 1) // 12
            invested = lump_sum_inr + monthly_sip_inr * (m_idx + 1)
            p10, p50, p90 = np.percentile(wealth_paths, [10, 50, 90])
            projections.append(
                {
                    "year": yr,
                    "invested_inr": round(invested, 0),
                    "bear_10_inr": round(float(p10), 0),
                    "base_50_inr": round(float(p50), 0),
                    "bull_90_inr": round(float(p90), 0),
                }
            )

    goal_prob_pct = float(np.mean(wealth_paths >= target_corpus_inr) * 100.0)
    median_final = float(np.median(wealth_paths))
    total_invested = lump_sum_inr + monthly_sip_inr * months

    r_m = prof["blended_mu"] / 12.0
    fv_factor = (((1.0 + r_m) ** months - 1.0) / r_m) if r_m > 0 else float(months)
    shortfall_inr = max(0.0, target_corpus_inr - median_final)
    recommended_extra_sip = round(shortfall_inr / max(1.0, fv_factor), 0) if shortfall_inr > 0 else 0.0

    return {
        "profile_label": prof["label"],
        "expected_cagr_pct": round(prof["blended_mu"] * 100.0, 2),
        "expected_volatility_pct": round(prof["blended_sigma"] * 100.0, 2),
        "deployment_summary": {
            "total_lump_sum_inr": round(lump_sum_inr, 0),
            "equity_budget_inr": round(equity_lump_inr, 0),
            "deployed_in_shares_inr": round(deployed_equity_inr, 0),
            "immediate_tranche_inr": round(immediate_tranche_inr, 0),
            "staggered_dip_reserve_inr": max(0.0, round(deployed_equity_inr - immediate_tranche_inr, 0)),
            "residual_cash_inr": unallocated_cash_inr,
            "sectors_covered": len(sector_exposure),
        },
        "monitoring_rules": [
            "Weekly Check (4s Price Refresh): Only deploy staggered dip tranches if a shortlisted stock pulls back 6–8%; ignore normal weekly price noise.",
            "Quarterly / Annual Fundamental Review: Continue holding as long as Composite Score stays >= 50 and 5Y Median ROCE/ROE remains above 14–15%.",
            "Sell / Replace Trigger: Exit only if a forensic red flag appears (PAT turns negative, corporate D/E > 1.8x, or Score drops below 45) or valuation stretches past 2.5x Fair P/E.",
        ],
        "asset_allocation": [
            {
                **item,
                "lump_sum_inr": round(lump_sum_inr * (item["pct"] / 100.0), 0),
                "monthly_sip_inr": round(monthly_sip_inr * (item["pct"] / 100.0), 0),
            }
            for item in prof["allocation"]
        ],
        "goal_summary": {
            "target_corpus_inr": round(target_corpus_inr, 0),
            "total_invested_inr": round(total_invested, 0),
            "median_corpus_inr": round(median_final, 0),
            "bear_10_corpus_inr": projections[-1]["bear_10_inr"],
            "bull_90_corpus_inr": projections[-1]["bull_90_inr"],
            "goal_probability_pct": round(goal_prob_pct, 1),
            "recommended_extra_sip_inr": recommended_extra_sip,
        },
        "stock_basket": stock_basket,
        "sector_exposure_pct": sector_exposure,
        "yearly_projections": projections,
    }
