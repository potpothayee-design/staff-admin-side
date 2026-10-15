// School Cashier screens (Cashier Workflow steps 2–6).
let selected = null;

function todayManila() {
  return new Date().toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD
}

async function selectStudent(s) {
  selected = await api(`/api/students/${s.id}`);
  $('#selectedStudent').innerHTML = `
    <div class="alert info">
      <div class="row between">
        <span><b>${esc(selected.full_name)}</b><br><span class="mono">${esc(selected.login_id)}</span></span>
        <span class="right"><small>Current balance</small><br><b style="font-size:1.2rem">${peso(selected.balance_cents)}</b></span>
      </div>
      ${!selected.is_active ? '<div style="margin-top:6px"><b>This account is disabled.</b></div>' : ''}
      ${selected.must_change_password ? '<div style="margin-top:6px"><span class="badge warn">Has not set own password yet</span></div>' : ''}
    </div>
    ${selected.is_active ? '<button class="btn ghost sm" id="resetPw" type="button" style="margin-top:8px">Reset password (forgot password)</button>' : ''}`;
  if ($('#resetPw')) $('#resetPw').onclick = () => resetStudentPassword(selected, `/api/cashier/students/${selected.id}/reset-password`);
  $('#topupForm').classList.toggle('hidden', !selected.is_active);
  $('#amount').value = '';
  $('#amount').focus();
  loadTxns();
}

async function loadTxns() {
  if (!selected) return;
  const list = await api(`/api/cashier/student/${selected.id}/transactions`);
  $('#studentTxns').innerHTML = list.length
    ? `<table>
        <thead><tr><th>Date</th><th>Type</th><th class="num">Amount</th><th class="num">Balance</th><th></th></tr></thead>
        <tbody>${list.map((t) => `
          <tr>
            <td><small>${fmtDateTime(t.created_at)}${t.receipt_no ? `<br><span class="mono">${esc(t.receipt_no)}</span>` : ''}</small></td>
            <td>${esc(TXN_LABELS[t.type] || t.type)}${t.is_reversed ? ' <span class="badge neutral">reversed</span>' : ''}</td>
            <td class="num ${t.amount_cents >= 0 ? 'amount-pos' : 'amount-neg'}">${signedPeso(t.amount_cents)}</td>
            <td class="num">${peso(t.balance_after_cents)}</td>
            <td class="right">${t.type === 'topup' && t.is_today && !t.is_reversed
              ? `<button class="btn secondary sm" data-reverse="${t.id}" data-amt="${t.amount_cents}" data-receipt="${esc(t.receipt_no || '')}">Reverse</button>` : ''}</td>
          </tr>`).join('')}</tbody>
      </table>`
    : '<div class="empty">No wallet activity yet.</div>';
}

$$('[data-amt]').forEach((c) => c.addEventListener('click', () => { $('#amount').value = c.dataset.amt; }));

$('#topupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const amount = Number($('#amount').value);
  if (!selected || !(amount >= 1)) return toast('Enter a valid amount (minimum ₱1.00).', 'error');
  const ok = await confirmModal('Confirm top-up',
    `Add <b>${peso(Math.round(amount * 100))}</b> to <b>${esc(selected.full_name)}</b> (${esc(selected.login_id)})?<br>
     Make sure you have received the cash.`, 'Confirm top-up');
  if (!ok) return;
  const btn = e.submitter;
  withBusy(btn, async () => {
    try {
      const r = await api('/api/cashier/topup', { method: 'POST', body: { student_id: selected.id, amount } });
      modal({
        title: 'Top-up receipt',
        html: `
          <div class="glass-card" style="background:#fff">
            <div class="row between"><span class="muted">Receipt no.</span><b class="mono">${esc(r.receipt_no)}</b></div>
            <div class="row between"><span class="muted">Date</span><span>${fmtDateTime(r.created_at)}</span></div>
            <div class="row between"><span class="muted">Student</span><span>${esc(r.student.full_name)}</span></div>
            <div class="row between"><span class="muted">School ID</span><span class="mono">${esc(r.student.login_id)}</span></div>
            <div class="row between"><span class="muted">Cashier</span><span>${esc(r.cashier)}</span></div>
            <div class="divider"></div>
            <div class="row between"><b>Amount added</b><b class="amount-pos">${peso(r.amount_cents)}</b></div>
            <div class="row between"><b>New balance</b><b>${peso(r.new_balance_cents)}</b></div>
          </div>`,
        buttons: [{ label: 'Print', value: 'print', class: 'secondary' }, { label: 'Done', value: true }],
      }).then((v) => { if (v === 'print') window.print(); });
      selectStudent(selected);
    } catch (err) { toast(err.message, 'error'); }
  });
});

