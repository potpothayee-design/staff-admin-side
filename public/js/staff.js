// Canteen Staff screens (Staff Workflow steps 2–10). Designed for a phone or tablet at the counter.
// Staff never see student wallet balances (only the School Cashier and Admin can).
let clockOffset = 0;
const nowServer = () => Date.now() + clockOffset;

// Payment badge: wallet orders are already paid; cash orders are collected at pickup.
function payBadge(o) {
  if (o.payment_method === 'cash') return `<span class="badge warn">Cash · collect ${peso(o.total_cents)}</span>`;
  return '<span class="badge neutral">Wallet · paid</span>';
}
const cashAttr = (o) => (o.payment_method === 'cash' && !o.is_walk_in ? o.total_cents : '');

const itemsList = (items) =>
  `<ul class="order-items">${items.map((i) => `<li><span><b>${i.quantity}×</b> ${esc(i.name)}</span></li>`).join('')}</ul>`;

// ===================== Account menu (⋮) =====================
$('#moreBtn').addEventListener('click', async () => {
  const choice = await modal({
    title: ME ? ME.full_name : 'Account',
    html: '<p class="muted" style="margin:0">Canteen Staff account</p>',
    buttons: [
      { label: 'Close', value: null, class: 'secondary' },
      { label: 'Change password', value: 'pw', class: 'secondary' },
      { label: 'Log out', value: 'logout', class: 'danger' },
    ],
  });
  if (choice === 'pw') changePasswordDialog();
  if (choice === 'logout') logout();
});

// ===================== Order queue =====================
let queueTimer = null;

function queueCard(o) {
  let action = '';
  if (o.status === 'placed') {
    action = `<div class="muted small-note">Student can still cancel · locks in <span class="countdown" data-deadline="${esc(o.cancel_deadline)}"></span></div>`;
  } else if (o.status === 'preparing') {
    action = `<button class="btn block" data-ready="${o.id}">Mark Ready</button>`;
  } else if (o.status === 'ready') {
    action = `<button class="btn block" data-complete="${o.id}" data-code="${esc(o.order_code)}" data-cash="${cashAttr(o)}">${cashAttr(o) ? `Collect ${peso(o.total_cents)} &amp; release` : 'Release'}</button>`;
  }
  return `
    <div class="glass-card order-card s-${o.status}">
      <div class="row between nowrap">
        <span class="code">${esc(o.order_code)}</span>
        ${statusBadge(o.status)}
      </div>
      <div class="who">${esc(o.student_name || '')} <small class="mono">${esc(o.student_login_id || '')}</small></div>
      ${itemsList(o.items)}
      <div class="chips">
        ${payBadge(o)}
        ${o.lock_method === 'confirm_now' && o.status === 'preparing' ? '<span class="badge neutral">Confirmed early</span>' : ''}
        ${o.missed_slot ? '<span class="badge warn">Missed slot · held</span>' : ''}
      </div>
      <div class="card-action">${action}</div>
    </div>`;
}

async function loadQueue() {
  try {
    const data = await api('/api/staff/queue');
    clockOffset = new Date(data.server_time).getTime() - Date.now();
    const by = (s) => data.orders.filter((o) => o.status === s).length;
    $('#queueStats').innerHTML = [
      ['Cancellable', by('placed'), 'placed'],
      ['To prepare', by('preparing'), 'preparing'],
      ['Ready', by('ready'), 'ready'],
      ['Completed', data.counts.completed, 'completed'],
    ].map(([l, v, st]) => `<div class="glass-card stat st-${st}"><div class="label">${l}</div><div class="value">${v}</div></div>`).join('');

    const toPrepare = by('preparing');
    $('#navQueueCount').textContent = toPrepare;
    $('#navQueueCount').classList.toggle('hidden', !toPrepare);

    if (!data.orders.length) {
      $('#queueList').innerHTML = '<div class="glass-card empty">No active orders right now.</div>';
      return;
    }
    const groups = new Map();
    for (const o of data.orders) {
      if (!groups.has(o.slot_id)) groups.set(o.slot_id, { label: o.slot_label, start: o.slot_start, end: o.slot_end, orders: [] });
      groups.get(o.slot_id).orders.push(o);
    }
    $('#queueList').innerHTML = [...groups.values()].map((g) => {
      // Batch totals for the kitchen (locked-in orders only)
      const totals = {};
      g.orders.filter((o) => o.status === 'preparing').forEach((o) => o.items.forEach((i) => { totals[i.name] = (totals[i.name] || 0) + i.quantity; }));
      const batch = Object.entries(totals).map(([n, q]) => `<span class="badge preparing">${q}× ${esc(n)}</span>`).join(' ');
      return `
        <div class="slot-group">
          <div class="slot-head">
            <h3>${esc(g.label)}</h3>
            <small class="muted">${fmtTime(g.start)}–${fmtTime(g.end)} · ${g.orders.length} order(s)</small>
          </div>
          ${batch ? `<div class="glass-card batch"><small class="muted">To prepare in this slot</small><div class="chips" style="margin-top:6px">${batch}</div></div>` : ''}
          <div class="order-grid">${g.orders.map(queueCard).join('')}</div>
        </div>`;
    }).join('');
    tickCountdowns();
  } catch (err) { toast(err.message, 'error'); }
}

