/* ────────────────────────────────────────────────────────────────────────────
   Million Checkboxes – Frontend Logic
   
   Architecture:
   ─ Paged rendering: 5000 checkboxes per page (virtual paging, not DOM)
   ─ Binary bitmap: initial state sent as base64-encoded Redis bitmap
   ─ WebSocket: real-time sync with reconnect + exponential backoff
   ─ Auth: checked via /auth/me on load; gates toggle actions
   ─ Toast system: user feedback for errors, rate limits, events
   ─────────────────────────────────────────────────────────────────────────── */

'use strict';

/* ── Constants ────────────────────────────────────────────────────────────── */
const CHECKBOX_COUNT  = 2_000;
const PAGE_SIZE       = 2_000;      // checkboxes visible per page
const TOTAL_PAGES     = Math.ceil(CHECKBOX_COUNT / PAGE_SIZE);   // 1 page
const COLS            = computeCols();                // responsive columns

/* ── State ────────────────────────────────────────────────────────────────── */
let bitmapBuffer   = new Uint8Array(Math.ceil(CHECKBOX_COUNT / 8));  // local bitmap mirror
let currentPage    = 0;         // 0-indexed
let checkedCount   = 0;
let connectedCount = 0;
let isAuthenticated = false;
let currentUser     = null;
let ws             = null;
let reconnectTimer = null;
let reconnectDelay = 1000;       // ms, doubles on failure (max 30s)

/* ── DOM Refs ─────────────────────────────────────────────────────────────── */
const grid            = document.getElementById('checkbox-grid');
const rangeLabel      = document.getElementById('range-label');
const statConnected   = document.getElementById('stat-connected');
const statChecked     = document.getElementById('stat-checked');
const connDot         = document.getElementById('conn-dot');
const navUserSection  = document.getElementById('nav-user-section');
const anonBanner      = document.getElementById('anon-banner');
const pagination      = document.getElementById('pagination');
const wsStatusEl      = document.getElementById('ws-status');
const wsStatusText    = document.getElementById('ws-status-text');
const loadingOverlay  = document.getElementById('loading-overlay');
const searchInput     = document.getElementById('search-input');
const btnJump         = document.getElementById('btn-jump');
const btnPrev         = document.getElementById('btn-prev-page');
const btnNext         = document.getElementById('btn-next-page');

/* ─────────────────────────────────────────────────────────────────────────── *
 *  BITMAP HELPERS                                                             *
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * Get a bit value from our local Uint8Array bitmap.
 * Redis stores bit 0 as the MSB of byte 0.
 */
function getBit(index) {
  const byteIndex = Math.floor(index / 8);
  const bitIndex  = 7 - (index % 8);   // MSB first (Redis convention)
  return (bitmapBuffer[byteIndex] >> bitIndex) & 1;
}

/**
 * Set a bit in our local Uint8Array bitmap.
 */
function setBit(index, value) {
  const byteIndex = Math.floor(index / 8);
  const bitIndex  = 7 - (index % 8);
  if (value) {
    bitmapBuffer[byteIndex] |= (1 << bitIndex);
  } else {
    bitmapBuffer[byteIndex] &= ~(1 << bitIndex);
  }
}

/**
 * Decode base64 bitmap string into our Uint8Array.
 */
function loadBitmap(base64Str) {
  const binary = atob(base64Str);
  const buf    = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
  bitmapBuffer = buf;
}

/* ─────────────────────────────────────────────────────────────────────────── *
 *  AUTH                                                                       *
 * ─────────────────────────────────────────────────────────────────────────── */

async function fetchAuthStatus() {
  try {
    const res  = await fetch('/auth/me');
    const data = await res.json();
    isAuthenticated = data.authenticated;
    currentUser     = data.user;
  } catch {
    isAuthenticated = false;
    currentUser     = null;
  }
  renderNavUser();
  renderAnonBanner();
}

