// model.js — pure domain logic: ids, validation, date handling, legacy adaptation.
// No Firebase, no DOM imports here on purpose, so this file is unit-testable in Node.

/* ---------- limits (enforced client-side AND mirrored in database.rules.json) ---------- */
export const LIMITS = Object.freeze({
    TITLE_MAX: 100,
    NOTE_MAX: 2000,
    NAME_MAX: 40,
    OPTIONS_MIN: 1,
    OPTIONS_MAX: 60,
    RESPONSES_MAX: 500,   // soft client-side guard; see README for rule-level note
    ID_RE: /^[A-Za-z0-9_-]{6,64}$/,
    DATE_RE: /^\d{4}-\d{2}-\d{2}$/,
    TIME_RE: /^([01]\d|2[0-3]):[0-5]\d$/,
});

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/* ---------- ids ---------- */
// Cryptographically-random, URL-safe id. 20 chars of 62-symbol alphabet ≈ 119 bits.
export function genId(len = 20) {
    const bytes = new Uint8Array(len);
    (globalThis.crypto || globalThis.msCrypto).getRandomValues(bytes);
    let out = '';
    for (let i = 0; i < len; i++) out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
    return out;
}
export function isValidId(id) {
    return typeof id === 'string' && LIMITS.ID_RE.test(id);
}

