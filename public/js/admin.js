// Canteen Admin screens (Admin Workflow steps 2–7).

// ===================== Dashboard =====================
function bars(list, valueKey, labelFn, valueFmt = (v) => v) {
  const max = Math.max(1, ...list.map((x) => x[valueKey]));
  return `<div class="bars">${list.map((x) => `
    <div class="bar" title="${esc(labelFn(x))}: ${esc(valueFmt(x[valueKey]))}">
      <span class="val">${x[valueKey] ? esc(valueFmt(x[valueKey])) : ''}</span>
      <div class="fill" style="height:${(x[valueKey] / max) * 100}%"></div>
      <span class="lbl">${esc(labelFn(x))}</span>
    </div>`).join('')}</div>`;
}
const shortDate = (iso) => new Date(iso + 'T00:00:00+08:00').toLocaleDateString('en-PH', { timeZone: TZ, month: 'short', day: 'numeric' });
const shortPeso = (c) => (c >= 100000 ? '₱' + (c / 100000).toFixed(1) + 'k' : '₱' + Math.round(c / 100));

async function loadDashboard() {
  const days = $('#dashDays').value;
  try {
    const d = await api(`/api/admin/dashboard?days=${days}`);
    const t = d.totals;
    const maxSeller = Math.max(1, ...d.best_sellers.map((b) => b.quantity));
    const hours = Array.from({ length: 13 }, (_, i) => i + 6).map((h) => ({ hour: h, orders: (d.peak_hours.find((x) => x.hour === h) || {}).orders || 0 }));
    const nsTotal = d.no_show_rate.reduce((a, x) => ({ n: a.n + x.no_shows, f: a.f + x.finished }), { n: 0, f: 0 });
    const w = d.wallet;

    $('#dashBody').innerHTML = `
      <div class="grid grid-4">
        <div class="glass-card stat"><div class="label">Sales today</div><div class="value">${peso(t.today_cents)}</div><small>${t.today_orders} orders</small></div>
        <div class="glass-card stat"><div class="label">Sales this week (7 days)</div><div class="value">${peso(t.week_cents)}</div><small>${t.week_orders} orders</small></div>
        <div class="glass-card stat"><div class="label">No-show rate (${days} days)</div><div class="value">${nsTotal.f ? Math.round((nsTotal.n / nsTotal.f) * 100) : 0}%</div><small>${nsTotal.n} of ${nsTotal.f} pre-orders</small></div>
        <div class="glass-card stat"><div class="label">Wasted items (${days} days)</div><div class="value">${d.waste.items}</div><small>perishables from no-shows</small></div>
      </div>

      <div class="glass-card">
        <h3>Daily sales</h3>
        ${bars(d.daily, 'sales_cents', (x) => shortDate(x.date), shortPeso)}
      </div>

      <div class="grid grid-2">
        <div class="glass-card">
          <h3>Best-selling items</h3>
          ${d.best_sellers.length ? d.best_sellers.map((b) => `
            <div class="hbar"><span class="name">${esc(b.name)}</span>
              <span class="track"><div style="width:${(b.quantity / maxSeller) * 100}%"></div></span>
              <span class="v">${b.quantity}</span></div>`).join('') : '<div class="empty">No sales yet.</div>'}
        </div>
        <div class="glass-card">
          <h3>Peak ordering times</h3>
          ${bars(hours, 'orders', (x) => `${((x.hour + 11) % 12) + 1}${x.hour < 12 ? 'a' : 'p'}`)}
        </div>
      </div>

      <div class="grid grid-2">
        <div class="glass-card">
          <h3>No-show rate over time</h3>
          ${bars(d.no_show_rate.map((x) => ({ ...x, pct: x.finished ? Math.round((x.no_shows / x.finished) * 100) : 0 })), 'pct', (x) => shortDate(x.date), (v) => v + '%')}
        </div>
        <div class="glass-card">
          <h3>Wallet top-ups vs. spending</h3>
          <div class="grid grid-2" style="margin-top:8px">
            <div class="stat"><div class="label">Top-ups (${days} days)</div><div class="value amount-pos">${peso(w.topups_cents)}</div></div>
            <div class="stat"><div class="label">Spending (${days} days)</div><div class="value amount-neg">${peso(w.spending_cents)}</div></div>
            <div class="stat"><div class="label">Top-ups (all time)</div><div class="value">${peso(w.topups_all_cents)}</div></div>
            <div class="stat"><div class="label">Spending (all time)</div><div class="value">${peso(w.spending_all_cents)}</div></div>
          </div>
          <div class="divider"></div>
          <small>Money currently held in ${w.students} student wallets: <b>${peso(w.total_balance_cents)}</b></small>
        </div>
      </div>`;
  } catch (err) { toast(err.message, 'error'); }
}
$('#dashDays').addEventListener('change', loadDashboard);
onTab('dashboard', loadDashboard);

