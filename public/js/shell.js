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
                <span class="right">${peso(s.balance_cents)}${s.is_suspended ? '<br><span class="badge danger">Suspended</span>' : ''}${!s.is_active ? '<br><span class="badge neutral">Disabled</span>' : ''}</span>
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
