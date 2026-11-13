"""Pydantic schemas enforcing strict input validation and allow-lists."""

from __future__ import annotations

import re
from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator

TICKER_RE = re.compile(r"^[A-Z0-9&-]{1,20}(\.(NS|BO))?$")

StrategyPreset = Literal[
    "qglp_compounder",
    "artha_blend",
    "coffee_can",
    "magic_formula",
    "value_momentum",
    "custom",
]

WeightingScheme = Literal["equal", "score", "inv_vol"]
RebalanceFrequency = Literal["quarterly", "semiannual", "annual"]
RiskProfile = Literal["equity_direct", "conservative", "moderate", "aggressive"]


class AuthCredentials(BaseModel):
    username: str = Field(..., min_length=3, max_length=32, pattern=r"^[a-zA-Z0-9_.-]+$")
    password: str = Field(..., min_length=8, max_length=128)


class FactorWeights(BaseModel):
    quality: float = Field(default=45.0, ge=0.0, le=100.0)
    value: float = Field(default=20.0, ge=0.0, le=100.0)
    growth: float = Field(default=25.0, ge=0.0, le=100.0)
    momentum: float = Field(default=10.0, ge=0.0, le=100.0)


class ScreenerRequest(BaseModel):
    preset: StrategyPreset = "qglp_compounder"
    weights: Optional[FactorWeights] = None
    sector: str = Field(default="ALL", max_length=50)
    min_score: float = Field(default=0.0, ge=0.0, le=100.0)


class TickerSyncRequest(BaseModel):
    ticker: str = Field(..., min_length=1, max_length=24)

    @field_validator("ticker")
    @classmethod
    def normalize_and_validate_ticker(cls, value: str) -> str:
        cleaned = value.strip().upper()
        if not cleaned.endswith((".NS", ".BO")):
            cleaned = f"{cleaned}.NS"
        if not TICKER_RE.match(cleaned):
            raise ValueError("Invalid NSE/BSE ticker symbol.")
        return cleaned


class FunnelRefreshRequest(BaseModel):
    shortlist_top_n: int = Field(default=80, ge=15, le=200)


class FunnelExpandRequest(BaseModel):
    batch_size: int = Field(default=30, ge=5, le=150)


class BacktestRequest(BaseModel):
    preset: StrategyPreset = "qglp_compounder"
    weights: Optional[FactorWeights] = None
    lookback_years: int = Field(default=5, ge=2, le=5)
    top_n: int = Field(default=10, ge=3, le=20)
    rebalance: RebalanceFrequency = "annual"
    weighting: WeightingScheme = "equal"
    initial_capital: float = Field(default=500_000.0, ge=50_000.0, le=1_000_000_000.0)
    cost_bps: float = Field(default=25.0, ge=0.0, le=200.0)


class PlannerRequest(BaseModel):
    plan_name: str = Field(default="₹5L Long-Term Portfolio", min_length=2, max_length=60)
    lump_sum_inr: float = Field(default=500_000.0, ge=0.0, le=1_000_000_000.0)
    monthly_sip_inr: float = Field(default=0.0, ge=0.0, le=50_000_000.0)
    horizon_years: int = Field(default=7, ge=1, le=40)
    target_corpus_inr: float = Field(default=1_500_000.0, ge=50_000.0, le=10_000_000_000.0)
    risk_profile: RiskProfile = "equity_direct"
    preset: StrategyPreset = "qglp_compounder"
    max_stocks: int = Field(default=8, ge=5, le=15)
    save_plan: bool = False