// ===================== Menu =====================
let menuItems = [];
async function loadMenu() {
  menuItems = await api('/api/admin/menu');
  $('#menuTable').innerHTML = menuItems.length ? `
    <table>
      <thead><tr><th></th><th>Item</th><th>Category</th><th class="num">Price</th><th>Type</th><th class="num">Stock</th><th>Status</th><th class="right">Actions</th></tr></thead>
      <tbody>${menuItems.map((m) => `
        <tr style="${m.is_active ? '' : 'opacity:0.55'}">
          <td style="width:56px">${m.photo ? `<img src="${esc(m.photo)}" alt="" style="width:44px;height:44px;object-fit:cover;border-radius:10px">` : `<div style="width:44px;height:44px;border-radius:10px;background:rgba(46,158,107,0.15);display:flex;align-items:center;justify-content:center;font-weight:700">${esc(m.name[0])}</div>`}</td>
          <td><b>${esc(m.name)}</b><br><small>${esc(m.description)}</small></td>
          <td>${esc(m.category)}</td>
          <td class="num">${peso(m.price_cents)}</td>
          <td>${m.is_perishable ? '<span class="badge warn">Perishable</span>' : '<span class="badge neutral">Non-perishable</span>'}</td>
          <td class="num">${m.stock}</td>
          <td>${m.is_active ? '<span class="badge ok">On menu</span>' : '<span class="badge neutral">Discontinued</span>'}</td>
          <td class="right" style="white-space:nowrap">
            <button class="btn secondary sm" data-edit="${m.id}">Edit</button>
            <button class="btn ghost sm" data-toggle="${m.id}" data-active="${m.is_active}">${m.is_active ? 'Discontinue' : 'Restore'}</button>
            <button class="btn ghost sm" data-del="${m.id}" title="Delete (only if never ordered)">Delete</button>
          </td>
        </tr>`).join('')}</tbody>
    </table>` : '<div class="empty">No menu items yet.</div>';
}

// Resize a chosen photo in the browser to a small JPEG data URL (stored in the database).
function resizeImage(file, maxSize = 480) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(img.src);
      resolve(canvas.toDataURL('image/jpeg', 0.78));
    };
    img.onerror = () => reject(new Error('Could not read that image.'));
    img.src = URL.createObjectURL(file);
  });
}

