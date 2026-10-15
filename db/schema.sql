-- =====================================================================
-- Canteen Pre-Order System: database schema (PostgreSQL / Render)
-- SHARED FILE: keep identical in canteen-student and canteen-backoffice.
-- Every statement is idempotent (safe to run on every startup).
-- Money is stored as INTEGER CENTAVOS (₱1.00 = 100) to avoid rounding errors.
-- =====================================================================

-- ---------- Users (students, staff, cashier, admin) ----------
CREATE TABLE IF NOT EXISTS users (
  id                    SERIAL PRIMARY KEY,
  login_id              VARCHAR(50)  NOT NULL UNIQUE,      -- school ID for students, username for others
  full_name             VARCHAR(120) NOT NULL,
  role                  VARCHAR(10)  NOT NULL CHECK (role IN ('student','staff','cashier','admin')),
  password_hash         TEXT         NOT NULL,
  balance_cents         INTEGER      NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  consecutive_no_shows  INTEGER      NOT NULL DEFAULT 0,
  total_no_shows        INTEGER      NOT NULL DEFAULT 0,
  suspended_until       TIMESTAMPTZ,
  is_demo               BOOLEAN      NOT NULL DEFAULT FALSE,
  is_active             BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ---------- System settings (editable by admin) ----------
CREATE TABLE IF NOT EXISTS settings (
  key    VARCHAR(50) PRIMARY KEY,
  value  TEXT NOT NULL
);

-- ---------- Pickup time slots ----------
CREATE TABLE IF NOT EXISTS time_slots (
  id              SERIAL PRIMARY KEY,
  label           VARCHAR(60) NOT NULL,
  start_time      TIME NOT NULL,
  end_time        TIME NOT NULL,
  cutoff_minutes  INTEGER NOT NULL DEFAULT 30,   -- ordering closes this many minutes before start_time
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  CHECK (end_time > start_time)
);

-- ---------- Menu ----------
CREATE TABLE IF NOT EXISTS menu_items (
  id                   SERIAL PRIMARY KEY,
  name                 VARCHAR(100) NOT NULL,
  description          VARCHAR(255) NOT NULL DEFAULT '',
  category             VARCHAR(50)  NOT NULL DEFAULT 'Meals',
  price_cents          INTEGER NOT NULL CHECK (price_cents > 0),
  photo                TEXT,                         -- small data URL (resized in browser) or image URL
  is_perishable        BOOLEAN NOT NULL DEFAULT TRUE,
  stock                INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  low_stock_threshold  INTEGER NOT NULL DEFAULT 10,
  is_active            BOOLEAN NOT NULL DEFAULT TRUE, -- FALSE = discontinued
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Orders ----------
CREATE TABLE IF NOT EXISTS orders (
  id                  SERIAL PRIMARY KEY,
  order_code          VARCHAR(10) NOT NULL UNIQUE,  -- shown to student + encoded in QR
  student_id          INTEGER REFERENCES users(id),  -- NULL for anonymous cash walk-ins
  slot_id             INTEGER REFERENCES time_slots(id),  -- NULL for walk-ins
  order_date          DATE NOT NULL,                 -- school-day date (Asia/Manila)
  total_cents         INTEGER NOT NULL CHECK (total_cents >= 0),
  status              VARCHAR(12) NOT NULL
                      CHECK (status IN ('placed','preparing','ready','completed','cancelled','no_show')),
  payment_method      VARCHAR(10) NOT NULL DEFAULT 'wallet' CHECK (payment_method IN ('wallet','cash')),
  is_walk_in          BOOLEAN NOT NULL DEFAULT FALSE,
  placed_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancel_deadline     TIMESTAMPTZ,                   -- placed_at + cancel window
  locked_at           TIMESTAMPTZ,
  lock_method         VARCHAR(12) CHECK (lock_method IN ('auto','confirm_now')),
  ready_at            TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,
  cancelled_at        TIMESTAMPTZ,
  no_show_at          TIMESTAMPTZ,
  handled_by          INTEGER REFERENCES users(id)   -- staff who completed / created walk-in / marked no-show
);
CREATE INDEX IF NOT EXISTS idx_orders_student ON orders(student_id, placed_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_date_status ON orders(order_date, status);

CREATE TABLE IF NOT EXISTS order_items (
  id                SERIAL PRIMARY KEY,
  order_id          INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id      INTEGER NOT NULL REFERENCES menu_items(id),
  item_name         VARCHAR(100) NOT NULL,           -- snapshot at time of order
  unit_price_cents  INTEGER NOT NULL,
  quantity          INTEGER NOT NULL CHECK (quantity > 0),
  line_total_cents  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

-- ---------- Wallet ledger (never deleted; corrections are new entries) ----------
CREATE SEQUENCE IF NOT EXISTS receipt_seq START 1;

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id                   SERIAL PRIMARY KEY,
  student_id           INTEGER NOT NULL REFERENCES users(id),
  type                 VARCHAR(12) NOT NULL
                       CHECK (type IN ('topup','purchase','refund','reversal','adjustment','demo_reset')),
  amount_cents         INTEGER NOT NULL,             -- + adds to wallet, - deducts
  balance_after_cents  INTEGER NOT NULL,
  order_id             INTEGER REFERENCES orders(id),
  performed_by         INTEGER REFERENCES users(id), -- cashier / admin / staff (NULL = student/system)
  receipt_no           VARCHAR(30),
  reason               VARCHAR(255),
  reverses_txn_id      INTEGER UNIQUE REFERENCES wallet_transactions(id), -- one reversal per top-up
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wallet_student ON wallet_transactions(student_id, created_at DESC);

-- ---------- Waste log (perishables from no-show orders) ----------
CREATE TABLE IF NOT EXISTS waste_log (
  id            SERIAL PRIMARY KEY,
  menu_item_id  INTEGER NOT NULL REFERENCES menu_items(id),
  item_name     VARCHAR(100) NOT NULL,
  quantity      INTEGER NOT NULL,
  order_id      INTEGER REFERENCES orders(id),
  logged_by     INTEGER REFERENCES users(id),
  reason        VARCHAR(255) NOT NULL DEFAULT 'No-show (perishable)',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Accounts created by the school cashier (Revision 4) ----------
-- must_change_password: student logged in with a temporary password and must set their own.
-- password_changed_at: last time the student set their own password (limit: once every 7 days).
-- created_by: the cashier who created the account (after checking the school ID card).
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id);
