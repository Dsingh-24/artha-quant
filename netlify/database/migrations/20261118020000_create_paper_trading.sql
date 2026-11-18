-- ArthaQuant V4.0: Multi-Strategy Paper Trading, Buy-on-Dip Limit Orders & Daily NAV History
-- Applied automatically by Netlify Database on deploy preview & production deploys.

CREATE TABLE IF NOT EXISTS paper_portfolios (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency IN ('INR', 'USD')),
  strategy_preset TEXT NOT NULL DEFAULT 'qglp_compounder',
  benchmark_ticker TEXT NOT NULL DEFAULT '^NSEI',
  cash_balance DOUBLE PRECISION NOT NULL CHECK (cash_balance >= 0),
  reserved_cash DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (reserved_cash >= 0),
  total_deposited DOUBLE PRECISION NOT NULL CHECK (total_deposited >= 0),
  fee_bps DOUBLE PRECISION NOT NULL DEFAULT 25 CHECK (fee_bps >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_paper_portfolios_user_id
  ON paper_portfolios (user_id);

CREATE TABLE IF NOT EXISTS paper_positions (
  portfolio_id TEXT NOT NULL REFERENCES paper_portfolios(id) ON DELETE CASCADE,
  ticker TEXT NOT NULL,
  shares INTEGER NOT NULL CHECK (shares > 0),
  avg_cost DOUBLE PRECISION NOT NULL CHECK (avg_cost >= 0),
  native_currency TEXT NOT NULL CHECK (native_currency IN ('INR', 'USD')),
  entry_score DOUBLE PRECISION NOT NULL,
  entry_rating TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (portfolio_id, ticker)
);

CREATE TABLE IF NOT EXISTS paper_orders (
  id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL REFERENCES paper_portfolios(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  order_type TEXT NOT NULL CHECK (order_type IN ('MARKET', 'LIMIT')),
  shares INTEGER NOT NULL CHECK (shares > 0),
  limit_price DOUBLE PRECISION,
  reserved_amount DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (reserved_amount >= 0),
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'FILLED', 'CANCELLED', 'EXPIRED')),
  score_at_order DOUBLE PRECISION,
  rating_at_order TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  filled_at TEXT,
  filled_price DOUBLE PRECISION
);

CREATE INDEX IF NOT EXISTS idx_paper_orders_user_id
  ON paper_orders (user_id);

CREATE INDEX IF NOT EXISTS idx_paper_orders_portfolio_status
  ON paper_orders (portfolio_id, status);

CREATE INDEX IF NOT EXISTS idx_paper_orders_status_ticker
  ON paper_orders (status, ticker);

CREATE TABLE IF NOT EXISTS paper_trades (
  id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL REFERENCES paper_portfolios(id) ON DELETE CASCADE,
  order_id TEXT REFERENCES paper_orders(id) ON DELETE CASCADE,
  ticker TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  shares INTEGER NOT NULL CHECK (shares > 0),
  exec_price_native DOUBLE PRECISION NOT NULL CHECK (exec_price_native > 0),
  fx_rate DOUBLE PRECISION NOT NULL DEFAULT 1.0 CHECK (fx_rate > 0),
  gross_amount DOUBLE PRECISION NOT NULL CHECK (gross_amount >= 0),
  fee_amount DOUBLE PRECISION NOT NULL CHECK (fee_amount >= 0),
  net_amount DOUBLE PRECISION NOT NULL CHECK (net_amount >= 0),
  realized_pnl DOUBLE PRECISION NOT NULL DEFAULT 0.0,
  score_at_trade DOUBLE PRECISION,
  rating_at_trade TEXT,
  executed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_paper_trades_portfolio_executed
  ON paper_trades (portfolio_id, executed_at DESC);

CREATE TABLE IF NOT EXISTS paper_live_quotes (
  ticker TEXT PRIMARY KEY,
  close_price DOUBLE PRECISION NOT NULL CHECK (close_price > 0),
  day_low DOUBLE PRECISION NOT NULL CHECK (day_low > 0),
  day_high DOUBLE PRECISION NOT NULL CHECK (day_high > 0),
  trade_date TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS paper_nav_history (
  portfolio_id TEXT NOT NULL REFERENCES paper_portfolios(id) ON DELETE CASCADE,
  snap_date TEXT NOT NULL,
  cash_balance DOUBLE PRECISION NOT NULL,
  holdings_value DOUBLE PRECISION NOT NULL,
  total_nav DOUBLE PRECISION NOT NULL,
  total_deposited DOUBLE PRECISION NOT NULL,
  return_pct DOUBLE PRECISION NOT NULL,
  benchmark_close DOUBLE PRECISION NOT NULL,
  benchmark_return_pct DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (portfolio_id, snap_date)
);