async function itemDialog(item) {
  const isNew = !item;
  item = item || { name: '', description: '', category: 'Meals', price_cents: '', is_perishable: true, stock: 0, low_stock_threshold: 10, photo: null };
  let photo = item.photo;
  let photoChanged = false;
  const data = await modal({
    title: isNew ? 'Add menu item' : 'Edit menu item',
    wide: true,
    html: `
      <div class="grid grid-2">
        <div>
          <div class="field"><label>Name</label><input id="fName" value="${esc(item.name)}" maxlength="100"></div>
          <div class="field"><label>Description</label><input id="fDesc" value="${esc(item.description)}" maxlength="255"></div>
          <div class="field"><label>Category</label><input id="fCat" value="${esc(item.category)}" list="catList">
            <datalist id="catList">${[...new Set(['Meals', 'Snacks', 'Drinks', ...menuItems.map((m) => m.category)])].map((c) => `<option value="${esc(c)}">`).join('')}</datalist></div>
          <div class="field"><label>Price (₱)</label><input id="fPrice" type="number" min="1" step="0.01" value="${item.price_cents ? item.price_cents / 100 : ''}"></div>
        </div>
        <div>
          ${isNew ? `<div class="field"><label>Starting stock quantity</label><input id="fStock" type="number" min="0" value="${item.stock}"></div>` : ''}
          <div class="field"><label>Low-stock warning at</label><input id="fThreshold" type="number" min="0" value="${item.low_stock_threshold}"></div>
          <label class="check field"><input type="checkbox" id="fPerish" ${item.is_perishable ? 'checked' : ''}> Perishable (discarded and logged as waste on no-show)</label>
          <div class="field"><label>Photo</label>
            <div class="row"><img id="fPreview" src="${esc(photo || '')}" alt="" style="width:72px;height:72px;object-fit:cover;border-radius:12px;${photo ? '' : 'display:none'}">
              <input id="fPhoto" type="file" accept="image/*" style="flex:1">
              <button type="button" class="btn ghost sm" id="fRemovePhoto" ${photo ? '' : 'style="display:none"'}>Remove</button></div>
          </div>
        </div>
      </div>
      <div id="fMsg"></div>`,
    buttons: [
      { label: 'Cancel', value: null, class: 'secondary' },
      {
        label: isNew ? 'Add item' : 'Save changes',
        validate: (r) => {
          if (!$('#fName', r).value.trim()) { showError($('#fMsg', r), 'Name is required.'); return false; }
          if (!(Number($('#fPrice', r).value) > 0)) { showError($('#fMsg', r), 'Enter a valid price.'); return false; }
          return true;
        },
        collect: (r) => ({
          name: $('#fName', r).value, description: $('#fDesc', r).value, category: $('#fCat', r).value,
          price: $('#fPrice', r).value, is_perishable: $('#fPerish', r).checked,
          low_stock_threshold: Number($('#fThreshold', r).value),
          stock: isNew ? Number($('#fStock', r).value) : undefined,
          photo, keep_photo: !isNew && !photoChanged,
        }),
      },
    ],
    onOpen: (r) => {
      $('#fPhoto', r).addEventListener('change', async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        try {
          photo = await resizeImage(f);
          photoChanged = true;
          $('#fPreview', r).src = photo; $('#fPreview', r).style.display = '';
          $('#fRemovePhoto', r).style.display = '';
        } catch (err) { showError($('#fMsg', r), err.message); }
      });
      $('#fRemovePhoto', r).addEventListener('click', () => {
        photo = null; photoChanged = true;
        $('#fPreview', r).style.display = 'none'; $('#fRemovePhoto', r).style.display = 'none'; $('#fPhoto', r).value = '';
      });
    },
  });
  if (!data) return;
  try {
    if (isNew) await api('/api/admin/menu', { method: 'POST', body: data });
    else await api(`/api/admin/menu/${item.id}`, { method: 'PUT', body: data });
    toast(isNew ? 'Item added.' : 'Item updated.');
    loadMenu();
  } catch (err) { toast(err.message, 'error'); }
}

