// app.js — controller: routing, subscription lifecycle, form state, history.
import { authReady, getUid, onConnectionState } from './firebase.js';
import * as EV from './event.js';
import * as UI from './ui.js';
import * as M from './model.js';

const $ = (id) => document.getElementById(id);

/* ---------- state ---------- */
let uid = null;
let currentId = null;
let currentEvent = null;
let currentResponses = [];
let isAdmin = false;
let unsubEvent = null;
let unsubResponses = null;
let online = true;

// respond-form working state — deliberately NOT overwritten by remote updates
let editingResponse = null;             // response object being edited, or null
let draftAnswers = {};                  // { optionId: true|false }
let saving = false;                     // dup-submit guard

// editor working state
let draftOptions = [];                  // [{ optionId?, date, time, label }]

const HIST_KEY = 'marubatsu-chousei-history';
const HIST_MAX = 24;

/* ---------- history (this device, localStorage) ---------- */
function loadHistory() { try { return JSON.parse(localStorage.getItem(HIST_KEY)) || []; } catch { return []; } }
function saveHistory(list) { try { localStorage.setItem(HIST_KEY, JSON.stringify(list.slice(0, HIST_MAX))); } catch { /* ignore */ } }
function recordHistory(ev, owner) {
    if (!ev || !ev.id) return;
    const rest = loadHistory().filter((e) => e.id !== ev.id);
    rest.unshift({ id: ev.id, title: ev.title || '(無題)', ts: Date.now(), owner: !!owner });
    saveHistory(rest);
}
function removeHistory(id) { saveHistory(loadHistory().filter((e) => e.id !== id)); renderHistory(); }
function renderHistory() {
    UI.renderHistory(loadHistory(), {
        inEvent: !!currentEvent, currentId,
        onOpen: (id) => { location.hash = `e/${id}`; },
        onRemove: removeHistory,
    });
}

/* ---------- card visibility ---------- */
const EVENT_CARDS = ['eventCard', 'resultsCard', 'respondCard', 'shareCard'];
function hide(id) { $(id).classList.add('hidden'); }
function show(id) { $(id).classList.remove('hidden'); }

function showHome() {
    teardown();
    currentId = currentEvent = null; currentResponses = []; isAdmin = false;
    hide('stateCard'); EVENT_CARDS.forEach(hide);
    openEditor(false);
    renderHistory();
    UI.setStatus('');
}

function showStateCard(text) {
    teardown();
    currentEvent = null;
    EVENT_CARDS.forEach(hide); hide('editorCard'); hide('historyCard');
    $('stateText').textContent = text;
    show('stateCard');
}

/* ---------- subscriptions ---------- */
function teardown() {
    if (unsubEvent) { unsubEvent(); unsubEvent = null; }
    if (unsubResponses) { unsubResponses(); unsubResponses = null; }
}

function openEvent(id) {
    teardown();
    currentId = id; currentEvent = null; currentResponses = [];
    editingResponse = null; draftAnswers = {};
    hide('editorCard');
    UI.setStatus('loading');

    unsubEvent = EV.subscribeEvent(id, (res) => {
        if (res.kind === 'notfound') { removeHistory(id); return showStateCard('イベントが見つかりませんでした（削除された可能性があります）。'); }
        if (res.kind === 'invalid') { return showStateCard('このイベントのデータを表示できませんでした。'); }

        currentEvent = res.event;
        isAdmin = !currentEvent.legacy && !!uid && currentEvent.ownerUid === uid;

        if (res.kind === 'legacy') {
            // legacy events have their responses embedded and are read-only under the new rules
            currentResponses = res.responses || [];
            renderLegacy();
            UI.setStatus(online ? 'synced' : 'offline');
            return;
        }

        // v2: subscribe responses once
        if (!unsubResponses) {
            unsubResponses = EV.subscribeResponses(id,
                (list) => { currentResponses = list; if (currentEvent && !currentEvent.legacy) renderEvent(); },
                (err) => reportError(err));
        }
        recordHistory(currentEvent, isAdmin);
        renderEvent();
        UI.setStatus(online ? 'synced' : 'offline');
    }, (err) => reportError(err));
}