function renderNavUser() {
  if (isAuthenticated && currentUser) {
    navUserSection.innerHTML = `
      <img class="user-avatar" src="${currentUser.picture || ''}" 
           onerror="this.src='data:image/svg+xml,<svg xmlns=\\'http://www.w3.org/2000/svg\\' viewBox=\\'0 0 40 40\\'><rect width=\\'40\\' height=\\'40\\' rx=\\'20\\' fill=\\'%2358a6ff\\'/><text x=\\'50%\\' y=\\'58%\\' text-anchor=\\'middle\\' fill=\\'%23000\\' font-size=\\'18\\' font-family=\\'Inter\\'>${currentUser.name?.[0] || '?'}</text></svg>'"
           alt="${currentUser.name}" width="32" height="32">
      <span class="user-name">${currentUser.name}</span>
      <a href="/auth/logout" id="btn-logout" class="ctrl-btn" aria-label="Sign out">Sign out</a>
    `;
  } else {
    navUserSection.innerHTML = `
      <a href="/auth/login" id="btn-login" aria-label="Sign in">🔑 Sign in</a>
    `;
  }
}

function renderAnonBanner() {
  if (!isAuthenticated) {
    anonBanner.classList.add('show');
  } else {
    anonBanner.classList.remove('show');
  }
}

/* ─────────────────────────────────────────────────────────────────────────── *
 *  GRID RENDERING                                                             *
 * ─────────────────────────────────────────────────────────────────────────── */

function computeCols() {
  const vw = window.innerWidth;
  if (vw >= 1400) return 100;
  if (vw >= 1100) return 80;
  if (vw >= 800)  return 60;
  if (vw >= 600)  return 40;
  return 25;
}

function setGridColumns() {
  const cols = computeCols();
  grid.style.gridTemplateColumns = `repeat(${cols}, var(--cb-size))`;
}

/**
 * Render the current page of checkboxes into the grid.
 * Creates DOM elements only for the visible page (5000 items max).
 */
function renderPage(page) {
  currentPage = Math.max(0, Math.min(page, TOTAL_PAGES - 1));
  const start = currentPage * PAGE_SIZE;
  const end   = Math.min(start + PAGE_SIZE, CHECKBOX_COUNT);

  grid.innerHTML = '';                    // Clear previous page
  grid.classList.add('loading');

  const fragment = document.createDocumentFragment();

  for (let i = start; i < end; i++) {
    const wrapper = document.createElement('div');
    wrapper.className = 'cb-item';

    const cb  = document.createElement('input');
    cb.type   = 'checkbox';
    cb.id     = `cb-${i}`;
    cb.checked = getBit(i) === 1;
    cb.disabled = !isAuthenticated;
    cb.dataset.index = i;
    cb.setAttribute('aria-label', `Checkbox ${i + 1}`);
    cb.addEventListener('change', handleToggle);

    wrapper.appendChild(cb);
    fragment.appendChild(wrapper);
  }

  grid.appendChild(fragment);
  grid.classList.remove('loading');

  // Update UI labels
  rangeLabel.textContent = `#${start + 1} – #${end.toLocaleString()}`;
  document.getElementById('page-display').textContent =
    `Page ${currentPage + 1} of ${TOTAL_PAGES}`;

  renderPagination();
  updateStats();
}

/* ── Pagination ───────────────────────────────────────────────────────────── */

function renderPagination() {
  pagination.innerHTML = '';

  // Prev button
  const prev = makePageBtn('← Prev', currentPage === 0, () => renderPage(currentPage - 1));
  pagination.appendChild(prev);

  // Page number buttons (show window of 7 around current page)
  const pages = getPageWindow(currentPage, TOTAL_PAGES);
  let lastPage = -1;
  for (const p of pages) {
    if (p === null) {
      const ellipsis = document.createElement('span');
      ellipsis.id = `ellipsis-${lastPage}`;
      ellipsis.textContent = '…';
      ellipsis.style.cssText = 'padding: 6px 4px; color: var(--text-dim); font-size:.8rem;';
      pagination.appendChild(ellipsis);
    } else {
      const btn = makePageBtn(String(p + 1), false, () => renderPage(p));
      if (p === currentPage) btn.classList.add('active');
      pagination.appendChild(btn);
      lastPage = p;
    }
  }

  // Next button
  const next = makePageBtn('Next →', currentPage === TOTAL_PAGES - 1, () => renderPage(currentPage + 1));
  pagination.appendChild(next);
}

