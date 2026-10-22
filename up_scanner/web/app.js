const state = {
  documents: [],
  selected: new Set(),
  scanned: {},
  itemStates: { statuses: {}, missing: {} },
  log: [],
  location: 'new',
  scannerMode: 'hid',
  lastScanEvent: 0,
  hidBuffer: '',
  hidLastKeyTs: 0,
  hidRapidCount: 0,
  isClosed: false,
  pingFailures: 0,
  keypadOpen: false,
  keypadBuffer: '',
  notFound: [],
  manualComments: {},
  commentsSaveTimer: {},
  progressSaveTimer: null,
  itemStatesSaveTimer: null,
  pendingScanChoices: [],
  projectSummary: [],
  parserProfiles: {},
  activeParserProfile: 'poscenter',
  vcomStatusTick: 0,
  keypadSide: 'right',
  keypadPrefix: 'УП-',
  lastScannedCode: '',
  pendingChoiceIndex: 0,
  notFoundSplashTimer: null,
  lastRawInput: '',
  lastCleanInput: '',
  lastInputSource: '',
  scannerTrimStart: 0,
  scannerTrimEnd: 0,
  scannerTrimManual: false,
  scannerSampleRaw: '',
  scannerSampleMeta: {},
  scannerEnterPressCount: 0,
  scannerLastEnterTs: 0,
  scannerKeyEvents: [],
  sidebarCollapsed: false,
  documentsLoading: false,
  dialogResolve: null,
};

const docsEl = document.getElementById('docs');
const tableWrap = document.getElementById('tableWrap');
const scanInput = document.getElementById('scan');
const logEl = document.getElementById('log');
const notFoundLogEl = document.getElementById('notFoundLog');
const scanChoicesEl = document.getElementById('scanChoices');
const keypadPanel = document.getElementById('keypadPanel');
const keypadDisplay = document.getElementById('keypadDisplay');
const keypadLogEl = document.getElementById('keypadLog');
const themeToggle = document.getElementById('themeToggle');
const projectListNewEl = document.getElementById('projectListNew');
const projectListOldEl = document.getElementById('projectListOld');
const helpOverlayEl = document.getElementById('helpOverlay');
const scrollTopBtnEl = document.getElementById('scrollTopBtn');
const scrollBottomBtnEl = document.getElementById('scrollBottomBtn');
const contentScrollEl = document.getElementById('contentScroll');
const notFoundSplashEl = document.getElementById('notFoundSplash');
const notFoundChoiceOverlayEl = document.getElementById('notFoundChoiceOverlay');
const notFoundChoiceTextEl = document.getElementById('notFoundChoiceText');
const notFoundChoiceOkEl = document.getElementById('notFoundChoiceOk');
const notFoundChoiceMissingEl = document.getElementById('notFoundChoiceMissing');
const keypadPrefixBtnEl = document.getElementById('keypadPrefixBtn');
const keypadPrefixInputEl = document.getElementById('keypadPrefixInput');
const parserProfileSelectEl = document.getElementById('parserProfile');
const parserProfileHintEl = document.getElementById('parserProfileHint');
const clockEl = document.getElementById('clock');
const scanDebugEl = document.getElementById('scanDebug');
const confirmOverlayEl = document.getElementById('confirmOverlay');
const confirmTitleEl = document.getElementById('confirmTitle');
const confirmTextEl = document.getElementById('confirmText');
const promptInputEl = document.getElementById('promptInput');
const confirmOkEl = document.getElementById('confirmOk');
const confirmCancelEl = document.getElementById('confirmCancel');
const scannerSettingsBtnEl = document.getElementById('scannerSettingsBtn');
const scannerSettingsOverlayEl = document.getElementById('scannerSettingsOverlay');
const scannerSettingsCloseEl = document.getElementById('scannerSettingsClose');
const scannerTestInputEl = document.getElementById('scannerTestInput');
const scannerResultEl = document.getElementById('scannerResult');
const trimStartInputEl = document.getElementById('trimStartInput');
const trimEndInputEl = document.getElementById('trimEndInput');
const trimManualInputEl = document.getElementById('trimManualInput');
const appMainEl = document.getElementById('appMain');
const toggleSidebarBtnEl = document.getElementById('toggleSidebar');

function savePref(key, value) {
  try { localStorage.setItem(`up_scanner_${key}`, JSON.stringify(value)); } catch {}
}