/* ---------- date / time ---------- */
// Parse "YYYY-MM-DD" WITHOUT the Date(string) constructor, which interprets
// bare ISO dates as UTC and can shift the day depending on the local time zone.
export function parseDateParts(dateStr) {
    if (typeof dateStr !== 'string' || !LIMITS.DATE_RE.test(dateStr)) return null;
    const [y, m, d] = dateStr.split('-').map(Number);
    // Construct with local components (no UTC involved) and confirm round-trip,
    // which rejects impossible calendar dates such as 2026-02-30.
    const dt = new Date(y, m - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
    return { y, m, d, weekday: WEEKDAYS[dt.getDay()] };
}

export function isValidDate(dateStr) {
    return parseDateParts(dateStr) !== null;
}
export function isValidTime(timeStr) {
    return timeStr === '' || timeStr == null ? true : (typeof timeStr === 'string' && LIMITS.TIME_RE.test(timeStr));
}

// "2026/7/20(月) 19:00" — Japanese, year included, no leading zeros on m/d.
export function formatOption(dateStr, timeStr) {
    const p = parseDateParts(dateStr);
    if (!p) return String(dateStr || '');
    let s = `${p.y}/${p.m}/${p.d}(${p.weekday})`;
    if (timeStr) s += ` ${timeStr}`;
    return s;
}

/* ---------- validation ---------- */
export function validateEventInput({ title, note, options }) {
    const errors = [];
    const t = (title || '').trim();
    if (t.length < 1) errors.push('タイトルを入力してください');
    else if (t.length > LIMITS.TITLE_MAX) errors.push(`タイトルは${LIMITS.TITLE_MAX}文字以内で入力してください`);
    if ((note || '').length > LIMITS.NOTE_MAX) errors.push(`メモは${LIMITS.NOTE_MAX}文字以内で入力してください`);
    if (!Array.isArray(options) || options.length < LIMITS.OPTIONS_MIN) errors.push('候補を1つ以上追加してください');
    else if (options.length > LIMITS.OPTIONS_MAX) errors.push(`候補は${LIMITS.OPTIONS_MAX}件までです`);
    else {
        for (const o of options) {
            if (!isValidDate(o.date)) { errors.push('日付の形式が正しくありません'); break; }
            if (!isValidTime(o.time)) { errors.push('時間の形式が正しくありません'); break; }
        }
    }
    return { ok: errors.length === 0, errors };
}

export function validateName(name) {
    const n = (name || '').trim();
    if (n.length < 1) return { ok: false, error: 'お名前を入力してください' };
    if (n.length > LIMITS.NAME_MAX) return { ok: false, error: `お名前は${LIMITS.NAME_MAX}文字以内で入力してください` };
    return { ok: true, value: n };
}

/* ---------- option helpers ---------- */
// Build a stored options map { optionId: {date,time,order} } from an ordered array.
export function optionsToMap(orderedOptions) {
    const map = {};
    orderedOptions.forEach((o, i) => {
        map[o.optionId] = { date: o.date, order: i + 1 };
        if (o.time) map[o.optionId].time = o.time;
    });
    return map;
}

// Turn a stored options map back into a display-ready, order-sorted array.
export function optionsFromMap(optionsMap) {
    if (!optionsMap || typeof optionsMap !== 'object') return [];
    return Object.entries(optionsMap)
        .filter(([id, o]) => isValidId(id) && o && typeof o === 'object')
        .map(([optionId, o]) => ({
            optionId,
            date: typeof o.date === 'string' ? o.date : '',
            time: typeof o.time === 'string' ? o.time : '',
            order: typeof o.order === 'number' ? o.order : 0,
            label: o.legacyLabel ? String(o.legacyLabel) : formatOption(o.date, o.time),
            legacy: !!o.legacyLabel,
        }))
        .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
}

/* ---------- normalization of remote snapshots ---------- */
// Detect what a raw events/{id} snapshot is: 'v2' (new schema), 'legacy' (old {t,d,o,p,h}), or 'invalid'.
export function classifyEvent(raw) {
    if (!raw || typeof raw !== 'object') return 'invalid';
    if (raw.options && typeof raw.options === 'object') return 'v2';
    if (Array.isArray(raw.o)) return 'legacy';
    return 'invalid';
}

// Normalize a v2 event snapshot into the in-memory shape the UI uses.
export function normalizeV2Event(id, raw) {
    return {
        id,
        title: typeof raw.title === 'string' ? raw.title : '',
        note: typeof raw.note === 'string' ? raw.note : '',
        ownerUid: typeof raw.ownerUid === 'string' ? raw.ownerUid : '',
        createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : 0,
        updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
        options: optionsFromMap(raw.options),
        legacy: false,
    };
}

// Adapt a legacy event {t,d,o:[labels],p:[{n,a:[1|0]}],h} into the in-memory shape.
// Legacy options are display strings without a real date; we keep the label and
// synthesize stable optionIds from the index so answers can be keyed consistently.
export function adaptLegacyEvent(id, raw) {
    const optionLabels = Array.isArray(raw.o) ? raw.o : [];
    const options = optionLabels.map((label, i) => ({
        optionId: `legacy-${i}`,
        date: '',
        time: '',
        order: i + 1,
        label: String(label),
        legacy: true,
    }));
    const responses = (Array.isArray(raw.p) ? raw.p : []).map((p, i) => {
        const answers = {};
        const arr = Array.isArray(p.a) ? p.a : [];
        options.forEach((opt, idx) => { if (idx < arr.length) answers[opt.optionId] = arr[idx] === 1; });
        return {
            responseId: `legacy-${i}`,
            name: typeof p.n === 'string' ? p.n : '(無名)',
            authorUid: '',        // legacy responses have no owner; read-only
            answers,
            createdAt: 0,
            updatedAt: 0,
            legacy: true,
        };
    });
    return {
        event: {
            id,
            title: typeof raw.t === 'string' ? raw.t : '',
            note: typeof raw.d === 'string' ? raw.d : '',
            ownerUid: '',          // no secure owner can be derived from a client-side hash
            createdAt: 0,
            updatedAt: 0,
            options,
            legacy: true,
        },
        responses,
    };
}

// Normalize a responses/{eventId} snapshot into an array.
export function normalizeResponses(raw) {
    if (!raw || typeof raw !== 'object') return [];
    return Object.entries(raw)
        .filter(([rid, r]) => isValidId(rid) && r && typeof r === 'object')
        .map(([responseId, r]) => ({
            responseId,
            name: typeof r.name === 'string' ? r.name : '(無名)',
            authorUid: typeof r.authorUid === 'string' ? r.authorUid : '',
            answers: (r.answers && typeof r.answers === 'object') ? r.answers : {},
            createdAt: typeof r.createdAt === 'number' ? r.createdAt : 0,
            updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : 0,
            legacy: false,
        }))
        .sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name));
}

/* ---------- aggregation ---------- */
// answer state for one (response, option): 'ok' | 'ng' | 'none'
export function answerState(answers, optionId) {
    if (!answers || !(optionId in answers)) return 'none';
    return answers[optionId] ? 'ok' : 'ng';
}

// ○ counts per option (only explicit true counts; unanswered/✕ do not).
export function optionCounts(options, responses) {
    return options.map((opt) =>
        responses.reduce((sum, r) => sum + (answerState(r.answers, opt.optionId) === 'ok' ? 1 : 0), 0));
}
