const appRoot = document.querySelector('#app');
const firebaseConfig = window.SHOPSYNC_FIREBASE_CONFIG;
const storageKey = 'shopsync:v2';
const roleKey = 'shopsync:roles:v2';
const adminStateKey = 'shopsync:last-admin:v2';
const dragStartMs = 80;
const dragAllMs = 600;
const listIdleMs = 30 * 24 * 60 * 60 * 1000;
const participantIcons = ['🦁', '🐺', '🦊', '🦍', '🐊', '🦅', '🐵', '🐢', '🦄', '🐱', '🐰', '🐨', '🦔', '🐿️', '🐞'];
const icons = {
  plus: 'M12 5v14M5 12h14',
  share: 'M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M16 6l-4-4-4 4M12 2v14',
  copy: 'M8 8h12v12H8zM4 4h12v2H6v10H4z',
  user: 'M20 21a8 8 0 0 0-16 0M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10',
  check: 'M20 6 9 17l-5-5',
  cart: 'M6 6h15l-2 8H8L6 3H3m6 16a1 1 0 1 0 0 .01M18 19a1 1 0 1 0 0 .01',
  trash: 'M3 6h18M8 6V4h8v2m-9 0 1 15h8l1-15M10 11v6M14 11v6',
  x: 'M18 6 6 18M6 6l12 12'
};
let state = loadLocal();
let roles = loadRoles();
let modal = null;
let db = null;
let auth = null;
let firebaseApi = null;
let firebaseUid = null;
let syncReady = false;
let syncError = '';
let unsubscribe = null;
let selectedParticipantId = null;
let undoAction = null;
let undoTimer = null;
let copyNotice = '';
let copyNoticeTimer = null;
let dragState = null;
const params = new URLSearchParams(location.search);
const sharedListId = params.get('list');

boot();

async function boot() {
  if (firebaseConfig) {
    try {
      firebaseApi = await loadFirebase();
      const firebaseApp = firebaseApi.initializeApp(firebaseConfig);
      db = firebaseApi.getDatabase(firebaseApp);
      auth = firebaseApi.getAuth(firebaseApp);
      firebaseApi.onAuthStateChanged(auth, (user) => {
        firebaseUid = user?.uid || null;
        syncReady = Boolean(firebaseUid);
        if (sharedListId && firebaseUid && (!state || state.id !== sharedListId)) attachRemote(sharedListId);
        recognizeDeviceRole();
        render();
      });
      await firebaseApi.signInAnonymously(auth);
    } catch (error) {
      syncError = 'Firebase не подключился';
      console.error(error);
    }
  }
  if (sharedListId && db) attachRemote(sharedListId);
  else if (sharedListId && (!state || state.id !== sharedListId)) state = makeJoinStub(sharedListId);
  render();
}

async function loadFirebase() {
  const [appModule, authModule, databaseModule] = await Promise.all([
    import('https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js'),
    import('https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js'),
    import('https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js')
  ]);
  return { ...appModule, ...authModule, ...databaseModule };
}

function attachRemote(listId) {
  if (!db) return;
  if (unsubscribe) unsubscribe();
  unsubscribe = firebaseApi.onValue(firebaseApi.ref(db, `lists/${listId}`), (snapshot) => {
    const remote = snapshot.val();
    if (remote && isExpiredList(remote)) {
      firebaseApi.remove(firebaseApi.ref(db, `lists/${listId}`));
      state = makeExpiredStub(listId);
    } else {
      state = remote ? normalizeState(remote) : makeMissingStub(listId);
    }
    recognizeDeviceRole();
    saveLocal();
    render();
  });
}

function normalizeState(next) {
  const updatedAt = Number(next.updatedAt || next.createdAt || Date.now());
  return {
    id: next.id,
    title: next.title || 'Общая закупка',
    adminUid: next.adminUid || null,
    createdAt: next.createdAt || Date.now(),
    participants: next.participants || {},
    items: next.items || {},
    updatedAt,
    expiresAt: Number(next.expiresAt || updatedAt + listIdleMs)
  };
}

function makeJoinStub(listId) {
  return { id: listId, title: 'Список по ссылке', adminUid: null, participants: {}, items: {}, missingRemote: true };
}

function makeMissingStub(listId) {
  return { id: listId, title: 'Список не найден', adminUid: null, participants: {}, items: {}, missingRemote: true };
}

function makeExpiredStub(listId) {
  return { id: listId, title: 'Список устарел', adminUid: null, participants: {}, items: {}, expired: true, missingRemote: true };
}

function isExpiredList(next) {
  const updatedAt = Number(next?.updatedAt || next?.createdAt || 0);
  return Boolean(updatedAt && Date.now() - updatedAt > listIdleMs);
}

function touchState() {
  state.updatedAt = Date.now();
  state.expiresAt = state.updatedAt + listIdleMs;
}