function loadPref(key, fallback) {
  try {
    const raw = localStorage.getItem(`up_scanner_${key}`);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function setSidebarCollapsed(collapsed) {
  state.sidebarCollapsed = Boolean(collapsed);
  if (appMainEl) appMainEl.classList.toggle('sidebar-collapsed', state.sidebarCollapsed);
  if (toggleSidebarBtnEl) {
    toggleSidebarBtnEl.classList.toggle('sidebar-collapsed', state.sidebarCollapsed);
    toggleSidebarBtnEl.textContent = state.sidebarCollapsed ? '☰' : '◀';
    const label = state.sidebarCollapsed ? 'Развернуть документы и проекты' : 'Свернуть документы и проекты';
    toggleSidebarBtnEl.title = label;
    toggleSidebarBtnEl.setAttribute('aria-label', label);
    toggleSidebarBtnEl.setAttribute('aria-expanded', String(!state.sidebarCollapsed));
  }
  savePref('sidebar_collapsed', state.sidebarCollapsed);
}

function isEditableTarget(target) {
  if (!target || !target.tagName) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if (target.isContentEditable) return true;
  return false;
}

function fmtQty(value) {
  const n = Number(value || 0);
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
}

function closeDialog(result) {
  if (!confirmOverlayEl || !state.dialogResolve) return;
  const resolve = state.dialogResolve;
  state.dialogResolve = null;
  confirmOverlayEl.classList.add('hidden');
  promptInputEl.classList.add('hidden');
  resolve(result);
}

function confirmAction(message, title = 'Подтверждение') {
  if (!confirmOverlayEl) return Promise.resolve(false);
  confirmTitleEl.textContent = title;
  confirmTextEl.textContent = message;
  promptInputEl.value = '';
  promptInputEl.classList.add('hidden');
  confirmOverlayEl.classList.remove('hidden');
  confirmOkEl.focus();
  return new Promise(resolve => { state.dialogResolve = resolve; });
}

function promptAction(title, message, initial = '') {
  if (!confirmOverlayEl) return Promise.resolve(null);
  confirmTitleEl.textContent = title;
  confirmTextEl.textContent = message;
  promptInputEl.value = initial;
  promptInputEl.classList.remove('hidden');
  confirmOverlayEl.classList.remove('hidden');
  promptInputEl.focus();
  promptInputEl.select();
  return new Promise(resolve => {
    state.dialogResolve = ok => resolve(ok ? promptInputEl.value : null);
  });
}

function updateClock() {
  if (!clockEl) return;
  clockEl.textContent = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function normalizeScannerRaw(value) {
  let text = String(value || '').trim();
  const start = Math.max(0, Number(state.scannerTrimStart || 0));
  const end = Math.max(0, Number(state.scannerTrimEnd || 0));
  if (start) text = text.slice(start);
  if (end) text = text.slice(0, Math.max(0, text.length - end));
  return text;
}

function shouldApplyScannerTrim(source = '') {
  const src = String(source || '').toLowerCase();
  if (src.includes('vcom')) return true;
  if (src.includes('hid + enter')) return true;
  if (src.includes('scanner-test')) return true;
  if (src.includes('поле') || src.includes('ручн') || src.includes('виртуаль')) return Boolean(state.scannerTrimManual);
  return Boolean(state.scannerTrimManual);
}

function cleanCode(value, source = '') {
  const text = (shouldApplyScannerTrim(source) ? normalizeScannerRaw(value) : String(value || '').trim()).toUpperCase();
  const match = text.match(/(?:УП|UP)-\d{1,}|\b\d{1,}\b/u);
  return match ? match[0].replace('UP-', 'УП-') : text;
}

function applyKeypadPrefix(value) {
  const normalized = String(value || '').trim() || 'УП-';
  state.keypadPrefix = normalized;
  if (keypadPrefixBtnEl) {
    keypadPrefixBtnEl.dataset.key = normalized;
    keypadPrefixBtnEl.textContent = normalized;
  }
  if (keypadPrefixInputEl && keypadPrefixInputEl.value !== normalized) {
    keypadPrefixInputEl.value = normalized;
  }
}

function rowId(code) {
  return `row-${String(code).replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

function getSelectedDocs() {
  return state.documents.filter(doc => state.selected.has(doc.id));
}

function getCurrentProjectName() {
  const field = document.getElementById('bulkProject');
  const fromInput = (field && field.value ? field.value : '').trim();
  if (fromInput) return fromInput;
  const uniq = [...new Set(getSelectedDocs().map(doc => (doc.project || '').trim()).filter(Boolean))];
  return uniq.length === 1 ? uniq[0] : '';
}

function addLog(text) {
  if (state.isClosed) return;
  const now = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  state.log.push(`${now} ${text}`);
  renderLog();
}

function updateScanDebug(raw, cleaned, source = 'HID') {
  state.lastRawInput = String(raw || '');
  state.lastCleanInput = String(cleaned || '');
  state.lastInputSource = source;
  if (!scanDebugEl) return;
  const rawText = state.lastRawInput || '—';
  const cleanText = state.lastCleanInput || '—';
  const digits = rawText.replace(/\D/g, '');
  const type = digits.length === 13 ? 'EAN13' : digits.length ? `${digits.length} цифр` : 'текст';
  const enter = source.includes('Enter') ? 'Enter' : 'ручной ввод';
  scanDebugEl.textContent = `Последний ввод: ${rawText} → ${cleanText}; ${type}; конец: ${enter}`;
}

function renderScannerSettingsSample(raw = state.scannerSampleRaw, meta = state.scannerSampleMeta || {}) {
  state.scannerSampleRaw = String(raw || '');
  state.scannerSampleMeta = meta || {};
  if (!scannerResultEl) return;
  const trimmed = normalizeScannerRaw(state.scannerSampleRaw);
  const cleaned = cleanCode(state.scannerSampleRaw, 'scanner-test');
  const digits = cleaned.replace(/\D/g, '');
  const type = digits.length === 13 ? 'EAN13' : digits.length ? `${digits.length} цифр` : 'текст';
  const crCount = Number(meta.cr_count || 0);
  const lfCount = Number(meta.lf_count || 0);
  const enterCount = Number(meta.enter_count ?? state.scannerEnterPressCount ?? 0);
  const ending = meta.ending || (enterCount ? 'Enter' : 'none');
  const source = meta.source || state.lastInputSource || 'тест';
  const keyEvents = state.scannerKeyEvents || [];
  const lastKey = keyEvents.length ? keyEvents[keyEvents.length - 1] : null;
  const enterEvents = keyEvents.filter(item => item.key === 'Enter' && item.type === 'keydown');
  const lastEnter = enterEvents.length ? enterEvents[enterEvents.length - 1] : null;
  const doubleEnter = lastEnter && Number(lastEnter.delta || 0) > 0 && Number(lastEnter.delta || 0) <= 250;
  const keyLine = lastKey
    ? `${lastKey.type}: key=${lastKey.key}, code=${lastKey.code}, repeat=${lastKey.repeat ? 'yes' : 'no'}, Δ=${lastKey.delta || 0} ms`
    : '—';
  scannerResultEl.innerHTML = [
    `<b>raw:</b> ${escapeHtml(state.scannerSampleRaw || '—')}`,
    `<b>после настроек:</b> ${escapeHtml(trimmed || '—')}`,
    `<b>cleaned:</b> ${escapeHtml(cleaned || '—')}`,
    `<b>тип:</b> ${escapeHtml(type)}`,
    `<b>источник:</b> ${escapeHtml(source)}`,
    `<b>Enter:</b> ${escapeHtml(enterCount)} · CR: ${escapeHtml(crCount)} · LF: ${escapeHtml(lfCount)} · конец: ${escapeHtml(ending)}`,
    `<b>USB/HID key:</b> ${escapeHtml(keyLine)}`,
    `<b>USB/HID Enter:</b> ${escapeHtml(enterEvents.length)}${lastEnter ? ` · последний интервал: ${escapeHtml(lastEnter.delta || 0)} ms` : ''}${doubleEnter ? ' · похоже на двойной Enter' : ''}`,
  ].join('<br>');
}

function rememberScannerKeyEvent(event) {
  const now = Date.now();
  const prevSame = [...(state.scannerKeyEvents || [])].reverse().find(item => item.key === event.key && item.type === event.type);
  const item = {
    type: event.type,
    key: event.key,
    code: event.code,
    repeat: Boolean(event.repeat),
    delta: prevSame ? now - prevSame.ts : 0,
    ts: now,
  };
  state.scannerKeyEvents = [...(state.scannerKeyEvents || []), item].slice(-20);
}

function applyScannerTrimInputs() {
  state.scannerTrimStart = Math.max(0, Number(trimStartInputEl?.value || 0));
  state.scannerTrimEnd = Math.max(0, Number(trimEndInputEl?.value || 0));
  state.scannerTrimManual = Boolean(trimManualInputEl?.checked);
  savePref('scanner_trim_start', state.scannerTrimStart);
  savePref('scanner_trim_end', state.scannerTrimEnd);
  savePref('scanner_trim_manual', state.scannerTrimManual);
  renderScannerSettingsSample();
}

function showNotFoundSplash(code) {
  if (!notFoundSplashEl) return;
  notFoundSplashEl.innerHTML = `<div class="not-found-code">${escapeHtml(code || 'Код')}</div><div class="not-found-caption">отсутствует</div>`;
  notFoundSplashEl.classList.remove('hidden');
  if (state.notFoundSplashTimer) clearTimeout(state.notFoundSplashTimer);
  state.notFoundSplashTimer = setTimeout(() => notFoundSplashEl.classList.add('hidden'), 1200);
}

function applyTheme(theme) {
  const target = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', target);
  if (themeToggle) {
    themeToggle.textContent = target === 'dark' ? '☀' : '🌙';
    themeToggle.title = target === 'dark' ? 'Светлая тема' : 'Тёмная тема';
  }
  try { localStorage.setItem('up_scanner_theme', target); } catch {}
}

async function loadNotFound() {
  try {
    const data = await (await fetch('/api/not-found')).json();
    state.notFound = data.items || [];
  } catch {
    state.notFound = [];
  }
}

async function loadProjectsSummary(refresh = false) {
  try {
    const url = refresh ? '/api/projects-summary?refresh=1' : '/api/projects-summary';
    const data = await (await fetch(url)).json();
    state.projectSummary = data.items || [];
  } catch {
    state.projectSummary = [];
  }
}

function renderParserProfiles() {
  if (!parserProfileSelectEl) return;
  const profiles = state.parserProfiles || {};
  const names = Object.keys(profiles);
  if (!names.length) {
    parserProfileSelectEl.innerHTML = '<option value="poscenter">poscenter</option>';
    parserProfileSelectEl.value = 'poscenter';
    if (parserProfileHintEl) parserProfileHintEl.textContent = '';
    return;
  }
  parserProfileSelectEl.innerHTML = names
    .sort((a, b) => a.localeCompare(b, 'ru'))
    .map(name => {
      const body = profiles[name] || {};
      const label = (body.label || '').trim() || name;
      return `<option value="${escapeHtml(name)}">${escapeHtml(label)} (${escapeHtml(name)})</option>`;
    }).join('');
  if (!profiles[state.activeParserProfile]) {
    state.activeParserProfile = names.includes('poscenter') ? 'poscenter' : names[0];
  }
  parserProfileSelectEl.value = state.activeParserProfile;
  const hint = profiles[state.activeParserProfile]?.description || '';
  if (parserProfileHintEl) parserProfileHintEl.textContent = hint;
}

async function loadParserProfiles() {
  try {
    const data = await (await fetch('/api/parser/profiles')).json();
    state.parserProfiles = data.profiles || {};
    state.activeParserProfile = data.active || 'poscenter';
  } catch {
    state.parserProfiles = { poscenter: { label: 'POScenter', description: '' } };
    state.activeParserProfile = 'poscenter';
  }
  renderParserProfiles();
}

async function switchParserProfile(name, { silent = false, refreshDocs = true } = {}) {
  const target = String(name || '').trim();
  if (!target) return true;
  if (target === state.activeParserProfile) return true;
  try {
    const data = await (await fetch('/api/parser/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: target }),
    })).json();
    if (!data.ok) {
      if (!silent) addLog(`Parser profile error: ${data.error || 'unknown'}`);
      await loadParserProfiles();
      return false;
    }
    state.activeParserProfile = data.active || target;
    if (!silent) addLog(`Parser profile: ${state.activeParserProfile}`);
    if (refreshDocs) await loadDocs(true, true);
    return true;
  } catch {
    if (!silent) addLog('Parser profile switch failed');
    await loadParserProfiles();
    return false;
  }
}

async function loadManualComments() {
  const project = getCurrentProjectName();
  if (!project) return (state.manualComments = {});
  try {
    const data = await (await fetch(`/api/manual-comments?project=${encodeURIComponent(project)}`)).json();
    state.manualComments = data.comments || {};
  } catch {
    state.manualComments = {};
  }
}

async function loadScanProgress() {
  const project = getCurrentProjectName();
  if (!project) return (state.scanned = {});
  try {
    const data = await (await fetch(`/api/scan-progress?project=${encodeURIComponent(project)}`)).json();
    state.scanned = data.scanned || {};
  } catch {
    state.scanned = {};
  }
}

async function loadItemStates() {
  const project = getCurrentProjectName();
  if (!project) return (state.itemStates = { statuses: {}, missing: {} });
  try {
    const data = await (await fetch(`/api/item-states?project=${encodeURIComponent(project)}`)).json();
    state.itemStates = {
      statuses: data.states?.statuses || {},
      missing: data.states?.missing || {},
    };
  } catch {
    state.itemStates = { statuses: {}, missing: {} };
  }
}

function queueItemStatesSave() {
  const project = getCurrentProjectName();
  if (!project) return;
  const snapshot = {
    statuses: { ...(state.itemStates?.statuses || {}) },
    missing: { ...(state.itemStates?.missing || {}) },
  };
  if (state.itemStatesSaveTimer) clearTimeout(state.itemStatesSaveTimer);
  state.itemStatesSaveTimer = setTimeout(async () => {
    try {
      await fetch('/api/item-states', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project, states: snapshot }),
      });
    } catch {
      addLog('Не удалось сохранить статусы позиций');
    }
  }, 250);
}

function queueScanProgressSave() {
  const project = getCurrentProjectName();
  if (!project) return;
  const snapshot = Object.fromEntries(
    Object.entries(state.scanned || {}).map(([k, v]) => [k, Number(v || 0)]).filter(([, v]) => v > 0)
  );
  if (state.progressSaveTimer) clearTimeout(state.progressSaveTimer);
  state.progressSaveTimer = setTimeout(async () => {
    try {
      await fetch('/api/scan-progress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project, scanned: snapshot }),
      });
    } catch {
      addLog('Не удалось сохранить прогресс сканирования');
    }
  }, 300);
}

async function saveScanProgressNow(project, scanned) {
  const snapshot = Object.fromEntries(
    Object.entries(scanned || {}).map(([k, v]) => [k, Number(v || 0)]).filter(([, v]) => v > 0)
  );
  await fetch('/api/scan-progress', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project, scanned: snapshot }),
  });
}

async function loadPorts() {
  const select = document.getElementById('portSelect');
  const statusEl = document.getElementById('serialStatus');
  const captureEl = document.getElementById('serialCapture');
  const packetEl = document.getElementById('serialLastPacket');
  try {
    const [portsData, statusData] = await Promise.all([
      (await fetch('/api/serial/ports')).json(),
      (await fetch('/api/serial/status')).json(),
    ]);
    if (!portsData.ok) {
      if (statusEl) statusEl.textContent = portsData.error || 'Ошибка COM';
      if (captureEl) captureEl.textContent = 'COM: неизвестно';
      if (packetEl) packetEl.textContent = 'Последний пакет: —';
      addLog(`VCOM: ${portsData.error || 'не удалось получить список портов'}`);
      return;
    }
    const ports = portsData.ports || [];
    const current = statusData.port || select.value || '';
    select.innerHTML = `<option value="">COM-порт</option>` + ports.map(p => (
      `<option value="${escapeHtml(p.device)}">${escapeHtml(p.device)} (${escapeHtml(p.description || 'порт')})</option>`
    )).join('');
    if (current) select.value = current;
    if (statusEl) {
      statusEl.textContent = statusData.running
        ? `VCOM активен: ${statusData.port} @ ${statusData.baudrate}`
        : 'VCOM остановлен';
    }
    if (captureEl) {
      captureEl.textContent = statusData.captured ? 'COM: захвачен' : 'COM: освобожден';
    }
    if (packetEl) {
      const packet = (statusData.last_packet || '').trim();
      const stamp = (statusData.last_packet_time || '').trim();
      const meta = statusData.last_packet_meta || {};
      if (packet && scannerSettingsOverlayEl && !scannerSettingsOverlayEl.classList.contains('hidden')) {
        renderScannerSettingsSample(packet, { ...meta, source: 'VCOM status' });
      }
      packetEl.textContent = packet ? `Последний пакет${stamp ? ` [${stamp}]` : ''}: ${packet}` : 'Последний пакет: —';
    }
  } catch {
    if (statusEl) statusEl.textContent = 'Ошибка связи с VCOM';
    if (captureEl) captureEl.textContent = 'COM: неизвестно';
  }
}

function renderScannerMode() {
  const hid = state.scannerMode === 'hid';
  document.getElementById('modeHid').classList.toggle('active', hid);
  document.getElementById('modeVcom').classList.toggle('active', !hid);
  document.getElementById('portSelect').disabled = hid;
  document.getElementById('baudrate').disabled = hid;
  document.getElementById('serialStart').disabled = hid;
  document.getElementById('serialStop').disabled = hid;
}

async function loadDocs(refreshDocs = false, refreshProjects = false) {
  state.documentsLoading = true;
  renderDocs();
  const refreshQ = refreshDocs ? '&refresh=1' : '';
  try {
    state.documents = await (await fetch(`/api/documents?location=${state.location}${refreshQ}`)).json();
    state.selected = new Set([...state.selected].filter(id => state.documents.some(d => d.id === id)));
    syncBulkProjectField();
    await Promise.all([loadNotFound(), loadManualComments(), loadScanProgress(), loadItemStates()]);
    if (refreshProjects || refreshDocs || !state.projectSummary.length) await loadProjectsSummary(refreshDocs || refreshProjects);
  } finally {
    state.documentsLoading = false;
    render();
  }
}

function syncBulkProjectField() {
  const field = document.getElementById('bulkProject');
  const selectedDocs = getSelectedDocs();
  if (!selectedDocs.length) return (field.value = '');
  const uniq = [...new Set(selectedDocs.map(doc => (doc.project || '').trim()).filter(Boolean))];
  field.value = uniq.length === 1 ? uniq[0] : '';
}

function aggregate() {
  const map = new Map();
  for (const doc of getSelectedDocs()) {
    for (const item of doc.items) {
      if (!map.has(item.code)) map.set(item.code, { code: item.code, name: item.name, qty: 0, scanned: 0, docs: [], comments: [], itemStatus: '' });
      const row = map.get(item.code);
      row.qty += Number(item.qty || 0);
      row.docs.push({ name: doc.name, row: item.row || '' });
      if (item.comment) row.comments.push(item.comment);
      if (!row.name && item.name) row.name = item.name;
    }
  }
  for (const [code, row] of map) {
    row.scanned = Number(state.scanned[code] || 0);
    row.itemStatus = state.itemStates?.statuses?.[code] || '';
  }
  for (const code of Object.keys(state.itemStates?.missing || {})) {
    if (!map.has(code)) map.set(code, {
      code,
      name: 'Отсутствует в накладной',
      qty: 0,
      scanned: 0,
      docs: [],
      comments: [],
      itemStatus: 'missing',
    });
  }
  return [...map.values()].sort((a, b) => {
    const aDone = isRowComplete(a) ? 1 : 0;
    const bDone = isRowComplete(b) ? 1 : 0;
    return aDone - bDone || a.code.localeCompare(b.code, 'ru');
  });
}

function isRowComplete(row) {
  return row.itemStatus !== 'defect' && row.itemStatus !== 'missing' && Number(row.qty || 0) > 0 && Number(row.scanned || 0) === Number(row.qty || 0);
}

function documentReferenceLabels(docs) {
  const labels = (docs || []).map(doc => {
    if (typeof doc === 'string') return doc;
    const name = String(doc?.name || '').trim();
    const row = String(doc?.row || '').trim();
    return row ? `${name} № ${row}` : name;
  }).filter(Boolean);
  return [...new Set(labels)];
}

function documentReferenceEntries(docs) {
  const entries = (docs || []).map(doc => {
    if (typeof doc === 'string') return { name: doc, row: '' };
    return {
      name: String(doc?.name || '').trim(),
      row: String(doc?.row || '').trim(),
    };
  }).filter(entry => entry.name);
  const seen = new Set();
  return entries.filter(entry => {
    const key = `${entry.name}\u0000${entry.row}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function documentReferencesHtml(docs) {
  return documentReferenceEntries(docs).map(entry => `
    <div class="document-reference">
      <span>${escapeHtml(entry.name)}</span>
      ${entry.row ? `<span class="document-position">${escapeHtml(entry.row)}</span>` : ''}
    </div>
  `).join('');
}

function getPrintableRows() {
  return aggregate().map(row => ({
    code: row.code,
    name: row.name,
    qty: Number(row.qty || 0),
    scanned: Number(state.scanned[row.code] || 0),
    docs: documentReferenceLabels(row.docs),
  }));
}

function buildPrintHtml(rows) {
  const selectedDocs = getSelectedDocs();
  const project = getCurrentProjectName() || '—';
  const generatedAt = new Date().toLocaleString('ru-RU');
  const docsHtml = selectedDocs.length
    ? selectedDocs.map(d => `<li>${escapeHtml(d.name)}</li>`).join('')
    : '<li>Документы не выбраны</li>';
  const rowsHtml = rows.map(row => `
    <tr>
      <td>${escapeHtml(row.code)}</td>
      <td>${escapeHtml(row.name)}</td>
      <td>${escapeHtml(fmtQty(row.scanned))} / ${escapeHtml(fmtQty(row.qty))}</td>
      <td>${escapeHtml(documentReferenceLabels(row.docs).join(', '))}</td>
    </tr>
  `).join('');
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <title>Печать проекта ${escapeHtml(project)}</title>
  <style>
    body{font-family:Segoe UI,Arial,sans-serif;color:#111;margin:22px}
    h1{margin:0 0 8px;font-size:24px}
    .meta{margin:0 0 14px;color:#333}
    ul{margin:0 0 14px 18px}
    table{border-collapse:collapse;width:100%}
    th,td{border:1px solid #999;padding:6px 8px;font-size:13px;vertical-align:top}
    th{background:#eee;text-align:left}
    .small{color:#444;font-size:12px;margin-bottom:8px}
    @media print { body{margin:10mm} }
  </style>
</head>
<body>
  <h1>Сканирование УП</h1>
  <p class="meta">Проект: <b>${escapeHtml(project)}</b> · Раздел: <b>${escapeHtml(state.location)}</b> · Дата: <b>${escapeHtml(generatedAt)}</b></p>
  <div class="small">Документы источники:</div>
  <ul>${docsHtml}</ul>
  <table>
    <thead><tr><th>Код</th><th>Оборудование</th><th>Отсканировано / Нужно</th><th>Документы</th></tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table>
</body>
</html>`;
}

function renderDocs() {
  if (state.documentsLoading) {
    docsEl.innerHTML = `<div class="documents-loader"><span class="loader-spinner" aria-hidden="true"></span><span>Читаю документы…</span></div>`;
    return;
  }
  if (!state.documents.length) {
    docsEl.innerHTML = `<div class="empty">В Acts/${state.location} пока нет PDF/XLSX.</div>`;
    return;
  }
  docsEl.innerHTML = state.documents.map(doc => `
    <label class="doc">
      <input type="checkbox" data-doc="${escapeHtml(doc.id)}" ${state.selected.has(doc.id) ? 'checked' : ''}>
      <span>
        <span class="doc-title">${escapeHtml(doc.name)}</span>
        <span class="doc-meta">${doc.items.length} поз. · ${escapeHtml(doc.ext)} · ${escapeHtml(doc.modified)}</span>
        <span class="doc-meta">${doc.project ? 'Проект: ' + escapeHtml(doc.project) : ''}</span>
        ${doc.warnings.map(w => `<div class="warning">${escapeHtml(w)}</div>`).join('')}
      </span>
    </label>
  `).join('');
  docsEl.querySelectorAll('input[type=checkbox]').forEach(input => {
    input.addEventListener('change', async () => {
      input.checked ? state.selected.add(input.dataset.doc) : state.selected.delete(input.dataset.doc);
      syncBulkProjectField();
      await Promise.all([loadManualComments(), loadScanProgress(), loadItemStates()]);
      render();
      scanInput.focus();
    });
  });
}

function renderProjectLists() {
  const items = state.projectSummary || [];
  const renderPart = (arr, title, location) => `<div class="project-meta">${title}</div>` + (
    arr.length ? arr.map(item => `
      <div class="project-pill">
        <div><div>${escapeHtml(item.project)}</div><div class="project-meta">${item.docs_count} док. · ${item.items_count} поз.</div></div>
        <button data-project-open="${escapeHtml(item.project)}" data-location="${location}" data-parser-profile="${escapeHtml(item.parser_profile || '')}">Открыть</button>
      </div>`).join('') : `<div class="project-meta">—</div>`
  );
  projectListNewEl.innerHTML = renderPart(items.filter(x => x.location === 'new'), 'Незавершённые', 'new');
  projectListOldEl.innerHTML = renderPart(items.filter(x => x.location === 'old'), 'Завершённые', 'old');
  document.querySelectorAll('button[data-project-open]').forEach(btn => {
    btn.addEventListener('click', () => openProjectFromSummary(btn.dataset.projectOpen, btn.dataset.location, btn.dataset.parserProfile));
  });
}

async function openProjectFromSummary(project, location, parserProfile = '') {
  if (parserProfile && parserProfile !== state.activeParserProfile) {
    const ok = await switchParserProfile(parserProfile, { silent: true, refreshDocs: false });
    if (!ok) return;
  }
  state.location = location === 'old' ? 'old' : 'new';
  await loadDocs(false);
  const ids = state.documents.filter(d => (d.project || '').trim() === String(project || '').trim()).map(d => d.id);
  state.selected = new Set(ids);
  document.getElementById('bulkProject').value = String(project || '').trim();
  await Promise.all([loadManualComments(), loadScanProgress(), loadItemStates()]);
  render();
}

function renderTable(rows) {
  if (!state.selected.size) {
    tableWrap.className = 'empty';
    tableWrap.innerHTML = 'Выбери один или несколько документов слева.';
    return;
  }
  if (!rows.length) {
    tableWrap.className = 'empty';
  tableWrap.innerHTML = 'В выбранных документах не нашлись позиции.';
    return;
  }
  const hasProject = Boolean(getCurrentProjectName());
  tableWrap.className = '';
  tableWrap.innerHTML = `
    <table>
      <thead><tr><th>Код</th><th>Оборудование</th><th>Кол-во</th><th>Статус</th><th>Документы</th><th>Комментарий</th></tr></thead>
      <tbody>
      ${rows.map(row => {
        const status = row.itemStatus === 'defect' ? 'Брак' : row.itemStatus === 'missing' ? 'Отсутствует' : row.scanned > row.qty ? 'Лишнее' : row.scanned >= row.qty ? 'Готово' : row.scanned > 0 ? 'Не всё' : 'Ждёт';
        const statusCls = row.itemStatus === 'defect' ? 'defect' : row.itemStatus === 'missing' ? 'missing' : row.scanned > row.qty ? 'extra' : row.scanned >= row.qty && row.qty > 0 ? 'done' : row.scanned > 0 ? 'partial' : '';
        const lastCls = row.code === state.lastScannedCode ? ' just-scanned' : '';
        return `<tr id="${rowId(row.code)}" class="${statusCls}${lastCls}">
          <td class="code">${escapeHtml(row.code)}</td>
          <td>${escapeHtml(row.name)}</td>
          <td class="qty">
            <div>${fmtQty(row.scanned)} / ${fmtQty(row.qty)}</div>
            <div class="qty-control">
              <button class="qty-btn" data-qty-minus="${escapeHtml(row.code)}" title="Уменьшить">−</button>
              <input class="qty-input" data-qty-input="${escapeHtml(row.code)}" value="${escapeHtml(fmtQty(row.scanned))}">
              <button class="qty-btn" data-qty-plus="${escapeHtml(row.code)}" title="Увеличить">+</button>
            </div>
          </td>
          <td class="status ${statusCls}">${status}${row.itemStatus === 'defect' ? `<button class="status-clear" data-clear-defect="${escapeHtml(row.code)}" title="Снять статус брака">×</button>` : ''}</td>
          <td>${documentReferencesHtml(row.docs)}</td>
          <td><div class="comment-cell">
            <div class="comment-doc">${escapeHtml([...new Set(row.comments)].join('; ')) || '—'}</div>
            <input class="comment-input" data-code="${escapeHtml(row.code)}" value="${escapeHtml(state.manualComments[row.code] || '')}" ${hasProject ? '' : 'disabled'} placeholder="${hasProject ? 'Ручной комментарий по проверке' : 'Сначала укажи проект'}">
          </div></td>
        </tr>`;
      }).join('')}
      </tbody>
    </table>`;
  tableWrap.querySelectorAll('.comment-input').forEach(input => {
    input.addEventListener('input', () => {
      const code = input.dataset.code;
      state.manualComments[code] = input.value;
      queueCommentSave(code, input.value);
    });
  });
  tableWrap.querySelectorAll('[data-qty-minus]').forEach(btn => {
    btn.addEventListener('click', () => {
      const code = btn.dataset.qtyMinus;
      setScannedForCode(code, Number(state.scanned[code] || 0) - 1);
    });
  });
  tableWrap.querySelectorAll('[data-qty-plus]').forEach(btn => {
    btn.addEventListener('click', () => {
      const code = btn.dataset.qtyPlus;
      setScannedForCode(code, Number(state.scanned[code] || 0) + 1);
    });
  });
  tableWrap.querySelectorAll('[data-qty-input]').forEach(input => {
    input.addEventListener('keydown', event => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const code = input.dataset.qtyInput;
      setScannedForCode(code, input.value.replace(',', '.'));
    });
    input.addEventListener('blur', () => {
      const code = input.dataset.qtyInput;
      setScannedForCode(code, input.value.replace(',', '.'));
    });
  });
  tableWrap.querySelectorAll('[data-clear-defect]').forEach(btn => {
    btn.addEventListener('click', () => setDefectStatus(btn.dataset.clearDefect, false));
  });
}

function renderStats(rows) {
  const selectedDocs = getSelectedDocs();
  const hasProject = Boolean(getCurrentProjectName());
  document.getElementById('statDocs').textContent = selectedDocs.length;
  document.getElementById('statLines').textContent = rows.length;
  document.getElementById('statNeed').textContent = fmtQty(rows.reduce((s, r) => s + r.qty, 0));
  document.getElementById('statScanned').textContent = fmtQty(rows.reduce((s, r) => s + Math.min(r.scanned, r.qty), 0));
  const allDone = state.location === 'new' && selectedDocs.length > 0 && rows.length > 0 && rows.every(isRowComplete);
  document.getElementById('moveDone').disabled = !allDone || selectedDocs.length !== 1;
  document.getElementById('finishProject').disabled = !(state.location === 'new' && selectedDocs.length > 0 && hasProject);
  document.getElementById('downloadHtml').disabled = selectedDocs.length === 0 && !hasProject;
  document.getElementById('printPage').disabled = selectedDocs.length === 0 && !hasProject;
  document.getElementById('openFolder').disabled = selectedDocs.length === 0 && !hasProject;
  document.getElementById('showNew').classList.toggle('active', state.location === 'new');
  document.getElementById('showOld').classList.toggle('active', state.location === 'old');
}

function renderLog() {
  const lines = state.log.slice(-30).map(escapeHtml).join('<br>');
  logEl.innerHTML = lines;
  logEl.scrollTop = logEl.scrollHeight;
  if (keypadLogEl) {
    keypadLogEl.innerHTML = lines || 'События сканирования появятся здесь';
    keypadLogEl.scrollTop = keypadLogEl.scrollHeight;
  }
}

function renderNotFoundLog() {
  const rows = (state.notFound || []).slice(-20).reverse();
  notFoundLogEl.innerHTML = rows.length
    ? rows.map(r => `${escapeHtml((r.time || '').replace('T', ' ').slice(0, 19))} · ${escapeHtml(r.raw || r.normalized || '')}`).join('<br>')
    : 'Не найдено: пока пусто';
}

function renderScanChoices() {
  const choices = state.pendingScanChoices || [];
  if (!choices.length) {
    scanChoicesEl.classList.add('hidden');
    scanChoicesEl.innerHTML = '';
    return;
  }
  state.pendingChoiceIndex = Math.max(0, Math.min(Number(state.pendingChoiceIndex || 0), choices.length - 1));
  scanChoicesEl.classList.remove('hidden');
  scanChoicesEl.innerHTML = `
    <div class="scan-choices-title">Найдено несколько совпадений. Выбери нужный код стрелками и Enter:</div>
    <div class="scan-choices-list">
      ${choices.map((item, index) => `<button class="scan-choice-btn ${index === state.pendingChoiceIndex ? 'selected' : ''}" data-index="${index}" data-code="${escapeHtml(item.code)}">${index + 1}. ${escapeHtml(item.code)} · ${escapeHtml(item.name || '')}</button>`).join('')}
    </div>`;
  scanChoicesEl.querySelectorAll('.scan-choice-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      applyScanByCode(btn.dataset.code);
      state.pendingScanChoices = [];
      renderScanChoices();
    });
  });
}

function render() {
  if (state.isClosed) return;
  const rows = aggregate();
  renderScannerMode();
  renderDocs();
  renderProjectLists();
  renderTable(rows);
  renderStats(rows);
  renderLog();
  renderNotFoundLog();
  renderScanChoices();
  renderParserProfiles();
  appMainEl?.classList.toggle('keypad-open', state.keypadOpen);
  keypadDisplay.value = state.keypadBuffer;
  updateScrollButtons();
  updateSettingsButton();
}

function scrollToCode(code) {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const row = document.getElementById(rowId(code));
      if (!row) return;
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      updateScrollButtons();
    });
  });
}

function updateScrollButtons() {
  if (!scrollTopBtnEl || !scrollBottomBtnEl) return;
  const scrollArea = contentScrollEl;
  const canScroll = scrollArea && scrollArea.scrollHeight > scrollArea.clientHeight + 10;
  scrollTopBtnEl.classList.toggle('hidden', !canScroll || scrollArea.scrollTop < 20);
  const nearBottom = !scrollArea || scrollArea.clientHeight + scrollArea.scrollTop >= scrollArea.scrollHeight - 20;
  scrollBottomBtnEl.classList.toggle('hidden', !canScroll || nearBottom);
}

function updateSettingsButton() {
  const btn = document.getElementById('settingsBtn');
  const settings = document.getElementById('settingsMenu');
  if (!btn || !settings) return;
  const isOpen = Boolean(settings.open);
  btn.textContent = `${isOpen ? '▾' : '▸'} Настройки`;
  btn.setAttribute('aria-expanded', String(isOpen));
}

function findScanMatches(input, rows) {
  const normalized = String(input || '').trim().toUpperCase().replace('UP-', 'УП-');
  if (!normalized) return { normalized: '', matches: [] };
  const exact = rows.filter(r => r.code === normalized);
  if (exact.length) return { normalized, matches: exact };
  const digits = normalized.replace(/\D/g, '');
  if (digits) {
    const matched = rows.filter(r => String(r.code || '').replace(/\D/g, '').endsWith(digits));
    return { normalized, matches: matched };
  }
  const terms = normalized.toLowerCase().split(/\s+/).filter(Boolean);
  const matched = rows.filter(r => {
    const name = String(r.name || '').toLowerCase();
    return terms.every(term => name.includes(term));
  });
  return { normalized, matches: matched };
}

function applyScanByCode(code) {
  const rows = aggregate();
  const row = rows.find(r => r.code === code);
  if (!row) return;
  state.scanned[code] = Number(state.scanned[code] || 0) + 1;
  state.lastScannedCode = code;
  queueScanProgressSave();
  const after = state.scanned[code];
  addLog(`${code}: ${fmtQty(after)} / ${fmtQty(row.qty)} ${after > row.qty ? 'ЛИШНЕЕ' : 'OK'}`);
  render();
  scrollToCode(code);
}

function setScannedForCode(code, value) {
  const next = Math.max(0, Number(value || 0));
  if (!Number.isFinite(next)) return;
  state.scanned[code] = next;
  state.lastScannedCode = code;
  queueScanProgressSave();
  render();
  scrollToCode(code);
}

function adjustLastScanned(delta) {
  const code = state.lastScannedCode;
  if (!code) return;
  const current = Number(state.scanned[code] || 0);
  setScannedForCode(code, current + delta);
}

function setDefectStatus(code, enabled) {
  const project = getCurrentProjectName();
  if (!project || !code) {
    addLog('Чтобы отметить брак, сначала укажи проект');
    return;
  }
  state.itemStates ??= { statuses: {}, missing: {} };
  state.itemStates.statuses ??= {};
  if (enabled) state.itemStates.statuses[code] = 'defect';
  else delete state.itemStates.statuses[code];
  state.lastScannedCode = code;
  queueItemStatesSave();
  addLog(`${code}: ${enabled ? 'БРАК' : 'брак снят'}`);
  render();
  scrollToCode(code);
}

function toggleLastDefect() {
  const code = state.lastScannedCode;
  if (!code) return addLog('Сначала отсканируй или выбери позицию');
  setDefectStatus(code, state.itemStates?.statuses?.[code] !== 'defect');
}

function showNotFoundChoice(code) {
  if (!notFoundChoiceOverlayEl || !notFoundChoiceTextEl) return;
  state.pendingMissingCode = String(code || '').trim().toUpperCase();
  notFoundChoiceTextEl.textContent = `Код ${state.pendingMissingCode || '—'} не найден в выбранных документах.`;
  notFoundChoiceOverlayEl.classList.remove('hidden');
  notFoundChoiceOkEl?.focus();
}

function closeNotFoundChoice() {
  state.pendingMissingCode = '';
  notFoundChoiceOverlayEl?.classList.add('hidden');
}

function addMissingCode() {
  const project = getCurrentProjectName();
  const code = String(state.pendingMissingCode || '').trim().toUpperCase();
  if (!project) {
    closeNotFoundChoice();
    return addLog('Чтобы сохранить отсутствующий код, сначала укажи проект');
  }
  if (!code) return closeNotFoundChoice();
  state.itemStates ??= { statuses: {}, missing: {} };
  state.itemStates.missing ??= {};
  state.itemStates.missing[code] = { created: new Date().toISOString() };
  state.lastScannedCode = code;
  queueItemStatesSave();
  closeNotFoundChoice();
  addLog(`${code}: ОТСУТСТВУЕТ В НАКЛАДНОЙ`);
  render();
  scrollToCode(code);
}

function choosePendingScan(delta) {
  const choices = state.pendingScanChoices || [];
  if (!choices.length) return false;
  state.pendingChoiceIndex = (state.pendingChoiceIndex + delta + choices.length) % choices.length;
  renderScanChoices();
  return true;
}

function applyPendingScanChoice() {
  const choices = state.pendingScanChoices || [];
  if (!choices.length) return false;
  const item = choices[state.pendingChoiceIndex] || choices[0];
  state.pendingScanChoices = [];
  state.pendingChoiceIndex = 0;
  renderScanChoices();
  applyScanByCode(item.code);
  return true;
}

async function rememberNotFound(raw, normalized) {
  const entry = { raw: String(raw || '').trim(), normalized: String(normalized || '').trim(), location: state.location, selected: getSelectedDocs().map(d => d.name) };
  state.notFound = [...(state.notFound || []), { ...entry, time: new Date().toISOString() }];
  renderNotFoundLog();
  try {
    await fetch('/api/not-found', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry), keepalive: true });
  } catch {}
}

function handleScan(raw, source = 'HID Enter') {
  if (state.isClosed) return;
  const rows = aggregate();
  const cleaned = cleanCode(raw, source);
  updateScanDebug(raw, cleaned, source);
  const resolved = findScanMatches(cleaned, rows);
  if (!resolved.matches.length) {
    state.pendingScanChoices = [];
    state.pendingChoiceIndex = 0;
    addLog(`НЕ НАЙДЕНО: ${resolved.normalized}`);
    rememberNotFound(raw, resolved.normalized);
    showNotFoundSplash(resolved.normalized || raw);
    showNotFoundChoice(resolved.normalized || raw);
    renderScanChoices();
    return;
  }
  if (resolved.matches.length > 1) {
    state.pendingScanChoices = resolved.matches;
    state.pendingChoiceIndex = 0;
    addLog(`Найдено несколько совпадений для ${resolved.normalized}`);
    renderScanChoices();
    return;
  }
  state.pendingScanChoices = [];
  state.pendingChoiceIndex = 0;
  renderScanChoices();
  applyScanByCode(resolved.matches[0].code);
}

function queueCommentSave(code, text) {
  const project = getCurrentProjectName();
  if (!project) return;
  if (state.commentsSaveTimer[code]) clearTimeout(state.commentsSaveTimer[code]);
  state.commentsSaveTimer[code] = setTimeout(async () => {
    try {
      await fetch('/api/manual-comments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project, code, comment: text }) });
    } catch {
      addLog(`Не удалось сохранить комментарий: ${code}`);
    }
  }, 300);
}

async function downloadSelectedHtml() {
  const files = [...state.selected];
  const project = getCurrentProjectName();
  if (!files.length && !project) return;
  const rows = getPrintableRows();
  const html = buildPrintHtml(rows);
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const projectPart = (project || 'project').replace(/[^\w.-]+/g, '_');
  const filename = `print_${projectPart}_${stamp}.html`;
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(href);
  addLog(`Скачан файл печати: ${filename}`);
}

async function downloadSelectedPdf() {
  const files = [...state.selected];
  const project = getCurrentProjectName();
  if (!files.length && !project) return;
  const rows = getPrintableRows();
  const html = buildPrintHtml(rows);
  const res = await fetch('/api/download-print-pdf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ html, project, location: state.location }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    addLog(`Ошибка скачивания PDF: ${err.error || 'неизвестно'}`);
    return;
  }
  const blob = await res.blob();
  const cd = res.headers.get('Content-Disposition') || '';
  const match = cd.match(/filename="([^"]+)"/i);
  const filename = match ? match[1] : 'print.pdf';
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(href);
  addLog(`Скачан PDF: ${filename}`);
}

function printSelectedDocs() {
  const rows = getPrintableRows();
  const html = buildPrintHtml(rows);
  const w = window.open('', '_blank');
  if (!w) return addLog('Не удалось открыть окно печати (браузер заблокировал pop-up)');
  w.document.open();
  w.document.write(html);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 150);
}

async function openProjectFolder() {
  const files = [...state.selected];
  const project = getCurrentProjectName();
  if (!files.length && !project) return;
  const data = await (await fetch('/api/open-project-folder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files, project, location: state.location }),
  })).json();
  if (!data.ok) return addLog(`Ошибка открытия папки: ${data.error || 'неизвестно'}`);
  addLog(`Открыта папка: ${data.folder}`);
}

async function uploadFilesFromInput(input) {
  const files = [...(input.files || [])];
  if (!files.length) return;
  const uploadButton = document.getElementById('uploadBtn');
  uploadButton.disabled = true;
  try {
  const payloadFiles = [];
  for (const file of files) {
    const ext = (file.name || '').toLowerCase().split('.').pop();
    if (!['pdf', 'xls', 'xlsx', 'xlsm'].includes(ext)) continue;
    const array = await file.arrayBuffer();
    let binary = '';
    const bytes = new Uint8Array(array);
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) binary += String.fromCharCode(...bytes.subarray(i, i + step));
    payloadFiles.push({ name: file.name, content_b64: btoa(binary) });
  }
  if (!payloadFiles.length) return addLog('Нет подходящих файлов для загрузки');
  const data = await (await fetch('/api/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: payloadFiles }),
  })).json();
  if (!data.ok) return addLog(`Ошибка загрузки: ${data.error || 'неизвестно'}`);
  const savedNames = (data.saved || []).map(file => String(file).replace(/^Acts\/new\//, '')).join(', ');
  addLog(`Загружено в Acts/new: ${savedNames || data.saved.length}`);
  input.value = '';
  state.location = 'new';
  savePref('location', state.location);
  await loadDocs(true, true);
  } finally {
    uploadButton.disabled = false;
  }
}

function showClosedScreen() {
  if (state.isClosed) return;
  state.isClosed = true;
  document.body.innerHTML = `
    <main style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.86);padding:0;box-sizing:border-box;font-family:Segoe UI,Arial,sans-serif;overflow:hidden;">
      <section style="text-align:center;width:100vw;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#fff;">
        <h1 style="margin:0;line-height:0.9;font-weight:900;letter-spacing:0;color:#e11d48;text-shadow:0 0 28px rgba(225,29,72,0.58);font-size:min(28vw,320px);">WASTED</h1>
        <h2 style="margin:0;line-height:0.95;font-weight:900;letter-spacing:0;color:#fca5a5;font-size:min(9vw,105px);">ПОТРАЧЕНО</h2>
      </section>
    </main>`;
}

scanInput.addEventListener('keydown', event => {
  if ((state.pendingScanChoices || []).length) {
    if (/^[1-9]$/.test(event.key)) {
      const index = Number(event.key) - 1;
      if (state.pendingScanChoices[index]) {
        event.preventDefault();
        state.pendingChoiceIndex = index;
        applyPendingScanChoice();
      }
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      choosePendingScan(1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      choosePendingScan(-1);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      applyPendingScanChoice();
      scanInput.value = '';
      return;
    }
  }
  if (event.key === 'ArrowRight') {
    event.preventDefault();
    adjustLastScanned(1);
    return;
  }
  if (event.key === 'ArrowLeft') {
    event.preventDefault();
    adjustLastScanned(-1);
    return;
  }
  if (event.key !== 'Enter') return;
  event.preventDefault();
  handleScan(scanInput.value, 'Поле + Enter');
  scanInput.value = '';
});

document.addEventListener('keydown', event => {
  if (event.key === 'F8') {
    event.preventDefault();
    toggleLastDefect();
    return;
  }
  if (isEditableTarget(event.target)) return;
  if ((state.pendingScanChoices || []).length) {
    if (/^[1-9]$/.test(event.key)) {
      const index = Number(event.key) - 1;
      if (state.pendingScanChoices[index]) {
        event.preventDefault();
        state.pendingChoiceIndex = index;
        applyPendingScanChoice();
      }
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      choosePendingScan(1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      choosePendingScan(-1);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      applyPendingScanChoice();
      return;
    }
  }
  if (event.key === 'ArrowRight') {
    event.preventDefault();
    adjustLastScanned(1);
    return;
  }
  if (event.key === 'ArrowLeft') {
    event.preventDefault();
    adjustLastScanned(-1);
    return;
  }
  const now = Date.now();
  const delta = now - state.hidLastKeyTs;
  if (delta > 250) { state.hidBuffer = ''; state.hidRapidCount = 0; }
  state.hidLastKeyTs = now;
  if (event.key === 'Enter') {
    if (state.hidBuffer.trim()) {
      event.preventDefault();
      event.stopPropagation();
      handleScan(state.hidBuffer, 'HID + Enter');
      state.hidBuffer = '';
      state.hidRapidCount = 0;
    }
    return;
  }
  if (event.key === 'Backspace') {
    event.preventDefault();
    event.stopPropagation();
    state.hidBuffer = state.hidBuffer.slice(0, -1);
    return;
  }
  if (event.key.length === 1) {
    state.hidBuffer += event.key;
    state.hidRapidCount = delta > 0 && delta < 45 ? state.hidRapidCount + 1 : 0;
  }
});

document.getElementById('refresh').addEventListener('click', () => loadDocs(true, true));
if (themeToggle) themeToggle.addEventListener('click', () => applyTheme((document.documentElement.getAttribute('data-theme') || 'light') === 'dark' ? 'light' : 'dark'));
document.getElementById('helpBtn').addEventListener('click', () => {
  helpOverlayEl.classList.remove('hidden');
});
document.getElementById('settingsBtn')?.addEventListener('click', () => {
  const settings = document.getElementById('settingsMenu');
  if (!settings) return;
  settings.open = !settings.open;
  updateSettingsButton();
});
document.addEventListener('click', event => {
  const settings = document.getElementById('settingsMenu');
  const btn = document.getElementById('settingsBtn');
  if (!settings?.open) return;
  if (settings.contains(event.target) || btn?.contains(event.target)) return;
  settings.open = false;
  updateSettingsButton();
});
document.getElementById('helpClose').addEventListener('click', () => {
  helpOverlayEl.classList.add('hidden');
});
helpOverlayEl.addEventListener('click', event => {
  if (event.target === helpOverlayEl) helpOverlayEl.classList.add('hidden');
});
confirmOkEl?.addEventListener('click', () => closeDialog(true));
confirmCancelEl?.addEventListener('click', () => closeDialog(false));
confirmOverlayEl?.addEventListener('click', event => {
  if (event.target === confirmOverlayEl) closeDialog(false);
});
promptInputEl?.addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    closeDialog(true);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    closeDialog(false);
  }
});
scannerSettingsBtnEl?.addEventListener('click', () => {
  scannerSettingsOverlayEl.classList.remove('hidden');
  renderScannerSettingsSample(scannerTestInputEl.value || state.scannerSampleRaw, state.scannerSampleMeta || {});
  scannerTestInputEl.focus();
});
scannerSettingsCloseEl?.addEventListener('click', () => {
  scannerSettingsOverlayEl.classList.add('hidden');
  scanInput.focus();
});
scannerSettingsOverlayEl?.addEventListener('click', event => {
  if (event.target === scannerSettingsOverlayEl) scannerSettingsOverlayEl.classList.add('hidden');
});
scannerTestInputEl?.addEventListener('keydown', event => {
  rememberScannerKeyEvent(event);
  if (event.key !== 'Enter') return;
  event.preventDefault();
  const now = Date.now();
  state.scannerEnterPressCount = now - state.scannerLastEnterTs < 700 ? state.scannerEnterPressCount + 1 : 1;
  state.scannerLastEnterTs = now;
  renderScannerSettingsSample(scannerTestInputEl.value, {
    source: 'HID/ручной тест',
    enter_count: state.scannerEnterPressCount,
    cr_count: 0,
    lf_count: 0,
    ending: 'Enter',
  });
  scannerTestInputEl.select();
});
scannerTestInputEl?.addEventListener('keyup', event => {
  rememberScannerKeyEvent(event);
  renderScannerSettingsSample(scannerTestInputEl.value, {
    source: 'HID/ручной тест',
    enter_count: state.scannerEnterPressCount || 0,
    cr_count: 0,
    lf_count: 0,
    ending: state.scannerEnterPressCount ? 'Enter' : 'none',
  });
});
scannerTestInputEl?.addEventListener('input', () => {
  renderScannerSettingsSample(scannerTestInputEl.value, {
    source: 'HID/ручной тест',
    enter_count: state.scannerEnterPressCount || 0,
    cr_count: 0,
    lf_count: 0,
    ending: state.scannerEnterPressCount ? 'Enter' : 'none',
  });
});
trimStartInputEl?.addEventListener('input', applyScannerTrimInputs);
trimEndInputEl?.addEventListener('input', applyScannerTrimInputs);
trimManualInputEl?.addEventListener('change', applyScannerTrimInputs);
document.getElementById('uploadBtn').addEventListener('click', () => document.getElementById('uploadInput').click());
document.getElementById('uploadInput').addEventListener('change', e => uploadFilesFromInput(e.target));
document.getElementById('applyProject').addEventListener('click', async () => {
  const files = [...state.selected];
  if (!files.length) return addLog('Сначала выбери документы слева');
  const project = document.getElementById('bulkProject').value.trim();
  if (!project && !(await confirmAction('Отвязать выбранные документы от проекта?'))) return;
  if (project && !(await confirmAction(`Привязать выбранные документы к проекту "${project}"?`))) return;
  await fetch('/api/project/bulk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files, project, parser_profile: state.activeParserProfile }),
  });
  state.documents = state.documents.map(doc => state.selected.has(doc.id) ? { ...doc, project } : doc);
  await Promise.all([loadManualComments(), loadScanProgress(), loadItemStates()]);
  await loadProjectsSummary();
  addLog(project ? `Проект применён: ${project}` : 'Проект очищен у выбранных документов');
  render();
});
document.getElementById('renameProject').addEventListener('click', async () => {
  const oldProject = getCurrentProjectName();
  if (!oldProject) return addLog('Сначала выбери проект или документ проекта');
  const next = await promptAction('Переименовать проект', 'Новое название проекта', oldProject);
  const newProject = String(next || '').trim();
  if (!newProject || newProject === oldProject) return;
  if (!(await confirmAction(`Переименовать проект "${oldProject}" в "${newProject}" с сохранением прогресса?`))) return;
  const data = await (await fetch('/api/project/rename', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ old_project: oldProject, new_project: newProject }),
  })).json();
  if (!data.ok) return addLog(`Ошибка переименования проекта: ${data.error || 'неизвестно'}`);
  document.getElementById('bulkProject').value = newProject;
  state.documents = state.documents.map(doc => (doc.project || '').trim() === oldProject ? { ...doc, project: newProject } : doc);
  await Promise.all([loadManualComments(), loadScanProgress(), loadItemStates()]);
  await loadProjectsSummary(true);
  addLog(`Проект переименован: ${oldProject} -> ${newProject}`);
  render();
});
document.getElementById('unlinkProject').addEventListener('click', async () => {
  const files = [...state.selected];
  if (!files.length) return addLog('Сначала выбери документы слева');
  if (!(await confirmAction('Отвязать выбранные документы от проекта? Прогресс проекта не удаляется.'))) return;
  await fetch('/api/project/bulk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files, project: '', parser_profile: state.activeParserProfile }),
  });
  state.documents = state.documents.map(doc => state.selected.has(doc.id) ? { ...doc, project: '' } : doc);
  document.getElementById('bulkProject').value = '';
  await Promise.all([loadManualComments(), loadScanProgress(), loadItemStates()]);
  await loadProjectsSummary(true);
  addLog('Выбранные документы отвязаны от проекта');
  render();
});
document.getElementById('deleteDocs').addEventListener('click', async () => {
  const files = [...state.selected];
  if (!files.length) return addLog('Сначала выбери документы слева');
  const label = files.length === 1 ? 'выбранный документ' : `выбранные документы (${files.length})`;
  if (!(await confirmAction(`Удалить ${label} из Acts/${state.location}? Файлы будут удалены без возможности восстановления.`))) return;
  const response = await fetch('/api/documents/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files }),
  });
  const data = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
  if (!data.ok) return addLog(`Ошибка удаления: ${data.error || 'неизвестно'}`);
  state.selected = new Set();
  state.scanned = {};
  state.pendingScanChoices = [];
  addLog(`Удалено документов: ${(data.deleted || []).length}`);
  await loadDocs(true, true);
});
document.getElementById('toggleKeypad').addEventListener('click', () => { state.keypadOpen = !state.keypadOpen; render(); });
toggleSidebarBtnEl.addEventListener('click', () => setSidebarCollapsed(!state.sidebarCollapsed));
notFoundChoiceOkEl?.addEventListener('click', closeNotFoundChoice);
notFoundChoiceMissingEl?.addEventListener('click', addMissingCode);
notFoundChoiceOverlayEl?.addEventListener('click', event => {
  if (event.target === notFoundChoiceOverlayEl) closeNotFoundChoice();
});
keypadPanel.addEventListener('click', e => {
  const button = e.target.closest('button');
  if (!button) return;
  const action = button.dataset.action;
  const key = button.dataset.key;
  if (action === 'back') state.keypadBuffer = state.keypadBuffer.slice(0, -1);
  else if (action === 'clear') state.keypadBuffer = '';
  else if (action === 'enter') {
    if ((state.pendingScanChoices || []).length) {
      applyPendingScanChoice();
    } else if (state.keypadBuffer.trim()) {
      handleScan(state.keypadBuffer, 'Виртуальная клавиатура');
      state.keypadBuffer = '';
    }
  } else if (action === 'qty-plus') {
    adjustLastScanned(1);
  } else if (action === 'qty-minus') {
    adjustLastScanned(-1);
  } else if (action === 'defect') {
    toggleLastDefect();
  } else if (key) {
    const choices = state.pendingScanChoices || [];
    if (choices.length && /^[1-9]$/.test(key) && choices[Number(key) - 1]) {
      state.pendingChoiceIndex = Number(key) - 1;
      applyPendingScanChoice();
    } else {
      state.keypadBuffer += key;
    }
  }
  render();
});
document.getElementById('showNew').addEventListener('click', async () => {
  state.location = 'new';
  savePref('location', state.location);
  state.selected = new Set();
  state.scanned = {};
  state.pendingScanChoices = [];
  await loadDocs(false);
});
document.getElementById('showOld').addEventListener('click', async () => {
  state.location = 'old';
  savePref('location', state.location);
  state.selected = new Set();
  state.scanned = {};
  state.pendingScanChoices = [];
  await loadDocs(false);
});
document.getElementById('modeHid').addEventListener('click', () => {
  state.scannerMode = 'hid';
  savePref('scanner_mode', state.scannerMode);
  render();
  addLog('Режим HID: сканер и ручной ввод цифр + Enter работают в любом месте страницы (кроме полей ввода).');
});
document.getElementById('modeVcom').addEventListener('click', async () => {
  state.scannerMode = 'vcom';
  savePref('scanner_mode', state.scannerMode);
  await loadPorts();
  render();
  addLog('Режим VCOM: выбери COM-порт, нажми Старт. Данные сканера читаются из порта; ручной ввод цифр + Enter тоже доступен.');
});
document.getElementById('baudrate').addEventListener('change', event => {
  savePref('baudrate', String(event.target.value || '9600'));
});
keypadPrefixInputEl.addEventListener('change', event => {
  const value = String(event.target.value || '').trim() || 'УП-';
  applyKeypadPrefix(value);
  savePref('keypad_prefix', value);
});
if (parserProfileSelectEl) {
  parserProfileSelectEl.addEventListener('change', async event => {
    const name = String(event.target.value || '').trim();
    await switchParserProfile(name, { silent: false, refreshDocs: true });
  });
}
document.getElementById('serialStart').addEventListener('click', async () => {
  const port = document.getElementById('portSelect').value;
  const baudrate = document.getElementById('baudrate').value;
  const data = await (await fetch('/api/serial/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ port, baudrate }) })).json();
  addLog(data.ok ? `VCOM запущен: ${port}` : `VCOM ошибка: ${data.error}`);
  await loadPorts();
});
document.getElementById('serialStop').addEventListener('click', async () => {
  await fetch('/api/serial/stop', { method: 'POST' });
  addLog('VCOM остановлен');
  await loadPorts();
});
document.getElementById('selectAll').addEventListener('click', async () => {
  const allSelected = state.documents.length && state.documents.every(doc => state.selected.has(doc.id));
  state.selected = allSelected ? new Set() : new Set(state.documents.map(doc => doc.id));
  syncBulkProjectField();
  await Promise.all([loadManualComments(), loadScanProgress(), loadItemStates()]);
  render();
  scanInput.focus();
});
document.getElementById('reset').addEventListener('click', async () => {
  if (!(await confirmAction('Сбросить текущий прогресс сканирования и лог?'))) return;
  state.scanned = {};
  state.log = [];
  state.pendingScanChoices = [];
  state.lastScannedCode = '';
  queueScanProgressSave();
  render();
  scanInput.focus();
});
document.getElementById('downloadHtml').addEventListener('click', downloadSelectedHtml);
document.getElementById('printPage').addEventListener('click', printSelectedDocs);
document.getElementById('openFolder').addEventListener('click', openProjectFolder);
document.getElementById('moveDone').addEventListener('click', async () => {
  const selected = [...state.selected];
  if (selected.length !== 1) return;
  if (!(await confirmAction('Переместить выбранный документ в old?'))) return;
  const data = await (await fetch('/api/move-to-old', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file: selected[0] }) })).json();
  if (!data.ok) return addLog(`Ошибка переноса: ${data.error}`);
  addLog(`Перемещен в old: ${data.target}`);
  state.selected.delete(selected[0]);
  await loadDocs(true, true);
});
document.getElementById('finishProject').addEventListener('click', async () => {
  const files = [...state.selected];
  if (!files.length) return addLog('Сначала выбери документы слева');
  const project = getCurrentProjectName();
  if (!project) return addLog('Укажи название проекта в поле "Мини-проект / название"');
  if (!(await confirmAction(`Завершить проект "${project}" и перенести выбранные документы в old?`))) return;
  const data = await (
    await fetch('/api/project/finish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files, project, parser_profile: state.activeParserProfile }),
    })
  ).json();
  if (!data.ok) return addLog(`Ошибка завершения проекта: ${data.error}`);
  try { await saveScanProgressNow(project, state.scanned); } catch { addLog('Не удалось сохранить прогресс перед переносом проекта'); }
  addLog(`Проект завершён: ${project} -> ${data.folder}`);
  state.selected = new Set();
  state.scanned = {};
  await loadDocs(true, true);
});
document.getElementById('exitApp').addEventListener('click', async () => {
  if (!(await confirmAction('Закрыть приложение и остановить сервер?'))) return;
  showClosedScreen();
  try {
    await fetch('/api/serial/stop', { method: 'POST', keepalive: true });
    await fetch('/api/shutdown', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', keepalive: true });
  } finally {}
});
scrollTopBtnEl.addEventListener('click', () => {
  contentScrollEl?.scrollTo({ top: 0, behavior: 'smooth' });
});
scrollBottomBtnEl.addEventListener('click', () => {
  contentScrollEl?.scrollTo({ top: contentScrollEl.scrollHeight, behavior: 'smooth' });
});
contentScrollEl?.addEventListener('scroll', updateScrollButtons);
window.addEventListener('resize', updateScrollButtons);

async function pollSerialScans() {
  if (state.isClosed) return;
  try {
    const ping = await fetch('/api/ping', { cache: 'no-store' });
    if (!ping.ok) throw new Error('ping failed');
    state.pingFailures = 0;
    const events = await (await fetch(`/api/scans?since=${state.lastScanEvent}`)).json();
    for (const event of events) {
      state.lastScanEvent = Math.max(state.lastScanEvent, event.id);
      if (scannerSettingsOverlayEl && !scannerSettingsOverlayEl.classList.contains('hidden')) {
        renderScannerSettingsSample(event.raw || event.code, { ...(event.meta || {}), source: event.source || 'VCOM' });
      }
      handleScan(event.code, 'VCOM');
    }
    if (state.scannerMode === 'vcom') {
      state.vcomStatusTick += 1;
      if (state.vcomStatusTick >= 4) {
        state.vcomStatusTick = 0;
        await loadPorts();
      }
    } else {
      state.vcomStatusTick = 0;
    }
  } catch {
    state.pingFailures += 1;
    if (state.pingFailures >= 2) showClosedScreen();
  }
}

try {
  applyTheme(localStorage.getItem('up_scanner_theme') || 'light');
} catch {
  applyTheme('light');
}
state.location = loadPref('location', state.location) === 'old' ? 'old' : 'new';
state.scannerMode = loadPref('scanner_mode', state.scannerMode) === 'vcom' ? 'vcom' : 'hid';
state.keypadSide = loadPref('keypad_side', state.keypadSide) === 'left' ? 'left' : 'right';
setSidebarCollapsed(Boolean(loadPref('sidebar_collapsed', false)));
state.scannerTrimStart = Math.max(0, Number(loadPref('scanner_trim_start', 0) || 0));
state.scannerTrimEnd = Math.max(0, Number(loadPref('scanner_trim_end', 0) || 0));
state.scannerTrimManual = Boolean(loadPref('scanner_trim_manual', false));
if (trimStartInputEl) trimStartInputEl.value = String(state.scannerTrimStart);
if (trimEndInputEl) trimEndInputEl.value = String(state.scannerTrimEnd);
if (trimManualInputEl) trimManualInputEl.checked = state.scannerTrimManual;
document.getElementById('baudrate').value = String(loadPref('baudrate', document.getElementById('baudrate').value || '9600'));
applyKeypadPrefix(loadPref('keypad_prefix', state.keypadPrefix));
async function initApp() {
  await loadParserProfiles();
  await loadDocs(false, false);
}
initApp();
updateClock();
setInterval(updateClock, 1000);
setInterval(pollSerialScans, 500);
