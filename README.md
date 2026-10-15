# Canteen Pre-Order: Back-Office App (Staff · School Cashier · Admin)

One app, three roles. The account's role decides which screen opens after login:

| Role | Screen | Features |
|---|---|---|
| **Canteen Staff** | `/staff.html` | Live order queue by pickup slot, Mark Ready, Pickup (type code or scan QR) → Release, End-of-Lunch No-Shows, Walk-In Sales (wallet or cash), read-only Balance Lookup |
| **School Cashier** | `/cashier.html` | Find student → cash top-up → receipt, same-day reversal (logged), End-of-Day Report |
| **Admin** | `/admin.html` | Sales dashboard, Menu (add/edit/photo/discontinue), daily Stock & Restock dashboard, Wallets (history, adjustments, demo reset), Suspensions, Slots & Settings, Accounts |

Shares a Render PostgreSQL database with the **canteen-student** repo. Tables and demo data are created automatically on first start.

## Run locally
```bash
cp .env.example .env    # paste the Render External Database URL + a JWT_SECRET, PORT=4000
npm install
npm start               # http://localhost:4000
```

## Deploy on Render
Web Service · Runtime **Node** · Build `npm install` · Start `npm start` · Region **Singapore**

| Key | Value |
|---|---|
| `DATABASE_URL` | Render **Internal Database URL** |
| `JWT_SECRET` | long random string (different from the student one) |
| `NODE_ENV` | `production` |
| `COOKIE_NAME` | `canteen_backoffice` |

Demo logins: `admin / admin123`, `staff / staff123`, `cashier / cashier123`. **Change these after deploying** (Admin → Accounts).

## Structure
```
server.js             Express app (API + static frontend)
routes/auth.js        login/logout/me for staff, cashier, admin
routes/students.js    student search + read-only balance (staff, cashier, admin)
routes/staff.js       queue, ready, complete, lookup, no-show (+ strikes/suspension/waste), walk-in
routes/cashier.js     top-up with receipt numbers, reversal, end-of-day report
routes/admin.js       dashboard, menu, stock, restock, slots, settings, wallets, suspensions, accounts
db/                   schema + auto-setup (shared)
lib/                  auth, helpers, auto lock-in / suspension sweeps (shared)
public/               login, staff, cashier, admin pages + css/js
```