$('#addItem').addEventListener('click', () => itemDialog(null));
document.addEventListener('click', async (e) => {
  const ed = e.target.closest('[data-edit]');
  const tg = e.target.closest('[data-toggle]');
  const del = e.target.closest('[data-del]');
  if (ed) itemDialog(menuItems.find((m) => m.id === Number(ed.dataset.edit)));
  if (tg) {
    const active = tg.dataset.active === 'true';
    try {
      await api(`/api/admin/menu/${tg.dataset.toggle}/active`, { method: 'POST', body: { is_active: !active } });
      toast(active ? 'Item discontinued (hidden from students).' : 'Item restored to the menu.');
      loadMenu();
    } catch (err) { toast(err.message, 'error'); }
  }
  if (del) {
    const m = menuItems.find((x) => x.id === Number(del.dataset.del));
    if (!(await confirmModal('Delete item?', `Permanently delete <b>${esc(m.name)}</b>? Items with order history can only be discontinued.`, 'Delete', 'danger'))) return;
    try { await api(`/api/admin/menu/${m.id}`, { method: 'DELETE' }); toast('Item deleted.'); loadMenu(); }
    catch (err) { toast(err.message, 'error'); }
  }
});
onTab('menu', () => loadMenu().catch((err) => toast(err.message, 'error')));

// ===================== Stock & restock =====================
async function loadStock() {
  try {
    const [r, items] = await Promise.all([api('/api/admin/restock'), api('/api/admin/menu')]);
    const row = (x) => `<tr><td>${esc(x.name)}</td><td class="num"><b>${x.stock}</b></td><td class="num">${x.low_stock_threshold}</td>
      <td class="num">${x.reserved_today}</td><td class="num">${x.sold_7d}</td></tr>`;
    const head = '<thead><tr><th>Item</th><th class="num">Stock</th><th class="num">Warn at</th><th class="num">Reserved today</th><th class="num">Sold (7d)</th></tr></thead>';
    $('#restockBody').innerHTML = `
      <div class="glass-card table-wrap">
        <h3><span class="badge danger">Out of stock</span> ${r.out_of_stock.length}</h3>
        ${r.out_of_stock.length ? `<table>${head}<tbody>${r.out_of_stock.map(row).join('')}</tbody></table>` : '<div class="empty">Nothing is out of stock.</div>'}
      </div>
      <div class="glass-card table-wrap">
        <h3><span class="badge warn">Low on stock</span> ${r.low_stock.length}</h3>
        ${r.low_stock.length ? `<table>${head}<tbody>${r.low_stock.map(row).join('')}</tbody></table>` : '<div class="empty">No items are running low.</div>'}
        ${r.waste_7d.length ? `<div class="divider"></div><small>Waste (last 7 days): ${r.waste_7d.map((w) => `${w.quantity}× ${esc(w.item_name)}`).join(', ')}</small>` : ''}
      </div>`;

    const active = items.filter((m) => m.is_active);
    $('#stockTable').innerHTML = `
      <table>
        <thead><tr><th>Item</th><th class="num">Current</th><th style="width:220px">Set to</th></tr></thead>
        <tbody>${active.map((m) => `
          <tr>
            <td>${esc(m.name)} ${m.stock === 0 ? '<span class="badge danger">Out</span>' : m.stock <= m.low_stock_threshold ? '<span class="badge warn">Low</span>' : ''}</td>
            <td class="num"><b>${m.stock}</b></td>
            <td><form class="row" data-stockform="${m.id}" style="flex-wrap:nowrap">
              <input type="number" min="0" value="${m.stock}" style="min-height:36px;padding:6px 10px">
              <button class="btn sm" type="submit">Save</button></form></td>
          </tr>`).join('')}</tbody>
      </table>`;
  } catch (err) { toast(err.message, 'error'); }
}
document.addEventListener('submit', async (e) => {
  const f = e.target.closest('[data-stockform]');
  if (!f) return;
  e.preventDefault();
  try {
    await api(`/api/admin/menu/${f.dataset.stockform}/stock`, { method: 'POST', body: { stock: Number($('input', f).value) } });
    toast('Stock updated.');
    loadStock();
  } catch (err) { toast(err.message, 'error'); }
});
onTab('stock', loadStock);