function tickCountdowns() {
  let expired = false;
  $$('[data-deadline]').forEach((el) => {
    const left = Math.max(0, new Date(el.dataset.deadline).getTime() - nowServer());
    el.textContent = `${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}`;
    if (left === 0) expired = true;
  });
  if (expired && currentTab() === 'queue') { clearTimeout(tickCountdowns.t); tickCountdowns.t = setTimeout(loadQueue, 1500); }
}
setInterval(tickCountdowns, 1000);

onTab('queue', () => {
  if (typeof stopScan === 'function') stopScan();
  loadQueue();
  clearInterval(queueTimer);
  queueTimer = setInterval(() => { if (currentTab() === 'queue') loadQueue(); }, 10000);
});

// Ready / complete buttons (used in queue, pickup and end of lunch)
document.addEventListener('click', async (e) => {
  const r = e.target.closest('[data-ready]');
  const c = e.target.closest('[data-complete]');
  if (r) {
    withBusy(r, async () => {
      try { await api(`/api/staff/orders/${r.dataset.ready}/ready`, { method: 'POST' }); toast('Marked Ready for Pickup.'); }
      catch (err) { toast(err.message, 'error'); }
      refreshCurrent();
    });
  }
  if (c) {
    const cash = Number(c.dataset.cash || 0);
    const ok = cash
      ? await confirmModal('Collect cash & release', `Cash order <b class="mono">${esc(c.dataset.code)}</b>.<br>Collect <b style="font-size:1.2rem">${peso(cash)}</b> from the student, then hand over the food.`, 'Cash received · Complete', 'warning')
      : await confirmModal('Release order?', `Hand over order <b class="mono">${esc(c.dataset.code)}</b> and mark it <b>Completed</b>?`, 'Release & complete');
    if (!ok) return;
    withBusy(c, async () => {
      try { await api(`/api/staff/orders/${c.dataset.complete}/complete`, { method: 'POST' }); toast(`Order ${c.dataset.code} completed.`); }
      catch (err) { toast(err.message, 'error'); }
      refreshCurrent();
    });
  }
});

function refreshCurrent() {
  const t = currentTab();
  if (t === 'queue') loadQueue();
  if (t === 'pickup' && lastLookup) lookup(lastLookup);
  if (t === 'lunch') loadUnclaimed();
}