function getPageWindow(current, total) {
  const pages = [];
  const window = 3;

  const addPage = (p) => { if (p >= 0 && p < total) pages.push(p); };
  const addEllipsis = () => { if (pages.at(-1) !== null) pages.push(null); };

  addPage(0);
  if (current > window + 1) addEllipsis();
  for (let p = Math.max(1, current - window); p <= Math.min(total - 2, current + window); p++) addPage(p);
  if (current < total - window - 2) addEllipsis();
  addPage(total - 1);

  return pages;
}

function makePageBtn(label, disabled, onClick) {
  const btn = document.createElement('button');
  btn.className = 'page-btn';
  btn.textContent = label;
  btn.disabled = disabled;
  btn.addEventListener('click', onClick);
  return btn;
}

/* ─────────────────────────────────────────────────────────────────────────── *
 *  STATS                                                                      *
 * ─────────────────────────────────────────────────────────────────────────── */

function updateStats() {
  statChecked.textContent   = checkedCount.toLocaleString();
  statConnected.textContent = connectedCount.toLocaleString();
}

/* ─────────────────────────────────────────────────────────────────────────── *
 *  CHECKBOX TOGGLE HANDLER                                                    *
 * ─────────────────────────────────────────────────────────────────────────── */

function handleToggle(e) {
  const index = parseInt(e.target.dataset.index, 10);
  if (!isAuthenticated) {
    e.target.checked = getBit(index) === 1; // revert
    toast('Sign in to toggle checkboxes', 'info');
    return;
  }

  if (!ws || ws.readyState !== WebSocket.OPEN) {
    e.target.checked = getBit(index) === 1; // revert
    toast('Not connected to server', 'error');
    return;
  }

  // Optimistic update
  const newVal = e.target.checked ? 1 : 0;
  setBit(index, newVal);
  if (newVal) checkedCount++; else checkedCount--;
  updateStats();
  popAnimate(e.target.closest('.cb-item'));

  ws.send(JSON.stringify({ type: 'toggle', index }));
}

function popAnimate(item) {
  if (!item) return;
  item.classList.remove('pop');
  void item.offsetWidth; // force reflow
  item.classList.add('pop');
  item.addEventListener('animationend', () => item.classList.remove('pop'), { once: true });
}

/* ─────────────────────────────────────────────────────────────────────────── *
 *  WEBSOCKET                                                                  *
 * ─────────────────────────────────────────────────────────────────────────── */

function connectWs() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${protocol}://${location.host}/`;

  ws = new WebSocket(url);

  ws.onopen = () => {
    console.log('[WS] Connected');
    reconnectDelay = 1000;
    clearTimeout(reconnectTimer);
    setWsStatus(true);
  };

  ws.onmessage = (event) => {
    let data;
    try { data = JSON.parse(event.data); }
    catch { return; }
    handleWsMessage(data);
  };

  ws.onclose = () => {
    console.log('[WS] Disconnected');
    setWsStatus(false);
    // Exponential backoff reconnect
    reconnectTimer = setTimeout(() => {
      console.log(`[WS] Reconnecting in ${reconnectDelay}ms…`);
      connectWs();
      reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
    }, reconnectDelay);
  };

  ws.onerror = (err) => {
    console.error('[WS] Error:', err);
  };
}

function handleWsMessage(data) {
  switch (data.type) {
    case 'init': {
      // Initial full state from server
      loadBitmap(data.data);
      checkedCount   = data.checkedCount || 0;
      connectedCount = data.connected    || 0;
      // Auth might be more accurate from HTTP /auth/me, but update from WS too
      updateStats();
      renderPage(currentPage);
      hideLoading();
      break;
    }

    case 'update': {
      // A single checkbox changed by another user
      const { index, checked } = data;
      const wasChecked = getBit(index) === 1;
      setBit(index, checked ? 1 : 0);

      // Update checked count
      if (checked && !wasChecked) checkedCount++;
      else if (!checked && wasChecked) checkedCount--;
      updateStats();

      // If this checkbox is on the current page, update the DOM
      const pageStart = currentPage * PAGE_SIZE;
      const pageEnd   = pageStart + PAGE_SIZE;
      if (index >= pageStart && index < pageEnd) {
        const cbEl = document.getElementById(`cb-${index}`);
        if (cbEl && cbEl.checked !== checked) {
          cbEl.checked = checked;
          popAnimate(cbEl.closest('.cb-item'));
        }
      }
      break;
    }

    case 'stats': {
      connectedCount = data.connected || 0;
      updateStats();
      break;
    }

    case 'error': {
      let icon = '⚠️';
      if (data.code === 'RATE_LIMITED') {
        icon = '🚦';
        // Revert any optimistic update: re-render current page from bitmap
        renderPage(currentPage);
      } else if (data.code === 'AUTH_REQUIRED') {
        icon = '🔐';
      }
      toast(`${icon} ${data.message}`, 'error');
      break;
    }

    case 'pong':
      break; // heartbeat response

    default:
      break;
  }
}