// ===================== Wallets =====================
let walletStudent = null;
async function openWallet(id) {
  try {
    const d = await api(`/api/admin/students/${id}`);
    walletStudent = d.student;
    const s = d.student;
    $('#walletDetail').innerHTML = `
      <div class="stack">
        <div class="wallet-card">
          <div class="label">${esc(s.full_name)} · ${esc(s.login_id)} ${s.is_demo ? '· DEMO' : ''}</div>
          <div class="amount">${peso(s.balance_cents)}</div>
          <div class="label">${s.is_suspended ? `Suspended until ${esc(fmtDateTime(s.suspended_until))}` : `Strikes: ${s.consecutive_no_shows} in a row · ${s.total_no_shows} total no-shows`}</div>
        </div>
        <div class="glass-card">
          <h3>Manual adjustment</h3>
          <p class="muted" style="font-size:0.85rem">For corrections only. Use a minus sign to deduct (e.g. -50). A reason is required and logged.</p>
          <form id="adjustForm" class="row">
            <input name="amount" type="number" step="0.01" placeholder="Amount (₱)" style="flex:1;min-width:120px" required>
            <input name="reason" placeholder="Reason" style="flex:2;min-width:160px" required minlength="3">
            <button class="btn sm" type="submit">Apply</button>
          </form>
          ${s.is_demo ? `<div class="divider"></div><button class="btn warning sm" id="resetDemo">Reset demo balance to ${peso(ME.settings.demo_balance_cents)}</button>` : ''}
        </div>
        <div class="glass-card">
          <div class="row between">
            <span><h3 style="margin:0">Account status</h3>
              ${s.is_active ? '<span class="badge ok">Active</span>' : '<span class="badge neutral">Disabled · cannot log in</span>'}</span>
            <button class="btn ${s.is_active ? 'danger' : ''} sm" id="toggleStudent">${s.is_active ? 'Disable account' : 'Enable account'}</button>
          </div>
          <p class="muted" style="font-size:0.82rem;margin:8px 0 0">
            ${s.created_by_name ? `Created by <b>${esc(s.created_by_name)}</b> (cashier) on ${esc(fmtDateTime(s.created_at))}.` : `Created ${esc(fmtDateTime(s.created_at))} (before cashier-created accounts).`}
            ${s.must_change_password ? '<br><span class="badge warn">Has not set own password yet</span>' : ''}</p>
          <p class="muted" style="font-size:0.82rem;margin:8px 0 0">Disable is for duplicate or wrong accounts. Nothing is deleted: wallet history and orders are kept.</p>
          ${s.is_active ? '<button class="btn secondary sm" id="adminResetPw" style="margin-top:10px">Reset password</button>' : ''}
        </div>
      </div>`;
    $('#walletTxns').classList.remove('hidden');
    $('#walletTxns').innerHTML = `
      <h3>Full transaction history</h3>
      ${d.transactions.length ? `<table>
        <thead><tr><th>Date</th><th>Type</th><th>Details</th><th class="hide-mobile">By</th><th class="num">Amount</th><th class="num">Balance</th></tr></thead>
        <tbody>${d.transactions.map((t) => `
          <tr>
            <td>${fmtDateTime(t.created_at)}</td>
            <td>${esc(TXN_LABELS[t.type] || t.type)}</td>
            <td><small>${esc(t.reason || '')}${t.receipt_no ? ` · <span class="mono">${esc(t.receipt_no)}</span>` : ''}</small></td>
            <td class="hide-mobile"><small>${esc(t.performed_by_name || 'Student / system')}</small></td>
            <td class="num ${t.amount_cents >= 0 ? 'amount-pos' : 'amount-neg'}">${signedPeso(t.amount_cents)}</td>
            <td class="num">${peso(t.balance_after_cents)}</td>
          </tr>`).join('')}</tbody></table>` : '<div class="empty">No transactions.</div>'}`;

    $('#adjustForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const amt = Number(f.amount.value);
      if (!(await confirmModal('Apply adjustment?', `${amt > 0 ? 'Add' : 'Deduct'} <b>${peso(Math.abs(Math.round(amt * 100)))}</b> ${amt > 0 ? 'to' : 'from'} ${esc(s.full_name)}'s wallet?<br>Reason: ${esc(f.reason.value)}`, 'Apply'))) return;
      try {
        await api(`/api/admin/students/${s.id}/adjust`, { method: 'POST', body: { amount: f.amount.value, reason: f.reason.value } });
        toast('Adjustment applied and logged.');
        openWallet(s.id);
      } catch (err) { toast(err.message, 'error'); }
    });
    if ($('#adminResetPw')) $('#adminResetPw').onclick = () => resetStudentPassword(s, `/api/admin/students/${s.id}/reset-password`);
    $('#toggleStudent').addEventListener('click', async () => {
      const disable = s.is_active;
      const ok = await confirmModal(
        disable ? 'Disable this account?' : 'Enable this account?',
        disable
          ? `<b>${esc(s.full_name)}</b> (${esc(s.login_id)}) will no longer be able to log in.${s.balance_cents > 0 ? `<br><br>Remaining wallet balance: <b>${peso(s.balance_cents)}</b> (kept; not refunded automatically).` : ''}`
          : `<b>${esc(s.full_name)}</b> (${esc(s.login_id)}) will be able to log in again.`,
        disable ? 'Disable account' : 'Enable account', disable ? 'danger' : '');
      if (!ok) return;
      try {
        await api(`/api/admin/students/${s.id}/active`, { method: 'POST', body: { is_active: !disable } });
        toast(disable ? 'Account disabled.' : 'Account enabled.');
        openWallet(s.id);
      } catch (err) { toast(err.message, 'error'); }
    });
    if ($('#resetDemo')) $('#resetDemo').addEventListener('click', async () => {
      try {
        const r = await api(`/api/admin/students/${s.id}/reset-demo`, { method: 'POST' });
        toast(`Demo balance reset to ${peso(r.balance_cents)}.`);
        openWallet(s.id);
      } catch (err) { toast(err.message, 'error'); }
    });
  } catch (err) { toast(err.message, 'error'); }
}
$('#openDemo').addEventListener('click', async () => {
  try {
    const list = await api('/api/students/search?q=2026-0001');
    const demo = list.find((s) => s.is_demo) || list[0];
    if (demo) openWallet(demo.id); else toast('Demo account not found.', 'error');
  } catch (err) { toast(err.message, 'error'); }
});
onTab('wallets', () => { if (walletStudent) openWallet(walletStudent.id); });