// ===================== Pickup / scan =====================
let lastLookup = null;
async function lookup(code) {
  code = code.trim().toUpperCase();
  if (!code) return;
  lastLookup = code;
  try {
    const o = await api(`/api/staff/lookup/${encodeURIComponent(code)}`);
    let action = '';
    if (o.status === 'ready' || o.status === 'preparing') {
      const release = `<button class="btn block" data-complete="${o.id}" data-code="${esc(o.order_code)}" data-cash="${cashAttr(o)}">${o.payment_method === 'cash' && !o.is_walk_in ? `Collect ${peso(o.total_cents)} cash &amp; release` : 'Release food &amp; mark Completed'}</button>`;
      action = o.status === 'preparing'
        ? `<div class="stack-sm"><button class="btn secondary block" data-ready="${o.id}">Mark Ready</button>${release}</div>`
        : release;
    } else if (o.status === 'placed') {
      action = '<div class="alert warn">Still in the cancellation window. It will lock in automatically.</div>';
    } else if (o.status === 'completed') {
      action = `<div class="alert info">Already picked up on ${esc(fmtDateTime(o.completed_at))}.</div>`;
    } else if (o.status === 'cancelled') {
      action = '<div class="alert error">This order was cancelled. Do not release.</div>';
    } else if (o.status === 'no_show') {
      action = '<div class="alert error">Marked No-Show. Do not release.</div>';
    }
    $('#pickupResult').innerHTML = `
      <div class="glass-card order-card s-${o.status}">
        <div class="row between nowrap"><span class="code">${esc(o.order_code)}</span>${statusBadge(o.status)}</div>
        <div class="who">${esc(o.student_name || 'Walk-in customer')} <small class="mono">${esc(o.student_login_id || '')}</small></div>
        <small class="muted">${esc(o.slot_label || 'Walk-in')} ${o.slot_start ? `· ${fmtTime(o.slot_start)}–${fmtTime(o.slot_end)}` : ''} · ${fmtDate(o.order_date)}</small>
        ${o.missed_slot ? '<div style="margin-top:6px"><span class="badge warn">Missed slot · held until end of lunch</span></div>' : ''}
        ${itemsList(o.items)}
        ${o.payment_method === 'cash' && !o.is_walk_in && !['completed', 'cancelled'].includes(o.status)
          ? `<div class="alert warn" style="margin-bottom:12px"><div class="row between nowrap"><b>Collect in cash</b><b style="font-size:1.15rem">${peso(o.total_cents)}</b></div></div>`
          : `<div class="row between nowrap" style="margin-bottom:12px"><span class="muted">${o.payment_method === 'cash' ? 'Cash' : 'Paid from wallet'}</span><b>${peso(o.total_cents)}</b></div>`}
        ${action}
      </div>`;
    $('#pickupResult').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    $('#pickupResult').innerHTML = `<div class="alert error">${esc(err.message)}</div>`;
  }
}
$('#lookupForm').addEventListener('submit', (e) => { e.preventDefault(); $('#codeInput').blur(); lookup($('#codeInput').value); });

// QR scanning uses the browser's built-in BarcodeDetector (Chrome on Android). Unchanged.
let scanStream = null;
async function stopScan() {
  if (scanStream) scanStream.getTracks().forEach((t) => t.stop());
  scanStream = null;
  $('#scanVideo').classList.add('hidden');
  $('#scanBtn span').textContent = 'Scan QR';
}
$('#scanBtn').addEventListener('click', async () => {
  if (scanStream) return stopScan();
  if (!('BarcodeDetector' in window)) {
    return toast('QR scanning is not supported in this browser. Type the order number instead (or use Chrome on Android).', 'error');
  }
  try {
    const detector = new BarcodeDetector({ formats: ['qr_code'] });
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    const video = $('#scanVideo');
    video.srcObject = scanStream;
    video.classList.remove('hidden');
    await video.play();
    $('#scanBtn span').textContent = 'Stop scanning';
    const loop = async () => {
      if (!scanStream) return;
      try {
        const codes = await detector.detect(video);
        if (codes.length) {
          const value = codes[0].rawValue;
          $('#codeInput').value = value;
          await stopScan();
          return lookup(value);
        }
      } catch { /* keep trying */ }
      requestAnimationFrame(loop);
    };
    loop();
  } catch (err) {
    stopScan();
    toast('Could not open the camera: ' + err.message, 'error');
  }
});

