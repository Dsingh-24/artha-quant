"""Point-in-Time Historical Backtesting Engine for NSE Multi-Factor Strategies.

Key institutional features:
- Zero look-ahead bias: Calls `score_universe_point_in_time` at each rebalance date,
  which enforces `reported_date <= rebalance_date` (60-day SEBI LODR filing lag).
- Realistic Indian market friction: Applies turnover-proportional transaction cost & slippage
  (`cost_bps`, covering 10 bps delivery STT, GST, SEBI/NSE fees, and bid-ask impact).
- Benchmarks against Nifty 50 (`^NSEI`) using a 6.8% India 10Y G-Sec risk-free rate.
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd

from app.factors import score_universe_point_in_time
from app.universe import BENCHMARK_TICKER

INDIA_RISK_FREE_RATE = 0.068  # ~6.8% 10Y Government of India G-Sec yield

REBALANCE_STEP_DAYS = {
    "quarterly": 63,
    "semiannual": 126,
    "annual": 252,
}


def _compute_weights(selected: List[Dict[str, Any]], scheme: str) -> Dict[str, float]:
    if not selected:
        return {}
    n = len(selected)
    if scheme == "score":
        raw = {s["ticker"]: max(5.0, float(s["composite_score"]) - 40.0) ** 1.4 for s in selected}
    elif scheme == "inv_vol":
        raw = {s["ticker"]: 1.0 / max(12.0, float(s["metrics"]["volatility_pct"])) for s in selected}
    else:
        raw = {s["ticker"]: 1.0 / n for s in selected}

    tot = sum(raw.values())
    return {k: v / tot for k, v in raw.items()}


def _max_drawdown_series(nav: pd.Series) -> pd.Series:
    running_max = nav.cummax()
    return (nav / running_max - 1.0) * 100.0


def run_point_in_time_backtest(
    companies: List[Dict[str, Any]],
    fundamentals_df: pd.DataFrame,
    price_matrix: pd.DataFrame,
    preset: str = "artha_blend",
    custom_weights: Optional[Dict[str, float]] = None,
    lookback_years: int = 5,
    top_n: int = 10,
    rebalance: str = "quarterly",
    weighting: str = "equal",
    initial_capital: float = 1_000_000.0,
    cost_bps: float = 25.0,
) -> Dict[str, Any]:
    if price_matrix.empty or BENCHMARK_TICKER not in price_matrix.columns:
        raise ValueError("Insufficient market & Nifty 50 benchmark price history for backtest.")

    all_dates = list(price_matrix.index)
    target_days = lookback_years * 252
    if len(all_dates) <= target_days + 65:
        start_idx = min(252, max(65, len(all_dates) // 5))
    else:
        start_idx = len(all_dates) - target_days

    sim_dates = all_dates[start_idx:]
    if len(sim_dates) < 60:
        raise ValueError("Backtest window requires at least 60 trading sessions.")

    step = REBALANCE_STEP_DAYS.get(rebalance, 63)
    rebal_indices = list(range(0, len(sim_dates) - 1, step))

    daily_ret_matrix = price_matrix.pct_change().fillna(0.0)
    port_daily_rets = np.zeros(len(sim_dates), dtype=float)
    bm_daily_rets = daily_ret_matrix.loc[sim_dates, BENCHMARK_TICKER].to_numpy(dtype=float)
    bm_daily_rets[0] = 0.0

    prev_weights: Dict[str, float] = {}
    rebalance_log: List[Dict[str, Any]] = []
    latest_holdings: List[Dict[str, Any]] = []

    for idx_pos, reb_offset in enumerate(rebal_indices):
        reb_date = sim_dates[reb_offset]
        next_offset = rebal_indices[idx_pos + 1] if idx_pos + 1 < len(rebal_indices) else len(sim_dates) - 1

        ranked = score_universe_point_in_time(
            companies=companies,
            fundamentals_df=fundamentals_df,
            price_matrix=price_matrix,
            as_of_date=reb_date,
            preset=preset,
            custom_weights=custom_weights,
        )
        # Exclude severe forensic red-flag / Avoid names when sufficient Buy/Hold candidates exist
        investable = [r for r in ranked if r["rating"] != "Avoid"]
        if len(investable) < top_n:
            investable = ranked
        selected = investable[:top_n]
        new_weights = _compute_weights(selected, weighting)

        # Compute one-way turnover & deduct transaction cost + slippage on rebalance day
        universe_keys = set(prev_weights.keys()) | set(new_weights.keys())
        one_way_turnover = 0.5 * sum(abs(new_weights.get(k, 0.0) - prev_weights.get(k, 0.0)) for k in universe_keys)
        if not prev_weights:
            one_way_turnover = 1.0  # Initial deployment cost
        rebal_cost_drag = one_way_turnover * (cost_bps / 10_000.0)

        # Simulate daily drifting weights across holding interval (reb_offset + 1 .. next_offset)
        slice_dates = sim_dates[reb_offset + 1 : next_offset + 1]
        if slice_dates and new_weights:
            tickers = list(new_weights.keys())
            w_vec = np.array([new_weights[t] for t in tickers], dtype=float)
            sub_rets = daily_ret_matrix.loc[slice_dates, tickers].to_numpy(dtype=float)

            cur_w = w_vec.copy()
            period_port_cum = 1.0
            for d_i in range(len(slice_dates)):
                day_r = float(np.dot(cur_w, sub_rets[d_i]))
                if d_i == 0:
                    day_r -= rebal_cost_drag
                port_daily_rets[reb_offset + 1 + d_i] = day_r
                period_port_cum *= 1.0 + day_r
                grown = cur_w * (1.0 + sub_rets[d_i])
                s_grown = float(grown.sum())
                if s_grown > 0:
                    cur_w = grown / s_grown

            bm_slice = bm_daily_rets[reb_offset + 1 : next_offset + 1]
            period_bm_cum = float(np.prod(1.0 + bm_slice))
            rebalance_log.append(
                {
                    "rebalance_date": reb_date,
                    "end_date": sim_dates[next_offset],
                    "top_picks": [s["ticker"].replace(".NS", "") for s in selected[:5]],
                    "holdings_count": len(selected),
                    "turnover_pct": round(one_way_turnover * 100.0, 1),
                    "period_return_pct": round((period_port_cum - 1.0) * 100.0, 2),
                    "benchmark_return_pct": round((period_bm_cum - 1.0) * 100.0, 2),
                    "excess_return_pct": round((period_port_cum - period_bm_cum) * 100.0, 2),
                }
            )

        prev_weights = new_weights
        if idx_pos == len(rebal_indices) - 1:
            latest_holdings = [
                {
                    "ticker": s["ticker"],
                    "name": s["name"],
                    "sector": s["sector"],
                    "weight_pct": round(new_weights.get(s["ticker"], 0.0) * 100.0, 2),
                    "composite_score": s["composite_score"],
                    "rating": s["rating"],
                }
                for s in selected
            ]

    port_nav = pd.Series(initial_capital * np.cumprod(1.0 + port_daily_rets), index=sim_dates)
    bm_nav = pd.Series(initial_capital * np.cumprod(1.0 + bm_daily_rets), index=sim_dates)

    port_dd = _max_drawdown_series(port_nav)
    bm_dd = _max_drawdown_series(bm_nav)

    years_elapsed = max(0.25, len(sim_dates) / 252.0)
    port_cagr = ((float(port_nav.iloc[-1]) / initial_capital) ** (1.0 / years_elapsed) - 1.0) * 100.0
    bm_cagr = ((float(bm_nav.iloc[-1]) / initial_capital) ** (1.0 / years_elapsed) - 1.0) * 100.0

    rf_daily = INDIA_RISK_FREE_RATE / 252.0
    port_ret_s = pd.Series(port_daily_rets[1:])
    bm_ret_s = pd.Series(bm_daily_rets[1:])

    port_vol = float(port_ret_s.std() * math.sqrt(252.0) * 100.0) if len(port_ret_s) > 5 else 15.0
    bm_vol = float(bm_ret_s.std() * math.sqrt(252.0) * 100.0) if len(bm_ret_s) > 5 else 15.0

    excess_daily = port_ret_s - rf_daily
    sharpe = float((excess_daily.mean() / max(1e-8, port_ret_s.std())) * math.sqrt(252.0))
    bm_sharpe = float(((bm_ret_s - rf_daily).mean() / max(1e-8, bm_ret_s.std())) * math.sqrt(252.0))

    downside = port_ret_s[port_ret_s < rf_daily] - rf_daily
    downside_dev = float(math.sqrt((downside**2).mean()) * math.sqrt(252.0)) if len(downside) > 0 else 0.10
    sortino = ((port_cagr / 100.0) - INDIA_RISK_FREE_RATE) / max(0.01, downside_dev)

    max_dd = float(port_dd.min())
    bm_max_dd = float(bm_dd.min())
    calmar = (port_cagr / abs(max_dd)) if max_dd < -0.5 else 0.0

    cov_mat = np.cov(port_ret_s.to_numpy(), bm_ret_s.to_numpy())
    beta = float(cov_mat[0, 1] / max(1e-9, cov_mat[1, 1])) if cov_mat.shape == (2, 2) else 1.0
    active_daily = port_ret_s - bm_ret_s
    info_ratio = float((active_daily.mean() / max(1e-8, active_daily.std())) * math.sqrt(252.0))

    wins = sum(1 for r in rebalance_log if r["excess_return_pct"] > 0)
    win_rate = (wins / max(1, len(rebalance_log))) * 100.0

    # Downsample time series to ~180 points for crisp SVG rendering while always keeping endpoints
    stride = max(1, len(sim_dates) // 180)
    sample_idx = sorted(set(list(range(0, len(sim_dates), stride)) + [len(sim_dates) - 1]))

    curve = [
        {
            "date": sim_dates[i],
            "portfolio_nav": round(float(port_nav.iloc[i]), 0),
            "benchmark_nav": round(float(bm_nav.iloc[i]), 0),
            "portfolio_dd_pct": round(float(port_dd.iloc[i]), 2),
            "benchmark_dd_pct": round(float(bm_dd.iloc[i]), 2),
        }
        for i in sample_idx
    ]

    return {
        "summary": {
            "start_date": sim_dates[0],
            "end_date": sim_dates[-1],
            "years_tested": round(years_elapsed, 2),
            "initial_capital_inr": round(initial_capital, 0),
            "final_portfolio_inr": round(float(port_nav.iloc[-1]), 0),
            "final_benchmark_inr": round(float(bm_nav.iloc[-1]), 0),
            "portfolio_cagr_pct": round(port_cagr, 2),
            "benchmark_cagr_pct": round(bm_cagr, 2),
            "alpha_annual_pct": round(port_cagr - bm_cagr, 2),
            "sharpe_ratio": round(sharpe, 2),
            "benchmark_sharpe": round(bm_sharpe, 2),
            "sortino_ratio": round(sortino, 2),
            "calmar_ratio": round(calmar, 2),
            "max_drawdown_pct": round(max_dd, 2),
            "benchmark_max_dd_pct": round(bm_max_dd, 2),
            "volatility_pct": round(port_vol, 2),
            "benchmark_vol_pct": round(bm_vol, 2),
            "beta": round(beta, 2),
            "information_ratio": round(info_ratio, 2),
            "win_rate_pct": round(win_rate, 1),
            "risk_free_rate_pct": round(INDIA_RISK_FREE_RATE * 100.0, 1),
            "reporting_lag_days": 60,
        },
        "equity_curve": curve,
        "rebalance_log": list(reversed(rebalance_log)),
        "latest_holdings": latest_holdings,
    }