document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-reverse]');
  if (!b) return;
  const reason = await modal({
    title: 'Reverse top-up',
    html: `<p>Reverse top-up <b class="mono">${esc(b.dataset.receipt)}</b> of <b>${peso(Number(b.dataset.amt))}</b>?
           A reversal entry is logged. The original record is kept.</p>
           <div class="field"><label>Reason (required)</label><input id="revReason" placeholder="e.g. Typed 500 instead of 50"></div>
           <div id="revMsg"></div>`,
    buttons: [
      { label: 'Cancel', value: null, class: 'secondary' },
      {
        label: 'Reverse', class: 'danger',
        validate: (r) => { if ($('#revReason', r).value.trim().length < 3) { showError($('#revMsg', r), 'Please enter a reason.'); return false; } return true; },
        collect: (r) => $('#revReason', r).value.trim(),
      },
    ],
    onOpen: (r) => $('#revReason', r).focus(),
  });
  if (!reason) return;
  try {
    const r = await api('/api/cashier/reverse', { method: 'POST', body: { transaction_id: Number(b.dataset.reverse), reason } });
    toast(`Top-up reversed. New balance: ${peso(r.new_balance_cents)}`);
    selectStudent(selected);
  } catch (err) { toast(err.message, 'error'); }
});

// ---------- New student account ----------
$('#nsId').addEventListener('input', (e) => {
  const d = e.target.value.replace(/\D/g, '').slice(0, 8);
  e.target.value = [d.slice(0, 2), d.slice(2, 4), d.slice(4, 8)].filter(Boolean).join('-');
});
$('#nsNoMiddle').addEventListener('change', (e) => {
  $('#nsMiddle').disabled = e.target.checked;
  $('#nsMiddle').required = !e.target.checked;
  if (e.target.checked) $('#nsMiddle').value = '';
});
$('#nsForm').addEventListener('submit', (e) => {
  e.preventDefault();
  showError($('#nsMsg'), '');
  if (!$('#nsChecked').checked) return showError($('#nsMsg'), "Check the student's school ID card first, then tick the box.");
  withBusy(e.submitter, async () => {
    try {
      const r = await api('/api/cashier/students', {
        method: 'POST',
        body: {
          school_id: $('#nsId').value,
          first_name: $('#nsFirst').value,
          middle_name: $('#nsMiddle').value,
          no_middle_name: $('#nsNoMiddle').checked,
          last_name: $('#nsLast').value,
          id_checked: $('#nsChecked').checked,
        },
      });
      e.target.reset();
      $('#nsMiddle').disabled = false; $('#nsMiddle').required = true;
      showSlip(r, false);
    } catch (err) { showError($('#nsMsg'), err.message); }
  });
});
onTab('newstudent', () => {
  $('#nsStart').textContent = peso(ME.settings.starting_balance_cents);
  setTimeout(() => $('#nsId').focus(), 50);
});

