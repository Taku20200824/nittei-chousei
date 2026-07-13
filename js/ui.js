// ui.js — DOM rendering and user-facing state. No Firebase here; everything comes
// in as plain data + callbacks. All user-provided text is written via textContent
// or escapeHtml(), so it can never be interpreted as HTML (no DOM/stored XSS).

import { answerState, optionCounts } from './model.js';

const $ = (id) => document.getElementById(id);

export function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- toast ---------- */
let toastTimer = null;
export function showToast(msg) {
    const t = $('toast');
    t.textContent = msg;                 // textContent → safe
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2000);
}

/* ---------- connection / sync status ---------- */
const STATUS = {
    loading: '⏳ 読み込み中…',
    synced: '🟢 同期済み',
    offline: '⚠ オフライン（再接続を待っています）',
    denied: '🔒 権限がありません',
    error: '⚠ 通信エラー',
    saving: '💾 保存中…',
};
export function setStatus(kind) {
    const el = $('syncStatus');
    if (!el) return;
    el.textContent = STATUS[kind] || '';
    el.dataset.state = kind || '';
}

/* ---------- event header + best-candidate banner ---------- */
export function renderHeader(event, responses, { isAdmin }) {
    $('evTitle').textContent = event.title || '(無題)';
    $('evNote').textContent = event.note || '';
    $('evNote').classList.toggle('hidden', !event.note);
    $('evMeta').textContent = `候補 ${event.options.length} 件 ・ 回答 ${responses.length} 人`;
    $('adminBadge').classList.toggle('hidden', !isAdmin);
    $('legacyBadge').classList.toggle('hidden', !event.legacy);

    const counts = optionCounts(event.options, responses);
    const max = Math.max(0, ...counts);
    const banner = $('bestBanner');
    if (responses.length > 0 && max > 0) {
        const best = counts
            .map((c, i) => (c === max ? event.options[i].label : null))
            .filter(Boolean)
            .map((label) => `「${escapeHtml(label)}」`)
            .join('、');
        banner.innerHTML = `最有力候補: <b>${best}</b>（○ ${max} 人）`;   // labels escaped above
        banner.classList.remove('hidden');
    } else {
        banner.classList.add('hidden');
    }
}