function reportError(err) {
    const code = (err && (err.code || err.message) || '').toString().toLowerCase();
    if (code.includes('permission')) { UI.setStatus('denied'); showStateCard('このイベントを閲覧する権限がありません。'); }
    else { UI.setStatus('error'); UI.showToast('通信エラーが発生しました。接続を確認してください'); }
}

/* ---------- render (v2) ---------- */
function renderEvent() {
    hide('editorCard'); hide('stateCard');
    show('eventCard'); show('resultsCard'); show('respondCard'); show('shareCard');
    $('editEventBtn').classList.toggle('hidden', !isAdmin);
    $('respondCard').classList.remove('hidden');
    $('legacyNotice').classList.add('hidden');

    UI.renderHeader(currentEvent, currentResponses, { isAdmin });
    UI.renderResults(currentEvent, currentResponses, {
        isAdmin, currentUid: uid,
        onEdit: (r) => startRespond(r),
        onDelete: (r) => doDeleteResponse(r),
    });
    // keep the form intact; only (re)build toggles if option set changed or first render
    ensureDraftShape();
    UI.renderToggles(currentEvent, draftAnswers, (oid, v) => { draftAnswers[oid] = v; });
    renderHistory();
}

function renderLegacy() {
    hide('editorCard'); hide('stateCard');
    show('eventCard'); show('resultsCard'); show('shareCard');
    hide('respondCard');                                   // read-only
    $('editEventBtn').classList.add('hidden');
    $('legacyNotice').classList.remove('hidden');
    UI.renderHeader(currentEvent, currentResponses, { isAdmin: false });
    UI.renderResults(currentEvent, currentResponses, { isAdmin: false, currentUid: null, onEdit() {}, onDelete() {} });
    renderHistory();
}

// make sure draftAnswers only has keys for current options (don't invent ○ for new ones)
function ensureDraftShape() {
    if (editingResponse) return;                           // editing keeps loaded answers
    const valid = new Set(currentEvent.options.map((o) => o.optionId));
    for (const k of Object.keys(draftAnswers)) if (!valid.has(k)) delete draftAnswers[k];
}

