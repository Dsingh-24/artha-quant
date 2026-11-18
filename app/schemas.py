"""Pydantic schemas enforcing strict input validation and allow-lists."""

from __future__ import annotations

import re
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

TICKER_RE = re.compile(r"^[A-Z0-9&-]{1,20}(\.(NS|BO))?$")

StrategyPreset = Literal[
    "qglp_compounder",
    "street_quant",
    "artha_blend",
    "coffee_can",
    "magic_formula",
    "value_momentum",
    "custom",
]

WeightingScheme = Literal["equal", "score", "inv_vol"]
RebalanceFrequency = Literal["quarterly", "semiannual", "annual"]
RiskProfile = Literal["equity_direct", "conservative", "moderate", "aggressive"]
MarketFilter = Literal["ALL", "IN", "US", "NASDAQ100", "SP500"]


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
    market: MarketFilter = "ALL"


class CompanyTickerQuery(BaseModel):
    ticker: str = Field(..., min_length=1, max_length=24)

    @field_validator("ticker")
    @classmethod
    def validate_ticker_symbol(cls, value: str) -> str:
        cleaned = value.strip().upper()
        if not TICKER_RE.match(cleaned):
            raise ValueError("Invalid NSE/BSE or Nasdaq ticker symbol.")
        return cleaned


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


class AiMemoScoreSummary(BaseModel):
    model_config = ConfigDict(extra="ignore")

    composite_score: Optional[float] = Field(default=None, ge=0.0, le=100.0)
    quality_score: Optional[float] = Field(default=None, ge=0.0, le=100.0)
    growth_score: Optional[float] = Field(default=None, ge=0.0, le=100.0)
    value_score: Optional[float] = Field(default=None, ge=0.0, le=100.0)
    momentum_score: Optional[float] = Field(default=None, ge=0.0, le=100.0)
    rank: Optional[int] = Field(default=None, ge=1, le=5000)


class AiMemoRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    ticker: str = Field(..., min_length=1, max_length=24)
    preset: StrategyPreset = "qglp_compounder"
    score_summary: Optional[AiMemoScoreSummary] = None

    @field_validator("ticker")
    @classmethod
    def validate_memo_ticker(cls, value: str) -> str:
        cleaned = value.strip().upper()
        if not TICKER_RE.match(cleaned):
            raise ValueError("Invalid NSE/BSE or US ticker symbol.")
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
    initial_capital: float = Field(default=500_000.0, ge=1_000.0, le=1_000_000_000.0)
    cost_bps: float = Field(default=25.0, ge=0.0, le=200.0)
    market: MarketFilter = "IN"


class PlannerRequest(BaseModel):
    plan_name: str = Field(default="₹5L Long-Term Portfolio", min_length=2, max_length=60)
    lump_sum_inr: float = Field(default=500_000.0, ge=0.0, le=1_000_000_000.0)
    monthly_sip_inr: float = Field(default=0.0, ge=0.0, le=50_000_000.0)
    horizon_years: int = Field(default=7, ge=1, le=40)
    target_corpus_inr: float = Field(default=1_500_000.0, ge=1_000.0, le=10_000_000_000.0)
    risk_profile: RiskProfile = "equity_direct"
    preset: StrategyPreset = "qglp_compounder"
    max_stocks: int = Field(default=8, ge=5, le=15)
    market: MarketFilter = "ALL"
    save_plan: bool = False


PaperCurrency = Literal["INR", "USD"]
PaperOrderSide = Literal["BUY", "SELL"]
PaperOrderType = Literal["MARKET", "LIMIT"]
ALLOWED_BENCHMARKS = {"^NSEI", "^GSPC", "^NDX"}


class PaperPortfolioCreateRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    name: str = Field(..., min_length=1, max_length=64)
    currency: PaperCurrency = "INR"
    initial_cash: float = Field(..., gt=0.0, le=10_000_000_000.0)
    strategy_preset: StrategyPreset = "qglp_compounder"
    benchmark_ticker: Optional[str] = Field(default=None, max_length=16)
    fee_bps: float = Field(default=25.0, ge=0.0, le=200.0)

    @field_validator("name")
    @classmethod
    def clean_portfolio_name(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Portfolio name cannot be blank.")
        return cleaned

    @field_validator("currency", mode="before")
    @classmethod
    def normalize_currency(cls, value: object) -> object:
        if isinstance(value, str):
            return value.strip().upper()
        return value

    @field_validator("strategy_preset", mode="before")
    @classmethod
    def normalize_preset(cls, value: object) -> object:
        if value is None or (isinstance(value, str) and not value.strip()):
            return "qglp_compounder"
        return value

    @field_validator("benchmark_ticker")
    @classmethod
    def validate_benchmark_symbol(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        cleaned = value.strip().upper()
        if not cleaned:
            return None
        if cleaned not in ALLOWED_BENCHMARKS:
            raise ValueError("Unsupported benchmark_ticker; expected ^NSEI, ^GSPC, or ^NDX.")
        return cleaned


class PaperDepositRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    amount: float = Field(..., gt=0.0, le=10_000_000_000.0)


class PaperOrderRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    portfolio_id: str = Field(..., min_length=1, max_length=64)
    ticker: str = Field(default="", max_length=128)
    side: PaperOrderSide
    order_type: PaperOrderType = "MARKET"
    shares: int = Field(..., gt=0, le=10_000_000)
    limit_price: Optional[float] = Field(default=None, gt=0.0, le=100_000_000.0)
    note: str = Field(default="", max_length=160)

    @field_validator("side", "order_type", mode="before")
    @classmethod
    def normalize_enum_str(cls, value: object) -> object:
        if isinstance(value, str):
            return value.strip().upper()
        return value

    @field_validator("note", mode="before")
    @classmethod
    def normalize_note(cls, value: object) -> str:
        if value is None:
            return ""
        return str(value).strip()[:160]


class PaperBasketItem(BaseModel):
    model_config = ConfigDict(extra="ignore")

    ticker: str = Field(default="", max_length=128)
    market_shares: int = Field(default=0, ge=0, le=10_000_000)
    dip_shares: int = Field(default=0, ge=0, le=10_000_000)
    dip_pct: float = Field(default=7.0, gt=0.0, le=50.0)
    note: str = Field(default="", max_length=160)

    @field_validator("dip_shares", mode="before")
    @classmethod
    def normalize_dip_shares(cls, value: object) -> object:
        return 0 if value is None else value

    @field_validator("dip_pct", mode="before")
    @classmethod
    def normalize_dip_pct(cls, value: object) -> object:
        return 7.0 if value is None else value

    @field_validator("note", mode="before")
    @classmethod
    def normalize_basket_note(cls, value: object) -> str:
        if value is None:
            return ""
        return str(value).strip()[:160]


class PaperDeployBasketRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    portfolio_id: str = Field(..., min_length=1, max_length=64)
    items: list[PaperBasketItem] = Field(..., min_length=1, max_length=30)


class PaperRefreshRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    portfolio_id: Optional[str] = Field(default=None, max_length=64)