function setWsStatus(connected) {
  wsStatusEl.classList.toggle('connected', connected);
  wsStatusText.textContent = connected ? 'Connected' : 'Disconnected';
  connDot.classList.toggle('red', !connected);
  connDot.style.animation = connected ? '' : 'none';
  if (!connected) connDot.style.background = 'var(--accent-red)';
}

/* WS heartbeat – send ping every 25s to keep connection alive */
setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'ping' }));
  }
}, 25_000);

/* ─────────────────────────────────────────────────────────────────────────── *
 *  TOASTS                                                                     *
 * ─────────────────────────────────────────────────────────────────────────── */

const toastContainer = document.getElementById('toast-container');

function toast(message, type = 'info', durationMs = 4000) {
  const icons = { error: '❌', success: '✅', info: 'ℹ️' };
  const div = document.createElement('div');
  div.className = `toast ${type}`;
  div.innerHTML = `<span class="toast-icon">${icons[type] || 'ℹ️'}</span><span class="toast-msg">${message}</span>`;
  div.addEventListener('click', () => removeToast(div));
  toastContainer.appendChild(div);

  setTimeout(() => removeToast(div), durationMs);
}

function removeToast(el) {
  el.classList.add('removing');
  el.addEventListener('animationend', () => el.remove(), { once: true });
}

/* ─────────────────────────────────────────────────────────────────────────── *
 *  LOADING OVERLAY                                                            *
 * ─────────────────────────────────────────────────────────────────────────── */

function hideLoading() {
  loadingOverlay.classList.add('hidden');
  setTimeout(() => { loadingOverlay.style.display = 'none'; }, 400);
}

/* ─────────────────────────────────────────────────────────────────────────── *
 *  CONTROLS                                                                   *
 * ─────────────────────────────────────────────────────────────────────────── */

btnJump.addEventListener('click', () => {
  const num = parseInt(searchInput.value, 10);
  if (!num || num < 1 || num > CHECKBOX_COUNT) {
    toast('Please enter a number between 1 and 2,000', 'error');
    return;
  }
  const targetPage = Math.floor((num - 1) / PAGE_SIZE);
  renderPage(targetPage);
  searchInput.value = '';
  // Scroll to the specific checkbox after render
  requestAnimationFrame(() => {
    const el = document.getElementById(`cb-${num - 1}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
});

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') btnJump.click();
});

btnPrev.addEventListener('click', () => {
  if (currentPage > 0) renderPage(currentPage - 1);
});

btnNext.addEventListener('click', () => {
  if (currentPage < TOTAL_PAGES - 1) renderPage(currentPage + 1);
});

/* ─────────────────────────────────────────────────────────────────────────── *
 *  RESPONSIVE REFLOW                                                          *
 * ─────────────────────────────────────────────────────────────────────────── */

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    setGridColumns();
  }, 150);
});

/* ─────────────────────────────────────────────────────────────────────────── *
 *  INIT                                                                       *
 * ─────────────────────────────────────────────────────────────────────────── */

async function init() {
  setGridColumns();

  // Fetch auth status first (parallel with WS connection attempt)
  await fetchAuthStatus();

  // Render initial empty page while waiting for WS data
  // (checkboxes will be all unchecked until init message arrives)
  renderPage(0);

  // Connect WebSocket
  connectWs();

  // Fallback: hide loading after 8s if WS never connects
  setTimeout(() => {
    if (loadingOverlay.style.display !== 'none') {
      hideLoading();
      toast('Could not connect to server. Showing cached state.', 'error', 6000);
    }
  }, 8_000);
}

init();