/* ---------- respond form ---------- */
function startRespond(response) {
    editingResponse = response || null;
    if (editingResponse) {
        $('nameInput').value = editingResponse.name;
        draftAnswers = { ...editingResponse.answers };
        $('respondTitle').textContent = '回答を編集';
        $('submitRespBtn').textContent = '更新する';
        $('cancelRespBtn').classList.remove('hidden');
        $('respondCard').scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else {
        $('nameInput').value = '';
        draftAnswers = {};                                 // new options start 未回答 (not ○)
        $('respondTitle').textContent = '出欠を入力';
        $('submitRespBtn').textContent = '登録する';
        $('cancelRespBtn').classList.add('hidden');
    }
    UI.renderToggles(currentEvent, draftAnswers, (oid, v) => { draftAnswers[oid] = v; });
}

async function submitResp() {
    if (saving) return;                                    // dup-submit guard
    const nameCheck = M.validateName($('nameInput').value);
    if (!nameCheck.ok) { UI.showToast(nameCheck.error); $('nameInput').focus(); return; }

    saving = true; $('submitRespBtn').disabled = true; UI.setStatus('saving');
    try {
        await EV.saveResponse(currentId, {
            responseId: editingResponse ? editingResponse.responseId : null,
            name: nameCheck.value,
            answers: draftAnswers,
        });
        UI.showToast(editingResponse ? '回答を更新しました' : '登録しました');
        UI.setStatus(online ? 'synced' : 'offline');
        startRespond(null);
    } catch (err) {
        handleWriteError(err, '回答の保存に失敗しました');
    } finally {
        saving = false; $('submitRespBtn').disabled = false;
    }
}

async function doDeleteResponse(r) {
    if (!confirm(`${r.name} さんの回答を削除しますか？`)) return;
    try {
        await EV.deleteResponse(currentId, r.responseId);
        if (editingResponse && editingResponse.responseId === r.responseId) startRespond(null);
        UI.showToast('削除しました');
    } catch (err) { handleWriteError(err, '削除に失敗しました'); }
}

function handleWriteError(err, fallback) {
    const code = (err && (err.code || err.message) || '').toString().toLowerCase();
    if (code.includes('permission')) { UI.setStatus('denied'); UI.showToast('権限がありません（自分の回答のみ編集できます）'); }
    else if (!online) { UI.setStatus('offline'); UI.showToast('オフラインです。接続後にもう一度お試しください'); }
    else { UI.setStatus('error'); UI.showToast(fallback); }
}

/* ---------- event editor ---------- */
function openEditor(isEdit) {
    $('editorTitle').textContent = isEdit ? 'イベントを編集' : 'イベントを作成';
    $('saveEventBtn').textContent = isEdit ? '更新する' : 'イベントを作成';
    $('cancelEditBtn').classList.toggle('hidden', !isEdit);
    $('dateInput').value = ''; $('timeInput').value = '';
    if (isEdit && currentEvent) {
        $('titleInput').value = currentEvent.title;
        $('noteInput').value = currentEvent.note || '';
        draftOptions = currentEvent.options.map((o) => ({ optionId: o.optionId, date: o.date, time: o.time, label: o.label }));
    } else {
        $('titleInput').value = ''; $('noteInput').value = ''; draftOptions = [];
    }
    UI.renderOptEditor(draftOptions, removeDraftOption);
    EVENT_CARDS.forEach(hide); hide('stateCard');
    show('editorCard');
    $('editorCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function addOption() {
    const date = $('dateInput').value;
    const time = $('timeInput').value;
    if (!M.isValidDate(date)) { UI.showToast('日付を正しく選んでください'); $('dateInput').focus(); return; }
    if (!M.isValidTime(time)) { UI.showToast('時間の形式が正しくありません'); return; }
    const label = M.formatOption(date, time);
    if (draftOptions.some((o) => o.date === date && (o.time || '') === (time || ''))) { UI.showToast('同じ候補が既にあります'); return; }
    if (draftOptions.length >= M.LIMITS.OPTIONS_MAX) { UI.showToast(`候補は${M.LIMITS.OPTIONS_MAX}件までです`); return; }
    draftOptions.push({ date, time, label });
    UI.renderOptEditor(draftOptions, removeDraftOption);
    $('timeInput').value = ''; $('dateInput').focus();
}
function removeDraftOption(i) { draftOptions.splice(i, 1); UI.renderOptEditor(draftOptions, removeDraftOption); }

async function saveEvent() {
    if (saving) return;
    const editing = !!currentEvent && !currentEvent.legacy && isAdmin && !$('cancelEditBtn').classList.contains('hidden');
    const input = { title: $('titleInput').value, note: $('noteInput').value, options: draftOptions };
    const check = M.validateEventInput(input);
    if (!check.ok) { UI.showToast(check.errors[0]); return; }

    saving = true; $('saveEventBtn').disabled = true; UI.setStatus('saving');
    try {
        if (editing) {
            await EV.updateEventDefinition(currentId, input);
            UI.showToast('更新しました');
            renderEvent();
        } else {
            const id = await EV.createEvent(input);
            recordHistory({ id, title: input.title }, true);
            location.hash = `e/${id}`;                     // triggers openEvent
            UI.showToast('イベントを作成しました');
        }
        UI.setStatus(online ? 'synced' : 'offline');
    } catch (err) {
        handleWriteError(err, '保存に失敗しました');
    } finally {
        saving = false; $('saveEventBtn').disabled = false;
    }
}

/* ---------- share (clipboard with fallback) ---------- */
function participantUrl() { return `${location.origin}${location.pathname}#e/${currentId}`; }
async function copyText(text, msg) {
    try { await navigator.clipboard.writeText(text); UI.showToast(msg); }
    catch {
        const ta = document.createElement('textarea');
        ta.value = text; document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); UI.showToast(msg); } catch { UI.showToast('コピーに失敗しました'); }
        ta.remove();
    }
}