// ===================== Suspensions =====================
async function loadSuspensions() {
  try {
    const d = await api('/api/admin/suspensions');
    $('#suspInfo').innerHTML = `<div class="alert info">Rule: <b>${d.no_show_limit} consecutive no-shows</b> → pre-ordering suspended for <b>${d.suspension_days} days</b>.
      A completed pick-up resets the count. Suspensions lift automatically.</div>`;
    const suspended = d.students.filter((s) => s.is_suspended);
    $('#suspTable').innerHTML = d.students.length ? `
      <h3>${suspended.length} currently suspended</h3>
      <table>
        <thead><tr><th>Student</th><th>Status</th><th class="num">Strikes in a row</th><th class="num">Total no-shows</th><th>Last no-show</th><th>Suspension ends</th></tr></thead>
        <tbody>${d.students.map((s) => `
          <tr>
            <td><b>${esc(s.full_name)}</b><br><small class="mono">${esc(s.login_id)}</small></td>
            <td>${s.is_suspended ? '<span class="badge danger">Suspended</span>' : s.consecutive_no_shows > 0 ? '<span class="badge warn">Warning</span>' : '<span class="badge ok">OK</span>'}</td>
            <td class="num">${s.consecutive_no_shows} / ${d.no_show_limit}</td>
            <td class="num">${s.total_no_shows}</td>
            <td>${s.last_no_show ? fmtDateTime(s.last_no_show) : ''}</td>
            <td>${s.is_suspended ? fmtDateTime(s.suspended_until) : ''}</td>
          </tr>`).join('')}</tbody>
      </table>` : '<div class="empty">No students have no-shows. 🎉</div>';
  } catch (err) { toast(err.message, 'error'); }
}
onTab('suspensions', loadSuspensions);

