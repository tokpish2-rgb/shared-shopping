const appRoot = document.querySelector('#app');
const storageKey = 'shopsync:v3';
const roleKey = 'shopsync:roles:v3';
const firebaseConfig = window.SHOPSYNC_FIREBASE_CONFIG;
const longPressMs = 520;
const animalIcons = ['🦁','🐺','🦊','🦍','🐊','🦅','🐵','🐢','🦄','🐱','🐰','🐨','🦔','🐿️','🐞'];
const icons = {
  plus: 'M12 5v14M5 12h14', share: 'M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M16 6l-4-4-4 4M12 2v14',
  user: 'M20 21a8 8 0 0 0-16 0M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10', check: 'M20 6 9 17l-5-5',
  cart: 'M6 6h15l-2 8H8L6 3H3m6 16a1 1 0 1 0 0 .01M18 19a1 1 0 1 0 0 .01', trash: 'M3 6h18M8 6V4h8v2m-9 0 1 15h8l1-15M10 11v6M14 11v6'
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
const sharedListId = new URLSearchParams(location.search).get('list');

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
    state = snapshot.val() ? normalizeState(snapshot.val()) : makeJoinStub(listId);
    saveLocal();
    render();
  });
}

function normalizeState(next) {
  return { id: next.id, title: next.title || 'Общая закупка', adminUid: next.adminUid || null, createdAt: next.createdAt || Date.now(), participants: next.participants || {}, items: next.items || {}, updatedAt: next.updatedAt || Date.now() };
}
function makeJoinStub(listId) { return { id: listId, title: 'Список по ссылке', adminUid: null, participants: {}, items: {}, missingRemote: true }; }
function loadLocal() { try { const raw = localStorage.getItem(storageKey); return raw ? normalizeState(JSON.parse(raw)) : null; } catch { return null; } }
function saveLocal() { if (state) localStorage.setItem(storageKey, JSON.stringify(state)); }
function loadRoles() { try { return JSON.parse(localStorage.getItem(roleKey) || '{}'); } catch { return {}; } }
function saveRoles() { localStorage.setItem(roleKey, JSON.stringify(roles)); }
function roleForList() { return state?.id ? roles[state.id] || {} : {}; }
function setRole(patch) { roles[state.id] = { ...roleForList(), ...patch }; saveRoles(); }
function isAdmin() { return Boolean(state?.adminUid && firebaseUid && state.adminUid === firebaseUid) || roleForList().adminLocal; }
function currentParticipantId() { return roleForList().participantId || null; }
function participantsArray() { return Object.values(state?.participants || {}).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)); }
function visibleParticipants() { const id = currentParticipantId(); return participantsArray().sort((a, b) => a.id === id ? -1 : b.id === id ? 1 : (a.createdAt || 0) - (b.createdAt || 0)); }
function itemsArray() { return Object.values(state?.items || {}).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)); }
function commonItems() { return itemsArray().filter((item) => remainingQty(item) > 0 && !item.done); }
function assignedItems(personId) { return itemsArray().filter((item) => Number(item.assignments?.[personId] || 0) > 0); }
function itemTotal(item) { return Math.max(0, Number(item.qty || 0)); }
function assignedQty(item) { return Object.values(item.assignments || {}).reduce((sum, qty) => sum + Number(qty || 0), 0); }
function remainingQty(item) { return Math.max(0, itemTotal(item) - assignedQty(item)); }
function uid(prefix) { return `${prefix}_${Math.random().toString(36).slice(2, 9)}_${Date.now().toString(36)}`; }
function icon(name) { return `<svg viewBox='0 0 24 24' aria-hidden='true' focusable='false'><path d='${icons[name] || ''}'></path></svg>`; }
function escapeHtml(value) { return String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;'); }
function randomAnimal() { return animalIcons[Math.floor(Math.random() * animalIcons.length)]; }
function fallbackAnimal(name) { return animalIcons[Array.from(name || '?').reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % animalIcons.length]; }
function participantIcon(person) { return person.icon || fallbackAnimal(person.name); }
function normalizeUnit(unit) { const value = String(unit || '').trim().toLowerCase(); if (value.includes('кг') || value.includes('кил')) return 'кг'; if (value.includes('л') || value.includes('лит')) return 'л'; return 'шт.'; }
function unitLabel(unit) { return { 'шт.': 'Штука', кг: 'Килограмм', л: 'Литры' }[unit] || 'Штука'; }
function formatQty(qty, unit) { const number = Number(qty || 0); const clean = Number.isInteger(number) ? String(number) : number.toFixed(2).replace(/0+$/, '').replace(/\.$/, ''); return `${clean} ${normalizeUnit(unit)}`; }
function itemEmoji(name) { const lower = String(name || '').toLowerCase(); if (lower.includes('вод')) return '🧴'; if (lower.includes('хлеб')) return '🥖'; if (lower.includes('уг')) return '🪨'; if (lower.includes('помид')) return '🍅'; if (lower.includes('салф')) return '🧻'; if (lower.includes('апт')) return '🧰'; if (lower.includes('плед')) return '🧺'; return '🛒'; }
function shareUrl() { const url = new URL(location.href); url.search = `?list=${encodeURIComponent(state.id)}`; return url.toString(); }
async function copyShareLink() { await navigator.clipboard?.writeText(shareUrl()); }
function syncLabel() { if (db && syncReady) return ['online', 'синхронизация']; if (syncError) return ['', syncError]; return ['', 'локальный режим']; }

async function updateRemote(path, value) {
  const parts = path.split('/');
  let cursor = state;
  for (let i = 0; i < parts.length - 1; i += 1) cursor = cursor[parts[i]];
  cursor[parts.at(-1)] = value;
  state.updatedAt = Date.now();
  saveLocal();
  render();
  if (db && !state.missingRemote) {
    await firebaseApi.set(firebaseApi.ref(db, `lists/${state.id}/${path}`), value);
    await firebaseApi.update(firebaseApi.ref(db, `lists/${state.id}`), { updatedAt: firebaseApi.serverTimestamp() });
  }
}

function render() {
  if (!state) appRoot.innerHTML = renderIntro();
  else if (!currentParticipantId() && !isAdmin()) appRoot.innerHTML = renderJoin();
  else appRoot.innerHTML = renderApp();
  bindEvents();
}
function renderIntro() { return `<section class='intro'><div><p class='kicker'>Совместные покупки</p><h1>Разберите общую корзину между людьми</h1></div><p class='intro-copy'>Админ создает список, отправляет ссылку или QR-код, участники добавляют покупки и берут себе нужное количество.</p><form class='panel stack' data-action='create-list'><label class='field'><span>Название</span><input class='input' name='title' required value='Пикник в субботу' /></label><label class='field'><span>Ваше имя</span><input class='input' name='name' required placeholder='Например, Антон' /></label><button class='button' type='submit'>${icon('cart')}Создать список</button></form></section>`; }
function renderJoin() { return `<section class='intro'><div><p class='kicker'>Приглашение</p><h1>${escapeHtml(state.title)}</h1></div><p class='intro-copy'>Введите имя, чтобы добавлять покупки и брать позиции себе.</p><form class='panel stack' data-action='join-list'><label class='field'><span>Ваше имя</span><input class='input' name='name' required placeholder='Например, Маша' /></label><button class='button' type='submit'>${icon('user')}Присоединиться</button></form></section>`; }
function renderApp() { const [dotClass, label] = syncLabel(); return `<header class='app-header'><div class='topline'><div class='title-block'><p class='kicker'>${isAdmin() ? 'Админ' : 'Участник'} · ${escapeHtml(roleForList().name || '')}</p><h1>${escapeHtml(state.title)}</h1></div><button class='sync-pill' data-action='open-share'><span class='dot ${dotClass}'></span>${label}</button></div></header>${renderDistribute()}${modal ? renderModal() : ''}`; }
function renderDistribute() { const people = visibleParticipants(); const items = commonItems(); return `<section class='distribute-screen'><div class='section-head'><div><h2>Распределить покупки</h2><div class='meta'>Быстро перетащите — 1 единица. Удержите и перетащите — всё количество</div></div></div>${renderParticipantStrip(people)}<div class='common-pool'><h3>Общий список</h3><div class='pool-items' data-drop-common='true'>${items.length ? items.map(renderPoolItem).join('') : `<span class='chip done'>Все разобрано</span>`}</div></div><div class='people-board'>${people.map(renderPersonDropCard).join('')}</div>${renderInviteCard()}<button class='button distribute-all' data-action='open-item'>${icon('plus')}Добавить покупку</button></section>`; }
function renderParticipantStrip(people) { return `<div class='participant-strip'>${people.map((person) => `<div class='participant-pill' data-drop-person='${person.id}'><span>${participantIcon(person)}</span><strong>${escapeHtml(person.name)}</strong></div>`).join('')}</div>`; }
function renderPoolItem(item) { return `<button class='pool-item' draggable='true' data-item-id='${item.id}' data-action='take-item' data-id='${item.id}'><span>${itemEmoji(item.name)}</span><strong>${escapeHtml(item.name)}</strong><em>${formatQty(remainingQty(item), item.unit)}</em></button>`; }
function renderPersonDropCard(person) { const items = assignedItems(person.id); return `<div class='person-drop-card' data-drop-person='${person.id}'><div class='person-head'><div class='mini-avatar'>${participantIcon(person)}</div><span class='person-name'>${escapeHtml(person.name)}</span></div><div class='mini-stack'>${items.length ? items.map((item) => `<div class='mini-item' draggable='true' data-item-id='${item.id}' data-drag-person='${person.id}'><span>${itemEmoji(item.name)}</span><strong>${escapeHtml(item.name)}</strong><em>${formatQty(item.assignments[person.id], item.unit)}</em></div>`).join('') : ''}<div class='drop-hint'>Перетащите сюда</div></div></div>`; }
function renderInviteCard() { const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(shareUrl())}`; return `<section class='invite-card compact'><div><h3>Пригласить участников</h3><button class='button secondary' data-action='copy-share' type='button'>${icon('share')}Скопировать ссылку</button></div><button class='qr-button' data-action='copy-share' data-long-copy='true' type='button' aria-label='QR-код приглашения'><img alt='QR-код приглашения' src='${qrUrl}' width='116' height='116' /><span data-copy-status>Скопировать ссылку</span></button></section>`; }
function renderModal() { const content = modal.type === 'item' ? renderItemModal() : modal.type === 'person' ? renderPersonModal() : modal.type === 'take' ? renderTakeModal() : renderShareModal(); return `<div class='modal-backdrop' data-action='close-modal'><section class='modal' role='dialog' aria-modal='true' onclick='event.stopPropagation()'>${content}</section></div>`; }
function renderItemModal() { const item = modal.itemId ? state.items[modal.itemId] : null; const unit = normalizeUnit(item?.unit || 'шт.'); return `<h2>${item ? 'Покупка' : 'Новая покупка'}</h2><form class='stack' data-action='save-item'><input type='hidden' name='id' value='${escapeHtml(item?.id || '')}' /><label class='field'><span>Название</span><input class='input' name='name' required value='${escapeHtml(item?.name || '')}' placeholder='Вода' /></label><div class='row'><label class='field grow'><span>Количество</span><input class='input' name='qty' required inputmode='decimal' value='${escapeHtml(item?.qty || 1)}' /></label><label class='field grow'><span>Ед.</span><select class='select' name='unit'>${['шт.', 'кг', 'л'].map((value) => `<option value='${value}' ${unit === value ? 'selected' : ''}>${unitLabel(value)}</option>`).join('')}</select></label></div><div class='row'><button class='button grow' type='submit'>${icon('check')}Сохранить</button><button class='button secondary' type='button' data-action='close-modal'>Отмена</button></div></form>`; }
function renderPersonModal() { return `<h2>Участник</h2><form class='stack' data-action='save-person'><label class='field'><span>Имя</span><input class='input' name='name' required placeholder='Например, Ира' /></label><button class='button' type='submit'>${icon('user')}Добавить</button></form>`; }
function renderTakeModal() { const item = state.items[modal.itemId]; const remaining = remainingQty(item); return `<h2>Взять себе</h2><form class='stack' data-action='assign-item'><input type='hidden' name='itemId' value='${item.id}' /><label class='field'><span>Кто берет</span><select class='select' name='personId'>${participantsArray().map((p) => `<option value='${p.id}' ${currentParticipantId() === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}</select></label><label class='field'><span>Количество, доступно ${formatQty(remaining, item.unit)}</span><input class='input' name='qty' required inputmode='decimal' value='${remaining || 1}' /></label><button class='button' type='submit'>${icon('cart')}Взять</button></form>`; }
function renderShareModal() { const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(shareUrl())}`; return `<h2>Приглашение</h2><div class='stack'><label class='field'><span>Ссылка для участников</span><input class='input' readonly value='${escapeHtml(shareUrl())}' /></label><img alt='QR-код приглашения' src='${qrUrl}' width='220' height='220' style='justify-self:center;border-radius:8px;border:1px solid var(--line)' /><button class='button' data-action='copy-share' type='button'>${icon('share')}Скопировать ссылку</button></div>`; }

function bindEvents() {
  appRoot.querySelectorAll('[data-action]').forEach((node) => { if (node.tagName === 'FORM') node.addEventListener('submit', handleSubmit); else if (node.dataset.longCopy) bindLongCopy(node); else node.addEventListener('click', handleClick); });
  appRoot.querySelectorAll(".pool-item[draggable='true'], .mini-item[draggable='true']").forEach((node) => {
    node.addEventListener('pointerdown', () => { node.dataset.pressStartedAt = String(Date.now()); node._longPressTimer = setTimeout(() => node.classList.add('drag-all-ready'), longPressMs); });
    node.addEventListener('pointerup', () => clearDragPress(node));
    node.addEventListener('dragstart', (event) => { event.dataTransfer.setData('text/plain', node.dataset.itemId); event.dataTransfer.setData('person', node.dataset.dragPerson || ''); event.dataTransfer.setData('qty', String(dragQty(node))); node.classList.add('dragging'); });
    node.addEventListener('dragend', () => clearDragPress(node));
  });
  appRoot.querySelectorAll('[data-drop-person]').forEach((node) => {
    node.addEventListener('dragover', (event) => event.preventDefault()); node.addEventListener('dragenter', () => node.classList.add('drop-target')); node.addEventListener('dragleave', () => node.classList.remove('drop-target'));
    node.addEventListener('drop', async (event) => { event.preventDefault(); node.classList.remove('drop-target'); const itemId = event.dataTransfer.getData('text/plain'); const sourcePerson = event.dataTransfer.getData('person'); const qty = Number(event.dataTransfer.getData('qty') || 1); if (!state.items[itemId]) return; if (sourcePerson && sourcePerson !== node.dataset.dropPerson) await moveAssignment(itemId, sourcePerson, node.dataset.dropPerson, qty); else await assignItem(itemId, node.dataset.dropPerson, qty); });
  });
  appRoot.querySelectorAll('[data-drop-common]').forEach((node) => {
    node.addEventListener('dragover', (event) => event.preventDefault()); node.addEventListener('dragenter', () => node.classList.add('drop-target')); node.addEventListener('dragleave', () => node.classList.remove('drop-target'));
    node.addEventListener('drop', async (event) => { event.preventDefault(); node.classList.remove('drop-target'); const itemId = event.dataTransfer.getData('text/plain'); const sourcePerson = event.dataTransfer.getData('person'); const qty = Number(event.dataTransfer.getData('qty') || 1); if (itemId && sourcePerson) await releaseItem(itemId, sourcePerson, qty); });
  });
}
function clearDragPress(node) { delete node.dataset.pressStartedAt; clearTimeout(node._longPressTimer); node.classList.remove('dragging', 'drag-all-ready'); }
function bindLongCopy(node) { let timer = null; const status = node.querySelector('[data-copy-status]'); const clear = () => clearTimeout(timer); node.addEventListener('click', (event) => event.preventDefault()); node.addEventListener('pointerdown', () => { node.classList.add('holding'); timer = setTimeout(async () => { await copyShareLink(); node.classList.remove('holding'); node.classList.add('copied'); if (status) status.textContent = 'Скопировано'; setTimeout(() => { node.classList.remove('copied'); if (status) status.textContent = 'Скопировать ссылку'; }, 1400); }, longPressMs); }); ['pointerup','pointerleave','pointercancel'].forEach((eventName) => node.addEventListener(eventName, () => { clear(); node.classList.remove('holding'); })); }
function dragQty(node) { const item = state.items[node.dataset.itemId]; const sourcePerson = node.dataset.dragPerson || ''; const available = sourcePerson ? Number(item.assignments?.[sourcePerson] || 0) : remainingQty(item); const startedAt = Number(node.dataset.pressStartedAt || Date.now()); return Date.now() - startedAt >= longPressMs ? available : Math.min(1, available); }

async function handleSubmit(event) { event.preventDefault(); const form = event.currentTarget; const data = Object.fromEntries(new FormData(form).entries()); if (form.dataset.action === 'create-list') await createList(data); if (form.dataset.action === 'join-list') await joinList(data.name); if (form.dataset.action === 'save-item') await saveItem(data); if (form.dataset.action === 'save-person') await addParticipant(data.name); if (form.dataset.action === 'assign-item') await assignItem(data.itemId, data.personId, data.qty); }
async function handleClick(event) { const target = event.currentTarget; const action = target.dataset.action; if (action === 'open-item') modal = { type: 'item' }; if (action === 'open-person') modal = { type: 'person' }; if (action === 'take-item') modal = { type: 'take', itemId: target.dataset.id }; if (action === 'open-share') modal = { type: 'share' }; if (action === 'copy-share') await copyShareLink(); if (action === 'close-modal') modal = null; render(); }
async function createList(data) { const listId = uid('list'); const personId = uid('person'); state = normalizeState({ id: listId, title: data.title.trim(), adminUid: firebaseUid || `local_${uid('admin')}`, createdAt: Date.now(), participants: { [personId]: { id: personId, name: data.name.trim(), icon: randomAnimal(), createdAt: Date.now() } }, items: {} }); setRole({ participantId: personId, name: data.name.trim(), adminLocal: !firebaseUid }); saveLocal(); if (db && firebaseUid) { await firebaseApi.set(firebaseApi.ref(db, `lists/${listId}`), { ...state, adminUid: firebaseUid, createdAt: firebaseApi.serverTimestamp(), updatedAt: firebaseApi.serverTimestamp() }); attachRemote(listId); } history.replaceState(null, '', `?list=${encodeURIComponent(listId)}`); render(); }
async function joinList(name) { const personId = uid('person'); const person = { id: personId, name: name.trim(), icon: randomAnimal(), createdAt: Date.now() }; setRole({ participantId: personId, name: person.name, adminLocal: false }); await updateRemote(`participants/${personId}`, person); modal = null; }
async function addParticipant(name) { const personId = uid('person'); modal = null; await updateRemote(`participants/${personId}`, { id: personId, name: name.trim(), icon: randomAnimal(), createdAt: Date.now() }); }
async function saveItem(data) { const id = data.id || uid('item'); const existing = state.items[id] || {}; const item = { ...existing, id, name: data.name.trim(), qty: Number(String(data.qty).replace(',', '.')) || 1, unit: normalizeUnit(data.unit), assignments: existing.assignments || {}, done: Boolean(existing.done), createdAt: existing.createdAt || Date.now() }; modal = null; await updateRemote(`items/${id}`, item); }
async function assignItem(itemId, personId, qty) { const item = state.items[itemId]; if (!item || !state.participants[personId]) return; const amount = Math.min(Math.max(0, Number(String(qty).replace(',', '.')) || 0), remainingQty(item)); if (amount <= 0) return; const assignments = { ...(item.assignments || {}) }; assignments[personId] = Number(assignments[personId] || 0) + amount; modal = null; await updateRemote(`items/${itemId}/assignments`, assignments); }
async function releaseItem(itemId, personId, qty = Infinity) { const current = Number(state.items[itemId]?.assignments?.[personId] || 0); const amount = Math.min(current, Math.max(0, Number(qty) || 0)); if (amount <= 0) return; const assignments = { ...(state.items[itemId]?.assignments || {}) }; const next = current - amount; if (next > 0) assignments[personId] = next; else delete assignments[personId]; await updateRemote(`items/${itemId}/assignments`, assignments); }
async function moveAssignment(itemId, fromPersonId, toPersonId, qty = Infinity) { const current = Number(state.items[itemId]?.assignments?.[fromPersonId] || 0); const amount = Math.min(current, Math.max(0, Number(qty) || 0)); if (amount <= 0) return; const assignments = { ...(state.items[itemId].assignments || {}) }; const next = current - amount; if (next > 0) assignments[fromPersonId] = next; else delete assignments[fromPersonId]; assignments[toPersonId] = Number(assignments[toPersonId] || 0) + amount; await updateRemote(`items/${itemId}/assignments`, assignments); }