/* ---------- routing ---------- */
function parseHash() {
    const raw = location.hash.replace(/^#/, '');
    if (!raw) return { kind: 'home' };
    if (raw.startsWith('e/')) { const id = raw.slice(2); return M.isValidId(id) ? { kind: 'event', id } : { kind: 'home' }; }
    // back-compat: old participant/admin links were "#id" or "#id.adminKey"
    const dot = raw.indexOf('.');
    const idPart = dot >= 0 ? raw.slice(0, dot) : raw;
    if (M.isValidId(idPart)) return { kind: 'event', id: idPart };
    // back-compat: very old links embedded full state as base64 in the hash
    const legacy = tryDecodeLegacyHash(raw);
    if (legacy) return { kind: 'legacyHash', data: legacy };
    return { kind: 'home' };
}

function tryDecodeLegacyHash(str) {
    try {
        const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const obj = JSON.parse(new TextDecoder().decode(bytes));
        return (obj && Array.isArray(obj.o)) ? obj : null;
    } catch { return null; }
}

function route() {
    const r = parseHash();
    if (r.kind === 'home') return showHome();
    if (r.kind === 'event') return openEvent(r.id);
    if (r.kind === 'legacyHash') {
        // render read-only from the embedded state; nothing is written to the DB
        const adapted = M.adaptLegacyEvent('legacy-url', { t: r.data.t, d: r.data.d, o: r.data.o, p: r.data.p });
        teardown();
        currentId = null; currentEvent = adapted.event; currentResponses = adapted.responses; isAdmin = false;
        renderLegacy();
        UI.setStatus('');
    }
}

/* ---------- wire up ---------- */
function wire() {
    $('saveEventBtn').addEventListener('click', saveEvent);
    $('addOptBtn').addEventListener('click', addOption);
    $('dateInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addOption(); } });
    $('timeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addOption(); } });
    $('cancelEditBtn').addEventListener('click', () => { if (currentEvent) renderEvent(); else showHome(); });
    $('editEventBtn').addEventListener('click', () => openEditor(true));
    $('homeBtn').addEventListener('click', () => { location.hash = ''; });
    $('newEventBtn').addEventListener('click', () => { location.hash = ''; });
    $('submitRespBtn').addEventListener('click', submitResp);
    $('cancelRespBtn').addEventListener('click', () => startRespond(null));
    $('nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitResp(); });
    $('copyLinkBtn').addEventListener('click', () => copyText(participantUrl(), '共有リンクをコピーしました'));
    $('clearHistBtn').addEventListener('click', () => {
        if (!confirm('この端末のイベント履歴をすべて消去しますか？（イベント自体は削除されません）')) return;
        try { localStorage.removeItem(HIST_KEY); } catch { /* ignore */ }
        renderHistory();
    });
    window.addEventListener('hashchange', route);
}

/* ---------- boot ---------- */
(async function boot() {
    wire();
    onConnectionState((isOnline) => {
        online = isOnline;
        // don't stomp a 'denied'/'loading' state with connection flaps
        const cur = $('syncStatus').dataset.state;
        if (cur !== 'denied' && cur !== 'loading' && cur !== 'saving') UI.setStatus(isOnline ? 'synced' : 'offline');
    });
    UI.setStatus('loading');
    try {
        uid = await authReady;
    } catch {
        UI.setStatus('error');
        UI.showToast('サインインに失敗しました。ページを再読み込みしてください');
    }
    route();
})();