// ===================== End of lunch =====================
async function loadUnclaimed() {
  try {
    const d = await api('/api/staff/unclaimed');
    $('#lunchInfo').innerHTML = `
      <div class="alert ${d.after_lunch ? 'info' : 'warn'}">
        Lunch ends at <b>${fmtTime(d.lunch_end_time)}</b>.
        ${d.after_lunch
          ? 'Lunch is over. Unclaimed orders below can be marked <b>No-Show</b>.'
          : 'Lunch is not over yet. Students who missed their slot can still pick up until lunch ends.'}
        <details style="margin-top:6px"><summary>What happens on No-Show?</summary>
        Wallet payments are forfeited (cash orders were never paid), non-perishables go back to stock, perishables are logged as waste, and the student gets 1 strike.</details>
      </div>`;
    if (!d.orders.length) {
      $('#unclaimedList').innerHTML = '<div class="glass-card empty">No unclaimed orders. 🎉</div>';
      return;
    }
    $('#unclaimedList').innerHTML = `
      <div class="glass-card bulk-bar">
        <label class="check" style="margin:0"><input type="checkbox" id="selAll" checked> Select all (${d.orders.length})</label>
        <button class="btn danger sm" id="noShowAll">Mark selected No-Show</button>
      </div>
      <div class="order-grid" style="margin-top:12px">${d.orders.map((o) => `
        <div class="glass-card order-card s-${o.status}">
          <div class="row between nowrap">
            <label class="check" style="margin:0"><input type="checkbox" class="sel" value="${o.id}" checked aria-label="Select ${esc(o.order_code)}">
              <span class="code">${esc(o.order_code)}</span></label>
            ${statusBadge(o.status)}
          </div>
          <div class="who">${esc(o.student_name)} <small class="mono">${esc(o.student_login_id)}</small></div>
          <small class="muted">${esc(o.slot_label)} · ${fmtTime(o.slot_start)} · ${fmtDate(o.order_date)}</small>
          ${itemsList(o.items)}
          <div class="chips">${payBadge(o)}</div>
          <div class="card-action two">
            <button class="btn secondary" data-complete="${o.id}" data-code="${esc(o.order_code)}" data-cash="${cashAttr(o)}">Picked up late</button>
            <button class="btn danger" data-noshow="${o.id}" data-code="${esc(o.order_code)}">No-Show</button>
          </div>
        </div>`).join('')}</div>`;
    $('#selAll').addEventListener('change', (e) => $$('.sel').forEach((c) => (c.checked = e.target.checked)));
    $('#noShowAll').addEventListener('click', async (e) => {
      const ids = $$('.sel').filter((c) => c.checked).map((c) => Number(c.value));
      if (!ids.length) return toast('Select at least one order.', 'error');
      const ok = await confirmModal('Mark as No-Show?',
        `${ids.length} order(s) will be marked <b>No-Show</b>. Wallet payments are <b>not refunded</b> and each student gets a strike.`
        + (d.after_lunch ? '' : '<br><br><b>Note:</b> lunch has not ended yet.'),
        'Mark No-Show', 'danger');
      if (!ok) return;
      withBusy(e.target, async () => {
        try {
          const r = await api('/api/staff/no-show-all', { method: 'POST', body: { order_ids: ids } });
          const susp = r.results.filter((x) => x.suspended).length;
          toast(`${r.count} order(s) marked No-Show.${susp ? ` ${susp} student(s) suspended.` : ''}`);
        } catch (err) { toast(err.message, 'error'); }
        loadUnclaimed();
      });
    });
  } catch (err) { toast(err.message, 'error'); }
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-noshow]');
  if (!b) return;
  const ok = await confirmModal('Mark as No-Show?', `Order <b class="mono">${esc(b.dataset.code)}</b>: wallet payments are forfeited and the student gets a strike.`, 'Mark No-Show', 'danger');
  if (!ok) return;
  withBusy(b, async () => {
    try {
      const r = await api(`/api/staff/orders/${b.dataset.noshow}/no-show`, { method: 'POST' });
      toast(`No-Show recorded (strike ${r.strikes}).${r.suspended ? ' Student is now suspended from pre-ordering.' : ''}`);
    } catch (err) { toast(err.message, 'error'); }
    loadUnclaimed();
  });
});
onTab('lunch', () => { stopScan(); loadUnclaimed(); });

// ===================== Walk-in sale =====================
let walkMenu = [];
const walkCart = new Map();
let walkStudent = null;
let payMethod = 'wallet';

