// event.js — data access: create/update events, save/delete responses, and
// real-time subscriptions. Concurrency-safe because every write targets a
// disjoint path (one event, or one response) and never rewrites the whole event.

import {
    authReady, getUid, eventRef, responsesRef, responseRef,
    onValue, get, set, update, remove, serverTimestamp,
} from './firebase.js';
import * as M from './model.js';

/* ---------- create ---------- */
// options: [{ date, start, end }] (no ids yet). Returns the new eventId.
export async function createEvent({ title, note, options }) {
    const uid = getUid() || (await authReady);
    const eventId = M.genId();
    const withIds = options.map((o) => ({ optionId: M.genId(), date: o.date, start: o.start || '', end: o.end || '' }));
    await set(eventRef(eventId), {
        title: title.trim(),
        note: (note || '').trim(),
        ownerUid: uid,
        options: M.optionsToMap(withIds),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        schemaVersion: 2,
    });
    return eventId;
}

/* ---------- edit event definition (admin only, enforced by rules) ---------- */
// options: [{ optionId?, date, time }] — existing options keep their optionId so
// answers stay aligned; new options get a fresh id. Removed options simply vanish
// (their orphaned answers are ignored on read). Replacing the whole `options` node
// is safe: it does not touch any response.
export async function updateEventDefinition(eventId, { title, note, options }) {
    const withIds = options.map((o) => ({
        optionId: o.optionId && M.isValidId(o.optionId) ? o.optionId : M.genId(),
        date: o.date, start: o.start || '', end: o.end || '',
    }));
    await update(eventRef(eventId), {
        title: title.trim(),
        note: (note || '').trim(),
        options: M.optionsToMap(withIds),
        updatedAt: serverTimestamp(),
    });
}

/* ---------- responses ---------- */
// answers: { optionId: boolean } — only options the participant actually chose.
// comment: optional free text (line breaks preserved). New response → fresh
// responseId owned by this uid. Editing → keep id/owner/createdAt.
export async function saveResponse(eventId, { responseId, name, comment, answers }) {
    const uid = getUid() || (await authReady);
    const clean = {};
    for (const [oid, v] of Object.entries(answers || {})) {
        if (M.isValidId(oid) && typeof v === 'boolean') clean[oid] = v;
    }
    const text = (comment == null ? '' : String(comment));
    if (responseId) {
        // edit an existing response (must be your own or you must be admin — rules enforce)
        await update(responseRef(eventId, responseId), {
            name: name.trim(),
            comment: text,
            answers: clean,
            updatedAt: serverTimestamp(),
        });
        return responseId;
    }
    const rid = M.genId();
    await set(responseRef(eventId, rid), {
        name: name.trim(),
        comment: text,
        authorUid: uid,
        answers: clean,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
    });
    return rid;
}

export async function deleteResponse(eventId, responseId) {
    await remove(responseRef(eventId, responseId));
}

/* ---------- one-shot load (used for legacy detection / migration) ---------- */
export async function loadEventOnce(eventId) {
    const snap = await get(eventRef(eventId));
    if (!snap.exists()) return { kind: 'notfound' };
    return classifySnap(eventId, snap.val());
}

function classifySnap(eventId, raw) {
    const kind = M.classifyEvent(raw);
    if (kind === 'v2') return { kind: 'v2', event: M.normalizeV2Event(eventId, raw) };
    if (kind === 'legacy') { const a = M.adaptLegacyEvent(eventId, raw); return { kind: 'legacy', event: a.event, responses: a.responses }; }
    return { kind: 'invalid' };
}

/* ---------- real-time subscriptions ---------- */
// Returns an unsubscribe function. cb receives:
//   { kind:'v2', event }                      → subscribe responses separately
//   { kind:'legacy', event, responses }       → responses are embedded, do NOT subscribe responses
//   { kind:'notfound' | 'invalid' }
export function subscribeEvent(eventId, cb, errCb) {
    return onValue(eventRef(eventId),
        (snap) => { cb(snap.exists() ? classifySnap(eventId, snap.val()) : { kind: 'notfound' }); },
        (err) => errCb && errCb(err));
}

export function subscribeResponses(eventId, cb, errCb) {
    return onValue(responsesRef(eventId),
        (snap) => cb(M.normalizeResponses(snap.val())),
        (err) => errCb && errCb(err));
}

/* ---------- migrate a legacy event into the new schema (adopt as owner) ---------- */
// Creates a brand-new v2 event owned by the current user, copying title/note and
// the option LABELS (legacy has no real dates). Does NOT modify or delete the
// original, and does NOT grant admin over the original. Returns the new eventId,
// or null when the labels can't be turned into valid dates (kept read-only instead).
export async function migrateLegacyToOwned(legacyEvent) {
    // Legacy options are display strings, so we cannot recover YYYY-MM-DD reliably.
    // Migration is therefore opt-in copy only; callers should warn the user.
    const uid = getUid() || (await authReady);
    const eventId = M.genId();
    const withIds = legacyEvent.options.map((o) => ({ optionId: M.genId(), date: o.date, start: o.start || '', end: o.end || '' }))
        .filter((o) => M.isValidDate(o.date));
    if (withIds.length === 0) return null;
    await set(eventRef(eventId), {
        title: legacyEvent.title || '(無題)',
        note: legacyEvent.note || '',
        ownerUid: uid,
        options: M.optionsToMap(withIds),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        schemaVersion: 2,
    });
    return eventId;
}
