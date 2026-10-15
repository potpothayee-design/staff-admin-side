// SHARED FILE: keep identical in canteen-student and canteen-backoffice.
// Creates tables and inserts starter/demo data. Safe to run on every startup:
// - tables use CREATE ... IF NOT EXISTS
// - demo data is inserted only when the tables are empty
// An advisory lock stops both apps from initialising at the same moment.
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { pool } = require('./pool');

const LOCK_KEY = 727001;

const DEFAULT_SETTINGS = {
  cancel_window_minutes: '10',
  no_show_limit: '3',
  suspension_days: '7',
  lunch_end_time: '13:00',
  demo_balance_cents: '100000', // ₱1,000.00
  starting_balance_cents: '100000', // every new student account starts with ₱1,000.00
  max_topup_cents: '500000',    // ₱5,000.00 per top-up
};

const DEMO_SLOTS = [
  ['Morning Recess', '09:30', '09:50', 30],
  ['Lunch A', '11:30', '11:50', 30],
  ['Lunch B', '11:50', '12:10', 30],
  ['Lunch C', '12:10', '12:30', 30],
  ['Afternoon Break', '14:30', '14:50', 30],
];

// [name, description, category, price (₱), perishable, stock]
const DEMO_MENU = [
  ['Chicken Adobo Rice', 'Classic adobo with steamed rice', 'Meals', 75, true, 50],
  ['Pork Sinigang Rice', 'Sour tamarind soup with rice', 'Meals', 80, true, 40],
  ['Beef Tapa Rice', 'Tapa, garlic rice and egg', 'Meals', 85, true, 30],
  ['Pancit Canton', 'Stir-fried noodles with vegetables', 'Meals', 55, true, 35],
  ['Lumpiang Shanghai (5 pcs)', 'Crispy spring rolls with sweet chili', 'Snacks', 45, true, 40],
  ['Turon', 'Banana and langka spring roll', 'Snacks', 20, true, 30],
  ['Bottled Water', '500 mL', 'Drinks', 20, false, 100],
  ['Iced Tea', '350 mL bottle', 'Drinks', 30, false, 60],
  ['Banana Chips', 'Sealed pack', 'Snacks', 25, false, 8],
];

const DEMO_ACCOUNTS = [
  // [login_id, full_name, role, password, is_demo]
  ['2026-0001', 'Juan Dela Cruz (Demo Student)', 'student', 'student123', true],
  ['cashier', 'Sample Cashier', 'cashier', 'cashier123', false],
  ['staff', 'Sample Staff', 'staff', 'staff123', false],
  ['admin', 'Sample Admin', 'admin', 'admin123', false],
];

async function initDatabase() {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);

    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await client.query(schema);

    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      await client.query(
        'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
        [key, value]
      );
    }

    const slots = await client.query('SELECT COUNT(*)::int AS n FROM time_slots');
    if (slots.rows[0].n === 0) {
      for (const [label, start, end, cutoff] of DEMO_SLOTS) {
        await client.query(
          'INSERT INTO time_slots (label, start_time, end_time, cutoff_minutes) VALUES ($1,$2,$3,$4)',
          [label, start, end, cutoff]
        );
      }
      console.log('Seeded time slots.');
    }

    const menu = await client.query('SELECT COUNT(*)::int AS n FROM menu_items');
    if (menu.rows[0].n === 0) {
      for (const [name, desc, cat, price, perishable, stock] of DEMO_MENU) {
        await client.query(
          `INSERT INTO menu_items (name, description, category, price_cents, is_perishable, stock)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [name, desc, cat, price * 100, perishable, stock]
        );
      }
      console.log('Seeded menu items.');
    }

    const users = await client.query('SELECT COUNT(*)::int AS n FROM users');
    if (users.rows[0].n === 0) {
      for (const [loginId, fullName, role, password, isDemo] of DEMO_ACCOUNTS) {
        const hash = await bcrypt.hash(password, 10);
        const balance = isDemo ? Number(DEFAULT_SETTINGS.demo_balance_cents) : 0;
        const u = await client.query(
          `INSERT INTO users (login_id, full_name, role, password_hash, balance_cents, is_demo)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [loginId, fullName, role, hash, balance, isDemo]
        );
        if (isDemo) {
          await client.query(
            `INSERT INTO wallet_transactions (student_id, type, amount_cents, balance_after_cents, reason)
             VALUES ($1, 'demo_reset', $2, $2, 'Demo starting balance (presentation only)')`,
            [u.rows[0].id, balance]
          );
        }
      }
      console.log('Seeded demo accounts (change these passwords after deploying!).');
    }

    // One-time fix for students who registered before the starting balance existed:
    // any student with NO wallet history at all gets the starting balance.
    const { rows: [sb] } = await client.query("SELECT value FROM settings WHERE key = 'starting_balance_cents'");
    const startCents = Number(sb && sb.value) || 0;
    if (startCents > 0) {
      const fixed = await client.query(
        `WITH s AS (
           UPDATE users u SET balance_cents = u.balance_cents + $1
            WHERE u.role = 'student'
              AND NOT EXISTS (SELECT 1 FROM wallet_transactions t WHERE t.student_id = u.id)
            RETURNING u.id, u.balance_cents
         )
         INSERT INTO wallet_transactions (student_id, type, amount_cents, balance_after_cents, reason)
         SELECT id, 'adjustment', $1, balance_cents, 'Starting balance' FROM s`,
        [startCents]
      );
      if (fixed.rowCount) console.log(`Gave the starting balance to ${fixed.rowCount} existing student account(s).`);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    client.release();
  }
}

module.exports = { initDatabase };

// Allow running directly: `npm run db:init`
if (require.main === module) {
  initDatabase()
    .then(() => { console.log('Database ready.'); return pool.end(); })
    .catch((err) => { console.error(err); process.exit(1); });
}
