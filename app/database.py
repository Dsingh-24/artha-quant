"""Parameterized SQLite storage layer for users, sessions, 2-stage funnel, fundamentals, prices, and plans.

Security guarantees:
- Strictly parameterized SQL statements (`?` placeholders) — zero string interpolation.
- Resource ownership verified by `user_id` directly inside SQL `WHERE` clauses.
- Session hashes stored (never plaintext session IDs) with strict expiration checks.
"""

from __future__ import annotations

import json
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Dict, Iterable, Iterator, List, Optional, Tuple

DEFAULT_DB_PATH = Path(__file__).resolve().parent.parent / "data" / "arthaquant.db"

# TODO(security): When migrating from embedded SQLite to networked PostgreSQL/MySQL in production,
# enforce mTLS connections and separate least-privilege DB users (SELECT-only reader vs writer).


class Database:
    def __init__(self, db_path: Path = DEFAULT_DB_PATH) -> None:
        self.db_path = db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(str(self.db_path), timeout=20.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON;")
        conn.execute("PRAGMA journal_mode = WAL;")
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def _init_schema(self) -> None:
        with self.connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT NOT NULL UNIQUE,
                    password_hash TEXT NOT NULL,
                    role TEXT NOT NULL DEFAULT 'advisor',
                    is_active INTEGER NOT NULL DEFAULT 1,
                    created_at INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS sessions (
                    session_hash TEXT PRIMARY KEY,
                    user_id INTEGER NOT NULL,
                    csrf_token TEXT NOT NULL,
                    expires_at INTEGER NOT NULL,
                    created_at INTEGER NOT NULL,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS companies (
                    ticker TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    sector TEXT NOT NULL,
                    cap_tier TEXT NOT NULL DEFAULT 'Large/Mid Cap',
                    is_financial INTEGER NOT NULL DEFAULT 0,
                    promoter_pct REAL NOT NULL DEFAULT 0.0,
                    inst_pct REAL NOT NULL DEFAULT 0.0,
                    data_source TEXT NOT NULL DEFAULT 'real_nse_live',
                    updated_at INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS stage1_funnel (
                    ticker TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    sector TEXT NOT NULL,
                    industry TEXT NOT NULL DEFAULT '',
                    last_price REAL NOT NULL DEFAULT 0.0,
                    ret_6m_pct REAL NOT NULL DEFAULT 0.0,
                    mom_12_1_pct REAL NOT NULL DEFAULT 0.0,
                    volatility_pct REAL NOT NULL DEFAULT 0.0,
                    dist_52w_high_pct REAL NOT NULL DEFAULT 0.0,
                    above_200dma INTEGER NOT NULL DEFAULT 0,
                    avg_turnover_cr REAL NOT NULL DEFAULT 0.0,
                    stage1_score REAL NOT NULL DEFAULT 0.0,
                    stage1_rank INTEGER NOT NULL DEFAULT 999,
                    shortlisted INTEGER NOT NULL DEFAULT 0,
                    deep_scored INTEGER NOT NULL DEFAULT 0,
                    updated_at INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS fundamentals_annual (
                    ticker TEXT NOT NULL,
                    fiscal_year INTEGER NOT NULL,
                    period_end TEXT NOT NULL,
                    reported_date TEXT NOT NULL,
                    revenue_cr REAL NOT NULL,
                    ebitda_cr REAL NOT NULL,
                    ebit_cr REAL NOT NULL,
                    net_profit_cr REAL NOT NULL,
                    cfo_cr REAL NOT NULL,
                    fcf_cr REAL NOT NULL,
                    total_assets_cr REAL NOT NULL,
                    total_equity_cr REAL NOT NULL,
                    total_debt_cr REAL NOT NULL,
                    current_assets_cr REAL NOT NULL,
                    current_liabilities_cr REAL NOT NULL,
                    shares_cr REAL NOT NULL,
                    roce_pct REAL NOT NULL,
                    roe_pct REAL NOT NULL,
                    op_margin_pct REAL NOT NULL,
                    debt_to_equity REAL NOT NULL,
                    cfo_to_ebitda_pct REAL NOT NULL,
                    PRIMARY KEY (ticker, fiscal_year),
                    FOREIGN KEY (ticker) REFERENCES companies(ticker) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS daily_prices (
                    ticker TEXT NOT NULL,
                    trade_date TEXT NOT NULL,
                    close_price REAL NOT NULL,
                    volume REAL NOT NULL DEFAULT 0,
                    PRIMARY KEY (ticker, trade_date)
                );

                CREATE INDEX IF NOT EXISTS idx_prices_date ON daily_prices(trade_date);
                CREATE INDEX IF NOT EXISTS idx_fund_reported ON fundamentals_annual(reported_date);

                CREATE TABLE IF NOT EXISTS saved_plans (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    plan_name TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS company_quarterly_signals (
                    ticker TEXT PRIMARY KEY,
                    latest_qtr_label TEXT NOT NULL DEFAULT '',
                    signals_reported_date TEXT NOT NULL DEFAULT '1970-01-01',
                    ttm_rev_cr REAL NOT NULL DEFAULT 0.0,
                    ttm_pat_cr REAL NOT NULL DEFAULT 0.0,
                    qtr_rev_yoy_pct REAL NOT NULL DEFAULT 0.0,
                    qtr_pat_yoy_pct REAL NOT NULL DEFAULT 0.0,
                    qtr_opm_delta_pct REAL NOT NULL DEFAULT 0.0,
                    promoter_chg_1y_pct REAL NOT NULL DEFAULT 0.0,
                    inst_chg_1y_pct REAL NOT NULL DEFAULT 0.0,
                    gnpa_pct REAL NOT NULL DEFAULT 0.0,
                    nnpa_pct REAL NOT NULL DEFAULT 0.0,
                    has_qtr_data INTEGER NOT NULL DEFAULT 0,
                    has_sh_trend INTEGER NOT NULL DEFAULT 0,
                    updated_at INTEGER NOT NULL,
                    FOREIGN KEY (ticker) REFERENCES companies(ticker) ON DELETE CASCADE
                );
                """
            )
            # Ensure backward-compatible migration if existing DB lacks promoter_pct / inst_pct
            cols = {r["name"] for r in conn.execute("PRAGMA table_info(companies)").fetchall()}
            if "promoter_pct" not in cols:
                conn.execute("ALTER TABLE companies ADD COLUMN promoter_pct REAL NOT NULL DEFAULT 0.0")
            if "inst_pct" not in cols:
                conn.execute("ALTER TABLE companies ADD COLUMN inst_pct REAL NOT NULL DEFAULT 0.0")

    # --- User & Session Management ---

    def count_users(self) -> int:
        with self.connect() as conn:
            row = conn.execute("SELECT COUNT(*) AS cnt FROM users WHERE is_active = 1").fetchone()
            return int(row["cnt"]) if row else 0

    def create_user(self, username: str, password_hash: str, role: str = "advisor") -> int:
        now = int(time.time())
        with self.connect() as conn:
            cur = conn.execute(
                "INSERT INTO users (username, password_hash, role, is_active, created_at) VALUES (?, ?, ?, 1, ?)",
                (username, password_hash, role, now),
            )
            return int(cur.lastrowid)

    def get_user_by_username(self, username: str) -> Optional[Dict[str, Any]]:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT id, username, password_hash, role, is_active FROM users WHERE username = ?",
                (username,),
            ).fetchone()
            return dict(row) if row else None

    def create_session(self, session_hash: str, user_id: int, csrf_token: str, ttl_seconds: int) -> None:
        now = int(time.time())
        expires_at = now + ttl_seconds
        with self.connect() as conn:
            conn.execute("DELETE FROM sessions WHERE expires_at <= ?", (now,))
            conn.execute(
                "INSERT INTO sessions (session_hash, user_id, csrf_token, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
                (session_hash, user_id, csrf_token, expires_at, now),
            )

    def get_active_session(self, session_hash: str) -> Optional[Dict[str, Any]]:
        now = int(time.time())
        with self.connect() as conn:
            row = conn.execute(
                """
                SELECT s.session_hash, s.user_id, s.csrf_token, s.expires_at,
                       u.username, u.role, u.is_active
                FROM sessions s
                JOIN users u ON u.id = s.user_id
                WHERE s.session_hash = ? AND s.expires_at > ? AND u.is_active = 1
                """,
                (session_hash, now),
            ).fetchone()
            return dict(row) if row else None

    def invalidate_all_user_sessions(self, user_id: int) -> None:
        with self.connect() as conn:
            conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))

    # --- Market, Funnel & Fundamental Data ---

    def purge_synthetic_seed_data(self) -> None:
        """Remove any synthetic `calibrated_nse` rows and stale benchmark prices while preserving users."""
        with self.connect() as conn:
            syn_cnt = conn.execute(
                "SELECT COUNT(*) AS cnt FROM companies WHERE data_source = ?",
                ("calibrated_nse",),
            ).fetchone()["cnt"]
            conn.execute("DELETE FROM companies WHERE data_source = ?", ("calibrated_nse",))
            if syn_cnt > 0:
                conn.execute("DELETE FROM daily_prices WHERE ticker = ?", ("^NSEI",))
            conn.execute(
                "DELETE FROM daily_prices WHERE ticker NOT IN (SELECT ticker FROM companies) AND ticker != ?",
                ("^NSEI",),
            )

    def count_companies(self) -> int:
        with self.connect() as conn:
            row = conn.execute("SELECT COUNT(*) AS cnt FROM companies").fetchone()
            return int(row["cnt"]) if row else 0

    def count_deep_scored_companies(self) -> int:
        with self.connect() as conn:
            row = conn.execute("SELECT COUNT(DISTINCT ticker) AS cnt FROM fundamentals_annual").fetchone()
            return int(row["cnt"]) if row else 0

    def upsert_company(
        self,
        ticker: str,
        name: str,
        sector: str,
        cap_tier: str,
        is_financial: bool,
        data_source: str,
        promoter_pct: float = 0.0,
        inst_pct: float = 0.0,
    ) -> None:
        now = int(time.time())
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO companies (
                    ticker, name, sector, cap_tier, is_financial, promoter_pct, inst_pct, data_source, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(ticker) DO UPDATE SET
                    name = excluded.name,
                    sector = excluded.sector,
                    cap_tier = excluded.cap_tier,
                    is_financial = excluded.is_financial,
                    promoter_pct = CASE WHEN excluded.promoter_pct > 0 THEN excluded.promoter_pct ELSE companies.promoter_pct END,
                    inst_pct = CASE WHEN excluded.inst_pct > 0 THEN excluded.inst_pct ELSE companies.inst_pct END,
                    data_source = excluded.data_source,
                    updated_at = excluded.updated_at
                """,
                (ticker, name, sector, cap_tier, 1 if is_financial else 0, round(promoter_pct, 2), round(inst_pct, 2), data_source, now),
            )

    def upsert_stage1_funnel(self, rows: Iterable[Tuple[Any, ...]]) -> None:
        with self.connect() as conn:
            conn.executemany(
                """
                INSERT INTO stage1_funnel (
                    ticker, name, sector, industry, last_price, ret_6m_pct, mom_12_1_pct,
                    volatility_pct, dist_52w_high_pct, above_200dma, avg_turnover_cr,
                    stage1_score, stage1_rank, shortlisted, deep_scored, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(ticker) DO UPDATE SET
                    name = excluded.name,
                    sector = excluded.sector,
                    industry = excluded.industry,
                    last_price = excluded.last_price,
                    ret_6m_pct = excluded.ret_6m_pct,
                    mom_12_1_pct = excluded.mom_12_1_pct,
                    volatility_pct = excluded.volatility_pct,
                    dist_52w_high_pct = excluded.dist_52w_high_pct,
                    above_200dma = excluded.above_200dma,
                    avg_turnover_cr = excluded.avg_turnover_cr,
                    stage1_score = excluded.stage1_score,
                    stage1_rank = excluded.stage1_rank,
                    shortlisted = MAX(stage1_funnel.shortlisted, excluded.shortlisted),
                    deep_scored = MAX(stage1_funnel.deep_scored, excluded.deep_scored),
                    updated_at = excluded.updated_at
                """,
                list(rows),
            )

    def mark_funnel_deep_scored(self, ticker: str) -> None:
        now = int(time.time())
        with self.connect() as conn:
            conn.execute(
                "UPDATE stage1_funnel SET deep_scored = 1, shortlisted = 1, updated_at = ? WHERE ticker = ?",
                (now, ticker),
            )

    def get_stage1_funnel(self) -> List[Dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM stage1_funnel ORDER BY stage1_rank ASC, stage1_score DESC"
            ).fetchall()
            return [dict(r) for r in rows]

    def get_next_unscored_funnel_tickers(self, limit: int = 25) -> List[Dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT ticker, name, sector FROM stage1_funnel WHERE deep_scored = 0 ORDER BY stage1_rank ASC LIMIT ?",
                (limit,),
            ).fetchall()
            return [dict(r) for r in rows]

    def upsert_fundamentals(self, rows: Iterable[Tuple[Any, ...]]) -> None:
        with self.connect() as conn:
            conn.executemany(
                """
                INSERT INTO fundamentals_annual (
                    ticker, fiscal_year, period_end, reported_date,
                    revenue_cr, ebitda_cr, ebit_cr, net_profit_cr, cfo_cr, fcf_cr,
                    total_assets_cr, total_equity_cr, total_debt_cr,
                    current_assets_cr, current_liabilities_cr, shares_cr,
                    roce_pct, roe_pct, op_margin_pct, debt_to_equity, cfo_to_ebitda_pct
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(ticker, fiscal_year) DO UPDATE SET
                    period_end = excluded.period_end,
                    reported_date = excluded.reported_date,
                    revenue_cr = excluded.revenue_cr,
                    ebitda_cr = excluded.ebitda_cr,
                    ebit_cr = excluded.ebit_cr,
                    net_profit_cr = excluded.net_profit_cr,
                    cfo_cr = excluded.cfo_cr,
                    fcf_cr = excluded.fcf_cr,
                    total_assets_cr = excluded.total_assets_cr,
                    total_equity_cr = excluded.total_equity_cr,
                    total_debt_cr = excluded.total_debt_cr,
                    current_assets_cr = excluded.current_assets_cr,
                    current_liabilities_cr = excluded.current_liabilities_cr,
                    shares_cr = excluded.shares_cr,
                    roce_pct = excluded.roce_pct,
                    roe_pct = excluded.roe_pct,
                    op_margin_pct = excluded.op_margin_pct,
                    debt_to_equity = excluded.debt_to_equity,
                    cfo_to_ebitda_pct = excluded.cfo_to_ebitda_pct
                """,
                list(rows),
            )

    def upsert_prices(self, rows: Iterable[Tuple[str, str, float, float]]) -> None:
        with self.connect() as conn:
            conn.executemany(
                """
                INSERT INTO daily_prices (ticker, trade_date, close_price, volume)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(ticker, trade_date) DO UPDATE SET
                    close_price = excluded.close_price,
                    volume = excluded.volume
                """,
                list(rows),
            )

    def get_all_companies(self) -> List[Dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT ticker, name, sector, cap_tier, is_financial, promoter_pct, inst_pct, data_source, updated_at FROM companies ORDER BY ticker ASC"
            ).fetchall()
            return [dict(r) for r in rows]

    def get_company(self, ticker: str) -> Optional[Dict[str, Any]]:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT ticker, name, sector, cap_tier, is_financial, promoter_pct, inst_pct, data_source, updated_at FROM companies WHERE ticker = ?",
                (ticker,),
            ).fetchone()
            return dict(row) if row else None

    def get_all_fundamentals(self) -> List[Dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM fundamentals_annual ORDER BY ticker ASC, fiscal_year ASC"
            ).fetchall()
            return [dict(r) for r in rows]

    def get_company_fundamentals(self, ticker: str) -> List[Dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM fundamentals_annual WHERE ticker = ? ORDER BY fiscal_year ASC",
                (ticker,),
            ).fetchall()
            return [dict(r) for r in rows]

    def upsert_quarterly_signals(self, signal: Dict[str, Any]) -> None:
        now = int(time.time())
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO company_quarterly_signals (
                    ticker, latest_qtr_label, signals_reported_date,
                    ttm_rev_cr, ttm_pat_cr, qtr_rev_yoy_pct, qtr_pat_yoy_pct, qtr_opm_delta_pct,
                    promoter_chg_1y_pct, inst_chg_1y_pct, gnpa_pct, nnpa_pct,
                    has_qtr_data, has_sh_trend, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(ticker) DO UPDATE SET
                    latest_qtr_label = excluded.latest_qtr_label,
                    signals_reported_date = excluded.signals_reported_date,
                    ttm_rev_cr = excluded.ttm_rev_cr,
                    ttm_pat_cr = excluded.ttm_pat_cr,
                    qtr_rev_yoy_pct = excluded.qtr_rev_yoy_pct,
                    qtr_pat_yoy_pct = excluded.qtr_pat_yoy_pct,
                    qtr_opm_delta_pct = excluded.qtr_opm_delta_pct,
                    promoter_chg_1y_pct = excluded.promoter_chg_1y_pct,
                    inst_chg_1y_pct = excluded.inst_chg_1y_pct,
                    gnpa_pct = excluded.gnpa_pct,
                    nnpa_pct = excluded.nnpa_pct,
                    has_qtr_data = excluded.has_qtr_data,
                    has_sh_trend = excluded.has_sh_trend,
                    updated_at = excluded.updated_at
                """,
                (
                    signal["ticker"],
                    signal.get("latest_qtr_label", ""),
                    signal.get("signals_reported_date", "1970-01-01"),
                    round(float(signal.get("ttm_rev_cr", 0.0)), 2),
                    round(float(signal.get("ttm_pat_cr", 0.0)), 2),
                    round(float(signal.get("qtr_rev_yoy_pct", 0.0)), 2),
                    round(float(signal.get("qtr_pat_yoy_pct", 0.0)), 2),
                    round(float(signal.get("qtr_opm_delta_pct", 0.0)), 2),
                    round(float(signal.get("promoter_chg_1y_pct", 0.0)), 2),
                    round(float(signal.get("inst_chg_1y_pct", 0.0)), 2),
                    round(float(signal.get("gnpa_pct", 0.0)), 2),
                    round(float(signal.get("nnpa_pct", 0.0)), 2),
                    1 if signal.get("has_qtr_data") else 0,
                    1 if signal.get("has_sh_trend") else 0,
                    now,
                ),
            )

    def get_all_quarterly_signals(self) -> Dict[str, Dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute("SELECT * FROM company_quarterly_signals").fetchall()
            return {r["ticker"]: dict(r) for r in rows}

    def get_all_prices(self, min_date: Optional[str] = None) -> List[Dict[str, Any]]:
        with self.connect() as conn:
            if min_date:
                rows = conn.execute(
                    "SELECT ticker, trade_date, close_price, volume FROM daily_prices WHERE trade_date >= ? ORDER BY trade_date ASC",
                    (min_date,),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT ticker, trade_date, close_price, volume FROM daily_prices ORDER BY trade_date ASC"
                ).fetchall()
            return [dict(r) for r in rows]

    def get_company_prices(self, ticker: str, limit_days: int = 1500) -> List[Dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT trade_date, close_price, volume FROM (
                    SELECT trade_date, close_price, volume
                    FROM daily_prices
                    WHERE ticker = ?
                    ORDER BY trade_date DESC
                    LIMIT ?
                ) ORDER BY trade_date ASC
                """,
                (ticker, limit_days),
            ).fetchall()
            return [dict(r) for r in rows]

    # --- User-Scoped Saved Plans ---

    def save_user_plan(self, user_id: int, plan_name: str, payload: Dict[str, Any]) -> int:
        now = int(time.time())
        with self.connect() as conn:
            cur = conn.execute(
                "INSERT INTO saved_plans (user_id, plan_name, payload_json, created_at) VALUES (?, ?, ?, ?)",
                (user_id, plan_name, json.dumps(payload), now),
            )
            return int(cur.lastrowid)

    def list_user_plans(self, user_id: int) -> List[Dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT id, plan_name, payload_json, created_at FROM saved_plans WHERE user_id = ? ORDER BY created_at DESC LIMIT 20",
                (user_id,),
            ).fetchall()
            return [
                {
                    "id": r["id"],
                    "plan_name": r["plan_name"],
                    "payload": json.loads(r["payload_json"]),
                    "created_at": r["created_at"],
                }
                for r in rows
            ]
