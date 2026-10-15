// Back-office page shell: role check, header, tab switching, student search widget.
let ME = null;

async function initShell(requiredRole) {
  ME = await api('/api/auth/me');
  if (ME.role !== requiredRole) { location.href = ME.home; return null; }
  $('#userName').textContent = `${ME.full_name} · ${ME.role[0].toUpperCase() + ME.role.slice(1)}`;
  initTabs();
  return ME;
}

// Tabs: <nav class="nav"><button data-tab="queue">…  +  <section id="tab-queue">
const tabHandlers = {};
function onTab(name, fn) { tabHandlers[name] = fn; }
function showTab(name) {
  $$('.nav [data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('section[id^="tab-"]').forEach((s) => s.classList.toggle('hidden', s.id !== `tab-${name}`));
  history.replaceState(null, '', `#${name}`);
  if (tabHandlers[name]) tabHandlers[name]();
}
function initTabs() {
  $$('.nav [data-tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
}
function startTab(defaultTab) {
  const fromHash = location.hash.slice(1);
  showTab($(`.nav [data-tab="${fromHash}"]`) ? fromHash : defaultTab);
}
const currentTab = () => ($('.nav [data-tab].active') || {}).dataset?.tab;

// Reusable student search. Calls onSelect(student) when a result is clicked.
function studentSearch(container, onSelect, placeholder = 'Search by School ID or name…') {
  container.innerHTML = `
    <input type="search" placeholder="${esc(placeholder)}" autocomplete="off" class="ss-input">
    <div class="ss-results" style="margin-top:8px"></div>`;
  const input = $('.ss-input', container);
  const results = $('.ss-results', container);
  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = input.value.trim();
      if (q.length < 2) { results.innerHTML = ''; return; }
      try {
        const list = await api(`/api/students/search?q=${encodeURIComponent(q)}`);
        results.innerHTML = list.length
          ? list.map((s, i) => `
              <div class="slot-option" data-i="${i}" style="margin-bottom:6px">
                <span><b>${esc(s.full_name)}</b><br><small class="mono">${esc(s.login_id)}</small></span>
                <span class="right">${[
                  typeof s.balance_cents === 'number' ? peso(s.balance_cents) : '',
                  s.is_suspended ? '<span class="badge danger">Suspended</span>' : '',
                  !s.is_active ? '<span class="badge neutral">Disabled</span>' : '',
                ].filter(Boolean).join('<br>')}</span>
              </div>`).join('')
          : '<div class="muted" style="padding:8px">No students found.</div>';
        $$('[data-i]', results).forEach((el) => el.addEventListener('click', () => {
          results.innerHTML = '';
          input.value = '';
          onSelect(list[Number(el.dataset.i)]);
        }));
      } catch (err) { results.innerHTML = `<div class="alert error">${esc(err.message)}</div>`; }
    }, 250);
  });
  return { focus: () => input.focus() };
}

function changePasswordDialog() {
  modal({
    title: 'Change password',
    html: `<div class="field"><label>Current password</label><input type="password" id="cpw"></div>
           <div class="field"><label>New password (min. 8)</label><input type="password" id="npw"></div>`,
    buttons: [
      { label: 'Cancel', value: null, class: 'secondary' },
      { label: 'Save', collect: (r) => ({ current_password: $('#cpw', r).value, new_password: $('#npw', r).value }) },
    ],
  }).then(async (data) => {
    if (!data) return;
    try { await api('/api/auth/change-password', { method: 'POST', body: data }); toast('Password changed.'); }
    catch (err) { toast(err.message, 'error'); }
  });
}

// ---------- Student account slip (temporary password) ----------
// Shown after the cashier creates an account or anyone resets a password. Can be printed.
function slipHtml(r, isReset) {
  const url = (ME && ME.student_app_url) || '';
  return `
    <div class="slip">
      <div class="row between"><b>CanteenGo</b><small class="muted">${isReset ? 'Password reset' : 'New student account'}</small></div>
      <div class="divider" style="margin:10px 0"></div>
      <div class="row between"><span class="muted">Name</span><b>${esc(r.student.full_name)}</b></div>
      <div class="row between"><span class="muted">School ID (login)</span><b class="mono">${esc(r.student.login_id)}</b></div>
      ${!isReset && r.student.balance_cents ? `<div class="row between"><span class="muted">Starting balance</span><b>${peso(r.student.balance_cents)}</b></div>` : ''}
      <div style="margin-top:10px" class="muted">Temporary password</div>
      <div class="temp">${esc(r.temp_password)}</div>
      <ol>
        ${url ? `<li>Open <span class="url">${esc(url)}</span></li>` : '<li>Open the CanteenGo student app.</li>'}
        <li>Log in with your School ID and this temporary password.</li>
        <li>Set your own password (you can change it once every 7 days).</li>
      </ol>
      <div class="divider" style="margin:10px 0"></div>
      <small class="muted">Issued by ${esc(r.cashier)} · ${esc(fmtDateTime(new Date().toISOString()))} · Keep this slip private.</small>
    </div>`;
}
function showSlip(r, isReset = false) {
  const html = slipHtml(r, isReset);
  return modal({
    title: isReset ? 'Password reset' : 'Account created',
    html: `${isReset ? '' : '<div class="alert success" style="margin-bottom:12px">Account created. Give this slip to the student.</div>'}${html}
           <p class="muted" style="font-size:0.82rem;margin:10px 0 0">The temporary password is shown only now. Print it or let the student take a photo.</p>`,
    buttons: [{ label: 'Print slip', value: 'print', class: 'secondary' }, { label: 'Done', value: true }],
  }).then((v) => {
    if (v !== 'print') return;
    let el = document.getElementById('printSlip');
    if (!el) { el = document.createElement('div'); el.id = 'printSlip'; document.body.appendChild(el); }
    el.innerHTML = html;
    document.body.classList.add('print-slip');
    window.print();
    setTimeout(() => { document.body.classList.remove('print-slip'); el.innerHTML = ''; }, 500);
  });
}

// Confirm, then reset a student's password and show the slip.
async function resetStudentPassword(student, endpoint) {
  const ok = await confirmModal('Reset password?',
    `Create a new temporary password for <b>${esc(student.full_name)}</b> (${esc(student.login_id)})?<br>
     Check the student's school ID card first. Their old password will stop working.`, 'Reset password', 'warning');
  if (!ok) return;
  try {
    const r = await api(endpoint, { method: 'POST' });
    showSlip(r, true);
  } catch (err) { toast(err.message, 'error'); }
}