function loadLocal() {
  try {
    const hasListInUrl = new URLSearchParams(location.search).has('list');
    if (!hasListInUrl) {
      const adminRaw = localStorage.getItem(adminStateKey);
      if (adminRaw) return normalizeState(JSON.parse(adminRaw));
    }
    const raw = localStorage.getItem(storageKey);
    return raw ? normalizeState(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function saveLocal() {
  if (!state) return;
  localStorage.setItem(storageKey, JSON.stringify(state));
  if (isAdmin()) localStorage.setItem(adminStateKey, JSON.stringify(state));
}

function loadRoles() {
  try {
    return JSON.parse(localStorage.getItem(roleKey) || '{}');
  } catch {
    return {};
  }
}

function saveRoles() {
  localStorage.setItem(roleKey, JSON.stringify(roles));
}

function roleForList() {
  return state?.id ? roles[state.id] || {} : {};
}

function setRole(patch) {
  roles[state.id] = { ...roleForList(), ...patch };
  saveRoles();
}

function participantForUid(uid) {
  if (!uid) return null;
  return participantsArray().find((person) => person.uid === uid) || null;
}

function recognizeDeviceRole() {
  if (!state?.id || !firebaseUid) return;
  const patch = {};
  if (state.adminUid === firebaseUid) patch.adminLocal = false;
  const participant = participantForUid(firebaseUid);
  if (participant) {
    patch.participantId = participant.id;
    patch.name = participant.name;
  }
  if (Object.keys(patch).length) setRole(patch);
}

function isAdmin() {
  return Boolean(state?.adminUid && firebaseUid && state.adminUid === firebaseUid) || roleForList().adminLocal;
}

function currentParticipantId() {
  return roleForList().participantId || null;
}

function participantsArray() {
  return Object.values(state?.participants || {}).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

function visibleParticipants() {
  const currentId = currentParticipantId();
  const selectedId = selectedParticipantId && state?.participants?.[selectedParticipantId] ? selectedParticipantId : null;
  return participantsArray().sort((a, b) => {
    if (a.id === selectedId) return -1;
    if (b.id === selectedId) return 1;
    if (a.id === currentId) return -1;
    if (b.id === currentId) return 1;
    return (a.createdAt || 0) - (b.createdAt || 0);
  });
}

function itemsArray() {
  return Object.values(state?.items || {}).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

function commonItems() {
  return itemsArray().filter((item) => remainingQty(item) > 0 && !item.done);
}

function assignedItems(personId) {
  return itemsArray().filter((item) => Number(item.assignments?.[personId] || 0) > 0);
}

function itemTotal(item) {
  return Math.max(0, Number(item.qty || 0));
}

function assignedQty(item) {
  return Object.values(item.assignments || {}).reduce((sum, qty) => sum + Number(qty || 0), 0);
}

function remainingQty(item) {
  return Math.max(0, itemTotal(item) - assignedQty(item));
}

function uid(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}_${Date.now().toString(36)}`;
}

function icon(name) {
  return `<svg viewBox='0 0 24 24' aria-hidden='true' focusable='false'><path d='${icons[name] || ''}'></path></svg>`;
}

function escapeHtml(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

function normalizeUnit(unit) {
  const value = String(unit || '').trim().toLowerCase();
  if (value.includes('кг') || value.includes('кил')) return 'кг';
  if (value.includes('л') || value.includes('лит')) return 'л';
  return 'шт.';
}

function unitLabel(unit) {
  return { 'шт.': 'Штука', кг: 'Килограмм', л: 'Литры' }[unit] || 'Штука';
}

function formatQty(qty, unit) {
  const number = Number(qty || 0);
  const clean = Number.isInteger(number) ? String(number) : number.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  return `${clean} ${normalizeUnit(unit)}`;
}

function itemEmoji(name) {
  const lower = String(name || '').toLowerCase();
  if (lower.includes('вод')) return '🧴';
  if (lower.includes('хлеб')) return '🥖';
  if (lower.includes('уг')) return '🪨';
  if (lower.includes('помид')) return '🍅';
  if (lower.includes('салф')) return '🧻';
  if (lower.includes('апт')) return '🧰';
  if (lower.includes('плед')) return '🧺';
  return '🛒';
}

function renderFace(name) {
  const seed = Array.from(name || '?').reduce((sum, letter) => sum + letter.charCodeAt(0), 0);
  return participantIcons[seed % participantIcons.length];
}

function randomParticipantIcon() {
  return participantIcons[Math.floor(Math.random() * participantIcons.length)];
}

function participantIcon(person) {
  return person.icon || renderFace(person.name);
}

function shareUrl() {
  const url = new URL(location.href);
  url.search = `?list=${encodeURIComponent(state.id)}`;
  return url.toString();
}

async function copyShareLink() {
  await navigator.clipboard?.writeText(shareUrl());
  showCopyNotice();
}

function plainListText() {
  const lines = [`Список: ${state.title || 'Общая закупка'}`, ''];
  const common = commonItems();
  lines.push('Общий список:');
  if (common.length) common.forEach((item) => lines.push(`${item.name} ${formatQty(remainingQty(item), item.unit)}`));
  else lines.push('Все разобрано');
  participantsArray().forEach((person) => {
    lines.push('', `${person.name}:`);
    const items = assignedItems(person.id);
    if (items.length) items.forEach((item) => lines.push(`${item.name} ${formatQty(item.assignments[person.id], item.unit)}${item.purchased?.[person.id] ? ' - куплено' : ''}`));
    else lines.push('Пока пусто');
  });
  return lines.join('\n');
}

async function copyPlainList() {
  await navigator.clipboard?.writeText(plainListText());
  showCopyNotice();
}

function showCopyNotice() {
  copyNotice = 'Скопировано';
  clearTimeout(copyNoticeTimer);
  copyNoticeTimer = setTimeout(() => {
    copyNotice = '';
    render();
  }, 1400);
}

function syncLabel() {
  if (db && syncReady) return ['online', 'синхронизация'];
  if (syncError) return ['', syncError];
  return ['', 'локальный режим'];
}

async function updateRemote(path, value) {
  const parts = path.split('/');
  let cursor = state;
  for (let i = 0; i < parts.length - 1; i += 1) cursor = cursor[parts[i]];
  cursor[parts.at(-1)] = value;
  touchState();
  saveLocal();
  render();
  if (db && !state.missingRemote) {
    await firebaseApi.set(firebaseApi.ref(db, `lists/${state.id}/${path}`), value);
    await firebaseApi.update(firebaseApi.ref(db, `lists/${state.id}`), { updatedAt: firebaseApi.serverTimestamp(), expiresAt: Date.now() + listIdleMs });
  }
}

async function removeRemote(path) {
  const parts = path.split('/');
  let cursor = state;
  for (let i = 0; i < parts.length - 1; i += 1) cursor = cursor[parts[i]];
  delete cursor[parts.at(-1)];
  touchState();
  saveLocal();
  render();
  if (db && !state.missingRemote) {
    await firebaseApi.remove(firebaseApi.ref(db, `lists/${state.id}/${path}`));
    await firebaseApi.update(firebaseApi.ref(db, `lists/${state.id}`), { updatedAt: firebaseApi.serverTimestamp(), expiresAt: Date.now() + listIdleMs });
  }
}

async function persistState() {
  touchState();
  saveLocal();
  render();
  if (db && !state.missingRemote) {
    await firebaseApi.set(firebaseApi.ref(db, `lists/${state.id}`), { ...state, updatedAt: firebaseApi.serverTimestamp(), expiresAt: Date.now() + listIdleMs });
  }
}

function render() {
  if (!state) appRoot.innerHTML = renderIntro();
  else if (state.expired || state.missingRemote) appRoot.innerHTML = renderUnavailableList();
  else if (!currentParticipantId() && !isAdmin()) appRoot.innerHTML = renderJoin();
  else appRoot.innerHTML = renderApp();
  bindEvents();
}

function renderIntro() {
  return `<section class='intro'><div><p class='kicker'>Совместные покупки</p><h1>Разберите общую корзину между людьми</h1></div><p class='intro-copy'>Админ создает список, отправляет ссылку или QR-код, участники добавляют покупки и берут себе нужное количество.</p><form class='panel stack' data-action='create-list'><label class='field'><span>Название</span><input class='input' name='title' required value='Пикник в субботу' /></label><label class='field'><span>Ваше имя</span><input class='input' name='name' required placeholder='Например, Антон' /></label><button class='button' type='submit'>${icon('cart')}Создать список</button></form></section>`;
}

function renderUnavailableList() {
  const title = state.expired ? 'Этот список удален' : 'Список не найден';
  const copy = state.expired ? 'Если в список не заходили больше 30 дней, он считается устаревшим.' : 'Возможно, ссылка неверная или список еще не создан в общей базе.';
  return `<section class='intro'><div><p class='kicker'>Совместные покупки</p><h1>${title}</h1></div><p class='intro-copy'>${copy}</p><form class='panel stack' data-action='create-list'><label class='field'><span>Название нового списка</span><input class='input' name='title' required value='Новая закупка' /></label><label class='field'><span>Ваше имя</span><input class='input' name='name' required placeholder='Например, Антон' /></label><button class='button' type='submit'>➕ Создать новый список</button></form></section>`;
}

function renderJoin() {
  return `<section class='intro'><div><p class='kicker'>Приглашение</p><h1>${escapeHtml(state.title)}</h1></div><p class='intro-copy'>Введите имя, чтобы добавлять покупки и брать позиции себе.</p><form class='panel stack' data-action='join-list'><label class='field'><span>Ваше имя</span><input class='input' name='name' required placeholder='Например, Маша' /></label><button class='button' type='submit'>${icon('user')}Присоединиться</button></form></section>`;
}

function renderApp() {
  const [dotClass, label] = syncLabel();
  const adminTools = isAdmin() ? `<button class='top-icon' data-action='copy-share' type='button' aria-label='Добавить участников'>👤</button><button class='top-icon trash-drop' data-drop-trash='true' type='button' aria-label='Удалить'>✖️</button>` : '';
  return `<header class='app-header'><div class='topline'><div class='title-block'><p class='kicker'>${isAdmin() ? 'Админ' : 'Участник'} · ${escapeHtml(roleForList().name || '')}</p><h1>${escapeHtml(state.title)}</h1></div><div class='top-actions'><button class='top-icon' data-action='new-list' type='button' aria-label='Создать новый список'>➕</button><button class='top-icon' data-action='copy-list' type='button' aria-label='Копировать список'>📄</button>${adminTools}</div></div><div class='sync-note'><span class='dot ${dotClass}'></span>${label}</div></header>${renderDistribute()}${modal ? renderModal() : ''}${renderUndoToast()}${renderCopyNotice()}`;
}

function renderDistribute() {
  const people = visibleParticipants();
  const items = commonItems();
  return `<section class='distribute-screen'><div class='common-pool'><div class='pool-head'><h3>Общий список</h3><button class='round-add' data-action='open-item' type='button' aria-label='Добавить покупку'>➕</button></div><div class='pool-items' data-drop-common='true'>${items.length ? items.map(renderPoolItem).join('') : `<span class='chip done'>Все разобрано</span>`}</div></div>${renderParticipantStrip(people)}<div class='people-board'>${people.map(renderPersonDropCard).join('')}</div></section>`;
}

function renderParticipantStrip(people) {
  return `<div class='participant-strip'>${people.map((person) => `<button class='participant-pill ${person.id === selectedParticipantId ? 'selected' : ''}' data-action='select-person' data-person-id='${person.id}' data-drop-person='${person.id}' draggable='${isAdmin() ? 'true' : 'false'}'><span>${participantIcon(person)}</span><strong>${escapeHtml(person.name)}</strong></button>`).join('')}</div>`;
}

function renderPoolItem(item) {
  return `<button class='pool-item' draggable='true' data-item-id='${item.id}' data-drag-kind='item' data-drag-source='common' data-action='take-item' data-id='${item.id}'><span>${itemEmoji(item.name)}</span><strong>${escapeHtml(item.name)}</strong><em>${formatQty(remainingQty(item), item.unit)}</em></button>`;
}

function renderPersonDropCard(person) {
  const items = assignedItems(person.id);
  return `<div class='person-drop-card ${person.id === selectedParticipantId ? 'selected' : ''}' data-drop-person='${person.id}'><div class='person-head'><div class='mini-avatar'>${participantIcon(person)}</div><span class='person-name'>${escapeHtml(person.name)}</span></div><div class='mini-stack'>${items.length ? items.map((item) => { const checked = Boolean(item.purchased?.[person.id]); return `<div class='mini-item ${checked ? 'purchased' : ''}' draggable='true' data-item-id='${item.id}' data-drag-kind='item' data-drag-source='person' data-drag-person='${person.id}'><span>${itemEmoji(item.name)}</span><strong>${escapeHtml(item.name)}</strong><em>${formatQty(item.assignments[person.id], item.unit)}</em><button class='item-check' data-action='toggle-purchased' data-item-id='${item.id}' data-person-id='${person.id}' type='button' aria-label='Отметить купленным'>${checked ? icon('check') : ''}</button></div>`; }).join('') : ''}<div class='drop-hint'>Перетащите сюда</div></div></div>`;
}

function renderUndoToast() {
  return undoAction ? `<div class='undo-toast'><span>${escapeHtml(undoAction.message)}</span><button data-action='undo-delete' type='button'>Отменить</button></div>` : '';
}

function renderCopyNotice() {
  return copyNotice ? `<div class='copy-toast'>${escapeHtml(copyNotice)}</div>` : '';
}

function renderInviteCard() {
  const url = shareUrl();
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(url)}`;
  return `<section class='invite-card compact'><div><h3>Пригласить участников</h3><button class='button secondary' data-action='copy-share' type='button'>${icon('share')}Скопировать ссылку</button></div><button class='qr-button' data-action='copy-share' data-long-copy='true' type='button' aria-label='QR-код приглашения'><img alt='QR-код приглашения' src='${qrUrl}' width='116' height='116' /><span data-copy-status>Скопировать ссылку</span></button></section>`;
}

function renderModal() {
  const content = modal.type === 'item' ? renderItemModal() : modal.type === 'person' ? renderPersonModal() : modal.type === 'take' ? renderTakeModal() : modal.type === 'list' ? renderListModal() : renderShareModal();
  return `<div class='modal-backdrop' data-action='close-modal'><section class='modal' role='dialog' aria-modal='true' onclick='event.stopPropagation()'>${content}</section></div>`;
}

function renderListModal() {
  return `<h2>Новый список</h2><form class='stack' data-action='create-list'><label class='field'><span>Название</span><input class='input' name='title' required value='Новая закупка' /></label><label class='field'><span>Ваше имя</span><input class='input' name='name' required value='${escapeHtml(roleForList().name || '')}' placeholder='Например, Антон' /></label><button class='button' type='submit'>➕ Создать список</button></form>`;
}

function renderItemModal() {
  const item = modal.itemId ? state.items[modal.itemId] : null;
  const unit = normalizeUnit(item?.unit || 'шт.');
  return `<h2>${item ? 'Покупка' : 'Новая покупка'}</h2><form class='stack' data-action='save-item'><input type='hidden' name='id' value='${escapeHtml(item?.id || '')}' /><label class='field'><span>Название</span><input class='input' name='name' required value='${escapeHtml(item?.name || '')}' placeholder='Вода' /></label><div class='row'><label class='field grow'><span>Количество</span><input class='input' name='qty' required type='number' min='1' step='1' inputmode='numeric' value='${escapeHtml(item?.qty || 1)}' /></label><label class='field grow'><span>Ед.</span><select class='select' name='unit'>${['шт.', 'кг', 'л'].map((value) => `<option value='${value}' ${unit === value ? 'selected' : ''}>${unitLabel(value)}</option>`).join('')}</select></label></div><div class='row'><button class='button grow' type='submit'>${icon('check')}Сохранить</button><button class='button secondary' type='button' data-action='close-modal'>Отмена</button></div></form>`;
}

function renderPersonModal() {
  return `<h2>Участник</h2><form class='stack' data-action='save-person'><label class='field'><span>Имя</span><input class='input' name='name' required placeholder='Например, Ира' /></label><button class='button' type='submit'>${icon('user')}Добавить</button></form>`;
}

function renderTakeModal() {
  const item = state.items[modal.itemId];
  const remaining = remainingQty(item);
  return `<h2>Взять себе</h2><form class='stack' data-action='assign-item'><input type='hidden' name='itemId' value='${item.id}' /><label class='field'><span>Кто берет</span><select class='select' name='personId'>${participantsArray().map((p) => `<option value='${p.id}' ${currentParticipantId() === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}</select></label><label class='field'><span>Количество, доступно ${formatQty(remaining, item.unit)}</span><input class='input' name='qty' required type='number' min='1' step='1' inputmode='numeric' value='${remaining || 1}' /></label><button class='button' type='submit'>${icon('cart')}Взять</button></form>`;
}

function renderShareModal() {
  const url = shareUrl();
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(url)}`;
  return `<h2>Приглашение</h2><div class='stack'><label class='field'><span>Ссылка для участников</span><input class='input' readonly value='${escapeHtml(url)}' /></label><img alt='QR-код приглашения' src='${qrUrl}' width='220' height='220' style='justify-self:center;border-radius:8px;border:1px solid var(--line)' /><button class='button' data-action='copy-share' type='button'>${icon('share')}Скопировать ссылку</button>${!db ? `<p class='meta'>Сейчас локальный режим. Для настоящей синхронизации добавьте Firebase config.js.</p>` : ''}</div>`;
}

function bindEvents() {
  appRoot.querySelectorAll('[data-action]').forEach((node) => {
    if (node.tagName === 'FORM') node.addEventListener('submit', handleSubmit);
    else if (node.dataset.longCopy) bindLongCopy(node);
    else node.addEventListener('click', handleClick);
  });
  appRoot.querySelectorAll("[data-drag-kind='item']").forEach((node) => {
    node.addEventListener('pointerdown', () => {
      node.dataset.pressStartedAt = String(Date.now());
      node._longPressTimer = setTimeout(() => node.classList.add('drag-all-ready'), dragAllMs);
    });
    node.addEventListener('pointerup', () => clearDragPress(node));
    node.addEventListener('dragstart', (event) => {
      event.dataTransfer.setData('text/plain', node.dataset.itemId);
      event.dataTransfer.setData('kind', 'item');
      event.dataTransfer.setData('person', node.dataset.dragPerson || '');
      event.dataTransfer.setData('qty', String(dragQty(node)));
      node.classList.add('dragging');
    });
    node.addEventListener('dragend', () => clearDragPress(node));
    bindTouchDrag(node, 'item');
  });
  appRoot.querySelectorAll(".participant-pill[draggable='true']").forEach((node) => {
    node.addEventListener('dragstart', (event) => {
      event.dataTransfer.setData('kind', 'person');
      event.dataTransfer.setData('person', node.dataset.personId);
      node.classList.add('dragging');
    });
    node.addEventListener('dragend', () => node.classList.remove('dragging'));
    bindTouchDrag(node, 'person');
  });
  appRoot.querySelectorAll('[data-drop-person]').forEach((node) => {
    node.addEventListener('dragover', (event) => event.preventDefault());
    node.addEventListener('dragenter', () => node.classList.add('drop-target'));
    node.addEventListener('dragleave', () => node.classList.remove('drop-target'));
    node.addEventListener('drop', async (event) => {
      event.preventDefault();
      node.classList.remove('drop-target');
      const itemId = event.dataTransfer.getData('text/plain');
      const sourcePerson = event.dataTransfer.getData('person');
      const qty = Number(event.dataTransfer.getData('qty') || 1);
      if (!state.items[itemId]) return;
      if (sourcePerson && sourcePerson !== node.dataset.dropPerson) await moveAssignment(itemId, sourcePerson, node.dataset.dropPerson, qty);
      else await assignItem(itemId, node.dataset.dropPerson, qty, { keepView: true });
    });
  });
  appRoot.querySelectorAll('[data-drop-common]').forEach((node) => {
    node.addEventListener('dragover', (event) => event.preventDefault());
    node.addEventListener('dragenter', () => node.classList.add('drop-target'));
    node.addEventListener('dragleave', () => node.classList.remove('drop-target'));
    node.addEventListener('drop', async (event) => {
      event.preventDefault();
      node.classList.remove('drop-target');
      const itemId = event.dataTransfer.getData('text/plain');
      const sourcePerson = event.dataTransfer.getData('person');
      const qty = Number(event.dataTransfer.getData('qty') || 1);
      if (itemId && sourcePerson) await releaseItem(itemId, sourcePerson, qty);
    });
  });
  appRoot.querySelectorAll('[data-drop-trash]').forEach((node) => {
    node.addEventListener('dragover', (event) => event.preventDefault());
    node.addEventListener('dragenter', () => node.classList.add('drop-target'));
    node.addEventListener('dragleave', () => node.classList.remove('drop-target'));
    node.addEventListener('drop', async (event) => {
      event.preventDefault();
      node.classList.remove('drop-target');
      const kind = event.dataTransfer.getData('kind') || (event.dataTransfer.getData('text/plain') ? 'item' : '');
      if (kind === 'person') await deleteParticipantWithUndo(event.dataTransfer.getData('person'));
      if (kind === 'item') await deleteItemWithUndo(event.dataTransfer.getData('text/plain'));
    });
  });
}

function clearDragPress(node) {
  delete node.dataset.pressStartedAt;
  clearTimeout(node._longPressTimer);
  node.classList.remove('dragging', 'drag-all-ready');
}

function bindTouchDrag(node, kind) {
  node.addEventListener('pointerdown', (event) => {
    const actionTarget = event.target.closest('[data-action]');
    if (event.pointerType === 'mouse' || (actionTarget && actionTarget !== node)) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const startedAt = Date.now();
    const ghost = node.cloneNode(true);
    const allTimer = setTimeout(() => {
      if (dragState?.node === node) {
        dragState.all = true;
        ghost.classList.add('drag-all-ready');
      }
    }, dragAllMs);
    const startTimer = setTimeout(() => {
      dragState = { node, kind, ghost, all: false, startedAt, allTimer };
      node.classList.add('dragging');
      ghost.classList.add('drag-ghost');
      document.body.appendChild(ghost);
      moveGhost(ghost, startX, startY);
      node.setPointerCapture?.(event.pointerId);
    }, dragStartMs);
    const cleanup = () => {
      clearTimeout(startTimer);
      clearTimeout(allTimer);
      node.removeEventListener('pointermove', onMove);
      node.removeEventListener('pointerup', onUp);
      node.removeEventListener('pointercancel', onCancel);
      node.classList.remove('dragging');
      ghost.remove();
      if (dragState?.node === node) dragState = null;
    };
    const onMove = (moveEvent) => {
      if (Math.abs(moveEvent.clientX - startX) + Math.abs(moveEvent.clientY - startY) > 10) moveEvent.preventDefault();
      if (!dragState || dragState.node !== node) return;
      moveGhost(ghost, moveEvent.clientX, moveEvent.clientY);
      markTouchTarget(moveEvent.clientX, moveEvent.clientY, kind);
    };
    const onUp = async (upEvent) => {
      const active = dragState?.node === node ? dragState : null;
      cleanup();
      clearTouchTargets();
      if (active) await finishTouchDrop(active, upEvent.clientX, upEvent.clientY);
    };
    const onCancel = () => {
      cleanup();
      clearTouchTargets();
    };
    node.addEventListener('pointermove', onMove, { passive: false });
    node.addEventListener('pointerup', onUp);
    node.addEventListener('pointercancel', onCancel);
  });
}

function moveGhost(ghost, x, y) {
  ghost.style.transform = `translate(${x + 12}px, ${y + 12}px)`;
}

function dropTargetAt(x, y, kind) {
  const hidden = dragState?.ghost;
  if (hidden) hidden.style.display = 'none';
  const element = document.elementFromPoint(x, y);
  if (hidden) hidden.style.display = '';
  if (!element) return null;
  if (kind === 'person') return element.closest('[data-drop-trash]');
  return element.closest('[data-drop-trash], [data-drop-person], [data-drop-common]');
}

function markTouchTarget(x, y, kind) {
  clearTouchTargets();
  dropTargetAt(x, y, kind)?.classList.add('drop-target');
}

function clearTouchTargets() {
  appRoot.querySelectorAll('.drop-target').forEach((node) => node.classList.remove('drop-target'));
}

async function finishTouchDrop(active, x, y) {
  const target = dropTargetAt(x, y, active.kind);
  if (!target) return;
  if (active.kind === 'person') {
    if (target.dataset.dropTrash) await deleteParticipantWithUndo(active.node.dataset.personId);
    return;
  }
  const itemId = active.node.dataset.itemId;
  const sourcePerson = active.node.dataset.dragPerson || '';
  const qty = touchDragQty(active.node, active.all);
  if (target.dataset.dropTrash) await deleteItemWithUndo(itemId);
  else if (target.dataset.dropCommon && sourcePerson) await releaseItem(itemId, sourcePerson, qty);
  else if (target.dataset.dropPerson) {
    if (sourcePerson && sourcePerson !== target.dataset.dropPerson) await moveAssignment(itemId, sourcePerson, target.dataset.dropPerson, qty);
    else if (!sourcePerson) await assignItem(itemId, target.dataset.dropPerson, qty, { keepView: true });
  }
}

function bindLongCopy(node) {
  let timer = null;
  const status = node.querySelector('[data-copy-status]');
  const clear = () => clearTimeout(timer);
  node.addEventListener('click', (event) => event.preventDefault());
  node.addEventListener('pointerdown', () => {
    node.classList.add('holding');
    timer = setTimeout(async () => {
      await copyShareLink();
      node.classList.remove('holding');
      node.classList.add('copied');
      if (status) status.textContent = 'Скопировано';
      setTimeout(() => {
        node.classList.remove('copied');
        if (status) status.textContent = 'Скопировать ссылку';
      }, 1400);
    }, dragStartMs);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((eventName) => node.addEventListener(eventName, () => {
    clear();
    node.classList.remove('holding');
  }));
}

function dragQty(node) {
  const item = state.items[node.dataset.itemId];
  const sourcePerson = node.dataset.dragPerson || '';
  const available = sourcePerson ? Number(item.assignments?.[sourcePerson] || 0) : remainingQty(item);
  const startedAt = Number(node.dataset.pressStartedAt || Date.now());
  return Date.now() - startedAt >= dragAllMs ? available : Math.min(1, available);
}

function touchDragQty(node, all) {
  const item = state.items[node.dataset.itemId];
  const sourcePerson = node.dataset.dragPerson || '';
  const available = sourcePerson ? Number(item.assignments?.[sourcePerson] || 0) : remainingQty(item);
  return all ? available : Math.min(1, available);
}

async function handleSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form).entries());
  if (form.dataset.action === 'create-list') await createList(data);
  if (form.dataset.action === 'join-list') await joinList(data.name);
  if (form.dataset.action === 'save-item') await saveItem(data);
  if (form.dataset.action === 'save-person') await addParticipant(data.name);
  if (form.dataset.action === 'assign-item') await assignItem(data.itemId, data.personId, data.qty);
}

async function handleClick(event) {
  event.stopPropagation();
  const target = event.currentTarget;
  const action = target.dataset.action;
  if (action === 'open-item') modal = { type: 'item' };
  if (action === 'new-list') modal = { type: 'list' };
  if (action === 'edit-item') modal = { type: 'item', itemId: target.dataset.id };
  if (action === 'open-person') modal = { type: 'person' };
  if (action === 'take-item') modal = { type: 'take', itemId: target.dataset.id };
  if (action === 'open-share') modal = { type: 'share' };
  if (action === 'copy-share') await copyShareLink();
  if (action === 'copy-list') await copyPlainList();
  if (action === 'select-person') selectedParticipantId = target.dataset.personId;
  if (action === 'toggle-purchased') await togglePurchased(target.dataset.itemId, target.dataset.personId);
  if (action === 'undo-delete') await undoDelete();
  if (action === 'close-modal') modal = null;
  if (action === 'delete-item') await deleteItemWithUndo(target.dataset.id);
  render();
}

async function createList(data) {
  const listId = uid('list');
  const personId = uid('person');
  const deviceUid = firebaseUid || `local_${uid('device')}`;
  const createdAt = Date.now();
  state = normalizeState({ id: listId, title: data.title.trim(), adminUid: deviceUid, createdAt, updatedAt: createdAt, expiresAt: createdAt + listIdleMs, participants: { [personId]: { id: personId, uid: deviceUid, name: data.name.trim(), icon: randomParticipantIcon(), createdAt } }, items: {} });
  setRole({ participantId: personId, name: data.name.trim(), adminLocal: !firebaseUid });
  modal = null;
  saveLocal();
  if (db && firebaseUid) {
    await firebaseApi.set(firebaseApi.ref(db, `lists/${listId}`), { ...state, adminUid: firebaseUid, createdAt: firebaseApi.serverTimestamp(), updatedAt: firebaseApi.serverTimestamp(), expiresAt: Date.now() + listIdleMs });
    attachRemote(listId);
  }
  history.replaceState(null, '', `?list=${encodeURIComponent(listId)}`);
  render();
}

async function joinList(name) {
  const existing = participantForUid(firebaseUid);
  if (existing) {
    setRole({ participantId: existing.id, name: existing.name, adminLocal: false });
    modal = null;
    render();
    return;
  }
  const personId = uid('person');
  const person = { id: personId, uid: firebaseUid || `local_${uid('device')}`, name: name.trim(), icon: randomParticipantIcon(), createdAt: Date.now() };
  setRole({ participantId: personId, name: person.name, adminLocal: false });
  await updateRemote(`participants/${personId}`, person);
  modal = null;
}

async function addParticipant(name) {
  const personId = uid('person');
  modal = null;
  await updateRemote(`participants/${personId}`, { id: personId, uid: null, name: name.trim(), icon: randomParticipantIcon(), createdAt: Date.now() });
}

async function saveItem(data) {
  const id = data.id || uid('item');
  const existing = state.items[id] || {};
  const item = { ...existing, id, name: data.name.trim(), qty: Math.max(1, Math.round(Number(String(data.qty).replace(',', '.')) || 1)), unit: normalizeUnit(data.unit), assignments: existing.assignments || {}, purchased: existing.purchased || {}, done: Boolean(existing.done), createdAt: existing.createdAt || Date.now() };
  modal = null;
  await updateRemote(`items/${id}`, item);
}

async function assignItem(itemId, personId, qty, options = {}) {
  const item = state.items[itemId];
  if (!item || !state.participants[personId]) return;
  const amount = Math.min(Math.max(0, Number(String(qty).replace(',', '.')) || 0), remainingQty(item));
  if (amount <= 0) return;
  const assignments = { ...(item.assignments || {}) };
  assignments[personId] = Number(assignments[personId] || 0) + amount;
  modal = null;
  await updateRemote(`items/${itemId}/assignments`, assignments);
}

async function releaseItem(itemId, personId, qty = Infinity) {
  const current = Number(state.items[itemId]?.assignments?.[personId] || 0);
  const amount = Math.min(current, Math.max(0, Number(qty) || 0));
  if (amount <= 0) return;
  const assignments = { ...(state.items[itemId]?.assignments || {}) };
  const next = current - amount;
  if (next > 0) assignments[personId] = next;
  else delete assignments[personId];
  const purchased = { ...(state.items[itemId]?.purchased || {}) };
  if (!assignments[personId]) delete purchased[personId];
  await updateRemote(`items/${itemId}/assignments`, assignments);
  await updateRemote(`items/${itemId}/purchased`, purchased);
}

async function moveAssignment(itemId, fromPersonId, toPersonId, qty = Infinity) {
  const current = Number(state.items[itemId]?.assignments?.[fromPersonId] || 0);
  const amount = Math.min(current, Math.max(0, Number(qty) || 0));
  if (amount <= 0) return;
  const assignments = { ...(state.items[itemId].assignments || {}) };
  const next = current - amount;
  if (next > 0) assignments[fromPersonId] = next;
  else delete assignments[fromPersonId];
  assignments[toPersonId] = Number(assignments[toPersonId] || 0) + amount;
  const purchased = { ...(state.items[itemId]?.purchased || {}) };
  if (!assignments[fromPersonId]) delete purchased[fromPersonId];
  await updateRemote(`items/${itemId}/assignments`, assignments);
  await updateRemote(`items/${itemId}/purchased`, purchased);
}

async function togglePurchased(itemId, personId) {
  const item = state.items[itemId];
  if (!item || !state.participants[personId]) return;
  const purchased = { ...(item.purchased || {}) };
  if (purchased[personId]) delete purchased[personId];
  else purchased[personId] = true;
  await updateRemote(`items/${itemId}/purchased`, purchased);
}

function snapshotState() {
  return JSON.parse(JSON.stringify(state));
}

function scheduleUndoClear() {
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => {
    undoAction = null;
    render();
  }, 5000);
}

async function deleteParticipantWithUndo(personId) {
  if (!isAdmin() || !state.participants[personId]) return;
  const snapshot = snapshotState();
  const name = state.participants[personId].name;
  delete state.participants[personId];
  if (selectedParticipantId === personId) selectedParticipantId = null;
  Object.values(state.items || {}).forEach((item) => {
    if (item.assignments?.[personId]) delete item.assignments[personId];
    if (item.purchased?.[personId]) delete item.purchased[personId];
  });
  undoAction = { message: `${name} удален`, snapshot };
  scheduleUndoClear();
  await persistState();
}

async function deleteItemWithUndo(itemId) {
  if (!isAdmin() || !state.items[itemId]) return;
  const snapshot = snapshotState();
  const name = state.items[itemId].name;
  delete state.items[itemId];
  undoAction = { message: `${name} удалено`, snapshot };
  scheduleUndoClear();
  await persistState();
}

async function undoDelete() {
  if (!undoAction?.snapshot) return;
  clearTimeout(undoTimer);
  state = normalizeState(undoAction.snapshot);
  undoAction = null;
  await persistState();
}
