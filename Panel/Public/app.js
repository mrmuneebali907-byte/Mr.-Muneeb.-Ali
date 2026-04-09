/* Panel Frontend */
'use strict';

const socket = io({ transports: ['websocket', 'polling'] });

let sessions = [];
let activeQrSession = null;
let qrRefreshInterval = null;
let uptimeInterval = null;
let startTime = Date.now();

// ── Utils ──────────────────────────────────────────────────────────────────

function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) {
  document.getElementById(id).classList.remove('open');
  if (id === 'modal-qr') {
    clearInterval(qrRefreshInterval);
    qrRefreshInterval = null;
    activeQrSession = null;
    resetQRDisplay();
  }
}

function resetQRDisplay() {
  document.getElementById('qr-image').style.display = 'none';
  document.getElementById('qr-loading').style.display = 'flex';
  document.getElementById('qr-expired').style.display = 'none';
  document.getElementById('pair-code-result').style.display = 'none';
  document.getElementById('pair-code-text').textContent = '';
  document.getElementById('pair-phone').value = '';
}

function switchTab(tab) {
  document.getElementById('tab-qr').classList.toggle('active', tab === 'qr');
  document.getElementById('tab-pair').classList.toggle('active', tab === 'pair');
  document.getElementById('panel-qr').classList.toggle('active', tab === 'qr');
  document.getElementById('panel-pair').classList.toggle('active', tab === 'pair');
}

