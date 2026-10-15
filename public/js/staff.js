// Canteen Staff screens (Staff Workflow steps 2–10).
let clockOffset = 0;
const nowServer = () => Date.now() + clockOffset;

// Payment badge: wallet orders are already paid; cash orders are collected at pickup.
function payBadge(o) {
  if (o.payment_method === 'cash') return `<span class="badge warn">Cash · collect ${peso(o.total_cents)}</span>`;
  return '<span class="badge neutral">Wallet · paid</span>';
}
const cashAttr = (o) => (o.payment_method === 'cash' && !o.is_walk_in ? o.total_cents : '');

function itemsText(items) {
  return items.map((i) => `${i.quantity}× ${esc(i.name)}`).join(', ');
}

// ===================== Order queue =====================
let queueTimer = null;
async function loadQueue() {
  try {
    const data = await api('/api/staff/queue');
    clockOffset = new Date(data.server_time).getTime() - Date.now();
    const by = (s) => data.orders.filter((o) => o.status === s).length;
    $('#queueStats').innerHTML = [
      ['Cancellable (wait)', by('placed')],
      ['To prepare', by('preparing')],
      ['Ready for pickup', by('ready')],
      ['Completed today', data.counts.completed],
    ].map(([l, v]) => `<div class="glass-card stat"><div class="label">${l}</div><div class="value">${v}</div></div>`).join('');

    if (!data.orders.length) {
      $('#queueList').innerHTML = '<div class="glass-card empty">No active orders right now.</div>';
      return;
    }
    const groups = new Map();
    for (const o of data.orders) {
      const key = o.slot_id;
      if (!groups.has(key)) groups.set(key, { label: o.slot_label, start: o.slot_start, end: o.slot_end, orders: [] });
      groups.get(key).orders.push(o);
    }
    $('#queueList').innerHTML = [...groups.values()].map((g) => {
      // batch totals for preparation (only locked-in orders)
      const totals = {};
      g.orders.filter((o) => o.status === 'preparing').forEach((o) => o.items.forEach((i) => { totals[i.name] = (totals[i.name] || 0) + i.quantity; }));
      const batch = Object.entries(totals).map(([n, q]) => `<span class="badge preparing">${q}× ${esc(n)}</span>`).join(' ');
      return `
        <div class="glass-card">
          <div class="row between">
            <h3 style="margin:0">${esc(g.label)} · ${fmtTime(g.start)}–${fmtTime(g.end)}</h3>
            <small class="muted">${g.orders.length} order(s)</small>
          </div>
          ${batch ? `<div class="chips" style="margin:10px 0"><small class="muted" style="align-self:center">To prepare:</small> ${batch}</div>` : ''}
          <div class="table-wrap"><table>
            <thead><tr><th>Order</th><th>Student</th><th>Items</th><th>Status</th><th class="right">Action</th></tr></thead>
            <tbody>${g.orders.map((o) => `
              <tr>
                <td class="mono"><b>${esc(o.order_code)}</b></td>
                <td>${esc(o.student_name || '')}<br><small class="mono">${esc(o.student_login_id || '')}</small></td>
                <td><small>${itemsText(o.items)}</small></td>
                <td>${statusBadge(o.status)} ${payBadge(o)}
                  ${o.status === 'placed' ? `<br><small class="muted">locks in <span class="countdown" data-deadline="${esc(o.cancel_deadline)}"></span></small>` : ''}
                  ${o.lock_method === 'confirm_now' && o.status === 'preparing' ? '<br><small class="muted">confirmed early</small>' : ''}
                  ${o.missed_slot ? '<br><span class="badge warn">Missed slot · held</span>' : ''}</td>
                <td class="right">
                  ${o.status === 'placed' ? '<small class="muted">No action needed</small>' : ''}
                  ${o.status === 'preparing' ? `<button class="btn sm" data-ready="${o.id}">Mark Ready</button>` : ''}
                  ${o.status === 'ready' ? `<button class="btn sm" data-complete="${o.id}" data-code="${esc(o.order_code)}" data-cash="${cashAttr(o)}">Release</button>` : ''}
                </td>
              </tr>`).join('')}</tbody>
          </table></div>
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
  loadQueue();
  clearInterval(queueTimer);
  queueTimer = setInterval(() => { if (currentTab() === 'queue') loadQueue(); }, 10000);
});

// Ready / complete buttons (used in queue and pickup)
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
      action = `<button class="btn block" data-complete="${o.id}" data-code="${esc(o.order_code)}" data-cash="${cashAttr(o)}">${o.payment_method === 'cash' && !o.is_walk_in ? `Collect ${peso(o.total_cents)} cash &amp; release` : 'Release food &amp; mark Completed'}</button>`;
      if (o.status === 'preparing') action = `<div class="row"><button class="btn secondary" data-ready="${o.id}">Mark Ready</button>${action.replace('btn block', 'btn')}</div>`;
    } else if (o.status === 'placed') {
      action = '<div class="alert warn">Still in the cancellation window. It will lock in automatically.</div>';
    } else if (o.status === 'completed') {
      action = `<div class="alert info">Already picked up on ${esc(fmtDateTime(o.completed_at))}.</div>`;
    } else if (o.status === 'cancelled') {
      action = '<div class="alert error">This order was cancelled and refunded. Do not release.</div>';
    } else if (o.status === 'no_show') {
      action = '<div class="alert error">Marked No-Show. Payment was forfeited.</div>';
    }
    $('#pickupResult').innerHTML = `
      <div class="glass-card order-card">
        <div class="row between"><span class="code">${esc(o.order_code)}</span>${statusBadge(o.status)}</div>
        <p style="margin:6px 0"><b>${esc(o.student_name || 'Walk-in customer')}</b> <small class="mono">${esc(o.student_login_id || '')}</small></p>
        <small class="muted">${esc(o.slot_label || 'Walk-in')} ${o.slot_start ? `· ${fmtTime(o.slot_start)}–${fmtTime(o.slot_end)}` : ''} · ${fmtDate(o.order_date)}</small>
        ${o.missed_slot ? '<div style="margin-top:6px"><span class="badge warn">Missed slot · held until end of lunch</span></div>' : ''}
        <ul class="order-items">${o.items.map((i) => `<li><span>${i.quantity} × ${esc(i.name)}</span></li>`).join('')}</ul>
        ${o.payment_method === 'cash' && !o.is_walk_in && !['completed', 'cancelled'].includes(o.status)
          ? `<div class="alert warn" style="margin-bottom:12px"><div class="row between"><b>Collect in cash</b><b>${peso(o.total_cents)}</b></div></div>`
          : `<div class="row between" style="margin-bottom:12px"><span class="muted">${o.payment_method === 'cash' ? 'Cash' : 'Paid from wallet'}</span><b>${peso(o.total_cents)}</b></div>`}
        ${action}
      </div>`;
  } catch (err) {
    $('#pickupResult').innerHTML = `<div class="alert error">${esc(err.message)}</div>`;
  }
}
$('#lookupForm').addEventListener('submit', (e) => { e.preventDefault(); lookup($('#codeInput').value); });

// QR scanning uses the browser's built-in BarcodeDetector (Chrome/Edge on Android, newer Safari).
let scanStream = null;
async function stopScan() {
  if (scanStream) scanStream.getTracks().forEach((t) => t.stop());
  scanStream = null;
  $('#scanVideo').classList.add('hidden');
  $('#scanBtn').textContent = 'Scan QR';
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
    $('#scanBtn').textContent = 'Stop';
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
onTab('pickup', () => setTimeout(() => $('#codeInput').focus(), 50));

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
        No-Show: wallet payments are forfeited (cash orders were never paid), non-perishables go back to stock, perishables are logged as waste, and the student gets 1 strike.
      </div>`;
    if (!d.orders.length) {
      $('#unclaimedList').innerHTML = '<div class="empty">No unclaimed orders. 🎉</div>';
      return;
    }
    $('#unclaimedList').innerHTML = `
      <div class="row between" style="margin-bottom:8px">
        <h2 style="margin:0">Unclaimed orders (${d.orders.length})</h2>
        <button class="btn danger sm" id="noShowAll">Mark selected as No-Show</button>
      </div>
      <table>
        <thead><tr><th><input type="checkbox" id="selAll" checked aria-label="Select all"></th><th>Order</th><th>Student</th><th>Slot</th><th>Items</th><th>Status</th><th></th></tr></thead>
        <tbody>${d.orders.map((o) => `
          <tr>
            <td><input type="checkbox" class="sel" value="${o.id}" checked></td>
            <td class="mono"><b>${esc(o.order_code)}</b></td>
            <td>${esc(o.student_name)}<br><small class="mono">${esc(o.student_login_id)}</small></td>
            <td><small>${fmtDate(o.order_date)}<br>${esc(o.slot_label)} ${fmtTime(o.slot_start)}</small></td>
            <td><small>${itemsText(o.items)}</small></td>
            <td>${statusBadge(o.status)} ${payBadge(o)}</td>
            <td class="right">
              <button class="btn secondary sm" data-complete="${o.id}" data-code="${esc(o.order_code)}" data-cash="${cashAttr(o)}">Picked up late</button>
              <button class="btn danger sm" data-noshow="${o.id}" data-code="${esc(o.order_code)}">No-Show</button>
            </td>
          </tr>`).join('')}</tbody>
      </table>`;
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
onTab('lunch', loadUnclaimed);

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
      <div class="row between" style="padding:8px 0;border-bottom:1px solid rgba(148,163,184,0.2)">
        <span><b>${esc(m.name)}</b><br><small>${peso(m.price_cents)} · ${m.stock} in stock</small></span>
        <span class="qty">
          <button class="icon-btn" data-wdec="${m.id}" ${q ? '' : 'disabled'}>−</button>
          <span>${q}</span>
          <button class="icon-btn" data-winc="${m.id}" ${q >= m.stock ? 'disabled' : ''}>+</button>
        </span>
      </div>`;
  }).join('') || '<div class="empty">No items on the menu.</div>';

  let total = 0;
  const lines = [];
  for (const [id, q] of walkCart) {
    const m = walkMenu.find((x) => x.id === id);
    if (!m) continue;
    total += m.price_cents * q;
    lines.push(`<li><span>${q} × ${esc(m.name)}</span><span>${peso(m.price_cents * q)}</span></li>`);
  }
  $('#walkinSummary').innerHTML = lines.join('') || '<li class="muted">No items yet.</li>';
  $('#walkinTotal').textContent = peso(total);

  $('#walkinStudent').innerHTML = walkStudent
    ? `<div class="alert ${walkStudent.balance_cents >= total || payMethod === 'cash' ? 'info' : 'error'}" style="margin-bottom:10px">
         <div class="row between">
           <span><b>${esc(walkStudent.full_name)}</b> <small class="mono">${esc(walkStudent.login_id)}</small><br>
           Balance: <b>${peso(walkStudent.balance_cents)}</b>${walkStudent.is_suspended ? ' · <span class="badge danger">Suspended</span>' : ''}</span>
           <button class="btn ghost sm" id="clearStudent">Change</button>
         </div>
         ${payMethod === 'wallet' && walkStudent.balance_cents < total ? '<div>Insufficient balance: take cash or ask them to top up at the school cashier.</div>' : ''}
       </div>`
    : '';
  $('#walkinStudentSearch').classList.toggle('hidden', !!walkStudent);
  $('#cashHint').textContent = payMethod === 'cash' ? 'Student is optional for cash sales.' : '';
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
$('#walkinSubmit').addEventListener('click', (e) => {
  if (!walkCart.size) return toast('Add at least one item.', 'error');
  if (payMethod === 'wallet' && !walkStudent) return toast('Select the student to charge their wallet.', 'error');
  withBusy(e.target, async () => {
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
        html: `<p>Order <b class="mono">${esc(r.order_code)}</b> · ${peso(r.total_cents)} paid by <b>${r.payment_method}</b>.</p>
               ${r.payment_method === 'cash' ? `<p>Collect <b>${peso(r.total_cents)}</b> in cash.</p>` : ''}
               ${r.balance_cents !== null ? `<p>Student's wallet balance: <b>${peso(r.balance_cents)}</b></p>` : ''}`,
      });
      walkCart.clear(); walkStudent = null;
      loadWalkinMenu();
    } catch (err) { toast(err.message, 'error'); }
  });
});
onTab('walkin', () => {
  loadWalkinMenu().catch((err) => toast(err.message, 'error'));
});

// ===================== Balance lookup (read-only) =====================
function showLookup(s) {
  $('#lookupResult').innerHTML = `
    <div class="wallet-card">
      <div class="label">${esc(s.full_name)} · ${esc(s.login_id)}</div>
      <div class="amount">${peso(s.balance_cents)}</div>
      <div class="label">${s.is_suspended ? `Pre-order suspended until ${esc(fmtDateTime(s.suspended_until))}` : `No-show strikes: ${s.consecutive_no_shows} in a row`}</div>
    </div>`;
}

(async function init() {
  try {
    if (!(await initShell('staff'))) return;
    studentSearch($('#walkinStudentSearch'), (s) => { walkStudent = s; renderWalkin(); }, 'Find student (School ID or name)…');
    studentSearch($('#lookupSearch'), showLookup);
    startTab('queue');
  } catch (err) { toast(err.message, 'error'); }
})();