// ---------- End-of-day report ----------
async function loadReport() {
  const date = $('#reportDate').value || todayManila();
  try {
    const d = await api(`/api/cashier/report?date=${date}`);
    const s = d.summary;
    $('#reportBody').innerHTML = `
      <div class="glass-card">
        <h3>Top-ups for ${fmtDate(s.date)}</h3>
        <div class="grid grid-4" style="margin-top:10px">
          <div class="stat"><div class="label">Top-ups</div><div class="value">${s.topup_count}</div></div>
          <div class="stat"><div class="label">Total topped up</div><div class="value">${peso(s.topup_total_cents)}</div></div>
          <div class="stat"><div class="label">Reversals (${s.reversal_count})</div><div class="value amount-neg">${peso(Math.abs(s.reversal_total_cents))}</div></div>
          <div class="stat"><div class="label">Net cash expected</div><div class="value amount-pos">${peso(s.net_cash_cents)}</div></div>
        </div>
      </div>
      <div class="glass-card">
        <h3>New student accounts</h3>
        <div class="grid grid-4" style="margin-top:10px">
          <div class="stat"><div class="label">Accounts created</div><div class="value">${s.new_accounts}</div></div>
          <div class="stat"><div class="label">Starting balance issued</div><div class="value">${peso(s.starting_issued_cents)}</div></div>
        </div>
        ${d.new_accounts.length ? `<div class="table-wrap" style="margin-top:10px"><table>
          <thead><tr><th>Time</th><th>Student</th><th class="num">Starting balance</th><th class="hide-mobile">Created by</th></tr></thead>
          <tbody>${d.new_accounts.map((a) => `<tr><td>${fmtDateTime(a.created_at)}</td><td>${esc(a.full_name)}<br><small class="mono">${esc(a.login_id)}</small></td>
            <td class="num">${peso(a.starting_cents)}</td><td class="hide-mobile">${esc(a.cashier || '')}</td></tr>`).join('')}</tbody></table></div>` : ''}
        <p class="muted" style="font-size:0.8rem;margin:8px 0 0">Starting balances are not cash received; they are listed so they can be accounted for.</p>
      </div>
      ${d.by_cashier.length ? `
      <div class="glass-card table-wrap">
        <h3>By cashier</h3>
        <table><thead><tr><th>Cashier</th><th class="num">Top-ups</th><th class="num">Net amount</th></tr></thead>
        <tbody>${d.by_cashier.map((c) => `<tr><td>${esc(c.cashier)}</td><td class="num">${c.topups}</td><td class="num">${peso(c.net_cents)}</td></tr>`).join('')}</tbody></table>
      </div>` : ''}
      <div class="glass-card table-wrap">
        <h3>All entries</h3>
        ${d.entries.length ? `
        <table><thead><tr><th>Time</th><th>Receipt</th><th>Student</th><th>Type</th><th class="num">Amount</th><th class="hide-mobile">Cashier</th></tr></thead>
        <tbody>${d.entries.map((t) => `
          <tr>
            <td>${fmtDateTime(t.created_at)}</td>
            <td class="mono">${esc(t.receipt_no || '')}</td>
            <td>${esc(t.student_name)}<br><small class="mono">${esc(t.login_id)}</small></td>
            <td>${esc(TXN_LABELS[t.type])}${t.type === 'reversal' ? `<br><small>${esc(t.reason)}</small>` : ''}</td>
            <td class="num ${t.amount_cents >= 0 ? 'amount-pos' : 'amount-neg'}">${signedPeso(t.amount_cents)}</td>
            <td class="hide-mobile">${esc(t.cashier || '')}</td>
          </tr>`).join('')}</tbody></table>` : '<div class="empty">No top-ups on this day.</div>'}
      </div>`;
  } catch (err) { toast(err.message, 'error'); }
}
$('#reportDate').addEventListener('change', loadReport);
onTab('report', loadReport);

(async function init() {
  try {
    if (!(await initShell('cashier'))) return;
    $('#reportDate').value = todayManila();
    studentSearch($('#topupSearch'), selectStudent);
    startTab('topup');
  } catch (err) { toast(err.message, 'error'); }
})();