async function loadWalkinMenu() {
  walkMenu = await api('/api/staff/menu');
  renderWalkin();
}
function renderWalkin() {
  $('#walkinMenu').innerHTML = walkMenu.map((m) => {
    const q = walkCart.get(m.id) || 0;
    return `
      <div class="walkin-item ${q ? 'picked' : ''}">
        <span class="info"><b>${esc(m.name)}</b><br><small>${peso(m.price_cents)} · ${m.stock} left</small></span>
        <span class="qty big">
          <button class="icon-btn" data-wdec="${m.id}" ${q ? '' : 'disabled'} aria-label="Remove one ${esc(m.name)}">−</button>
          <span>${q}</span>
          <button class="icon-btn" data-winc="${m.id}" ${q >= m.stock ? 'disabled' : ''} aria-label="Add one ${esc(m.name)}">+</button>
        </span>
      </div>`;
  }).join('') || '<div class="empty">No items on the menu.</div>';

  let total = 0, count = 0;
  const lines = [];
  for (const [id, q] of walkCart) {
    const m = walkMenu.find((x) => x.id === id);
    if (!m) continue;
    total += m.price_cents * q;
    count += q;
    lines.push(`<li><span>${q} × ${esc(m.name)}</span><span>${peso(m.price_cents * q)}</span></li>`);
  }
  $('#walkinSummary').innerHTML = lines.join('') || '<li class="muted">No items yet.</li>';
  $('#walkinTotal').textContent = peso(total);
  $('#walkinBarTotal').textContent = peso(total);
  $('#walkinBarCount').textContent = count ? `${count} item${count > 1 ? 's' : ''}${payMethod === 'cash' ? ' · cash' : ' · wallet'}` : 'No items';

  // Selected student: name and School ID only (no balance for staff).
  $('#walkinStudent').innerHTML = walkStudent
    ? `<div class="alert info" style="margin-bottom:10px">
         <div class="row between nowrap">
           <span><b>${esc(walkStudent.full_name)}</b><br><small class="mono">${esc(walkStudent.login_id)}</small>${walkStudent.is_suspended ? ' <span class="badge danger">Suspended</span>' : ''}</span>
           <button class="btn ghost sm" id="clearStudent">Change</button>
         </div>
       </div>`
    : '';
  $('#walkinStudentSearch').classList.toggle('hidden', !!walkStudent);
  $('#cashHint').textContent = payMethod === 'cash' ? 'Student is optional for cash sales.' : 'Select the student whose wallet will be charged.';
  if ($('#clearStudent')) $('#clearStudent').onclick = () => { walkStudent = null; renderWalkin(); };
}
document.addEventListener('click', (e) => {
  const inc = e.target.closest('[data-winc]');
  const dec = e.target.closest('[data-wdec]');
  if (inc) { const id = Number(inc.dataset.winc); walkCart.set(id, (walkCart.get(id) || 0) + 1); renderWalkin(); }
  if (dec) { const id = Number(dec.dataset.wdec); const q = (walkCart.get(id) || 0) - 1; if (q <= 0) walkCart.delete(id); else walkCart.set(id, q); renderWalkin(); }
  const pay = e.target.closest('[data-pay]');
  if (pay) { payMethod = pay.dataset.pay; $$('[data-pay]').forEach((b) => b.classList.toggle('active', b === pay)); renderWalkin(); }
});
function submitWalkin(btn) {
  if (!walkCart.size) return toast('Add at least one item.', 'error');
  if (payMethod === 'wallet' && !walkStudent) {
    toast('Select the student to charge their wallet.', 'error');
    $('#walkinStudentSearch').scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  withBusy(btn, async () => {
    try {
      const r = await api('/api/staff/walk-in', {
        method: 'POST',
        body: {
          payment_method: payMethod,
          student_id: walkStudent ? walkStudent.id : null,
          items: [...walkCart].map(([menu_item_id, quantity]) => ({ menu_item_id, quantity })),
        },
      });
      modal({
        title: 'Sale completed',
        html: `<p>Order <b class="mono">${esc(r.order_code)}</b> · <b>${peso(r.total_cents)}</b></p>
               ${r.payment_method === 'cash'
                 ? `<div class="alert warn">Collect <b>${peso(r.total_cents)}</b> in cash.</div>`
                 : '<div class="alert success">Paid from the student\'s wallet.</div>'}`,
      });
      walkCart.clear(); walkStudent = null;
      loadWalkinMenu();
    } catch (err) { toast(err.message, 'error'); }
  });
}
$('#walkinSubmit').addEventListener('click', (e) => submitWalkin(e.currentTarget));
$('#walkinSubmitMobile').addEventListener('click', (e) => submitWalkin(e.currentTarget));
onTab('walkin', () => {
  stopScan();
  loadWalkinMenu().catch((err) => toast(err.message, 'error'));
});

(async function init() {
  try {
    if (!(await initShell('staff'))) return;
    studentSearch($('#walkinStudentSearch'), (s) => { walkStudent = s; renderWalkin(); }, 'Find student (School ID or name)…');
    startTab('queue');
  } catch (err) { toast(err.message, 'error'); }
})();
