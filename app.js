/* ====================== FIREBASE CONFIG ====================== */
const firebaseConfig = {
  apiKey: "AIzaSyCemVHrdqncmTUDnR4KwLr-nb4_lmdMD6w",
  authDomain: "reports-project-e8f66.firebaseapp.com",
  databaseURL: "https://reports-project-e8f66-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "reports-project-e8f66",
  storageBucket: "reports-project-e8f66.firebasestorage.app",
  messagingSenderId: "446361408809",
  appId: "1:446361408809:web:dbbc988f92a37e156ed338"
};
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.database();
const ROOT = "importReports";

/* ====================== STATE ====================== */
let currentUser = null;       // {id, name}
let pendingLoginUser = null;  // user being PIN-verified
let enteredPin = "";
let usersCache = {};          // {uid: {name, pin}}
let invoicesCache = {};       // {invId: {...}}
let editingInvoiceId = null;
let listFilter = "all";
let currentReportType = null;

/* ====================== UTIL ====================== */
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}
function fmtMoney(n) {
  n = Number(n) || 0;
  return '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}
function fmtDate(d) {
  if (!d) return '-';
  const dt = new Date(d);
  if (isNaN(dt)) return d;
  return dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
function todayISO() {
  return new Date().toISOString().split('T')[0];
}
function remitStatus(total, advance, balance) {
  total = Number(total) || 0;
  advance = Number(advance) || 0;
  balance = Number(balance) || 0;
  const paid = advance;
  if (balance <= 0 && (advance > 0 || total > 0)) {
    if (total > 0 && advance >= total) return 'completed';
    if (balance === 0 && advance > 0) return 'completed';
  }
  if (advance > 0 && balance > 0) return 'partial';
  if (advance === 0 && balance === 0 && total === 0) return 'pending';
  if (advance === 0) return 'pending';
  return 'partial';
}
function statusLabel(s) {
  return { pending: 'Pending', partial: 'Partial', completed: 'Completed' }[s] || s;
}
function initials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}

/* ====================== LOGIN FLOW ====================== */
const pinPadKeys = ['1','2','3','4','5','6','7','8','9','','0','⌫'];

function renderPinPad() {
  const pad = document.getElementById('pinPad');
  pad.innerHTML = '';
  pinPadKeys.forEach(k => {
    const btn = document.createElement('button');
    btn.className = 'pin-key' + (k === '' ? ' empty' : '');
    btn.textContent = k;
    if (k !== '') btn.onclick = () => handlePinKey(k);
    pad.appendChild(btn);
  });
}
function renderPinDots() {
  const wrap = document.getElementById('pinDisplay');
  wrap.innerHTML = '';
  for (let i = 0; i < 4; i++) {
    const dot = document.createElement('div');
    dot.className = 'pin-dot' + (i < enteredPin.length ? ' filled' : '');
    wrap.appendChild(dot);
  }
}
function handlePinKey(k) {
  document.getElementById('loginErr').textContent = '';
  if (k === '⌫') {
    enteredPin = enteredPin.slice(0, -1);
  } else if (enteredPin.length < 4) {
    enteredPin += k;
  }
  renderPinDots();
  if (enteredPin.length === 4) {
    setTimeout(verifyPin, 150);
  }
}
function verifyPin() {
  if (!pendingLoginUser) return;
  if (enteredPin === pendingLoginUser.pin) {
    currentUser = { id: pendingLoginUser.id, name: pendingLoginUser.name };
    sessionStorage_set();
    doFirebaseSignInAndEnterApp();
  } else {
    document.getElementById('loginErr').textContent = 'Wrong PIN, please try again';
    enteredPin = '';
    renderPinDots();
  }
}
function sessionStorage_set() {
  try { window.__currentUserMem = currentUser; } catch(e) {}
}
function renderUserList() {
  const wrap = document.getElementById('userListWrap');
  const loading = document.getElementById('userListLoading');
  wrap.innerHTML = '';
  const ids = Object.keys(usersCache);
  if (ids.length === 0) {
    loading.textContent = 'No users found. Please create a user in Firebase first.';
    return;
  }
  loading.classList.add('hidden');
  ids.forEach(uid => {
    const u = usersCache[uid];
    const card = document.createElement('button');
    card.className = 'user-card';
    card.style.width = '100%';
    card.style.border = 'none';
    card.innerHTML = `<span class="av">${initials(u.name)}</span><span>${u.name}</span>`;
    card.onclick = () => {
      pendingLoginUser = { id: uid, name: u.name, pin: u.pin };
      enteredPin = '';
      document.getElementById('pinEntryName').textContent = '👋 ' + u.name;
      document.getElementById('userSelectBox').classList.add('hidden');
      document.getElementById('pinEntryBox').classList.remove('hidden');
      renderPinDots();
    };
    wrap.appendChild(card);
  });
}
function backToUserSelect() {
  document.getElementById('pinEntryBox').classList.add('hidden');
  document.getElementById('userSelectBox').classList.remove('hidden');
  enteredPin = '';
  pendingLoginUser = null;
  document.getElementById('loginErr').textContent = '';
}

function loadUsersForLogin() {
  db.ref(ROOT + '/users').once('value').then(snap => {
    usersCache = snap.val() || {};
    if (Object.keys(usersCache).length === 0) {
      // bootstrap default users on very first run (no auth yet, so this only
      // works if rules allow it pre-auth... they don't, so instead we sign in
      // anonymously first, then seed if empty)
      anonAuthThenBootstrap();
    } else {
      renderUserList();
    }
  }).catch(() => {
    // Not authed yet — sign in anonymously first to read users (rules require auth)
    anonAuthThenBootstrap();
  });
}
function anonAuthThenBootstrap() {
  auth.signInAnonymously().then(() => {
    db.ref(ROOT + '/users').once('value').then(snap => {
      usersCache = snap.val() || {};
      if (Object.keys(usersCache).length === 0) {
        const seed = {
          u1: { name: 'Ramesh', pin: '1234' },
          u2: { name: 'User2', pin: '5678' }
        };
        db.ref(ROOT + '/users').set(seed).then(() => {
          usersCache = seed;
          renderUserList();
        });
      } else {
        renderUserList();
      }
    });
  }).catch(err => {
    document.getElementById('userListLoading').textContent = 'Connection error: ' + err.message;
  });
}

function doFirebaseSignInAndEnterApp() {
  if (auth.currentUser) {
    enterApp();
  } else {
    auth.signInAnonymously().then(enterApp).catch(err => {
      toast('Login error: ' + err.message);
    });
  }
}

function enterApp() {
  document.getElementById('loginScreen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  attachInvoicesListener();
  renderSettingsUserList();
}

function lockApp() {
  currentUser = null;
  pendingLoginUser = null;
  enteredPin = '';
  document.getElementById('app').classList.add('hidden');
  document.getElementById('loginScreen').classList.remove('hidden');
  document.getElementById('pinEntryBox').classList.add('hidden');
  document.getElementById('userSelectBox').classList.remove('hidden');
  renderUserList();
}

/* ====================== TABS ====================== */
function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  ['list','reports','settings'].forEach(t => {
    document.getElementById('tab-' + t).classList.toggle('hidden', t !== tab);
  });
  document.getElementById('fabAdd').classList.toggle('hidden', tab !== 'list');
  if (tab === 'settings') renderSettingsUserList();
}

/* ====================== INVOICES: LIVE DATA ====================== */
function attachInvoicesListener() {
  db.ref(ROOT + '/invoices').on('value', snap => {
    invoicesCache = snap.val() || {};
    renderSummary();
    renderInvoiceList();
  });
}

function renderSummary() {
  const list = Object.values(invoicesCache);
  const total = list.length;
  const tension = list.filter(i => i.tension).length;
  const pending = list.filter(i => remitStatus(i.total, i.advance, i.balance) !== 'completed').length;
  const completed = list.filter(i => remitStatus(i.total, i.advance, i.balance) === 'completed').length;
  document.getElementById('sTotal').textContent = total;
  document.getElementById('sTension').textContent = tension;
  document.getElementById('sPending').textContent = pending;
  document.getElementById('sCompleted').textContent = completed;
}

function setListFilter(f) {
  listFilter = f;
  document.querySelectorAll('#listFilterBar .filter-chip').forEach(c => c.classList.toggle('active', c.dataset.f === f));
  renderInvoiceList();
}

function getFilteredInvoices() {
  let entries = Object.entries(invoicesCache);
  entries.sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));
  if (listFilter === 'tension') entries = entries.filter(([id, i]) => i.tension);
  else if (listFilter === 'pending') entries = entries.filter(([id, i]) => remitStatus(i.total, i.advance, i.balance) !== 'completed');
  else if (listFilter === 'completed') entries = entries.filter(([id, i]) => remitStatus(i.total, i.advance, i.balance) === 'completed');
  return entries;
}