function statusLabel(s) {
  const map = {
    idle: '⚪ Idle',
    connecting: '🟡 Connecting',
    qr_ready: '🔵 Scan QR',
    pairing: '🟡 Pairing',
    connected: '🟢 Connected',
    disconnected: '🔴 Disconnected',
    error: '🔴 Error'
  };
  return map[s] || s;
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// ── Render ─────────────────────────────────────────────────────────────────

function renderSessions(list) {
  sessions = list;
  const grid = document.getElementById('sessions-grid');
  const empty = document.getElementById('empty-state');

  const connected = list.filter(s => s.status === 'connected').length;
  document.getElementById('connected-count').textContent = connected;
  document.getElementById('total-count').textContent = list.length;

  if (list.length === 0) {
    grid.innerHTML = '';
    grid.appendChild(empty);
    empty.style.display = '';
    return;
  }

  empty.style.display = 'none';
  const cards = list.map(s => buildCard(s)).join('');

  const prevCards = grid.querySelectorAll('.session-card');
  if (prevCards.length !== list.length) {
    grid.innerHTML = cards;
  } else {
    list.forEach((s, i) => {
      const card = grid.children[i];
      if (card) card.outerHTML = buildCard(s);
    });
    grid.innerHTML = cards;
  }
}

function buildCard(s) {
  const statusClass = s.status.replace('_', '-');
  const connected = s.status === 'connected';
  const idle = s.status === 'idle' || s.status === 'disconnected' || s.status === 'error';
  const running = s.status === 'connecting' || s.status === 'qr_ready' || s.status === 'pairing';
  const hasSession = s.hasSession;

  const startBtn = idle
    ? `<button class="btn btn-primary btn-sm" onclick="startSession(${s.id})">▶ Start</button>`
    : '';
  const stopBtn = (connected || running)
    ? `<button class="btn btn-ghost btn-sm" onclick="stopSession(${s.id})">⏹ Stop</button>`
    : '';
  const qrBtn = (running || idle)
    ? `<button class="btn btn-outline btn-sm" onclick="openQRModal(${s.id})">📱 Connect</button>`
    : '';
  const deleteBtn = `<button class="btn btn-danger btn-sm" onclick="deleteSession(${s.id})">🗑</button>`;

  return `
    <div class="session-card ${connected ? 'connected' : ''} ${s.status === 'error' ? 'error' : ''}" id="card-${s.id}">
      <div class="card-header">
        <div class="card-title">
          <div class="session-num">${s.id}</div>
          <div>
            <div class="session-name">${escHtml(s.name)}</div>
          </div>
        </div>
        <div class="status-badge ${s.status}">${statusLabel(s.status)}</div>
      </div>
      <div class="card-info">
        ${s.connectedNumber ? `<span>📞 <strong>${s.connectedNumber}</strong></span>` : ''}
        ${s.ownerNumber ? `<span>👑 Owner: <strong>${escHtml(s.ownerNumber)}</strong></span>` : ''}
        <span>📁 ${hasSession ? '✅ Session saved' : '⚪ No session'}</span>
      </div>
      <div class="card-actions">
        ${startBtn}${stopBtn}${qrBtn}${deleteBtn}
      </div>
    </div>`;
}

function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

// ── Session actions ────────────────────────────────────────────────────────

function startSession(id) {
  socket.emit('session:start', { id });
  toast(`Starting session ${id}...`, 'info');
}

function stopSession(id) {
  if (!confirm('Stop this session?')) return;
  socket.emit('session:stop', { id });
  toast(`Stopping session ${id}...`, 'info');
}

let _pendingDeleteId = null;

function deleteSession(id) {
  _pendingDeleteId = id;
  document.getElementById('input-delete-password').value = '';
  document.getElementById('delete-password-error').style.display = 'none';
  openModal('modal-delete-confirm');
  setTimeout(() => document.getElementById('input-delete-password').focus(), 100);
}

function cancelDelete() {
  _pendingDeleteId = null;
  closeModal('modal-delete-confirm');
}

function confirmDelete() {
  const entered = document.getElementById('input-delete-password').value;
  const OWNER_PASSWORD = 'MUNEEB SAR';

  if (entered !== OWNER_PASSWORD) {
    document.getElementById('delete-password-error').style.display = 'block';
    document.getElementById('input-delete-password').value = '';
    document.getElementById('input-delete-password').focus();
    return;
  }

  const id = _pendingDeleteId;
  _pendingDeleteId = null;
  closeModal('modal-delete-confirm');
  socket.emit('session:delete', { id });
  toast('Session deleted successfully', 'success');
}

function openQRModal(id) {
  activeQrSession = id;
  resetQRDisplay();
  openModal('modal-qr');
  startSession(id);
  pollQR(id);
}

function pollQR(id) {
  clearInterval(qrRefreshInterval);

  const doFetch = async () => {
    if (!activeQrSession) return;
    try {
      const res = await fetch(`/api/sessions/${id}/qr`);
      const data = await res.json();
      if (data.qr) {
        document.getElementById('qr-loading').style.display = 'none';
        document.getElementById('qr-expired').style.display = 'none';
        const img = document.getElementById('qr-image');
        img.src = data.qr;
        img.style.display = 'block';
      } else if (data.status === 'connected') {
        clearInterval(qrRefreshInterval);
        closeModal('modal-qr');
        toast('✅ Session connected!', 'success');
      }
    } catch (e) {}
  };

  doFetch();
  qrRefreshInterval = setInterval(doFetch, 3000);
}

function refreshQR() {
  if (activeQrSession) {
    resetQRDisplay();
    pollQR(activeQrSession);
  }
}

async function getPairCode() {
  const phone = document.getElementById('pair-phone').value.trim().replace(/[^0-9]/g, '');
  if (!phone || phone.length < 7) {
    toast('Please enter a valid phone number', 'error');
    return;
  }
  if (!activeQrSession) return;

  const btn = document.getElementById('btn-get-paircode');
  btn.disabled = true;
  btn.textContent = 'Getting code...';

  try {
    const res = await fetch(`/api/sessions/${activeQrSession}/paircode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone })
    });
    const data = await res.json();
    if (data.success && data.code) {
      document.getElementById('pair-code-result').style.display = 'block';
      document.getElementById('pair-code-text').textContent = data.code;
    } else {
      toast(data.error || 'Failed to get pairing code', 'error');
    }
  } catch (e) {
    toast('Network error', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Get Pairing Code';
  }
}

// ── Create session ─────────────────────────────────────────────────────────

document.getElementById('btn-add-session').addEventListener('click', () => {
  document.getElementById('input-session-name').value = '';
  document.getElementById('input-owner-number').value = '';
  openModal('modal-add');
});

document.getElementById('btn-create-session').addEventListener('click', () => {
  const name = document.getElementById('input-session-name').value.trim();
  const ownerNumber = document.getElementById('input-owner-number').value.trim().replace(/[^0-9]/g, '');
  socket.emit('session:create', { name: name || undefined, ownerNumber: ownerNumber || undefined });
  closeModal('modal-add');
  toast('Session created!', 'success');
});

// ── Socket events ──────────────────────────────────────────────────────────

socket.on('sessions:list', ({ sessions: list }) => renderSessions(list));
socket.on('sessions:refresh', ({ sessions: list }) => renderSessions(list));

socket.on('session:qr', ({ id, qr }) => {
  if (id === activeQrSession && qr) {
    document.getElementById('qr-loading').style.display = 'none';
    document.getElementById('qr-expired').style.display = 'none';
    const img = document.getElementById('qr-image');
    img.src = qr;
    img.style.display = 'block';
  }
});

socket.on('session:paircode', ({ id, code }) => {
  if (id === activeQrSession) {
    document.getElementById('pair-code-result').style.display = 'block';
    document.getElementById('pair-code-text').textContent = code;
  }
  toast(`Pairing code for session ${id}: ${code}`, 'success');
});

socket.on('session:connected', ({ id, number }) => {
  toast(`✅ Session ${id} connected as ${number}`, 'success');
  if (id === activeQrSession) {
    clearInterval(qrRefreshInterval);
    closeModal('modal-qr');
  }
});

socket.on('session:disconnected', ({ id }) => {
  toast(`Session ${id} disconnected`, 'info');
});

socket.on('session:error', ({ id, error }) => {
  toast(`Session ${id} error: ${error}`, 'error');
});

socket.on('session:ok', ({ id, action }) => {
  toast(`Session ${id}: ${action} done`, 'success');
});

socket.on('disconnect', () => toast('Connection to panel lost, reconnecting...', 'error'));
socket.on('connect', () => {
  if (sessions.length > 0) toast('Reconnected to panel', 'success');
});

// ── Uptime ─────────────────────────────────────────────────────────────────

async function fetchStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    document.getElementById('uptime').textContent = formatUptime(data.uptime);
  } catch (e) {}
}
fetchStatus();
setInterval(fetchStatus, 10000);

// Close modal on overlay click
document.querySelectorAll('.modal-overlay').forEach(el => {
  el.addEventListener('click', e => {
    if (e.target === el) closeModal(el.id);
  });
});

// Enter key for create session
document.getElementById('input-owner-number').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btn-create-session').click();
});

// Enter key for delete password
document.getElementById('input-delete-password').addEventListener('keydown', e => {
  if (e.key === 'Enter') confirmDelete();
});