// ===================== Slots & settings =====================
let slots = [];
async function loadSettings() {
  try {
    const [sl, s] = await Promise.all([api('/api/admin/slots'), api('/api/admin/settings')]);
    slots = sl;
    $('#slotTable').innerHTML = slots.length ? `
      <table>
        <thead><tr><th>Slot</th><th>Time</th><th>Order by</th><th>Status</th><th></th></tr></thead>
        <tbody>${slots.map((x) => `
          <tr style="${x.is_active ? '' : 'opacity:0.55'}">
            <td><b>${esc(x.label)}</b></td>
            <td>${fmtTime(x.start_time)} – ${fmtTime(x.end_time)}</td>
            <td><small>${x.cutoff_minutes} min before</small></td>
            <td>${x.is_active ? '<span class="badge ok">Active</span>' : '<span class="badge neutral">Off</span>'}</td>
            <td class="right"><button class="btn secondary sm" data-slot="${x.id}">Edit</button></td>
          </tr>`).join('')}</tbody>
      </table>` : '<div class="empty">No slots yet.</div>';
    const f = $('#settingsForm');
    f.cancel_window_minutes.value = s.cancel_window_minutes;
    f.no_show_limit.value = s.no_show_limit;
    f.suspension_days.value = s.suspension_days;
    f.lunch_end_time.value = s.lunch_end_time;
    f.max_topup.value = s.max_topup_cents / 100;
    f.demo_balance.value = s.demo_balance_cents / 100;
    f.starting_balance.value = (s.starting_balance_cents ?? 100000) / 100;
  } catch (err) { toast(err.message, 'error'); }
}

async function slotDialog(slot) {
  const isNew = !slot;
  slot = slot || { label: '', start_time: '11:30', end_time: '11:50', cutoff_minutes: 30, is_active: true };
  const data = await modal({
    title: isNew ? 'Add pickup slot' : 'Edit pickup slot',
    html: `
      <div class="field"><label>Name</label><input id="sLabel" value="${esc(slot.label)}" placeholder="e.g. Lunch A"></div>
      <div class="grid grid-2">
        <div class="field"><label>Start</label><input id="sStart" type="time" value="${slot.start_time}"></div>
        <div class="field"><label>End</label><input id="sEnd" type="time" value="${slot.end_time}"></div>
      </div>
      <div class="field"><label>Ordering closes (minutes before start)</label><input id="sCut" type="number" min="0" value="${slot.cutoff_minutes}"></div>
      <label class="check"><input type="checkbox" id="sActive" ${slot.is_active ? 'checked' : ''}> Active</label>`,
    buttons: [
      { label: 'Cancel', value: null, class: 'secondary' },
      { label: 'Save', collect: (r) => ({ label: $('#sLabel', r).value, start_time: $('#sStart', r).value, end_time: $('#sEnd', r).value, cutoff_minutes: Number($('#sCut', r).value), is_active: $('#sActive', r).checked }) },
    ],
  });
  if (!data) return;
  try {
    if (isNew) await api('/api/admin/slots', { method: 'POST', body: data });
    else await api(`/api/admin/slots/${slot.id}`, { method: 'PUT', body: data });
    toast('Slot saved.');
    loadSettings();
  } catch (err) { toast(err.message, 'error'); }
}
$('#addSlot').addEventListener('click', () => slotDialog(null));
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-slot]');
  if (b) slotDialog(slots.find((s) => s.id === Number(b.dataset.slot)));
});
$('#settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    const s = await api('/api/admin/settings', {
      method: 'PUT',
      body: {
        cancel_window_minutes: f.cancel_window_minutes.value,
        no_show_limit: f.no_show_limit.value,
        suspension_days: f.suspension_days.value,
        lunch_end_time: f.lunch_end_time.value,
        max_topup_cents: String(Math.round(Number(f.max_topup.value) * 100)),
        demo_balance_cents: String(Math.round(Number(f.demo_balance.value) * 100)),
        starting_balance_cents: String(Math.round(Number(f.starting_balance.value) * 100)),
      },
    });
    ME.settings = s;
    toast('Settings saved.');
  } catch (err) { toast(err.message, 'error'); }
});
onTab('settings', loadSettings);