function renderInvoiceList() {
  const wrap = document.getElementById('invoiceList');
  const entries = getFilteredInvoices();
  if (entries.length === 0) {
    wrap.innerHTML = '<div class="empty">📭 No invoices yet.<br>Tap the + button below to add one.</div>';
    return;
  }
  wrap.innerHTML = entries.map(([id, inv]) => {
    const rs = remitStatus(inv.total, inv.advance, inv.balance);
    const cardClass = inv.tension ? 'tension' : (rs === 'completed' ? 'ok' : '');
    return `
      <div class="card ${cardClass}">
        <div class="top">
          <div>
            <div class="inv">🧾 ${escapeHtml(inv.invNo || '-')}</div>
            <div class="date">${fmtDate(inv.date)}${inv.addedBy ? ' · by ' + escapeHtml(inv.addedBy) : ''}</div>
          </div>
        </div>
        <div class="badges">
          <span class="badge ${rs}">💰 ${statusLabel(rs)}</span>
          <span class="badge ${inv.tension ? 'tension-yes' : 'tension-no'}">${inv.tension ? '⚠️ Issue' : '✅ No Issue'}</span>
        </div>
        <div class="row2"><span>Supplier</span><b>${escapeHtml(inv.supplier || '-')}</b></div>
        <div class="row2"><span>Customer</span><b>${escapeHtml(inv.customer || '-')}</b></div>
        <div class="row2"><span>Package</span><b>${escapeHtml(truncate(inv.package, 40))}</b></div>
        ${inv.total ? `<div class="row2"><span>Total</span><b>${fmtMoney(inv.total)}</b></div>` : ''}
        ${(inv.advance || inv.balance) ? `<div class="row2"><span>Advance / Balance</span><b>${fmtMoney(inv.advance)} / ${fmtMoney(inv.balance)}</b></div>` : ''}
        <div class="row2"><span>Remittance</span><b>${inv.remitType === '3rdparty' ? '🔁 3rd Party' + (inv.remitThirdParty ? ' (' + escapeHtml(inv.remitThirdParty) + ')' : '') : '➡️ Direct'}</b></div>
        <div class="actions">
          <button onclick="openInvoiceModal('${id}')">✏️ Edit</button>
          <button class="danger" onclick="deleteInvoice('${id}')">🗑️ Delete</button>
        </div>
      </div>`;
  }).join('');
}

