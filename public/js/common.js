// SHARED FILE: keep identical in canteen-student and canteen-backoffice.
// Small helpers used by every page (no frameworks, no external libraries).

const TZ = 'Asia/Manila';

// Fetch JSON from our API. Throws Error(message) on failure; redirects to login on 401.
async function api(path, options = {}) {
  const opts = { method: 'GET', credentials: 'same-origin', headers: {}, ...options };
  if (opts.body && typeof opts.body !== 'string') {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    throw new Error('Cannot reach the server. Check your connection. (The server may be waking up; try again in a minute.)');
  }
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (res.status === 401 && !location.pathname.endsWith('/login.html') && !options.noRedirect) {
    location.href = '/login.html';
    throw new Error('Please log in.');
  }
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

const peso = (cents) =>
  '₱' + (Number(cents || 0) / 100).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const signedPeso = (cents) => (cents > 0 ? '+' : cents < 0 ? '−' : '') + peso(Math.abs(cents));

function fmtDateTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-PH', { timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function fmtDate(iso) {
  if (!iso) return '';
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(iso + 'T00:00:00+08:00') : new Date(iso);
  return d.toLocaleDateString('en-PH', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' });
}
// "13:05" -> "1:05 PM"
function fmtTime(hhmm) {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${suffix}`;
}

const STATUS_LABELS = {
  placed: 'Placed (Cancellable)',
  preparing: 'Preparing',
  ready: 'Ready for Pickup',
  completed: 'Completed',
  cancelled: 'Cancelled',
  no_show: 'No-Show',
};
const statusBadge = (status) => `<span class="badge ${status}">${STATUS_LABELS[status] || status}</span>`;

const TXN_LABELS = {
  topup: 'Top-up',
  purchase: 'Purchase',
  refund: 'Refund',
  reversal: 'Top-up reversal',
  adjustment: 'Adjustment',
  demo_reset: 'Demo balance',
};

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function toast(message, type = 'success') {
  let wrap = $('.toast-wrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'toast-wrap';
    document.body.appendChild(wrap);
  }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.setAttribute('role', 'status');
  el.textContent = message;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), type === 'error' ? 6000 : 3500);
}

// Show a modal. `html` is the body; resolves with the clicked button's value (or null).
function modal({ title = '', html = '', buttons = [{ label: 'OK', value: true }], wide = false, onOpen } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal';
    overlay.innerHTML = `
      <div class="modal-box ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
        ${title ? `<h2>${esc(title)}</h2>` : ''}
        <div class="modal-body">${html}</div>
        <div class="modal-actions">
          ${buttons.map((b, i) => `<button class="btn ${b.class || ''}" data-i="${i}">${esc(b.label)}</button>`).join('')}
        </div>
      </div>`;
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    const close = (value) => { document.removeEventListener('keydown', onKey); overlay.remove(); resolve(value); };
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close(null);
      const btn = e.target.closest('[data-i]');
      if (btn) {
        const b = buttons[Number(btn.dataset.i)];
        if (b.validate) {
          const ok = b.validate(overlay);
          if (!ok) return;
        }
        close(b.collect ? b.collect(overlay) : b.value);
      }
    });
    document.body.appendChild(overlay);
    if (onOpen) onOpen(overlay);
  });
}

const confirmModal = (title, message, okLabel = 'Confirm', okClass = '') =>
  modal({
    title,
    html: `<p>${message}</p>`,
    buttons: [
      { label: 'Go back', value: false, class: 'secondary' },
      { label: okLabel, value: true, class: okClass },
    ],
  });

// Disable a button while an async action runs.
async function withBusy(button, fn) {
  if (button) button.disabled = true;
  try { return await fn(); }
  finally { if (button) button.disabled = false; }
}

function showError(el, message) {
  el.innerHTML = message ? `<div class="alert error">${esc(message)}</div>` : '';
}

async function logout() {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  location.href = '/login.html';
}

// Mark the current page's nav link active.
function markActiveNav() {
  const here = location.pathname.replace(/\/$/, '/index.html');
  $$('.nav a').forEach((a) => {
    if (here.endsWith(a.getAttribute('href'))) a.classList.add('active');
  });
}
