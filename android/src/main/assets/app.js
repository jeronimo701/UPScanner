'use strict';
const $ = id => document.getElementById(id);
const storageKey = 'upscanner.mobile.v1';
const themes = {light: 'Светлая', dark: 'Тёмная', amoled: 'AMOLED'};
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
const makeProject = name => ({ id: newId(), name, docs: [], scans: {}, defects: {}, missing: {} });
let state;
const nativeStore = typeof window.Android?.loadState === 'function';
let storageLoadFailed = false;
let stored = null;
try { if (nativeStore) stored = window.Android.loadState() ?? null; }
catch { storageLoadFailed = true; }
if (stored === null && !storageLoadFailed) {
  try { state = JSON.parse(localStorage.getItem(storageKey)); } catch {}
} else if (!storageLoadFailed) {
  try {
    state = JSON.parse(stored);
    if (!Array.isArray(state?.projects) || !state.projects.length) storageLoadFailed = true;
  } catch { storageLoadFailed = true; }
}
const needsMigration = nativeStore && stored === null && Boolean(state?.projects?.length);
if (storageLoadFailed) state = null;
if (!state?.projects?.length) {
  const first = makeProject('Основная');
  state = { projects: [first], current: first.id };
}
state.theme = Object.hasOwn(themes, state.theme) ? state.theme : 'light';
state.scanner ||= {};
let filter = 'all';
let last = '';
let busy = false;
const project = () => state.projects.find(p => p.id === state.current) || state.projects[0];
const el = (tag, text = '', cls = '') => {
  const node = document.createElement(tag);
  node.textContent = text;
  node.className = cls;
  return node;
};
function feedback(message, error = false) {
  $('feedback').textContent = message;
  $('feedback').hidden = !message;
  $('feedback').classList.toggle('error', error);
}
function save() {
  if (storageLoadFailed) {
    feedback('Не удалось открыть сохранённые данные. Старый файл не перезаписан.', true);
    return false;
  }
  try {
    const data = JSON.stringify(state);
    if (nativeStore) {
      if (!window.Android.saveState(data)) throw new Error('Storage write failed');
    } else localStorage.setItem(storageKey, data);
    return true;
  }
  catch { feedback('Не удалось сохранить изменения: хранилище переполнено или недоступно.', true); return false; }
}
function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  window.Android?.setTheme?.(state.theme);
}
function rowsFor(p = project()) {
  const rows = new Map();
  for (const doc of p.docs) for (const item of doc.items) {
    if (!rows.has(item.code)) rows.set(item.code, { code: item.code, qty: 0, name: '', refs: [], comments: [] });
    const row = rows.get(item.code);
    row.qty += item.qty;
    row.name ||= item.name;
    row.refs.push(doc.name + ' · ' + item.ref);
    if (item.comment && !row.comments.includes(item.comment)) row.comments.push(item.comment);
  }
  for (const code of Object.keys(p.missing)) if (!rows.has(code)) {
    rows.set(code, {code, qty: 0, name: '', refs: [], comments: [], missing: true});
  }
  return [...rows.values()].map(r => {
    const qty = +(r.qty.toFixed(6));
    const count = Object.hasOwn(p.scans, r.code) ? p.scans[r.code] : 0;
    const defect = Object.hasOwn(p.defects, r.code);
    const done = !defect && !r.missing && count === qty;
    const issue = defect || r.missing || count > qty;
    return {...r, qty, count, defect, done, issue,
      status: defect ? 'Брак' : r.missing ? 'Нет в накладных' : done ? 'Готово' : count > qty ? 'Лишнее' : count ? 'Не всё' : 'Ждёт'};
  }).sort((a, b) => Number(a.done) - Number(b.done) || a.code.localeCompare(b.code, 'ru'));
}
function update(code, delta) {
  const p = project();
  const row = rowsFor(p).find(r => r.code === code);
  if (!row) return;
  const next = Math.max(row.missing ? 1 : 0, row.count + delta);
  if (next) p.scans[code] = next;
  else delete p.scans[code];
  last = code;
  if (save()) feedback(code + ' · ' + next + ' / ' + row.qty);
  render();
}
function toggleDefect(code) {
  if (!code || !rowsFor().some(r => r.code === code && !r.missing)) return;
  const p = project();
  if (Object.hasOwn(p.defects, code)) delete p.defects[code];
  else p.defects[code] = true;
  last = code;
  if (save()) feedback(code + ' · ' + (p.defects[code] ? 'Брак' : 'Брак снят'));
  render();
}
function render() {
  const p = project();
  const rows = rowsFor(p);
  $('project').replaceChildren();
  for (const [archived, label] of [[false, 'Активные'], [true, 'Архив']]) {
    const entries = state.projects.filter(entry => Boolean(entry.archived) === archived);
    if (!entries.length) continue;
    const group = document.createElement('optgroup');
    group.label = label;
    for (const entry of entries) group.append(new Option(entry.name, entry.id, false, entry.id === p.id));
    $('project').append(group);
  }
  $('project').disabled = busy;
  $('projects').disabled = busy;
  $('newProject').disabled = busy;
  $('pick').disabled = busy;
  $('files').hidden = !p.docs.length;
  $('docCount').textContent = p.docs.length;
  $('docList').replaceChildren(...p.docs.map(d => {
    const item = el('li', d.name + ' · ' + d.items.length + ' поз.');
    if (d.warnings?.length) {
      const warnings = el('ul');
      for (const warning of d.warnings) warnings.append(el('li', warning));
      item.append(warnings);
    }
    return item;
  }));
  $('total').textContent = rows.length;
  $('complete').textContent = rows.filter(r => r.done).length;
  $('issues').textContent = rows.filter(r => r.issue).length;
  $('export').disabled = !rows.length;
  document.querySelectorAll('[data-filter]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.filter === filter)));
  const visible = rows.filter(r => filter === 'all' || (filter === 'open' ? !r.done : r.issue));
  $('rows').replaceChildren();
  if (!visible.length) {
    $('rows').append(el('p', p.docs.length ? 'В этом списке нет позиций.' : 'Накладные не добавлены.', 'empty'));
    return;
  }
  const frag = document.createDocumentFragment();
  for (const row of visible) {
    const item = el('article', '', 'row' + (row.done ? ' done' : row.issue ? ' issue' : '') + (row.code === last ? ' last' : ''));
    item.dataset.code = row.code;
    const head = el('div', '', 'row-head');
    head.append(el('code', row.code), el('span', row.status, 'status'));
    item.append(head);
    if (row.name) item.append(el('h3', row.name));
    if (row.refs.length) item.append(el('small', [...new Set(row.refs)].join('; ')));
    if (row.comments.length) item.append(el('small', row.comments.join('; ')));
    const actions = el('div', '', 'row-actions');
    const stepper = el('div', '', 'stepper');
    const minus = el('button', '−');
    const plus = el('button', '+');
    minus.setAttribute('aria-label', 'Уменьшить количество ' + row.code);
    plus.setAttribute('aria-label', 'Увеличить количество ' + row.code);
    minus.disabled = row.count <= (row.missing ? 1 : 0);
    minus.onclick = () => update(row.code, -1);
    plus.onclick = () => update(row.code, 1);
    stepper.append(minus, el('span', row.count + ' / ' + row.qty, 'amount'), plus);
    const defect = el('button', row.defect ? 'Снять брак' : 'Брак', 'defect');
    defect.setAttribute('aria-pressed', String(row.defect));
    defect.onclick = () => toggleDefect(row.code);
    actions.append(stepper);
    if (!row.missing) actions.append(defect);
    item.append(actions);
    frag.append(item);
  }
  $('rows').append(frag);
}
function modal(title) {
  $('modalTitle').textContent = title;
  $('modalBody').replaceChildren();
  $('modalActions').replaceChildren();
  if (!$('modal').open) $('modal').showModal();
}
function action(label, handler, cls = '') {
  const button = el('button', label, cls);
  button.type = 'button';
  button.onclick = handler;
  $('modalActions').append(button);
}
function trimSize(value) { return Math.min(64, Math.max(0, Math.trunc(Number(value)) || 0)); }
function applyScan(raw, source = 'manual') {
  let text = raw.trim();
  if (text && (source === 'camera' || state.scanner.trimManual)) {
    text = text.slice(trimSize(state.scanner.trimStart), Math.max(0, text.length - trimSize(state.scanner.trimEnd)));
    if (!text.trim()) return feedback('После обрезки не осталось кода. Проверьте настройки сканера.', true);
  }
  const code = text.trim().toUpperCase().replace(/^UP-/, 'УП-');
  if (!code || $('modal').open) return;
  if (!project().docs.length) return feedback('Сначала добавьте накладную.', true);
  const rows = rowsFor();
  const exact = rows.find(r => r.code === code);
  if (exact) return update(exact.code, 1);
  const digits = code.match(/^(?:УП-)?(\d+)$/)?.[1];
  const terms = code.toLowerCase().split(/\s+/);
  const matches = rows.filter(r => digits ? !r.missing && r.code.endsWith(digits) : terms.every(t => r.name.toLowerCase().includes(t)));
  if (matches.length === 1) return update(matches[0].code, 1);
  if (matches.length) {
    modal('Выберите позицию');
    for (const row of matches) {
      const pick = el('button', row.code + ' · ' + row.name, 'choice');
      pick.type = 'button';
      pick.onclick = () => { $('modal').close(); update(row.code, 1); };
      $('modalBody').append(pick);
    }
    action('Отмена', () => $('modal').close());
    return;
  }
  modal(digits ? 'Код не найден' : 'Позиция не найдена');
  $('modalBody').textContent = code;
  action('OK', () => $('modal').close());
  if (digits) action('Отсутствует в накладной', () => {
    $('modal').close();
    project().missing[code] = true;
    update(code, 1);
  }, 'solid');
}
function csvCell(value) {
  let safe = String(value ?? '');
  if (/^[\s]*[=+\-@]/.test(safe) || /^[\t\r\n]/.test(safe)) safe = "'" + safe;
  return '"' + safe.replace(/"/g, '""') + '"';
}
$('scanForm').onsubmit = event => {
  event.preventDefault();
  const code = $('code').value;
  $('code').value = '';
  applyScan(code);
};
function selectProject(id) {
  if (busy || !state.projects.some(p => p.id === id)) return;
  state.current = id;
  last = '';
  filter = 'all';
  $('code').value = '';
  $('files').open = false;
  feedback('');
  save();
  render();
}
function editProject(entry = null) {
  modal(entry ? 'Переименовать проект' : 'Новый проект');
  const input = el('input');
  input.setAttribute('aria-label', 'Название проекта');
  input.placeholder = 'Название проекта';
  input.value = entry?.name || '';
  input.maxLength = 80;
  const warning = el('p', '', 'form-error');
  warning.hidden = true;
  const commit = () => {
    if (busy) return;
    const name = input.value.trim();
    if (!name) { input.focus(); return; }
    if (state.projects.some(p => p.id !== entry?.id && p.name.toLowerCase() === name.toLowerCase())) {
      warning.textContent = 'Проект с таким названием уже есть.';
      warning.hidden = false;
      input.focus();
      return;
    }
    $('modal').close();
    if (!entry) {
      const p = makeProject(name);
      state.projects.push(p);
      selectProject(p.id);
    } else {
      entry.name = name;
      save();
      render();
    }
  };
  $('modalBody').append(input, warning);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } });
  action('Отмена', () => $('modal').close());
  action(entry ? 'Сохранить' : 'Создать', commit, 'solid');
  input.focus();
  if (entry) input.select();
}
function showProjects() {
  modal('Проекты');
  const current = project();
  for (const [archived, title] of [[false, 'Активные'], [true, 'Архив']]) {
    const entries = state.projects.filter(p => Boolean(p.archived) === archived);
    if (!entries.length) continue;
    const list = el('section', '', 'project-group');
    list.append(el('h3', title));
    for (const entry of entries) {
      const button = el('button', '', 'project-entry');
      button.type = 'button';
      const selected = entry.id === current.id;
      button.setAttribute('aria-current', String(selected));
      button.append(el('b', entry.name), el('small', (selected ? 'Текущий · ' : '') + 'Документов: ' + entry.docs.length));
      button.onclick = () => { $('modal').close(); selectProject(entry.id); };
      list.append(button);
    }
    $('modalBody').append(list);
  }
  const tools = el('div', '', 'project-tools');
  tools.append(el('p', 'Текущий проект: ' + current.name));
  for (const [label, handler] of [
    ['Переименовать', () => editProject(current)],
    [current.archived ? 'Вернуть из архива' : 'В архив', () => {
      const restore = Boolean(current.archived);
      modal(restore ? 'Вернуть проект из архива?' : 'Перенести проект в архив?');
      $('modalBody').textContent = '«' + current.name + '». Накладные и результаты сохранятся.';
      action('Отмена', showProjects);
      action(restore ? 'Вернуть' : 'В архив', () => {
        if (busy) return;
        current.archived = !restore;
        save();
        render();
        showProjects();
      }, 'solid');
    }],
    ['Удалить', () => {
      modal('Удалить проект?');
      $('modalBody').textContent = '«' + current.name + '»: накладные и результаты проверки будут удалены из UPScanner. Исходные файлы не изменятся.';
      action('Отмена', showProjects);
      action('Удалить проект', () => {
        if (busy) return;
        state.projects = state.projects.filter(p => p.id !== current.id);
        if (!state.projects.length) state.projects.push(makeProject('Основная'));
        const next = state.projects.find(p => !p.archived) || state.projects[0];
        $('modal').close();
        selectProject(next.id);
      }, 'danger');
    }]
  ]) {
    const button = el('button', label);
    button.type = 'button';
    button.onclick = () => { if (!busy) handler(); };
    tools.append(button);
  }
  $('modalBody').append(tools);
  action('Закрыть', () => $('modal').close());
  action('Новый проект', () => editProject(), 'solid');
}
function showSettings() {
  modal('Настройки');
  const field = el('fieldset', '', 'theme-options');
  field.append(el('legend', 'Тема'));
  for (const [value, name] of Object.entries(themes)) {
    const label = el('label', '', 'theme-option');
    const radio = el('input');
    radio.type = 'radio';
    radio.name = 'theme';
    radio.value = value;
    radio.checked = value === state.theme;
    radio.onchange = () => { state.theme = value; applyTheme(); save(); };
    label.append(radio, el('span', name));
    field.append(label);
  }
  const instructions = el('details', '', 'instructions');
  const steps = el('ol');
  for (const step of [
    'Откройте «Проекты» → «Новый проект», введите своё название и нажмите «Создать». Рядом с «Проекты» можно переключаться между проверками.',
    'Добавьте PDF, XLS или XLSX через «Накладные». Из почты или Telegram отправьте сам файл через «Поделиться» → «UPScanner».',
    'Используйте камеру или введите код и нажмите «Ввод». Количество меняется кнопками «−» и «＋». Кнопка «Брак» отмечает позицию.',
    'Для отчёта нажмите значок выгрузки. Накладные и результаты сохраняются на этом устройстве; для завершённого проекта используйте «В архив».'
  ]) steps.append(el('li', step));
  instructions.append(el('summary', 'Инструкция'), steps);
  const scanner = el('details', '', 'scanner-options');
  scanner.append(el('summary', 'Обрезка кода'));
  for (const [key, name] of [['trimStart', 'Символов спереди'], ['trimEnd', 'Символов сзади']]) {
    const label = el('label', name, 'scanner-setting');
    const input = el('input');
    input.type = 'number';
    input.min = '0';
    input.max = '64';
    input.value = trimSize(state.scanner[key]);
    input.onchange = () => {
      state.scanner[key] = trimSize(input.value);
      input.value = state.scanner[key];
      save();
    };
    label.append(input);
    scanner.append(label);
  }
  const manual = el('label', '', 'theme-option');
  const checkbox = el('input');
  checkbox.type = 'checkbox';
  checkbox.checked = Boolean(state.scanner.trimManual);
  checkbox.onchange = () => { state.scanner.trimManual = checkbox.checked; save(); };
  manual.append(checkbox, el('span', 'Применять к ручному вводу и HID'));
  scanner.append(manual);
  const reset = el('button', 'Сбросить результаты', 'outline');
  reset.type = 'button';
  reset.onclick = () => {
    if (busy) return;
    modal('Сбросить результаты?');
    $('modalBody').textContent = '«' + project().name + '»: количество, брак и пересорт будут сброшены. Накладные останутся.';
    action('Отмена', showSettings);
    action('Сбросить', () => {
      if (busy) return;
      Object.assign(project(), {scans: {}, defects: {}, missing: {}});
      last = '';
      $('modal').close();
      if (save()) feedback('Результаты сброшены');
      render();
    }, 'danger');
  };
  $('modalBody').append(field, scanner, instructions, reset);
  action('Закрыть', () => $('modal').close(), 'solid');
}
$('project').onchange = () => selectProject($('project').value);
$('newProject').onclick = () => editProject();
$('projects').onclick = showProjects;
$('settings').onclick = showSettings;
document.querySelectorAll('[data-filter]').forEach(b => b.onclick = () => { filter = b.dataset.filter; render(); });
window.addEventListener('keydown', e => {
  if ($('modal').open || e.repeat || !last || e.key !== 'F8') return;
  e.preventDefault();
  toggleDefect(last);
});
$('pick').onclick = () => window.Android?.pick();
$('camera').onclick = () => window.Android?.scan();
$('export').onclick = () => {
  const table = [['Код', 'Оборудование', 'Нужно', 'Факт', 'Статус', 'Документы', 'Комментарий']];
  for (const row of rowsFor()) table.push([row.code, row.name, row.qty, row.count, row.status, row.refs.join('; '), row.comments.join('; ')]);
  window.Android?.exportCsv('UPScanner.csv', table.map(line => line.map(csvCell).join(';')).join('\r\n'));
};
window.receive = (event, payload) => {
  if (event === 'scan') applyScan(payload, 'camera');
  if (event === 'busy') { busy = true; feedback('Читаю накладные…'); render(); }
  if (event === 'idle') { busy = false; render(); }
  if (event === 'error') feedback(payload, true);
  if (event === 'message') feedback(payload);
  if (event === 'import') {
    const doc = JSON.parse(payload);
    const p = project();
    if (p.docs.some(d => d.name === doc.name && JSON.stringify(d.items) === JSON.stringify(doc.items))) {
      feedback('Накладная уже добавлена: ' + doc.name);
      return;
    }
    p.docs.push(doc);
    if (save()) feedback(doc.name + ' · добавлено ' + doc.items.length + ' поз.' +
      (doc.warnings?.length ? ' · проверьте количество: ' + doc.warnings.length : ''), Boolean(doc.warnings?.length));
    if (doc.warnings?.length) $('files').open = true;
    render();
  }
};
applyTheme();
if (needsMigration || storageLoadFailed) save();
render();