function escapeHtml(s) {
  if (s === undefined || s === null) return '';
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function truncate(s, n) {
  if (!s) return '-';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/* ====================== ADD/EDIT INVOICE MODAL ====================== */
function openInvoiceModal(id) {
  editingInvoiceId = id || null;
  document.getElementById('modalTitle').textContent = id ? 'Invoice Edit' : 'New Invoice';
  if (id && invoicesCache[id]) {
    const inv = invoicesCache[id];
    document.getElementById('f_invno').value = inv.invNo || '';
    document.getElementById('f_date').value = inv.date || '';
    document.getElementById('f_supplier').value = inv.supplier || '';
    document.getElementById('f_customer').value = inv.customer || '';
    document.getElementById('f_package').value = inv.package || '';
    document.getElementById('f_total').value = inv.total || '';
    document.getElementById('f_advance').value = inv.advance || '';
    document.getElementById('f_balance').value = inv.balance || '';
    document.getElementById('f_remitType').value = inv.remitType || 'direct';
    document.getElementById('f_remitThirdParty').value = inv.remitThirdParty || '';
    document.getElementById('f_tension').checked = !!inv.tension;
    document.getElementById('f_notes').value = inv.notes || '';
  } else {
    document.getElementById('f_invno').value = '';
    document.getElementById('f_date').value = todayISO();
    document.getElementById('f_supplier').value = '';
    document.getElementById('f_customer').value = '';
    document.getElementById('f_package').value = '';
    document.getElementById('f_total').value = '';
    document.getElementById('f_advance').value = '';
    document.getElementById('f_balance').value = '';
    document.getElementById('f_remitType').value = 'direct';
    document.getElementById('f_remitThirdParty').value = '';
    document.getElementById('f_tension').checked = false;
    document.getElementById('f_notes').value = '';
  }
  toggleThirdPartyField();
  updateBalanceHint();
  document.getElementById('invoiceModalOverlay').classList.remove('hidden');
}
function closeInvoiceModal() {
  document.getElementById('invoiceModalOverlay').classList.add('hidden');
  editingInvoiceId = null;
}
function toggleThirdPartyField() {
  const type = document.getElementById('f_remitType').value;
  document.getElementById('thirdPartyNameWrap').classList.toggle('hidden', type !== '3rdparty');
}

function updateBalanceHint() {
  const total = Number(document.getElementById('f_total').value) || 0;
  const adv = Number(document.getElementById('f_advance').value) || 0;
  if (total > 0) {
    const bal = Math.max(total - adv, 0);
    document.getElementById('f_balance').value = bal ? bal : '';
    document.getElementById('balanceHint').textContent = `Balance = Total (${fmtMoney(total)}) − Advance (${fmtMoney(adv)}) = ${fmtMoney(bal)}`;
  } else {
    document.getElementById('balanceHint').textContent = '';
  }
}
function showBalanceHint() {
  const total = Number(document.getElementById('f_total').value) || 0;
  const adv = Number(document.getElementById('f_advance').value) || 0;
  const bal = Number(document.getElementById('f_balance').value) || 0;
  if (total > 0) {
    document.getElementById('balanceHint').textContent = `Balance = Total (${fmtMoney(total)}) − Advance (${fmtMoney(adv)}) = ${fmtMoney(bal)}`;
  } else if (adv > 0 || bal > 0) {
    document.getElementById('balanceHint').textContent = `Advance + Balance = ${fmtMoney(adv + bal)}`;
  } else {
    document.getElementById('balanceHint').textContent = '';
  }
}
function saveInvoice() {
  const invNo = document.getElementById('f_invno').value.trim();
  const supplier = document.getElementById('f_supplier').value.trim();
  const customer = document.getElementById('f_customer').value.trim();
  const pkg = document.getElementById('f_package').value.trim();
  const remitType = document.getElementById('f_remitType').value;
  const remitThirdParty = document.getElementById('f_remitThirdParty').value.trim();
  if (!invNo || !supplier || !customer || !pkg) {
    toast('⚠️ Please fill Invoice No, Supplier, Customer, and Package');
    return;
  }
  if (remitType === '3rdparty' && !remitThirdParty) {
    toast('⚠️ Please enter 3rd Party Name');
    return;
  }
  const data = {
    invNo, supplier, customer, package: pkg,
    date: document.getElementById('f_date').value || todayISO(),
    total: Number(document.getElementById('f_total').value) || 0,
    advance: Number(document.getElementById('f_advance').value) || 0,
    balance: Number(document.getElementById('f_balance').value) || 0,
    remitType,
    remitThirdParty: remitType === '3rdparty' ? remitThirdParty : '',
    tension: document.getElementById('f_tension').checked,
    notes: document.getElementById('f_notes').value.trim(),
    addedBy: currentUser ? currentUser.name : 'Unknown',
    updatedAt: Date.now()
  };
  const ref = editingInvoiceId
    ? db.ref(ROOT + '/invoices/' + editingInvoiceId)
    : db.ref(ROOT + '/invoices').push();
  if (!editingInvoiceId) data.createdAt = Date.now();
  if (editingInvoiceId) {
    db.ref(ROOT + '/invoices/' + editingInvoiceId).update(data).then(() => {
      toast('✅ Invoice updated');
      closeInvoiceModal();
    }).catch(err => toast('Error: ' + err.message));
  } else {
    db.ref(ROOT + '/invoices').push(data).then(() => {
      toast('✅ Invoice saved');
      closeInvoiceModal();
    }).catch(err => toast('Error: ' + err.message));
  }
}
function deleteInvoice(id) {
  if (!confirm('Delete this invoice? This is permanent.')) return;
  db.ref(ROOT + '/invoices/' + id).remove().then(() => toast('🗑️ Deleted'));
}

/* ====================== SETTINGS: USERS ====================== */
function renderSettingsUserList() {
  db.ref(ROOT + '/users').once('value').then(snap => {
    const users = snap.val() || {};
    usersCache = users;
    const wrap = document.getElementById('settingsUserList');
    const ids = Object.keys(users);
    if (ids.length === 0) {
      wrap.innerHTML = '<p style="font-size:12px;color:#888;">No users found</p>';
      return;
    }
    wrap.innerHTML = ids.map(uid => {
      const u = users[uid];
      return `
        <div class="card" style="display:flex;align-items:center;justify-content:space-between;padding:12px 14px;">
          <div style="display:flex;align-items:center;gap:10px;">
            <span class="user-card av" style="width:32px;height:32px;background:#e0f2f1;color:#0f766e;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;">${initials(u.name)}</span>
            <span style="font-size:14px;font-weight:600;">${escapeHtml(u.name)}</span>
          </div>
          <div style="display:flex;gap:6px;">
            <button onclick="editUserPin('${uid}','${escapeHtml(u.name)}')" style="border:1px solid #ddd;background:#fafafa;border-radius:8px;padding:6px 10px;font-size:11px;">Change PIN</button>
            <button onclick="deleteUser('${uid}')" style="border:1px solid #fecaca;color:#dc2626;background:#fff;border-radius:8px;padding:6px 10px;font-size:11px;">Remove</button>
          </div>
        </div>`;
    }).join('');
  });
}
function openAddUserModal() {
  document.getElementById('au_name').value = '';
  document.getElementById('au_pin').value = '';
  document.getElementById('addUserModalOverlay').classList.remove('hidden');
}
function closeAddUserModal() {
  document.getElementById('addUserModalOverlay').classList.add('hidden');
}
function saveNewUser() {
  const name = document.getElementById('au_name').value.trim();
  const pin = document.getElementById('au_pin').value.trim();
  if (!name || !/^\d{4}$/.test(pin)) {
    toast('⚠️ Please enter a name and a valid 4-digit PIN');
    return;
  }
  db.ref(ROOT + '/users').push({ name, pin }).then(() => {
    toast('✅ User added');
    closeAddUserModal();
    renderSettingsUserList();
  });
}
function editUserPin(uid, name) {
  const newPin = prompt('New 4-digit PIN for ' + name + ':');
  if (newPin === null) return;
  if (!/^\d{4}$/.test(newPin)) { toast('⚠️ Please enter a 4-digit PIN'); return; }
  db.ref(ROOT + '/users/' + uid + '/pin').set(newPin).then(() => {
    toast('✅ PIN updated');
  });
}
function deleteUser(uid) {
  if (Object.keys(usersCache).length <= 1) {
    toast('⚠️ Cannot remove the last user');
    return;
  }
  if (!confirm('Remove this user?')) return;
  db.ref(ROOT + '/users/' + uid).remove().then(() => {
    toast('🗑️ User removed');
    renderSettingsUserList();
  });
}

/* ====================== BACKUP EXPORT ====================== */
function exportJSONBackup() {
  db.ref(ROOT).once('value').then(snap => {
    const data = snap.val() || {};
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'import-reports-backup-' + todayISO() + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast('⬇️ Backup downloaded');
  }).catch(err => toast('Error: ' + err.message));
}

/* ====================== REPORTS ====================== */
function openReport(type) {
  currentReportType = type;
  const titles = {
    invoice: '🧾 Invoice-wise Status',
    package: '📦 Package-wise Status',
    daterange: '📅 Date Range Report',
    tension: '⚠️ Issue / Pending Cases',
    remittance: '💰 Remittance Pending',
    summary: '📈 Summary Dashboard'
  };
  document.getElementById('reportTitle').textContent = titles[type] || 'Report';
  const dateFilterWrap = document.getElementById('reportDateFilter');
  const applyBtn = document.getElementById('rep_applyDate');
  if (type === 'daterange') {
    dateFilterWrap.classList.remove('hidden');
    applyBtn.classList.remove('hidden');
    document.getElementById('rep_from').value = '';
    document.getElementById('rep_to').value = '';
  } else {
    dateFilterWrap.classList.add('hidden');
    applyBtn.classList.add('hidden');
  }
  document.getElementById('reportModalOverlay').classList.remove('hidden');
  renderReportBody();
}
function closeReportModal() {
  document.getElementById('reportModalOverlay').classList.add('hidden');
  currentReportType = null;
}

function getReportData() {
  let entries = Object.entries(invoicesCache);
  if (currentReportType === 'tension') {
    entries = entries.filter(([id, i]) => i.tension);
  } else if (currentReportType === 'remittance') {
    entries = entries.filter(([id, i]) => remitStatus(i.total, i.advance, i.balance) !== 'completed');
  } else if (currentReportType === 'daterange') {
    const from = document.getElementById('rep_from').value;
    const to = document.getElementById('rep_to').value;
    entries = entries.filter(([id, i]) => {
      if (!i.date) return false;
      if (from && i.date < from) return false;
      if (to && i.date > to) return false;
      return true;
    });
  }
  entries.sort((a, b) => (a[1].date || '').localeCompare(b[1].date || ''));
  return entries;
}

function renderReportBody() {
  const body = document.getElementById('reportBody');
  const entries = getReportData();

  if (currentReportType === 'summary') {
    const list = Object.values(invoicesCache);
    const total = list.length;
    const tension = list.filter(i => i.tension).length;
    const totalAmt = list.reduce((s, i) => s + (Number(i.total) || 0), 0);
    const advAmt = list.reduce((s, i) => s + (Number(i.advance) || 0), 0);
    const balAmt = list.reduce((s, i) => s + (Number(i.balance) || 0), 0);
    const completed = list.filter(i => remitStatus(i.total, i.advance, i.balance) === 'completed').length;
    const pending = total - completed;
    body.innerHTML = `
      <div class="card"><div class="row2"><span>Total Invoices</span><b>${total}</b></div></div>
      <div class="card"><div class="row2"><span>Issue Cases</span><b>${tension}</b></div></div>
      <div class="card"><div class="row2"><span>Remittance Completed</span><b>${completed}</b></div></div>
      <div class="card"><div class="row2"><span>Remittance Pending</span><b>${pending}</b></div></div>
      <div class="card"><div class="row2"><span>Total Invoice Value</span><b>${fmtMoney(totalAmt)}</b></div></div>
      <div class="card"><div class="row2"><span>Total Advance Received</span><b>${fmtMoney(advAmt)}</b></div></div>
      <div class="card"><div class="row2"><span>Total Balance Due</span><b>${fmtMoney(balAmt)}</b></div></div>
    `;
    return;
  }

  if (entries.length === 0) {
    body.innerHTML = '<div class="empty">No data for this report</div>';
    return;
  }

  if (currentReportType === 'package') {
    body.innerHTML = entries.map(([id, i]) => `
      <div class="card">
        <div class="inv" style="margin-bottom:4px;">${escapeHtml(i.invNo)}</div>
        <div class="row2"><span>Package</span><b>${escapeHtml(i.package)}</b></div>
        <div class="row2"><span>Supplier</span><b>${escapeHtml(i.supplier)}</b></div>
        <div class="row2"><span>Customer</span><b>${escapeHtml(i.customer)}</b></div>
      </div>`).join('');
    return;
  }

  // default: invoice / daterange / tension / remittance — all show full card list
  body.innerHTML = entries.map(([id, i]) => {
    const rs = remitStatus(i.total, i.advance, i.balance);
    return `
      <div class="card ${i.tension ? 'tension' : (rs === 'completed' ? 'ok' : '')}">
        <div class="top">
          <div>
            <div class="inv">${escapeHtml(i.invNo)}</div>
            <div class="date">${fmtDate(i.date)}</div>
          </div>
        </div>
        <div class="badges">
          <span class="badge ${rs}">💰 ${statusLabel(rs)}</span>
          <span class="badge ${i.tension ? 'tension-yes' : 'tension-no'}">${i.tension ? '⚠️ Issue' : '✅ OK'}</span>
        </div>
        <div class="row2"><span>Supplier</span><b>${escapeHtml(i.supplier)}</b></div>
        <div class="row2"><span>Customer</span><b>${escapeHtml(i.customer)}</b></div>
        <div class="row2"><span>Total / Adv / Bal</span><b>${fmtMoney(i.total)} / ${fmtMoney(i.advance)} / ${fmtMoney(i.balance)}</b></div>
        <div class="row2"><span>Remittance</span><b>${i.remitType === '3rdparty' ? '🔁 3rd Party' + (i.remitThirdParty ? ' (' + escapeHtml(i.remitThirdParty) + ')' : '') : '➡️ Direct'}</b></div>
      </div>`;
  }).join('');
}

/* ====================== EXPORT: PDF ====================== */
function exportReportPDF() {
  const entries = currentReportType === 'summary' ? null : getReportData();
  const doc = new jspdf.jsPDF();
  const titleMap = {
    invoice: 'Invoice-wise Status Report',
    package: 'Package-wise Status Report',
    daterange: 'Date Range Report',
    tension: 'Issue / Pending Cases Report',
    remittance: 'Remittance Pending Report',
    summary: 'Summary Dashboard'
  };
  doc.setFontSize(14);
  doc.text(titleMap[currentReportType] || 'Report', 14, 16);
  doc.setFontSize(9);
  doc.text('Sri Veeramathi Amman & Sri Muniyappan Kovil — Import Reports', 14, 22);
  doc.text('Generated: ' + new Date().toLocaleString('en-IN'), 14, 27);

  if (currentReportType === 'summary') {
    const list = Object.values(invoicesCache);
    const rows = [
      ['Total Invoices', String(list.length)],
      ['Issue Cases', String(list.filter(i => i.tension).length)],
      ['Remittance Completed', String(list.filter(i => remitStatus(i.total, i.advance, i.balance) === 'completed').length)],
      ['Remittance Pending', String(list.filter(i => remitStatus(i.total, i.advance, i.balance) !== 'completed').length)],
      ['Total Invoice Value', fmtMoney(list.reduce((s, i) => s + (Number(i.total) || 0), 0))],
      ['Total Advance Received', fmtMoney(list.reduce((s, i) => s + (Number(i.advance) || 0), 0))],
      ['Total Balance Due', fmtMoney(list.reduce((s, i) => s + (Number(i.balance) || 0), 0))]
    ];
    doc.autoTable({ startY: 33, head: [['Metric', 'Value']], body: rows });
  } else if (currentReportType === 'package') {
    const rows = entries.map(([id, i]) => [i.invNo, i.package, i.supplier, i.customer]);
    doc.autoTable({ startY: 33, head: [['Invoice No', 'Package Details', 'Supplier', 'Customer']], body: rows, styles: { fontSize: 8 } });
  } else {
    const rows = entries.map(([id, i]) => [
      i.invNo, fmtDate(i.date), i.supplier, i.customer,
      statusLabel(remitStatus(i.total, i.advance, i.balance)),
      i.remitType === '3rdparty' ? ('3rd Party' + (i.remitThirdParty ? ': ' + i.remitThirdParty : '')) : 'Direct',
      i.tension ? 'Yes' : 'No',
      fmtMoney(i.total), fmtMoney(i.advance), fmtMoney(i.balance)
    ]);
    doc.autoTable({
      startY: 33,
      head: [['Invoice', 'Date', 'Supplier', 'Customer', 'Remit', 'Remit Type', 'Issue', 'Total', 'Advance', 'Balance']],
      body: rows,
      styles: { fontSize: 6.5 }
    });
  }
  doc.save((titleMap[currentReportType] || 'report').replace(/\s+/g, '_') + '_' + todayISO() + '.pdf');
  toast('📄 PDF downloaded');
}

/* ====================== EXPORT: EXCEL ====================== */
function exportReportExcel() {
  const titleMap = {
    invoice: 'Invoice_Status',
    package: 'Package_Status',
    daterange: 'Date_Range',
    tension: 'Issue_Cases',
    remittance: 'Remittance_Pending',
    summary: 'Summary'
  };
  let rows;
  if (currentReportType === 'summary') {
    const list = Object.values(invoicesCache);
    rows = [
      { Metric: 'Total Invoices', Value: list.length },
      { Metric: 'Issue Cases', Value: list.filter(i => i.tension).length },
      { Metric: 'Remittance Completed', Value: list.filter(i => remitStatus(i.total, i.advance, i.balance) === 'completed').length },
      { Metric: 'Remittance Pending', Value: list.filter(i => remitStatus(i.total, i.advance, i.balance) !== 'completed').length },
      { Metric: 'Total Invoice Value', Value: list.reduce((s, i) => s + (Number(i.total) || 0), 0) },
      { Metric: 'Total Advance Received', Value: list.reduce((s, i) => s + (Number(i.advance) || 0), 0) },
      { Metric: 'Total Balance Due', Value: list.reduce((s, i) => s + (Number(i.balance) || 0), 0) }
    ];
  } else {
    const entries = getReportData();
    rows = entries.map(([id, i]) => ({
      'Invoice No': i.invNo,
      Date: i.date,
      Supplier: i.supplier,
      Customer: i.customer,
      Package: i.package,
      Total: i.total,
      Advance: i.advance,
      Balance: i.balance,
      'Remittance Status': statusLabel(remitStatus(i.total, i.advance, i.balance)),
      'Remittance Type': i.remitType === '3rdparty' ? '3rd Party' : 'Direct',
      '3rd Party Name': i.remitType === '3rdparty' ? (i.remitThirdParty || '') : '',
      Issue: i.tension ? 'Yes' : 'No',
      'Added By': i.addedBy || '',
      Notes: i.notes || ''
    }));
  }
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Report');
  XLSX.writeFile(wb, (titleMap[currentReportType] || 'report') + '_' + todayISO() + '.xlsx');
  toast('📊 Excel downloaded');
}

/* ====================== INIT ====================== */
document.addEventListener('DOMContentLoaded', () => {
  renderPinPad();
  renderPinDots();
  loadUsersForLogin();
  document.getElementById('f_date').value = todayISO();
});