/* ---------- results table (built with DOM APIs; user text via textContent) ---------- */
export function renderResults(event, responses, { isAdmin, currentUid, onEdit, onDelete }) {
    const counts = optionCounts(event.options, responses);
    const max = Math.max(0, ...counts);
    const isBest = (i) => max > 0 && counts[i] === max;

    const noResp = responses.length === 0;
    $('noResp').classList.toggle('hidden', !noResp);
    const table = $('resultsTable');
    table.classList.toggle('hidden', noResp);
    table.replaceChildren();
    if (noResp) return;

    // head
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    hr.appendChild(th('参加者', 'col-name'));
    event.options.forEach((opt, i) => hr.appendChild(th(opt.label, isBest(i) ? 'best' : '')));
    thead.appendChild(hr);
    table.appendChild(thead);

    // body
    const tbody = document.createElement('tbody');
    responses.forEach((r) => {
        const tr = document.createElement('tr');
        const nameTh = document.createElement('th');
        nameTh.className = 'col-name';
        const cell = document.createElement('span');
        cell.className = 'name-cell';
        const nameSpan = document.createElement('span');
        nameSpan.textContent = r.name;                 // safe
        cell.appendChild(nameSpan);

        const canManage = isAdmin || (!!currentUid && r.authorUid === currentUid);
        if (canManage && !r.legacy) {
            const tools = document.createElement('span');
            tools.className = 'tools';
            tools.appendChild(iconBtn('✎', '編集', () => onEdit(r)));
            tools.appendChild(iconBtn('🗑', '削除', () => onDelete(r), 'del'));
            cell.appendChild(tools);
        }
        nameTh.appendChild(cell);
        tr.appendChild(nameTh);

        event.options.forEach((opt, i) => {
            const st = answerState(r.answers, opt.optionId);
            const td = document.createElement('td');
            td.className = `${st} ${isBest(i) ? 'best' : ''}`.trim();
            const mark = document.createElement('span');
            mark.className = `mark ${st}`;
            mark.textContent = st === 'ok' ? '○' : st === 'ng' ? '✕' : '－';
            td.appendChild(mark);
            tr.appendChild(td);
        });
        tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    // foot
    const tfoot = document.createElement('tfoot');
    const fr = document.createElement('tr');
    fr.appendChild(th('○ 合計', 'col-name'));
    counts.forEach((c, i) => {
        const td = document.createElement('td');
        td.className = isBest(i) ? 'best' : '';
        const s = document.createElement('span');
        s.className = 'count-ok';
        s.textContent = String(c);
        td.appendChild(s);
        fr.appendChild(td);
    });
    tfoot.appendChild(fr);
    table.appendChild(tfoot);
}

function th(text, cls) {
    const el = document.createElement('th');
    if (cls) el.className = cls;
    el.textContent = text;                             // safe
    return el;
}
function iconBtn(glyph, title, handler, extra = '') {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `icon-btn ${extra}`.trim();
    b.textContent = glyph;
    b.title = title;
    b.addEventListener('click', handler);
    return b;
}

/* ---------- respond form: ○ / ✕ toggles per option ---------- */
// draftAnswers: { optionId: true|false } (absent = 未回答). onToggle(optionId, value).
export function renderToggles(event, draftAnswers, onToggle) {
    const wrap = $('toggles');
    wrap.replaceChildren();
    event.options.forEach((opt) => {
        const row = document.createElement('div');
        row.className = 'opt-toggle';
        const label = document.createElement('span');
        label.className = 'opt-label';
        label.textContent = opt.label;                 // safe
        const seg = document.createElement('div');
        seg.className = 'seg2';
        const ok = document.createElement('button');
        ok.type = 'button'; ok.textContent = '○';
        const ng = document.createElement('button');
        ng.type = 'button'; ng.textContent = '✕';
        const paint = () => {
            const v = draftAnswers[opt.optionId];
            ok.className = v === true ? 'on-ok' : '';
            ng.className = v === false ? 'on-ng' : '';
        };
        ok.addEventListener('click', () => { onToggle(opt.optionId, true); paint(); });
        ng.addEventListener('click', () => { onToggle(opt.optionId, false); paint(); });
        paint();
        seg.append(ok, ng);
        row.append(label, seg);
        wrap.appendChild(row);
    });
}

/* ---------- option editor list ---------- */
export function renderOptEditor(draftOptions, onRemove) {
    const ul = $('optList');
    ul.replaceChildren();
    draftOptions.forEach((o, i) => {
        const li = document.createElement('li');
        const span = document.createElement('span');
        span.textContent = o.label;                    // safe
        const rm = document.createElement('button');
        rm.type = 'button'; rm.className = 'rm'; rm.textContent = '✕'; rm.title = '削除';
        rm.addEventListener('click', () => onRemove(i));
        li.append(span, rm);
        ul.appendChild(li);
    });
}

/* ---------- on-device history ---------- */
export function renderHistory(list, { inEvent, currentId, onOpen, onRemove }) {
    positionHistory(inEvent);
    const card = $('historyCard');
    const display = inEvent ? list.filter((e) => e.id !== currentId) : list;
    $('histHeading').textContent = inEvent ? '自分の作成したイベント' : '最近のイベント';
    const ul = $('histList');
    ul.replaceChildren();
    if (display.length === 0) { card.classList.add('hidden'); return; }
    card.classList.remove('hidden');
    display.forEach((e) => {
        const li = document.createElement('li');
        li.className = 'hist-item';
        const open = document.createElement('button');
        open.className = 'hist-open'; open.type = 'button';
        const title = document.createElement('span');
        title.className = 'hist-title';
        title.textContent = e.title || '(無題)';       // safe
        if (e.owner) {
            const badge = document.createElement('span');
            badge.className = 'hist-admin'; badge.textContent = ' 🔑 管理者';
            title.appendChild(badge);
        }
        const meta = document.createElement('span');
        meta.className = 'hist-meta';
        meta.textContent = relTime(e.ts);
        open.append(title, meta);
        open.addEventListener('click', () => onOpen(e.id));
        const del = document.createElement('button');
        del.className = 'hist-del'; del.type = 'button'; del.textContent = '✕'; del.title = '履歴から削除';
        del.addEventListener('click', () => onRemove(e.id));
        li.append(open, del);
        ul.appendChild(li);
    });
}

function positionHistory(inEvent) {
    const wrap = document.querySelector('.wrap');
    const card = $('historyCard');
    const anchor = inEvent ? document.querySelector('.footer-note') : $('editorCard');
    if (anchor && card.nextSibling !== anchor) wrap.insertBefore(card, anchor);
}

function relTime(ts) {
    if (!ts) return '';
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return 'たった今';
    if (s < 3600) return `${Math.floor(s / 60)}分前`;
    if (s < 86400) return `${Math.floor(s / 3600)}時間前`;
    return `${Math.floor(s / 86400)}日前`;
}