// ===================== Accounts =====================
const ROLE_NAMES = { staff: 'Canteen Staff', cashier: 'School Cashier', admin: 'Admin' };
async function loadAccounts() {
  try {
    const list = await api('/api/admin/accounts');
    $('#accountsTable').innerHTML = `
      <h2>Back-office accounts</h2>
      <table>
        <thead><tr><th>Name</th><th>Role</th><th>Status</th><th class="right"></th></tr></thead>
        <tbody>${list.map((a) => `
          <tr style="${a.is_active ? '' : 'opacity:0.55'}">
            <td><b>${esc(a.full_name)}</b><br><small class="mono">${esc(a.login_id)}</small></td>
            <td>${ROLE_NAMES[a.role]}</td>
            <td>${a.is_active ? '<span class="badge ok">Active</span>' : '<span class="badge neutral">Disabled</span>'}</td>
            <td class="right" style="white-space:nowrap">
              <button class="btn secondary sm" data-pw="${a.id}" data-name="${esc(a.full_name)}">Reset password</button>
              ${a.id !== ME.id ? `<button class="btn ghost sm" data-acct="${a.id}" data-active="${a.is_active}">${a.is_active ? 'Disable' : 'Enable'}</button>` : ''}
            </td>
          </tr>`).join('')}</tbody>
      </table>`;
  } catch (err) { toast(err.message, 'error'); }
}
$('#accountForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api('/api/admin/accounts', { method: 'POST', body: { role: f.role.value, login_id: f.login_id.value, full_name: f.full_name.value, password: f.password.value } });
    toast('Account created.');
    f.reset();
    loadAccounts();
  } catch (err) { toast(err.message, 'error'); }
});
document.addEventListener('click', async (e) => {
  const pw = e.target.closest('[data-pw]');
  const ac = e.target.closest('[data-acct]');
  if (pw) {
    const password = await modal({
      title: `Reset password: ${pw.dataset.name}`,
      html: '<div class="field"><label>New password (min. 6)</label><input id="newPw" type="password"></div>',
      buttons: [{ label: 'Cancel', value: null, class: 'secondary' }, { label: 'Reset', collect: (r) => $('#newPw', r).value }],
    });
    if (!password) return;
    try { await api(`/api/admin/accounts/${pw.dataset.pw}/password`, { method: 'POST', body: { password } }); toast('Password reset.'); }
    catch (err) { toast(err.message, 'error'); }
  }
  if (ac) {
    try {
      await api(`/api/admin/accounts/${ac.dataset.acct}/active`, { method: 'POST', body: { is_active: ac.dataset.active !== 'true' } });
      loadAccounts();
    } catch (err) { toast(err.message, 'error'); }
  }
});
onTab('accounts', loadAccounts);

(async function init() {
  try {
    if (!(await initShell('admin'))) return;
    studentSearch($('#walletSearch'), (s) => openWallet(s.id));
    startTab('dashboard');
  } catch (err) { toast(err.message, 'error'); }
})();
