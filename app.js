'use strict';
/*
 * Our Universe (O&H), v39. The whole app in one readable script; no build step.
 *
 *  1. Configuration (sections, modules, statuses)
 *  2. Helpers (escaping, dates, storage, errors, toast)
 *  3. Overlays: drawer, dialogs, scroll lock, phone/browser Back button
 *  4. Data layer (every Supabase call lives here)
 *  5. Routing and the app shell
 *  6. Views: dashboard, Future Plans, simple modules, Discussions and Games
 *  7. Forms: add/edit entry, dates, confirm, new password
 *  8. Sign-in and start-up
 *
 * Database objects used (see docs/02_DATABASE_COMPATIBILITY.md):
 *   tables  entries, app_settings, app_members, deck_categories, deck_cards, deck_history
 *   rpc     deck_overview, deck_draw, deck_reset
 *   storage bucket "memories" (private)
 */
(function () {
  const VERSION = '40';
  const cfg = window.APP_CONFIG || {};
  const $ = (id) => document.getElementById(id);
  const qsa = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /* ------------------------------------------------------------------ */
  /* 1. Configuration                                                    */
  /* ------------------------------------------------------------------ */

  // Used only when a date has never been saved (this is what v38 showed).
  const DEFAULT_START = '2025-12-19';
  const DEFAULT_MEETING = '2027-02-10T18:00';
  const PLAN_STATUSES = ['Idea', 'Pending', 'Discussing', 'Agreed', 'In Progress', 'Completed'];
  const LEVELS = ['Plan', 'Section', 'Subsection', 'Item', 'Sub-item'];
  const PHOTO_BUCKET = 'memories';
  const PAGE_SIZE = 1000; // PostgREST returns at most 1000 rows per request

  const SECTIONS = [
    { id: 'dashboard', label: 'Home', icon: '⌂' },
    { id: 'together', label: 'O&H Togetherverse', icon: '✦' },
    { id: 'plan', label: 'Future Plans', icon: '⌁' },
    { id: 'discussion', label: 'Discussions', icon: '◌' },
    { id: 'game', label: 'Couple Games', icon: '♟' },
    { id: 'decision', label: 'Decisions', icon: '✓' },
    { id: 'memory', label: 'Memories & Photos', icon: '◇' },
    { id: 'bucket', label: 'Bucket List', icon: '☆' },
    { id: 'date', label: 'Important Dates', icon: '◷' },
    // Replaced by Open When in Togetherverse; kept so earlier letters stay reachable.
    { id: 'letter', label: 'Earlier letters', icon: '✉', hidden: true },
    { id: 'journal', label: 'Shared Journal', icon: '☷' },
    { id: 'dateidea', label: 'Date Ideas', icon: '♡' },
  ];
  const SECTION = Object.fromEntries(SECTIONS.map((s) => [s.id, s]));
  const BOTTOM_TABS = ['dashboard', 'plan', 'together', 'discussion', 'game'];

  // The seven simple modules share the entries table; this decides which
  // fields each one shows and what its statuses are. Existing values that are
  // not in a list (for example an old "Pending") are kept and still shown.
  const MODULES = {
    decision: {
      noun: 'decision', statuses: ['Discussing', 'Agreed', 'Revisit'], done: 'Agreed',
      noToggle: true, filterLabels: { open: 'Open', done: 'Agreed' },
      category: 'Topic', details: 'What we decided', date: 'Decided on',
      empty: 'Nothing decided yet. When you agree on something, write it here so neither of you has to remember who said what.',
    },
    memory: {
      noun: 'memory', statuses: null, category: 'Tag', details: 'What happened', date: 'When',
      photo: true, sort: 'dateDesc',
      empty: 'No memories yet. Add a moment you want to keep. Photos stay private to the two of you.',
    },
    bucket: {
      noun: 'bucket-list item', statuses: ['Idea', 'Planned', 'Completed'], done: 'Completed',
      category: 'Type', details: 'Notes', date: 'Target date', budget: 'Budget',
      empty: 'The bucket list is empty. What do you want to do together one day?',
    },
    date: {
      noun: 'date', statuses: null, category: 'Type', details: 'Notes', date: 'Date',
      dateRequired: true, repeat: true, sort: 'upcoming',
      empty: 'No important dates yet. Add birthdays, anniversaries and anything you want a countdown for.',
    },
    letter: {
      noun: 'letter', statuses: null, category: false, details: 'Letter', date: 'Open on (optional)',
      big: true, sort: 'createdDesc',
      empty: 'No letters yet. Write one now, or seal one to be opened on a date.',
    },
    journal: {
      noun: 'journal entry', statuses: null, category: false, details: 'Entry', date: 'Date',
      dateDefaultToday: true, big: true, sort: 'dateDesc',
      empty: 'The journal is empty. Write about today, however short.',
    },
    dateidea: {
      noun: 'date idea', statuses: ['Idea', 'Planned', 'Done'], done: 'Done',
      category: 'Where (home, call, out)', details: 'Notes', date: 'Planned for', budget: 'Budget',
      empty: 'No date ideas yet. Add one, or play a round of Plan It Together for inspiration.',
    },
  };

  const state = {
    db: null,
    user: null,
    members: new Map(),
    entries: [],
    byId: new Map(),
    kids: new Map(),
    unfiled: [],
    settings: {},
    loadedAt: 0,
    route: { section: 'dashboard', id: null },
    plan: { outline: false, hideDone: false },
    filters: {},
    decks: { discussion: null, game: null },
    photoUrls: new Map(),
  };

  /* ------------------------------------------------------------------ */
  /* 2. Helpers                                                          */
  /* ------------------------------------------------------------------ */

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const sid = (id) => (id == null ? null : String(id));
  const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

  function storeGet(key, fallback) {
    try {
      const v = localStorage.getItem('ou.' + key);
      return v === null ? fallback : JSON.parse(v);
    } catch (_) {
      return fallback;
    }
  }
  function storeSet(key, value) {
    try { localStorage.setItem('ou.' + key, JSON.stringify(value)); } catch (_) { /* storage unavailable */ }
  }

  // Dates are handled as local calendar days so counters do not jump at
  // midnight UTC.
  function localDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
  }
  function localDateTime(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(String(s || ''));
    return m ? new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)) : null;
  }
  function today() {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }
  const dayOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const daysBetween = (a, b) => Math.round((dayOf(b) - dayOf(a)) / 86400000);
  const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const fmtDay = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const fmtTime = (d) => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  function relDays(n) {
    if (n === 0) return 'today';
    if (n === 1) return 'tomorrow';
    if (n === -1) return 'yesterday';
    return n > 0 ? `in ${n} days` : `${-n} days ago`;
  }
  function nextOccurrence(d) {
    const t = today();
    let n = new Date(t.getFullYear(), d.getMonth(), d.getDate());
    if (n < t) n = new Date(t.getFullYear() + 1, d.getMonth(), d.getDate());
    return n;
  }
  const fmtNumber = (n) => Number(n).toLocaleString('en-GB', { maximumFractionDigits: 2 });
  const fmtSecs = (s) => (s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `0:${String(s).padStart(2, '0')}`);

  class AppError extends Error {
    constructor(action, cause) {
      super(friendlyError(action, cause));
      this.cause = cause;
      this.code = cause && cause.code;
      this.raw = (cause && cause.message) || String(cause || '');
    }
  }
  function friendlyError(action, e) {
    const msg = (e && (e.message || e.error_description || e.msg)) || String(e || 'Unknown error');
    if (/failed to fetch|networkerror|load failed|network request failed|fetch failed/i.test(msg)) {
      return `${action}: no connection. Check your internet and try again.`;
    }
    if ((e && e.code === '42501') || /row-level security|permission denied/i.test(msg)) {
      return `${action}: this account isn't allowed to do that.`;
    }
    if ((e && e.code === '23503') || /foreign key/i.test(msg)) {
      return `${action}: something inside it was added or moved on the other phone. Pull down to refresh (or reopen the app) and try again.`;
    }
    if (/jwt expired|invalid jwt|not authenticated/i.test(msg)) {
      return `${action}: your session has expired. Please sign in again.`;
    }
    return `${action}: ${msg}`;
  }
  // Wraps a Supabase call: throws AppError on network or API errors.
  async function q(action, builder) {
    let res;
    try {
      res = await builder;
    } catch (e) {
      throw new AppError(action, e);
    }
    if (res && res.error) throw new AppError(action, res.error);
    return res || {};
  }
  function isMissingSchema(err) {
    const raw = (err && (err.raw || err.message)) || '';
    return /schema cache|does not exist|could not find the (table|function)|PGRST20[25]|42P01|42883/i.test(raw + ' ' + (err && err.code));
  }

  let toastTimer = null;
  function toast(message, kind) {
    const el = $('toast');
    el.textContent = message;
    el.dataset.kind = kind || 'info';
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, kind === 'error' ? 7000 : 2800);
  }
  function fail(err) {
    console.warn(err);
    toast((err && err.message) || String(err), 'error');
  }

  /* ------------------------------------------------------------------ */
  /* 3. Overlays, scroll lock and the Back button                        */
  /* ------------------------------------------------------------------ */
  // Each open overlay (drawer or dialog) adds one history entry, so the
  // phone's Back button closes it instead of leaving the app.

  const overlays = [];
  let skipPops = 0;
  const popWaiters = [];
  let lockDepth = 0;
  let lockY = 0;

  function lockScroll() {
    if (lockDepth++ > 0) return;
    lockY = window.scrollY;
    document.body.style.top = `-${lockY}px`;
    document.body.classList.add('scroll-locked');
  }
  function unlockScroll() {
    if (lockDepth === 0 || --lockDepth > 0) return;
    document.body.classList.remove('scroll-locked');
    document.body.style.top = '';
    window.scrollTo(0, lockY);
  }
  function pushOverlay(id, onBack) {
    overlays.push({ id, onBack });
    try { history.pushState({ ouOverlay: id }, ''); } catch (_) { /* ignore */ }
    lockScroll();
  }
  // Called when the UI closed an overlay. Resolves once history is in step.
  function releaseOverlay(id) {
    const i = overlays.findIndex((o) => o.id === id);
    if (i === -1) return Promise.resolve();
    overlays.splice(i, 1);
    unlockScroll();
    if (!(history.state && history.state.ouOverlay === id)) return Promise.resolve();
    return new Promise((resolve) => {
      skipPops += 1;
      popWaiters.push(resolve);
      history.back();
      setTimeout(() => {
        const k = popWaiters.indexOf(resolve);
        if (k !== -1) { popWaiters.splice(k, 1); skipPops = Math.max(0, skipPops - 1); resolve(); }
      }, 1500);
    });
  }
  window.addEventListener('popstate', () => {
    if (skipPops > 0) {
      skipPops -= 1;
      const r = popWaiters.shift();
      if (r) r();
      return;
    }
    const top = overlays.pop();
    if (top) {
      unlockScroll();
      top.onBack();
    }
  });

  const mqMobile = window.matchMedia('(max-width: 850px)');
  const drawerIsOpen = () => document.body.classList.contains('drawer-open');
  function syncDrawerMode() {
    const mobile = mqMobile.matches;
    $('drawer').inert = mobile && !drawerIsOpen();
    $('drawer').setAttribute('aria-hidden', String(mobile && !drawerIsOpen()));
    if (!mobile && drawerIsOpen()) closeDrawer();
  }
  function showDrawerUI(open) {
    document.body.classList.toggle('drawer-open', open);
    $('drawer').inert = mqMobile.matches && !open;
    $('drawer').setAttribute('aria-hidden', String(mqMobile.matches && !open));
    $('menuBtn').setAttribute('aria-expanded', String(open));
  }
  function openDrawer() {
    if (!mqMobile.matches || drawerIsOpen()) return;
    showDrawerUI(true);
    pushOverlay('drawer', () => { showDrawerUI(false); $('menuBtn').focus(); });
    setTimeout(() => { const a = $('nav').querySelector('[aria-current="page"]') || $('closeDrawer'); a.focus(); }, 60);
  }
  function closeDrawer() {
    if (!drawerIsOpen()) return Promise.resolve();
    showDrawerUI(false);
    return releaseOverlay('drawer');
  }

  function openDialog(id) {
    const d = $(id);
    if (d.open) return;
    d.showModal();
    pushOverlay(id, () => { if (d.open) d.close(); });
  }
  function closeDialog(id) {
    const d = $(id);
    if (d.open) d.close();
    return releaseOverlay(id);
  }

  /* ------------------------------------------------------------------ */
  /* 4. Data layer                                                       */
  /* ------------------------------------------------------------------ */

  async function loadMembers() {
    const { data } = await q('Checking access', state.db.from('app_members').select('user_id, display_name'));
    state.members = new Map((data || []).map((m) => [m.user_id, m.display_name]));
    return state.members.has(state.user.id);
  }

  async function loadEntries() {
    const all = [];
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data } = await q('Loading your data', state.db.from('entries').select('*')
        .order('sort_order', { ascending: true, nullsFirst: false })
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, from + PAGE_SIZE - 1));
      all.push(...(data || []));
      if (!data || data.length < PAGE_SIZE) break;
    }
    state.entries = all;
    indexEntries();
    state.loadedAt = Date.now();
  }

  async function loadSettings() {
    const { data } = await q('Loading dates', state.db.from('app_settings').select('*'));
    state.settings = {};
    for (const row of data || []) state.settings[row.key] = settingValue(row.value);
  }
  function settingValue(v) {
    if (v == null) return '';
    if (typeof v === 'object') return String(v.value != null ? v.value : (v.date != null ? v.date : ''));
    return String(v);
  }

  function indexEntries() {
    state.byId = new Map(state.entries.map((e) => [sid(e.id), e]));
    state.kids = new Map();
    const plans = state.entries.filter((e) => e.type === 'plan');
    for (const e of plans) {
      const p = sid(e.parent_id);
      if (!state.kids.has(p)) state.kids.set(p, []);
      state.kids.get(p).push(e);
    }
    // Anything not reachable from the top level is "unfiled" (a missing
    // parent or a loop). It is shown, never hidden, so it can be moved.
    const reach = new Set();
    const stack = [...(state.kids.get(null) || [])];
    while (stack.length) {
      const e = stack.pop();
      const id = sid(e.id);
      if (reach.has(id)) continue;
      reach.add(id);
      stack.push(...(state.kids.get(id) || []));
    }
    const roots = new Set();
    for (const e of plans) {
      if (reach.has(sid(e.id))) continue;
      let cur = e;
      const path = new Set();
      for (;;) {
        path.add(sid(cur.id));
        const p = cur.parent_id == null ? null : state.byId.get(sid(cur.parent_id));
        if (!p || p.type !== 'plan' || path.has(sid(p.id))) { roots.add(sid(cur.id)); break; }
        cur = p;
      }
    }
    state.unfiled = [...roots].map((id) => state.byId.get(id));
  }

  const kids = (id) => state.kids.get(sid(id)) || [];
  function descendants(id) {
    const out = [];
    const seen = new Set([sid(id)]);
    (function walk(pid) {
      for (const c of kids(pid)) {
        if (seen.has(sid(c.id))) continue;
        seen.add(sid(c.id));
        out.push(c);
        walk(c.id);
      }
    })(id);
    return out;
  }
  function lineage(id) {
    const out = [];
    const seen = new Set();
    let e = state.byId.get(sid(id));
    while (e && !seen.has(sid(e.id))) {
      seen.add(sid(e.id));
      out.unshift(e);
      if (e.parent_id == null) break;
      e = state.byId.get(sid(e.parent_id));
      if (e && e.type !== 'plan') break;
    }
    return out;
  }
  const depthOf = (id) => Math.max(0, lineage(id).length - 1);
  const levelName = (depth) => LEVELS[Math.min(depth, LEVELS.length - 1)];

  function doneStatusFor(type) {
    if (type === 'plan') return 'Completed';
    return (MODULES[type] && MODULES[type].done) || 'Completed';
  }
  function isDone(e) {
    return e.completed === true || e.status === 'Completed' || e.status === doneStatusFor(e.type);
  }

  // Progress counts finished tasks (entries with nothing inside them).
  function planStats(id) {
    let total = 0;
    let done = 0;
    for (const d of descendants(id)) {
      if (kids(d.id).length) continue;
      total += 1;
      if (isDone(d)) done += 1;
    }
    if (total === 0) {
      const self = state.byId.get(sid(id));
      return { total: 0, done: 0, pct: self && isDone(self) ? 100 : 0 };
    }
    return { total, done, pct: Math.round((done / total) * 100) };
  }

  function putLocal(row) {
    const i = state.entries.findIndex((e) => sid(e.id) === sid(row.id));
    if (i === -1) state.entries.push(row); else state.entries[i] = row;
    indexEntries();
  }

  class StaleError extends Error {}

  async function updateEntry(entry, patch, opts) {
    let req = state.db.from('entries').update(patch).eq('id', entry.id);
    if (opts && opts.checkStale && entry.updated_at) req = req.eq('updated_at', entry.updated_at);
    const { data } = await q((opts && opts.action) || 'Saving', req.select('*'));
    if (!data || !data.length) {
      throw new StaleError('This was changed on the other phone while you were editing. Close this form to load the latest version, then try again.');
    }
    putLocal(data[0]);
    return data[0];
  }
  async function insertEntry(payload) {
    const { data } = await q('Saving', state.db.from('entries').insert(payload).select('*'));
    putLocal(data[0]);
    return data[0];
  }
  async function deleteEntries(ids) {
    await q('Deleting', state.db.from('entries').delete().in('id', ids));
    const gone = new Set(ids.map(sid));
    state.entries = state.entries.filter((e) => !gone.has(sid(e.id)));
    indexEntries();
  }

  async function setStatus(entry, status) {
    await updateEntry(entry, { status, completed: status === doneStatusFor(entry.type) || status === 'Completed' },
      { action: 'Updating the status' });
  }
  async function toggleDone(entry) {
    const mod = MODULES[entry.type];
    const nowDone = !isDone(entry);
    let status;
    if (nowDone) status = doneStatusFor(entry.type);
    else if (entry.type === 'plan') status = 'In Progress';
    else status = (mod && mod.statuses && mod.statuses[0]) || 'Idea';
    await updateEntry(entry, { status, completed: nowDone }, { action: nowDone ? 'Marking done' : 'Reopening' });
  }

  // Photos: resized in the browser (which also drops location data), stored
  // in the private bucket, shown through short-lived signed links.
  async function compressImage(file) {
    if (!/^image\//.test(file.type || '')) throw new Error('Choose an image file.');
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch (_) {
      return file;
    }
    const max = 1600;
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.82));
    return blob || file;
  }
  function newId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  }
  // Uploads go to a private bucket under a random name. Images are resized
  // first; audio is checked for type and size (5 MB, a few minutes).
  const AUDIO_TYPES = ['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/x-m4a', 'audio/webm', 'audio/ogg', 'audio/wav'];
  async function uploadFile(file, opts) {
    const o = Object.assign({ bucket: PHOTO_BUCKET, prefix: state.user.id, kind: 'image' }, opts || {});
    let blob = file;
    let type = file.type || '';
    let ext;
    if (o.kind === 'audio') {
      if (!AUDIO_TYPES.includes(type)) throw new Error('Choose an audio file (MP3, M4A, AAC, WebM, OGG or WAV).');
      if (file.size > 5 * 1024 * 1024) throw new Error('That voice note is too large (5 MB maximum, about 5 minutes).');
      ext = { 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/wav': 'wav' }[type];
    } else {
      blob = await compressImage(file);
      if (blob.size > 5 * 1024 * 1024) throw new Error('That photo is too large, even after resizing (5 MB maximum).');
      type = blob.type || 'image/jpeg';
      ext = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg';
    }
    const path = `${o.prefix}/${newId()}.${ext}`;
    await q(o.kind === 'audio' ? 'Uploading the voice note' : 'Uploading the photo',
      state.db.storage.from(o.bucket).upload(path, blob, { contentType: type, upsert: false }));
    return path;
  }
  const uploadPhoto = (file) => uploadFile(file, {});
  function removeFile(bucket, path) {
    if (!path) return;
    state.photoUrls.delete(bucket + ':' + path);
    state.db.storage.from(bucket).remove([path]).catch(() => { /* best effort */ });
  }
  const removePhoto = (path) => removeFile(PHOTO_BUCKET, path);
  async function signedUrls(bucket, paths) {
    const now = Date.now();
    const key = (p) => bucket + ':' + p;
    const need = paths.filter((p) => { const c = state.photoUrls.get(key(p)); return !c || c.expires < now + 60000; });
    if (need.length) {
      try {
        const { data } = await q('Loading media', state.db.storage.from(bucket).createSignedUrls(need, 3600));
        for (const r of data || []) if (r.signedUrl) state.photoUrls.set(key(r.path), { url: r.signedUrl, expires: now + 3600000 });
      } catch (err) {
        console.warn(err);
      }
    }
    return paths.map((p) => (state.photoUrls.get(key(p)) || {}).url || null);
  }
  const photoUrls = (paths) => signedUrls(PHOTO_BUCKET, paths);

  // Decks
  async function loadDeck(kind) {
    const [cats, ov] = await Promise.all([
      q('Loading categories', state.db.from('deck_categories').select('id, slug, kind, name, description, rules, sort_order')
        .eq('kind', kind).eq('is_active', true).order('sort_order')),
      q('Counting cards', state.db.rpc('deck_overview', { p_kind: kind })),
    ]);
    const prev = state.decks[kind];
    const deck = {
      kind,
      cats: cats.data || [],
      overview: new Map((ov.data || []).map((r) => [r.category_id, { total: r.total, remaining: r.remaining }])),
      current: null,
      card: null,
      seen: prev ? prev.seen : new Map(),
    };
    const saved = storeGet('deck.' + kind, null);
    const pick = deck.cats.find((c) => c.id === (prev && prev.current))
      || deck.cats.find((c) => c.slug === saved)
      || deck.cats.find((c) => (deck.overview.get(c.id) || {}).remaining > 0)
      || deck.cats[0];
    deck.current = pick ? pick.id : null;
    state.decks[kind] = deck;
    return deck;
  }
  async function drawFrom(catId, exclude) {
    const { data } = await q('Drawing a card', state.db.rpc('deck_draw', { p_category: catId, p_exclude: exclude }));
    return (data && data[0]) || null;
  }
  async function recordCard(cardId, action) {
    await q(action === 'completed' ? 'Saving' : 'Skipping', state.db.from('deck_history').insert({ card_id: cardId, action }));
  }

  /* ------------------------------------------------------------------ */
  /* 5. Routing and the shell                                            */
  /* ------------------------------------------------------------------ */

  function parseHash() {
    const m = /^#\/([a-z]+)(?:\/([^?#]+))?/.exec(location.hash || '');
    const section = m && SECTION[m[1]] ? m[1] : 'dashboard';
    return { section, id: m && m[2] ? decodeURIComponent(m[2]) : null };
  }
  function go(section, id) {
    const hash = '#/' + section + (id ? '/' + String(id).split('/').map(encodeURIComponent).join('/') : '');
    if (location.hash === hash) {
      state.route = parseHash();
      render();
    } else {
      location.hash = hash;
    }
  }
  window.addEventListener('hashchange', () => {
    if (!state.user) return;
    state.route = parseHash();
    render();
  });

  function buildNav() {
    $('nav').innerHTML = SECTIONS.filter((s) => !s.hidden).map((s) =>
      `<button type="button" data-nav="${s.id}"><span aria-hidden="true">${s.icon}</span> ${esc(s.label)}</button>`).join('');
    const me = state.members.get(state.user.id);
    $('whoami').textContent = me ? `Signed in as ${me}` : '';
  }

  function setAdd(action) {
    const btn = $('pageAddBtn');
    const fab = $('fab');
    document.body.classList.toggle('has-fab', !!action);
    if (!action) {
      btn.hidden = true;
      fab.hidden = true;
      btn.onclick = fab.onclick = null;
      return;
    }
    btn.hidden = false;
    fab.hidden = false;
    btn.textContent = '＋ ' + action.label;
    fab.setAttribute('aria-label', action.label);
    btn.onclick = fab.onclick = action.run;
  }

  let activeTimer = null;
  function stopTimer() {
    if (activeTimer) clearInterval(activeTimer);
    activeTimer = null;
  }

  function setContent(html) {
    $('content').innerHTML = html;
  }

  function render() {
    stopTimer();
    if (window.OU_TV) window.OU_TV.leave();
    const { section, id } = state.route;
    const meta = SECTION[section];
    document.title = `${meta.label} · Our Universe`;
    $('pageTitle').textContent = meta.label;
    qsa('#nav [data-nav]').forEach((b) => {
      if (b.dataset.nav === section) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    qsa('#bottomNav [data-tab]').forEach((b) => {
      const on = b.dataset.tab === section;
      b.classList.toggle('active', on);
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    if (section === 'dashboard') viewDashboard();
    else if (section === 'plan') viewPlans(id);
    else if (section === 'discussion' || section === 'game') viewDeck(section);
    else if (section === 'together') {
      setAdd(null);
      if (window.OU_TV) window.OU_TV.view(id);
      else setContent(errorBlock("Togetherverse didn't load. Check your connection and refresh."));
    } else viewModule(section);
  }

  // One delegated handler per event type for everything inside #content,
  // so re-rendering never stacks up duplicate listeners.
  async function onContentClick(ev) {
    const el = ev.target.closest('[data-act]');
    if (!el || !$('content').contains(el)) return;
    const act = el.dataset.act;
    const entry = el.dataset.id ? state.byId.get(el.dataset.id) : null;
    try {
      switch (act) {
        case 'go': go(el.dataset.section, el.dataset.target || null); break;
        case 'open': go('plan', el.dataset.id); break;
        case 'plans-root': go('plan'); break;
        case 'toggle': if (entry) { el.disabled = true; await toggleDone(entry); render(); } break;
        case 'edit': if (entry) openEntryForm({ type: entry.type, entry }); break;
        case 'delete': if (entry) await deleteFlow(entry); break;
        case 'add-child': openEntryForm({ type: 'plan', parentId: el.dataset.id }); break;
        case 'outline': state.plan.outline = !state.plan.outline; render(); break;
        case 'hide-done': state.plan.hideDone = !state.plan.hideDone; render(); break;
        case 'filter': state.filters[state.route.section] = el.dataset.value; render(); break;
        case 'dates': openDatesForm(); break;
        case 'more': el.closest('.card').classList.toggle('expanded'); el.textContent = el.closest('.card').classList.contains('expanded') ? 'Show less' : 'Show more'; break;
        case 'retry': render(); break;
        default:
          if (act.startsWith('tv-') && window.OU_TV) await window.OU_TV.onClick(act, el, ev);
          else await onDeckClick(act, el);
      }
    } catch (err) {
      fail(err);
      // Togetherverse views keep what was typed; everything else re-renders.
      if (!act.startsWith('tv-')) render();
    }
  }
  async function onContentChange(ev) {
    const el = ev.target;
    if (el.matches('[data-tv-change]') && window.OU_TV) {
      try { await window.OU_TV.onChange(el, ev); } catch (err) { fail(err); }
      return;
    }
    if (!el.matches('[data-status]')) return;
    const entry = state.byId.get(el.dataset.status);
    if (!entry) return;
    el.disabled = true;
    try {
      await setStatus(entry, el.value);
      toast(`Status: ${el.value}`);
    } catch (err) {
      fail(err);
    }
    render();
  }

  function errorBlock(message) {
    return `<div class="state-box error" role="alert"><p>${esc(message)}</p><button type="button" class="btn primary" data-act="retry">Try again</button></div>`;
  }

  /* ------------------------------------------------------------------ */
  /* 6a. Dashboard                                                       */
  /* ------------------------------------------------------------------ */

  function viewDashboard() {
    setAdd(null);
    const s = state.settings;
    const startRaw = s.relationship_start === undefined || s.relationship_start === '' ? DEFAULT_START : s.relationship_start;
    const meetRaw = s.next_meeting === undefined ? DEFAULT_MEETING : s.next_meeting;
    const start = localDate(startRaw);
    const meet = localDateTime(meetRaw);
    const t = today();

    const together = start ? daysBetween(start, t) + 1 : null;
    let meetMain = 'Not set';
    let meetSub = 'Add the next visit';
    if (meet) {
      const d = daysBetween(t, meet);
      if (d < 0) { meetMain = 'Passed'; meetSub = 'Set the next visit'; }
      else if (d === 0) { meetMain = 'Today'; meetSub = `at ${fmtTime(meet)}`; }
      else if (d === 1) { meetMain = 'Tomorrow'; meetSub = `at ${fmtTime(meet)}`; }
      else { meetMain = plural(d, 'day'); meetSub = fmtDay(meet); }
    }

    const leaves = state.entries.filter((e) => e.type === 'plan' && !kids(e.id).length && !isDone(e));
    const rank = (e) => (e.status === 'In Progress' ? 0 : e.target_date ? 1 : e.status === 'Agreed' ? 2 : 3);
    leaves.sort((a, b) => rank(a) - rank(b) || String(a.target_date || '9').localeCompare(String(b.target_date || '9')));
    const upNext = leaves.slice(0, 4);

    const dates = state.entries.filter((e) => e.type === 'date' && e.target_date).map((e) => {
      const base = localDate(e.target_date);
      const when = e.repeats_yearly ? nextOccurrence(base) : base;
      return { e, when, d: daysBetween(t, when) };
    }).filter((x) => x.d >= 0 && x.d <= 90).sort((a, b) => a.d - b.d).slice(0, 3);

    const roots = kids(null);

    setContent(`
      <section class="hero">
        <p class="eyebrow">WELCOME TO</p>
        <h1>Omar &amp; Habiba</h1>
        <p>Two cities, one future, and a universe being built together.</p>
      </section>

      <section class="counter-grid" aria-label="Our counters">
        <button type="button" class="counter" data-act="dates">
          <span class="counter-label">Next meeting</span>
          <b>${esc(meetMain)}</b>
          <span class="counter-sub">${esc(meetSub)}</span>
          <span class="counter-edit">Edit</span>
        </button>
        <button type="button" class="counter" data-act="dates">
          <span class="counter-label">Days together</span>
          <b>${together == null ? '–' : together.toLocaleString('en-GB')}</b>
          <span class="counter-sub">since ${start ? esc(fmtDay(start)) : '–'}</span>
          <span class="counter-edit">Edit</span>
        </button>
      </section>

      <div class="dash-grid">
        <section class="panel" aria-labelledby="upNextTitle">
          <div class="panel-head"><h3 id="upNextTitle">Up next</h3><button type="button" class="btn link" data-act="go" data-section="plan">All plans</button></div>
          ${upNext.length ? `<ul class="mini-list">${upNext.map((e) => {
            const path = lineage(e.id).slice(0, -1).map((p) => p.title).join(' › ');
            const due = e.target_date ? localDate(e.target_date) : null;
            return `<li>
              <button type="button" class="check-btn" data-act="toggle" data-id="${esc(e.id)}" aria-pressed="false" aria-label="Mark done: ${esc(e.title)}">✓</button>
              <button type="button" class="mini-list-main" data-act="open" data-id="${esc(e.parent_id || e.id)}">
                <span class="t" dir="auto">${esc(e.title)}</span>
                <span class="s" dir="auto">${esc(path || 'Future Plans')}${e.status ? ' · ' + esc(e.status) : ''}${due ? ' · due ' + esc(relDays(daysBetween(t, due))) : ''}</span>
              </button></li>`;
          }).join('')}</ul>` : '<p class="muted">Nothing open in Future Plans.</p>'}
        </section>

        <section class="panel" aria-labelledby="startTitle">
          <div class="panel-head"><h3 id="startTitle">Together time</h3></div>
          <div class="quick-start">
            <button type="button" class="quick" data-act="go" data-section="discussion"><span aria-hidden="true">◌</span><b>Start a conversation</b><small>Pick a topic or let it surprise you</small></button>
            <button type="button" class="quick" data-act="go" data-section="game"><span aria-hidden="true">♟</span><b>Play a game</b><small>Works on a call or side by side</small></button>
          </div>
          ${dates.length ? `<h4 class="panel-sub">Coming up</h4><ul class="date-list">${dates.map((x) =>
            `<li><span dir="auto">${esc(x.e.title)}</span><span class="when">${esc(cap(relDays(x.d)))}</span></li>`).join('')}</ul>` : ''}
        </section>
      </div>

      ${roots.length ? `<section class="panel" aria-labelledby="plansProgressTitle">
        <div class="panel-head"><h3 id="plansProgressTitle">Plans</h3></div>
        <ul class="progress-list">${roots.map((r) => {
          const st = planStats(r.id);
          return `<li><button type="button" data-act="open" data-id="${esc(r.id)}">
            <span class="t" dir="auto">${esc(r.title)}</span><span class="pct">${st.pct}%</span>
            <span class="progress" role="progressbar" aria-label="${esc(r.title)} progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${st.pct}"><i style="width:${st.pct}%"></i></span>
          </button></li>`;
        }).join('')}</ul></section>` : ''}

      <div id="tvDashSlot"></div>

      <section class="love-card">
        <p class="eyebrow">TODAY'S VERY SERIOUS QUESTION</p>
        <h3>Will you keep building this universe with me?</h3>
        <p id="loveReply" aria-live="polite">Choose wisely. One answer is suspiciously difficult.</p>
        <div class="love-actions">
          <button type="button" id="loveYes" class="btn yes">Yes, always 🤍</button>
          <button type="button" id="loveNo" class="btn no">No</button>
        </div>
      </section>`);

    $('loveYes').onclick = () => { $('loveReply').textContent = 'Correct answer. Unlimited bad jokes unlocked ✨'; };
    const no = $('loveNo');
    const dodge = (e) => {
      e.preventDefault();
      const box = no.parentElement.getBoundingClientRect();
      const maxX = Math.max(0, box.width - no.offsetWidth);
      no.style.left = `${Math.round(Math.random() * maxX)}px`;
      no.style.top = `${Math.round(Math.random() * 46)}px`;
    };
    no.onpointerenter = dodge;
    no.onclick = dodge;
    if (window.OU_TV) window.OU_TV.dashboardPanel($('tvDashSlot'));
  }

  /* ------------------------------------------------------------------ */
  /* 6b. Future Plans                                                    */
  /* ------------------------------------------------------------------ */

  function statusSelect(e) {
    const list = e.type === 'plan' ? PLAN_STATUSES : (MODULES[e.type].statuses || []);
    const cur = e.status || list[0];
    const options = list.includes(cur) ? list : [cur, ...list];
    return `<label class="status-select"><span class="sr-only">Status for ${esc(e.title)}</span>
      <select data-status="${esc(e.id)}" class="status s-${esc(String(cur).toLowerCase().replace(/[^a-z]+/g, '-'))}">
        ${options.map((s) => `<option ${s === cur ? 'selected' : ''}>${esc(s)}</option>`).join('')}
      </select></label>`;
  }
  function chips(e) {
    const out = [];
    if (e.target_date) {
      const d = localDate(e.target_date);
      if (d) out.push(`<span class="chip" title="Target date">◷ ${esc(fmtDay(d))}</span>`);
    }
    if (e.budget != null && e.budget !== '') out.push(`<span class="chip" title="Budget">Budget ${esc(fmtNumber(e.budget))}</span>`);
    return out.join('');
  }
  function doneButton(e) {
    const done = isDone(e);
    return `<button type="button" class="check-btn ${done ? 'on' : ''}" data-act="toggle" data-id="${esc(e.id)}"
      aria-pressed="${done}" aria-label="${done ? 'Mark not done' : 'Mark done'}: ${esc(e.title)}" title="${done ? 'Mark not done' : 'Mark done'}">✓</button>`;
  }

  function planCard(e, depth) {
    const st = planStats(e.id);
    const n = kids(e.id).length;
    const lvl = Math.min(depth, 2);
    return `<article class="plan-card lvl-${lvl} ${isDone(e) ? 'is-done' : ''}">
      <button type="button" class="plan-card-open" data-act="open" data-id="${esc(e.id)}">
        <span class="level-badge">${levelName(depth)}</span>
        <h3 dir="auto">${esc(e.title)}</h3>
        <span class="meta">${n ? `${plural(n, 'part')} inside · ${st.done} of ${plural(st.total, 'task')} done` : 'Nothing inside yet'}</span>
        <span class="progress" role="progressbar" aria-label="Progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${st.pct}"><i style="width:${st.pct}%"></i></span>
      </button>
      <div class="plan-card-foot">${statusSelect(e)}<span class="pct">${st.pct}%</span>${doneButton(e)}</div>
    </article>`;
  }

  function planRow(e, depth) {
    const n = kids(e.id).length;
    const st = n ? planStats(e.id) : null;
    const lvl = depth >= 4 ? 4 : 3;
    return `<article class="plan-row lvl-${lvl} ${isDone(e) ? 'is-done' : ''}">
      ${doneButton(e)}
      <div class="plan-row-main">
        <span class="level-badge">${levelName(depth)}</span>
        <h4 dir="auto">${esc(e.title)}</h4>
        ${e.details ? `<p class="details" dir="auto">${esc(e.details)}</p>` : ''}
        <div class="row-meta">${statusSelect(e)}${chips(e)}
          ${n ? `<button type="button" class="chip chip-btn" data-act="open" data-id="${esc(e.id)}">${plural(n, 'sub-item')} · ${st.done}/${st.total} done ›</button>` : ''}
        </div>
      </div>
      <div class="row-actions">
        <button type="button" class="mini" data-act="add-child" data-id="${esc(e.id)}" aria-label="Add a sub-item to ${esc(e.title)}">＋ Sub-item</button>
        <button type="button" class="mini" data-act="edit" data-id="${esc(e.id)}" aria-label="Edit ${esc(e.title)}">Edit</button>
        <button type="button" class="mini danger" data-act="delete" data-id="${esc(e.id)}" aria-label="Delete ${esc(e.title)}">Delete</button>
      </div>
    </article>`;
  }

  function outlineList(id, depth, seen) {
    const list = kids(id).filter((c) => !(state.plan.hideDone && isDone(c)) && !seen.has(sid(c.id)));
    if (!list.length) return '';
    return `<ul class="outline">${list.map((c) => {
      seen.add(sid(c.id));
      const n = kids(c.id).length;
      const st = n ? planStats(c.id) : null;
      return `<li class="ol-${Math.min(depth, 4)} ${isDone(c) ? 'is-done' : ''}">
        <div class="ol-row">${doneButton(c)}
          <button type="button" class="ol-title" data-act="open" data-id="${esc(c.id)}"><span class="level-badge">${levelName(depth)}</span> <span dir="auto">${esc(c.title)}</span></button>
          <span class="chip">${esc(c.status || 'Idea')}</span>${st ? `<span class="chip">${st.pct}%</span>` : ''}
        </div>${outlineList(c.id, depth + 1, seen)}</li>`;
    }).join('')}</ul>`;
  }

  function viewPlans(id) {
    if (!id) return planRoot();
    const node = state.byId.get(sid(id));
    if (!node || node.type !== 'plan') {
      setAdd({ label: 'New main plan', run: () => openEntryForm({ type: 'plan', parentId: null }) });
      setContent(`<div class="state-box"><p>This plan no longer exists. It may have been deleted on the other phone.</p>
        <button type="button" class="btn primary" data-act="plans-root">Back to all plans</button></div>`);
      return;
    }
    planLevel(node);
  }

  function planRoot() {
    setAdd({ label: 'New main plan', run: () => openEntryForm({ type: 'plan', parentId: null }) });
    const roots = kids(null);
    setContent(`
      <div class="section-title"><div><p class="eyebrow">FUTURE PLANS</p><h3>Our road to summer 2028</h3></div></div>
      ${roots.length ? `<div class="plan-grid">${roots.map((r) => planCard(r, 0)).join('')}</div>`
        : `<div class="state-box"><p>No plans yet. Start with a main plan, like "Our Marriage", then add sections inside it.</p></div>`}
      ${state.unfiled.length ? `<section class="unfiled" aria-labelledby="unfiledTitle">
        <h3 id="unfiledTitle">Unfiled</h3>
        <p class="muted">These items lost their parent (it was deleted, or they point at each other). Edit one and choose where it belongs.</p>
        <div class="plan-list">${state.unfiled.map((e) => planRow(e, 3)).join('')}</div></section>` : ''}`);
  }

  function planLevel(node) {
    const path = lineage(node.id);
    const depth = path.length - 1;
    const childDepth = depth + 1;
    const childLevel = levelName(childDepth).toLowerCase();
    const st = planStats(node.id);
    const all = kids(node.id);
    const shown = state.plan.hideDone ? all.filter((c) => !isDone(c)) : all;
    const hiddenCount = all.length - shown.length;
    const parent = path.length > 1 ? path[path.length - 2] : null;

    setAdd({ label: `Add ${childLevel}`, run: () => openEntryForm({ type: 'plan', parentId: node.id }) });

    let children;
    if (state.plan.outline) {
      children = outlineList(node.id, childDepth, new Set([sid(node.id)])) || '';
    } else if (childDepth <= 2) {
      children = shown.length ? `<div class="plan-grid sub">${shown.map((c) => planCard(c, childDepth)).join('')}</div>` : '';
    } else {
      children = shown.length ? `<div class="plan-list">${shown.map((c) => planRow(c, childDepth)).join('')}</div>` : '';
    }
    if (!children) {
      children = all.length
        ? `<div class="state-box"><p>Everything here is done and hidden.</p></div>`
        : `<div class="state-box"><p>Nothing inside "${esc(node.title)}" yet.</p><button type="button" class="btn primary" data-act="add-child" data-id="${esc(node.id)}">＋ Add the first ${esc(childLevel)}</button></div>`;
    }

    setContent(`
      <nav class="breadcrumb" aria-label="Where you are">
        <button type="button" class="crumb-back" data-act="${parent ? 'open' : 'plans-root'}" ${parent ? `data-id="${esc(parent.id)}"` : ''} aria-label="Back to ${esc(parent ? parent.title : 'all plans')}">‹</button>
        <ol>
          <li><button type="button" data-act="plans-root">All plans</button></li>
          ${path.map((p, i) => (i === path.length - 1
            ? `<li><span aria-current="page" dir="auto">${esc(p.title)}</span></li>`
            : `<li><button type="button" data-act="open" data-id="${esc(p.id)}" dir="auto">${esc(p.title)}</button></li>`)).join('')}
        </ol>
      </nav>

      <section class="plan-head lvl-${Math.min(depth, 4)} ${isDone(node) ? 'is-done' : ''}">
        <span class="level-badge">${levelName(depth)}</span>
        <h3 dir="auto">${esc(node.title)}</h3>
        ${node.details ? `<p class="details" dir="auto">${esc(node.details)}</p>` : ''}
        <div class="row-meta">${statusSelect(node)}${chips(node)}${doneButton(node)}</div>
        <div class="progress progress-lg" role="progressbar" aria-label="Progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${st.pct}"><i style="width:${st.pct}%"></i></div>
        <p class="meta">${st.total ? `${st.done} of ${plural(st.total, 'task')} done · ${st.pct}%` : 'No tasks inside yet'}</p>
        <div class="head-actions">
          <button type="button" class="btn primary" data-act="add-child" data-id="${esc(node.id)}">＋ Add ${esc(childLevel)}</button>
          <button type="button" class="btn ghost small" data-act="edit" data-id="${esc(node.id)}">Edit</button>
          <button type="button" class="btn ghost small" data-act="outline" aria-pressed="${state.plan.outline}">${state.plan.outline ? 'Cards' : 'Outline'}</button>
          <button type="button" class="btn ghost small" data-act="hide-done" aria-pressed="${state.plan.hideDone}">${state.plan.hideDone ? 'Show done' : 'Hide done'}</button>
          <button type="button" class="btn danger-ghost small" data-act="delete" data-id="${esc(node.id)}">Delete</button>
        </div>
      </section>
      ${hiddenCount ? `<p class="muted small">${plural(hiddenCount, 'completed item')} hidden.</p>` : ''}
      <div class="plan-children">${children}</div>`);
  }

  async function deleteFlow(entry) {
    const inside = entry.type === 'plan' ? descendants(entry.id) : [];
    const ok = await confirmAction({
      title: inside.length ? `Delete "${entry.title}" and everything inside it?` : `Delete "${entry.title}"?`,
      text: inside.length
        ? `This also deletes ${plural(inside.length, 'item')} inside it. This can't be undone.`
        : "This can't be undone.",
      items: inside.slice(0, 8).map((e) => e.title).concat(inside.length > 8 ? [`…and ${inside.length - 8} more`] : []),
      ok: inside.length ? `Delete ${inside.length + 1} items` : 'Delete',
    });
    if (!ok) return;
    const ids = [entry.id, ...inside.map((e) => e.id)];
    const photos = [entry, ...inside].map((e) => e.photo_path).filter(Boolean);
    const parentId = entry.parent_id;
    await deleteEntries(ids);
    photos.forEach(removePhoto);
    toast('Deleted');
    if (state.route.section === 'plan' && state.route.id && ids.map(sid).includes(sid(state.route.id))) {
      if (parentId && state.byId.has(sid(parentId))) go('plan', parentId); else go('plan');
    } else {
      render();
    }
  }

  /* ------------------------------------------------------------------ */
  /* 6c. Simple modules                                                  */
  /* ------------------------------------------------------------------ */

  function viewModule(type) {
    const mod = MODULES[type];
    setAdd({ label: `Add ${mod.noun}`, run: () => openEntryForm({ type }) });
    const t = today();
    let list = state.entries.filter((e) => e.type === type);

    if (mod.sort === 'dateDesc') {
      list.sort((a, b) => String(b.target_date || b.created_at || '').localeCompare(String(a.target_date || a.created_at || '')));
    } else if (mod.sort === 'createdDesc') {
      list.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    } else if (mod.sort === 'upcoming') {
      list = list.map((e) => {
        const base = localDate(e.target_date);
        const when = base ? (e.repeats_yearly ? nextOccurrence(base) : base) : null;
        return Object.assign({}, e, { _when: when, _d: when ? daysBetween(t, when) : null });
      });
      list.sort((a, b) => {
        const pa = a._d == null ? 2 : a._d < 0 ? 1 : 0;
        const pb = b._d == null ? 2 : b._d < 0 ? 1 : 0;
        return pa - pb || (pa === 1 ? b._d - a._d : (a._d || 0) - (b._d || 0));
      });
    } else if (mod.statuses) {
      list.sort((a, b) => Number(isDone(a)) - Number(isDone(b)));
    }

    let filterBar = '';
    if (mod.statuses) {
      const f = state.filters[type] || 'all';
      const counts = { all: list.length, open: list.filter((e) => !isDone(e)).length, done: list.filter(isDone).length };
      if (f === 'open') list = list.filter((e) => !isDone(e));
      if (f === 'done') list = list.filter(isDone);
      filterBar = `<div class="filters" role="group" aria-label="Filter">${['all', 'open', 'done'].map((k) =>
        `<button type="button" class="chip-toggle ${f === k ? 'active' : ''}" aria-pressed="${f === k}" data-act="filter" data-value="${k}">${esc((mod.filterLabels && mod.filterLabels[k]) || cap(k))} <b>${counts[k]}</b></button>`).join('')}</div>`;
    }

    const cards = list.map((e) => moduleCard(type, e, t)).join('');
    setContent(`${filterBar}${cards ? `<div class="cards">${cards}</div>`
      : `<div class="state-box"><p>${esc((state.filters[type] && state.filters[type] !== 'all') ? 'Nothing matches this filter.' : mod.empty)}</p></div>`}`);

    if (mod.photo) {
      const imgs = qsa('img[data-photo]', $('content'));
      if (imgs.length) {
        photoUrls(imgs.map((i) => i.dataset.photo)).then((urls) => {
          imgs.forEach((img, i) => {
            if (urls[i]) img.src = urls[i]; else img.closest('.photo').classList.add('missing');
          });
        });
      }
    }
  }

  function moduleCard(type, e, t) {
    const mod = MODULES[type];
    const done = mod.statuses ? isDone(e) : false;
    const author = e.created_by ? state.members.get(e.created_by) : null;
    const mine = !e.created_by || e.created_by === state.user.id;
    const meta = [];
    if (e.category) meta.push(`<span class="pill" dir="auto">${esc(e.category)}</span>`);
    const d = e.target_date ? localDate(e.target_date) : null;

    if (type === 'letter' && d && d > t) {
      return `<article class="card letter sealed">
        <div class="card-top"><span class="pill">Sealed</span>${author ? `<span class="by">From ${esc(author)}</span>` : ''}</div>
        <h3 dir="auto">${esc(e.title)}</h3>
        <p class="sealed-note">Opens on ${esc(fmtDay(d))} (${esc(relDays(daysBetween(t, d)))}).</p>
        ${mine ? `<div class="card-actions"><span class="card-tools"><button type="button" class="mini" data-act="edit" data-id="${esc(e.id)}" aria-label="Edit ${esc(e.title)}">Edit</button>
          <button type="button" class="mini danger" data-act="delete" data-id="${esc(e.id)}" aria-label="Delete ${esc(e.title)}">Delete</button></span></div>` : ''}
      </article>`;
    }

    if (type === 'date' && e._when) {
      meta.push(`<span class="chip strong">${esc(cap(relDays(e._d)))}</span>`);
      meta.push(`<span class="chip">${esc(fmtDay(e._when))}</span>`);
      if (e.repeats_yearly) meta.push('<span class="chip">Every year</span>');
    } else if (d) {
      meta.push(`<span class="chip">${esc(fmtDay(d))}</span>`);
    }
    if (e.budget != null && e.budget !== '' && mod.budget) meta.push(`<span class="chip">Budget ${esc(fmtNumber(e.budget))}</span>`);
    if (author && (type === 'journal' || type === 'letter' || type === 'memory')) meta.push(`<span class="by">${type === 'letter' ? 'From' : 'By'} ${esc(author)}</span>`);

    const long = (e.details || '').length > 320 || (e.details || '').split('\n').length > 6;
    const doneClass = done ? (mod.noToggle ? 'is-agreed' : 'is-done') : '';
    return `<article class="card ${type} ${doneClass}">
      ${meta.length ? `<div class="card-top">${meta.join('')}</div>` : ''}
      <h3 dir="auto">${esc(e.title)}</h3>
      ${e.photo_path ? `<div class="photo"><img data-photo="${esc(e.photo_path)}" alt="Photo for ${esc(e.title)}" loading="lazy"></div>` : ''}
      ${e.details ? `<p class="details ${long ? 'clamp' : ''}" dir="auto">${esc(e.details)}</p>${long ? '<button type="button" class="btn link small" data-act="more">Show more</button>' : ''}` : ''}
      <div class="card-actions">
        ${mod.statuses ? statusSelect(e) + (mod.noToggle ? '' : doneButton(e)) : ''}
        <span class="card-tools">
          <button type="button" class="mini" data-act="edit" data-id="${esc(e.id)}" aria-label="Edit ${esc(e.title)}">Edit</button>
          <button type="button" class="mini danger" data-act="delete" data-id="${esc(e.id)}" aria-label="Delete ${esc(e.title)}">Delete</button>
        </span>
      </div>
    </article>`;
  }

  /* ------------------------------------------------------------------ */
  /* 6d. Discussions and Couple Games                                    */
  /* ------------------------------------------------------------------ */

  async function viewDeck(kind) {
    setAdd(null);
    const route = state.route.section;
    setContent(`<div class="deck">
      <div class="deck-bar">
        <div id="deckStrip" class="chip-strip" role="group" aria-label="Categories"></div>
        <button type="button" class="btn ghost small" data-act="surprise">Surprise me</button>
      </div>
      <div id="stage" class="stage"><div class="state-box" role="status"><span class="spinner" aria-hidden="true"></span><p>Shuffling…</p></div></div>
    </div>`);
    let deck;
    try {
      deck = await loadDeck(kind);
    } catch (err) {
      if (state.route.section !== route) return;
      if (isMissingSchema(err)) {
        $('stage').innerHTML = `<div class="state-box error" role="alert"><p>The new question decks aren't installed in the database yet.</p>
          <p class="muted">Run <code>supabase/001_v39_upgrade.sql</code> and <code>supabase/002_seed_deck.sql</code> in the Supabase SQL editor.</p></div>`;
      } else {
        $('stage').innerHTML = errorBlock(err.message);
      }
      return;
    }
    if (state.route.section !== route) return;
    if (!deck.cats.length) {
      $('stage').innerHTML = `<div class="state-box"><p>No categories yet. Run <code>supabase/002_seed_deck.sql</code> to load the deck.</p></div>`;
      return;
    }
    renderStrip(deck);
    await drawCard(deck);
  }

  function renderStrip(deck) {
    $('deckStrip').innerHTML = deck.cats.map((c) => {
      const ov = deck.overview.get(c.id) || { total: 0, remaining: 0 };
      const on = c.id === deck.current;
      return `<button type="button" class="chip-toggle ${on ? 'active' : ''} ${ov.remaining ? '' : 'exhausted'}" aria-pressed="${on}"
        data-act="cat" data-cat="${esc(c.id)}">${esc(c.name)} <b data-count="${esc(c.id)}">${ov.remaining ? ov.remaining : '✓'}</b></button>`;
    }).join('');
    const active = $('deckStrip').querySelector('.active');
    if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest', inline: 'center' });
  }
  function updateStripCount(deck, catId) {
    const ov = deck.overview.get(catId);
    const b = $('deckStrip') && $('deckStrip').querySelector(`[data-count="${CSS.escape(catId)}"]`);
    if (!b || !ov) return;
    b.textContent = ov.remaining ? ov.remaining : '✓';
    b.parentElement.classList.toggle('exhausted', !ov.remaining);
  }
  function selectCategory(deck, catId) {
    deck.current = catId;
    const cat = deck.cats.find((c) => c.id === catId);
    if (cat) storeSet('deck.' + deck.kind, cat.slug);
    qsa('#deckStrip [data-cat]').forEach((b) => {
      const on = b.dataset.cat === catId;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
  }

  async function drawCard(deck, opts) {
    stopTimer();
    const route = state.route.section;
    const catId = deck.current;
    const ov = deck.overview.get(catId) || { total: 0, remaining: 0 };
    if (!ov.remaining) return renderExhausted(deck);
    if (!deck.seen.has(catId)) deck.seen.set(catId, new Set());
    const seen = deck.seen.get(catId);
    const current = deck.card && deck.card.category_id === catId ? deck.card.id : null;
    if (current) seen.add(current);
    let card = await drawFrom(catId, [...seen]);
    if (!card && seen.size) {
      // Every remaining card has been shown this session: start the round
      // again, still avoiding the card that is on screen.
      seen.clear();
      card = await drawFrom(catId, current ? [current] : []);
      if (card) toast("You've seen every remaining card once. Going round again.");
      else if (current && opts && opts.allowSame) card = deck.card;
    }
    if (state.route.section !== route || deck.current !== catId) return;
    if (!card) {
      if (current && deck.card) {
        toast('This is the last card left in this category.');
        return renderCard(deck, deck.card);
      }
      ov.remaining = 0;
      updateStripCount(deck, catId);
      return renderExhausted(deck);
    }
    seen.add(card.id);
    deck.card = card;
    renderCard(deck, card);
  }

  function cardBody(mech, card) {
    const data = card.data || {};
    const qn = (t) => `<p class="prompt-question" dir="auto">${esc(t)}</p>`;
    switch (mech) {
      case 'choice':
        return `<p class="prompt-lead">Would you rather…</p>
          <div class="options">
            <div class="option"><span class="opt-key">A</span><p dir="auto">${esc((data.options || [])[0])}</p></div>
            <div class="option-or" aria-hidden="true">or</div>
            <div class="option"><span class="opt-key">B</span><p dir="auto">${esc((data.options || [])[1])}</p></div>
          </div>`;
      case 'quickfire':
        return `<p class="prompt-lead">Quick fire. Answer together, no thinking.</p>
          <ol class="pairs">${(data.pairs || []).map((p) => `<li><span dir="auto">${esc(p[0])}</span><em>or</em><span dir="auto">${esc(p[1])}</span></li>`).join('')}</ol>`;
      case 'rank':
        return `${qn(card.body)}<ul class="rank-items">${(data.items || []).map((i) => `<li dir="auto">${esc(i)}</li>`).join('')}</ul>`;
      case 'scenario':
        return `${qn(card.body)}<ol class="choices">${(data.choices || []).map((c, i) => `<li><span class="opt-key">${'ABC'[i]}</span><span dir="auto">${esc(c)}</span></li>`).join('')}</ol>`;
      case 'fib':
        return `<p class="prompt-lead">Two truths and a fib about…</p>${qn(cap(data.topic || card.body))}`;
      case 'act':
        return `<div class="secret">
            <p class="secret-hint">For the actor only. Turn the screen away from the other person, then reveal.</p>
            <button type="button" class="btn primary" data-act="reveal">Reveal the card</button>
            <div class="secret-card" hidden>${qn(card.body)}<button type="button" class="btn link small" data-act="reveal">Hide it again</button></div>
          </div>${timerBlock(data.seconds || 60)}`;
      case 'challenge':
      case 'plan':
        return `${qn(card.body)}${timerBlock(data.seconds || (mech === 'plan' ? 300 : 60))}`;
      default:
        return qn(card.body);
    }
  }
  function timerBlock(raw) {
    const seconds = Math.min(3600, Math.max(5, Math.round(Number(raw)) || 60));
    return `<div class="timer" data-seconds="${seconds}">
      <button type="button" class="btn ghost" data-act="timer">Start ${fmtSecs(seconds)} timer</button>
      <span class="timer-display" role="timer" aria-label="Time left">${fmtSecs(seconds)}</span>
    </div>`;
  }

  function renderCard(deck, card) {
    const cat = deck.cats.find((c) => c.id === card.category_id) || deck.cats.find((c) => c.id === deck.current);
    const rules = (cat && cat.rules) || {};
    const mech = rules.mechanic || 'talk';
    const ov = deck.overview.get(cat.id) || { total: 0, remaining: 0 };
    const isGame = deck.kind === 'game';
    const rulesSeen = storeGet('rules.' + cat.slug, false);
    if (isGame && !rulesSeen) storeSet('rules.' + cat.slug, true);
    $('stage').innerHTML = `<article class="prompt-stage ${deck.kind} mech-${esc(mech)}" aria-live="polite">
      <div class="stage-top">
        <span class="pill">${esc(cat.name)}</span>
        <span class="pill soft">${ov.remaining} of ${ov.total} left</span>
      </div>
      ${isGame && rules.summary ? `<p class="how-summary">${esc(rules.summary)}</p>` : ''}
      <div class="stage-body">${cardBody(mech, card)}</div>
      <div class="stage-actions">
        <button type="button" class="btn primary" data-act="card-done">${isGame ? 'Round done' : 'We talked about it'}</button>
        <button type="button" class="btn ghost" data-act="card-skip">${isGame ? 'Skip card' : 'Skip'}</button>
      </div>
      <div class="stage-extra">
        ${!isGame ? '<button type="button" class="btn link small" data-act="save-decision">Save as a decision</button>' : ''}
        ${mech === 'plan' ? '<button type="button" class="btn link small" data-act="save-idea">Save as a date idea</button>' : ''}
        <button type="button" class="btn link small" data-act="deck-reset">Start this category again</button>
      </div>
      ${isGame ? `<details class="rules" ${rulesSeen ? '' : 'open'}>
        <summary>How to play</summary>
        ${rules.purpose ? `<p>${esc(rules.purpose)}</p>` : ''}
        <ol>${(rules.steps || []).map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
        <dl>
          ${rules.turns ? `<dt>Turns</dt><dd>${esc(rules.turns)}</dd>` : ''}
          ${rules.answer ? `<dt>Answer</dt><dd>${esc(rules.answer)}</dd>` : ''}
          ${rules.round_end ? `<dt>Round ends</dt><dd>${esc(rules.round_end)}</dd>` : ''}
          ${rules.scoring ? `<dt>Scoring</dt><dd>${esc(rules.scoring)}</dd>` : ''}
          ${rules.video_call ? `<dt>On a call</dt><dd>${esc(rules.video_call)}</dd>` : ''}
        </dl>
      </details>` : ''}
    </article>`;
  }

  function renderExhausted(deck) {
    const cat = deck.cats.find((c) => c.id === deck.current);
    const ov = deck.overview.get(deck.current) || { total: 0 };
    $('stage').innerHTML = `<div class="prompt-stage exhausted">
      <span class="pill">${esc(cat ? cat.name : '')}</span>
      <h3>${ov.total ? `All ${ov.total} cards done` : 'No cards in this category'}</h3>
      <p>Pick another category above, or start this one again. Cards you've played stay in your history.</p>
      ${ov.total ? `<button type="button" class="btn primary" data-act="deck-reset">Start ${esc(cat ? cat.name : 'this category')} again</button>` : ''}
    </div>`;
  }

  async function onDeckClick(act, el) {
    const kind = state.route.section;
    const deck = state.decks[kind];
    if (act === 'timer') return startTimer(el);
    if (act === 'reveal') {
      const box = el.closest('.secret');
      const card = box.querySelector('.secret-card');
      const show = card.hidden;
      card.hidden = !show;
      box.querySelector('[data-act="reveal"]').hidden = show;
      box.querySelector('.secret-hint').hidden = show;
      return undefined;
    }
    if (!deck || (kind !== 'discussion' && kind !== 'game')) return undefined;
    if (act === 'cat') {
      if (el.dataset.cat === deck.current) return undefined;
      selectCategory(deck, el.dataset.cat);
      return drawCard(deck);
    }
    if (act === 'surprise') {
      const options = deck.cats.filter((c) => c.id !== deck.current && (deck.overview.get(c.id) || {}).remaining > 0);
      if (!options.length) { toast('Every other category is finished.'); return undefined; }
      const pick = options[Math.floor(Math.random() * options.length)];
      selectCategory(deck, pick.id);
      renderStripScroll();
      return drawCard(deck);
    }
    if (act === 'card-done' || act === 'card-skip') {
      if (!deck.card) return undefined;
      qsa('.stage-actions button', $('stage')).forEach((b) => { b.disabled = true; });
      const card = deck.card;
      if (act === 'card-done') {
        await recordCard(card.id, 'completed');
        const ov = deck.overview.get(card.category_id);
        if (ov) ov.remaining = Math.max(0, ov.remaining - 1);
        updateStripCount(deck, card.category_id);
        deck.card = null;
      } else {
        recordCard(card.id, 'skipped').catch((err) => console.warn(err));
      }
      return drawCard(deck, { allowSame: act === 'card-skip' });
    }
    if (act === 'deck-reset') {
      const cat = deck.cats.find((c) => c.id === deck.current);
      const ov = deck.overview.get(deck.current) || { total: 0 };
      const ok = await confirmAction({
        title: `Start "${cat.name}" again?`,
        text: `All ${ov.total} cards become available again. Your history is kept.`,
        ok: 'Start again',
        danger: false,
      });
      if (!ok) return undefined;
      await q('Starting again', state.db.rpc('deck_reset', { p_category: deck.current }));
      ov.remaining = ov.total;
      deck.seen.set(deck.current, new Set());
      deck.card = null;
      updateStripCount(deck, deck.current);
      toast(`${cat.name} is fresh again`);
      return drawCard(deck);
    }
    if (act === 'save-decision' && deck.card) {
      return openEntryForm({ type: 'decision', preset: { title: '', details: deck.card.body } });
    }
    if (act === 'save-idea' && deck.card) {
      return openEntryForm({ type: 'dateidea', preset: { title: '', details: deck.card.body } });
    }
    return undefined;
  }
  function renderStripScroll() {
    const active = $('deckStrip') && $('deckStrip').querySelector('.active');
    if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest', inline: 'center' });
  }

  function startTimer(btn) {
    const box = btn.closest('.timer');
    const display = box.querySelector('.timer-display');
    const total = Number(box.dataset.seconds) || 60;
    if (activeTimer && box.classList.contains('running')) {
      stopTimer();
      box.classList.remove('running');
      btn.textContent = 'Restart timer';
      return;
    }
    stopTimer();
    let left = total;
    box.classList.add('running');
    box.classList.remove('finished');
    btn.textContent = 'Stop';
    display.textContent = fmtSecs(left);
    activeTimer = setInterval(() => {
      left -= 1;
      display.textContent = fmtSecs(Math.max(0, left));
      if (left <= 0) {
        stopTimer();
        box.classList.remove('running');
        box.classList.add('finished');
        display.textContent = "Time's up";
        btn.textContent = 'Restart timer';
        if (navigator.vibrate) navigator.vibrate(200);
      }
    }, 1000);
  }

  /* ------------------------------------------------------------------ */
  /* 7. Forms                                                            */
  /* ------------------------------------------------------------------ */

  let formCtx = null;
  // What was typed into a form that was closed without saving (Back button,
  // Escape, Cancel) is kept for the same item and offered again next time.
  let entryDraft = null;
  const formFields = ['entryTitle', 'entryCategory', 'entryDetails', 'entryStatus', 'entryDate', 'entryBudget', 'entryParent'];
  function readForm() {
    const v = {};
    formFields.forEach((id) => { v[id] = $(id).value; });
    v.entryRepeat = $('entryRepeat').checked;
    return v;
  }
  function writeForm(v) {
    formFields.forEach((id) => { if (v[id] !== undefined && $(id).querySelector) $(id).value = v[id]; });
    $('entryRepeat').checked = !!v.entryRepeat;
  }
  const sameForm = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  function showField(id, show) { $(id).hidden = !show; }
  const fieldShown = (id) => !$(id).hidden;
  function fieldError(inputId, message) {
    const input = $(inputId);
    const err = $(inputId + 'Error');
    input.setAttribute('aria-invalid', 'true');
    if (err) { err.textContent = message; err.hidden = false; }
  }
  function clearFormErrors() {
    ['entryTitle', 'entryDate'].forEach((id) => {
      $(id).removeAttribute('aria-invalid');
      const err = $(id + 'Error');
      if (err) { err.hidden = true; err.textContent = ''; }
    });
    $('entryFormError').hidden = true;
  }

  function parentOptions(selectedId, excludeId) {
    const exclude = new Set();
    if (excludeId) {
      exclude.add(sid(excludeId));
      descendants(excludeId).forEach((d) => exclude.add(sid(d.id)));
    }
    const rows = ['<option value="">Top level (a main plan)</option>'];
    const seen = new Set();
    (function walk(pid, depth) {
      for (const c of kids(pid)) {
        if (seen.has(sid(c.id)) || exclude.has(sid(c.id))) continue;
        seen.add(sid(c.id));
        rows.push(`<option value="${esc(c.id)}" ${sid(c.id) === sid(selectedId) ? 'selected' : ''}>${'— '.repeat(depth)}${esc(c.title)}</option>`);
        walk(c.id, depth + 1);
      }
    })(null, 0);
    for (const u of state.unfiled) {
      if (exclude.has(sid(u.id)) || seen.has(sid(u.id))) continue;
      seen.add(sid(u.id));
      rows.push(`<option value="${esc(u.id)}" ${sid(u.id) === sid(selectedId) ? 'selected' : ''}>(Unfiled) ${esc(u.title)}</option>`);
      (function walkU(pid, depth) {
        for (const c of kids(pid)) {
          if (seen.has(sid(c.id)) || exclude.has(sid(c.id))) continue;
          seen.add(sid(c.id));
          rows.push(`<option value="${esc(c.id)}" ${sid(c.id) === sid(selectedId) ? 'selected' : ''}>(Unfiled) ${'\u2014 '.repeat(depth)}${esc(c.title)}</option>`);
          walkU(c.id, depth + 1);
        }
      })(u.id, 1);
    }
    if (selectedId && !seen.has(sid(selectedId))) {
      const p = state.byId.get(sid(selectedId));
      // Never let a save silently move something to the top level.
      rows.push(`<option value="${esc(selectedId)}" selected>${p ? esc(p.title) : '(Missing parent: choose another)'}</option>`);
    }
    return rows.join('');
  }

  function openEntryForm({ type, entry, parentId, preset }) {
    const mod = MODULES[type];
    const isPlan = type === 'plan';
    formCtx = { type, entry: entry || null };
    $('entryForm').reset();
    clearFormErrors();
    $('entryPhoto').value = '';
    $('photoCurrent').hidden = true;

    const pId = entry ? entry.parent_id : (parentId || null);
    formCtx.key = `${type}|${entry ? entry.id : 'new'}|${pId || ''}`;
    $('entryFormNote').hidden = true;
    if (isPlan) {
      const depth = pId ? depthOf(pId) + 1 : 0;
      const parent = pId ? state.byId.get(sid(pId)) : null;
      $('entryDialogTitle').textContent = entry ? `Edit ${levelName(depthOf(entry.id)).toLowerCase()}`
        : parent ? `Add ${levelName(depth).toLowerCase()} to "${parent.title}"` : 'New main plan';
      $('entryParent').innerHTML = parentOptions(pId, entry && entry.id);
    } else {
      $('entryDialogTitle').textContent = entry ? `Edit ${mod.noun}` : `Add ${mod.noun}`;
    }

    showField('parentField', isPlan);
    showField('categoryField', !isPlan && !!mod.category);
    if (!isPlan && mod.category) $('entryCategoryLabel').textContent = mod.category;
    $('entryDetailsLabel').textContent = isPlan ? 'Notes' : mod.details;
    $('entryDetails').rows = !isPlan && mod.big ? 10 : 4;

    const statuses = isPlan ? PLAN_STATUSES : mod.statuses;
    showField('statusField', !!statuses);
    if (statuses) {
      const cur = (entry && entry.status) || statuses[0];
      const opts = statuses.includes(cur) ? statuses : [cur, ...statuses];
      $('entryStatus').innerHTML = opts.map((s) => `<option ${s === cur ? 'selected' : ''}>${esc(s)}</option>`).join('');
    }
    showField('dateField', isPlan || !!mod.date);
    $('entryDateLabel').textContent = isPlan ? 'Target date' : mod.date;
    $('entryDate').required = !isPlan && !!mod.dateRequired;
    showField('budgetField', isPlan || !!mod.budget);
    showField('repeatField', !isPlan && !!mod.repeat);
    showField('photoField', !isPlan && !!mod.photo);

    $('entryTitle').value = (entry && entry.title) || (preset && preset.title) || '';
    $('entryCategory').value = (entry && entry.category) || '';
    $('entryDetails').value = (entry && entry.details) || (preset && preset.details) || '';
    $('entryDate').value = (entry && entry.target_date ? String(entry.target_date).slice(0, 10) : '')
      || (!entry && !isPlan && mod.dateDefaultToday ? isoDay(today()) : '');
    $('entryBudget').value = entry && entry.budget != null ? entry.budget : '';
    $('entryRepeat').checked = !!(entry && entry.repeats_yearly);
    $('entryDeleteBtn').hidden = !entry;

    if (entry && entry.photo_path && !isPlan && mod.photo) {
      $('photoCurrent').hidden = false;
      $('photoPreview').removeAttribute('src');
      photoUrls([entry.photo_path]).then(([u]) => { if (u) $('photoPreview').src = u; });
    }
    formCtx.initial = readForm();
    if (entryDraft && entryDraft.key === formCtx.key) {
      writeForm(entryDraft.values);
      $('entryFormNote').textContent = 'Restored what you were typing before.';
      $('entryFormNote').hidden = false;
    }
    entryDraft = null;
    openDialog('entryDialog');
    setTimeout(() => $('entryTitle').focus(), 60);
  }
  function keepDraft() {
    if (!formCtx || formCtx.noDraft || !formCtx.initial) return;
    const now = readForm();
    if (!sameForm(now, formCtx.initial)) entryDraft = { key: formCtx.key, values: now };
  }

  async function saveEntry(ev) {
    ev.preventDefault();
    const ctx = formCtx;
    if (!ctx) return;
    clearFormErrors();
    const isPlan = ctx.type === 'plan';
    const mod = MODULES[ctx.type];
    const title = $('entryTitle').value.trim();
    const date = $('entryDate').value;
    let bad = false;
    if (!title) { fieldError('entryTitle', 'Give it a title.'); bad = true; }
    if (!isPlan && mod.dateRequired && !date) { fieldError('entryDate', 'Choose the date.'); bad = true; }
    if (bad) {
      (title ? $('entryDate') : $('entryTitle')).focus();
      return;
    }

    const payload = { title, details: $('entryDetails').value.trim() || null };
    if (!ctx.entry) payload.type = ctx.type;
    if (isPlan) payload.parent_id = $('entryParent').value || null;
    else if (!ctx.entry) payload.parent_id = null;
    if (fieldShown('categoryField')) payload.category = $('entryCategory').value.trim() || null;
    if (fieldShown('statusField')) {
      payload.status = $('entryStatus').value;
      payload.completed = payload.status === doneStatusFor(ctx.type) || payload.status === 'Completed';
    } else if (!ctx.entry) {
      payload.status = 'Idea';
      payload.completed = false;
    }
    if (fieldShown('dateField')) payload.target_date = date || null;
    if (fieldShown('budgetField')) {
      const b = $('entryBudget').value;
      payload.budget = b === '' ? null : Number(b);
    }
    if (fieldShown('repeatField')) payload.repeats_yearly = $('entryRepeat').checked;

    const btn = $('entrySaveBtn');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    let uploaded = null;
    try {
      const oldPhoto = ctx.entry ? ctx.entry.photo_path : null;
      const file = fieldShown('photoField') && $('entryPhoto').files && $('entryPhoto').files[0];
      if (file) {
        uploaded = await uploadPhoto(file);
        payload.photo_path = uploaded;
      } else if (fieldShown('photoField') && $('entryRemovePhoto').checked) {
        payload.photo_path = null;
      }
      if (ctx.entry) await updateEntry(ctx.entry, payload, { checkStale: true });
      else await insertEntry(payload);
      if (oldPhoto && 'photo_path' in payload && payload.photo_path !== oldPhoto) removePhoto(oldPhoto);
      formCtx = null;
      await closeDialog('entryDialog');
      toast('Saved');
      render();
    } catch (err) {
      if (uploaded) removePhoto(uploaded);
      console.warn(err);
      const banner = $('entryFormError');
      banner.textContent = err.message || String(err);
      banner.hidden = false;
      banner.scrollIntoView({ block: 'nearest' });
      if (err instanceof StaleError) {
        loadEntries().catch(() => {});
      }
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save';
    }
  }

  function openDatesForm() {
    const s = state.settings;
    $('dateFormError').hidden = true;
    $('relationshipDate').value = String(s.relationship_start === undefined || s.relationship_start === '' ? DEFAULT_START : s.relationship_start).slice(0, 10);
    $('meetingDate').value = String(s.next_meeting === undefined ? DEFAULT_MEETING : s.next_meeting).slice(0, 16);
    openDialog('dateDialog');
  }
  async function saveDates(ev) {
    ev.preventDefault();
    const start = $('relationshipDate').value;
    if (!start) {
      $('dateFormError').textContent = 'Choose the date you got together.';
      $('dateFormError').hidden = false;
      $('relationshipDate').focus();
      return;
    }
    const meet = $('meetingDate').value;
    try {
      await q('Saving dates', state.db.from('app_settings').upsert(
        [{ key: 'relationship_start', value: start }, { key: 'next_meeting', value: meet }], { onConflict: 'key' }));
      state.settings.relationship_start = start;
      state.settings.next_meeting = meet;
      await closeDialog('dateDialog');
      toast('Dates saved');
      render();
    } catch (err) {
      $('dateFormError').textContent = err.message;
      $('dateFormError').hidden = false;
    }
  }

  let confirmResolve = null;
  function confirmAction({ title, text, items, ok, danger }) {
    $('confirmTitle').textContent = title;
    $('confirmText').textContent = text || '';
    const list = items || [];
    $('confirmList').innerHTML = list.map((i) => `<li dir="auto">${esc(i)}</li>`).join('');
    $('confirmList').hidden = !list.length;
    $('confirmOk').textContent = ok || 'Delete';
    $('confirmOk').className = 'btn ' + (danger === false ? 'primary' : 'danger');
    if (confirmResolve) confirmResolve(false);
    openDialog('confirmDialog');
    setTimeout(() => $('confirmCancel').focus(), 60);
    return new Promise((resolve) => { confirmResolve = resolve; });
  }
  function settleConfirm(value) {
    const r = confirmResolve;
    confirmResolve = null;
    if (r) r(value);
  }

  /* ------------------------------------------------------------------ */
  /* 8. Sign-in and start-up                                             */
  /* ------------------------------------------------------------------ */

  let authMessage = '';

  function showAuth(message) {
    if (window.OU_TV) window.OU_TV.stop();
    state.user = null;
    state.entries = [];
    state.decks = { discussion: null, game: null };
    qsa('dialog[open]').forEach((d) => d.close());
    if (drawerIsOpen()) showDrawerUI(false);
    overlays.length = 0;
    while (lockDepth > 0) unlockScroll();
    $('app').hidden = true;
    $('auth').hidden = false;
    const err = $('authError');
    const msg = message || authMessage;
    authMessage = '';
    err.textContent = msg || '';
    err.hidden = !msg;
  }

  async function enter(user) {
    if (state.user && state.user.id === user.id && state.entries.length) return;
    state.user = user;
    $('auth').hidden = true;
    $('app').hidden = false;
    setAdd(null);
    setContent('<div class="state-box" role="status"><span class="spinner" aria-hidden="true"></span><p>Loading…</p></div>');
    try {
      const allowed = await loadMembers();
      if (!allowed) {
        authMessage = "This account doesn't have access to Our Universe.";
        await state.db.auth.signOut();
        showAuth(authMessage);
        return;
      }
      buildNav();
      await Promise.all([loadEntries(), loadSettings()]);
    } catch (err) {
      console.warn(err);
      buildNav();
      if (isMissingSchema(err)) {
        setContent(`<div class="state-box error" role="alert"><p>The database needs the v39 update before this version can run.</p>
          <p class="muted">Run <code>supabase/001_v39_upgrade.sql</code> in the Supabase SQL editor (see docs/05_DEPLOYMENT_AND_ROLLBACK.md).</p></div>`);
      } else {
        setContent(errorBlock(err.message));
        $('content').querySelector('[data-act="retry"]').onclick = (e) => { e.stopPropagation(); state.entries = []; enter(user); };
      }
      return;
    }
    state.route = parseHash();
    render();
    if (window.OU_TV) window.OU_TV.start();
  }

  async function signIn(ev) {
    ev.preventDefault();
    const email = $('email').value.trim();
    const password = $('password').value;
    const err = $('authError');
    err.hidden = true;
    if (!email || !password) {
      err.textContent = 'Enter your email and password.';
      err.hidden = false;
      return;
    }
    const btn = $('loginBtn');
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    try {
      const { data } = await q('Signing in', state.db.auth.signInWithPassword({ email, password }));
      $('password').value = '';
      if (data && data.session) await enter(data.session.user);
    } catch (e) {
      err.textContent = /invalid login credentials/i.test(e.raw) ? 'That email and password don\'t match.' : e.message;
      err.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Enter our universe';
    }
  }

  async function forgotPassword() {
    const email = $('email').value.trim();
    const err = $('authError');
    if (!email) {
      err.textContent = 'Type your email first, then tap "Forgot password?" again.';
      err.hidden = false;
      $('email').focus();
      return;
    }
    try {
      await q('Sending the reset link', state.db.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname }));
      err.textContent = 'If that email has an account, a reset link is on its way.';
      err.hidden = false;
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
    }
  }

  async function savePassword(ev) {
    ev.preventDefault();
    const pw = $('newPassword').value;
    const err = $('passwordError');
    if (pw.length < 8) {
      err.textContent = 'Use at least 8 characters.';
      err.hidden = false;
      return;
    }
    try {
      await q('Saving the password', state.db.auth.updateUser({ password: pw }));
      await closeDialog('passwordDialog');
      toast('Password updated');
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
    }
  }

  function bindStatic() {
    $('authForm').addEventListener('submit', signIn);
    $('forgotBtn').addEventListener('click', forgotPassword);
    $('logoutBtn').addEventListener('click', async () => {
      try { await state.db.auth.signOut(); } catch (e) { fail(e); }
      showAuth();
    });
    $('menuBtn').addEventListener('click', openDrawer);
    $('closeDrawer').addEventListener('click', () => { closeDrawer(); $('menuBtn').focus(); });
    $('drawerOverlay').addEventListener('click', () => closeDrawer());
    $('nav').addEventListener('click', async (e) => {
      const b = e.target.closest('[data-nav]');
      if (!b) return;
      await closeDrawer();
      go(b.dataset.nav);
      $('content').focus({ preventScroll: true });
    });
    qsa('#bottomNav [data-tab]').forEach((b) => b.addEventListener('click', async () => {
      await closeDrawer();
      go(b.dataset.tab);
    }));
    $('content').addEventListener('click', onContentClick);
    $('content').addEventListener('change', onContentChange);

    $('entryForm').addEventListener('submit', saveEntry);
    $('entryDeleteBtn').addEventListener('click', async () => {
      const entry = formCtx && formCtx.entry;
      if (!entry) return;
      formCtx.noDraft = true;
      await closeDialog('entryDialog');
      formCtx = null;
      try { await deleteFlow(entry); } catch (err) { fail(err); }
    });
    $('dateForm').addEventListener('submit', saveDates);
    $('passwordForm').addEventListener('submit', savePassword);
    $('confirmOk').addEventListener('click', async () => {
      const r = confirmResolve;
      confirmResolve = null;
      await closeDialog('confirmDialog');
      if (r) r(true);
    });
    $('confirmCancel').addEventListener('click', () => closeDialog('confirmDialog'));

    qsa('dialog').forEach((d) => {
      d.addEventListener('close', () => {
        if (d.id === 'confirmDialog') settleConfirm(false);
        if (d.id === 'entryDialog') { keepDraft(); formCtx = null; }
        releaseOverlay(d.id);
      });
      // Tapping the dark backdrop closes small dialogs, but never the entry
      // form, so a stray tap can't throw away what you typed.
      if (d.id !== 'entryDialog' && d.id !== 'passwordDialog' && d.id !== 'tvDialog') {
        d.addEventListener('click', (e) => { if (e.target === d) closeDialog(d.id); });
      }
    });
    qsa('[data-close]').forEach((b) => b.addEventListener('click', () => closeDialog(b.dataset.close)));

    // Swipe the drawer left to close it (the × button and overlay also work).
    let sx = 0;
    let sy = 0;
    $('drawer').addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
    $('drawer').addEventListener('touchend', (e) => {
      const dx = e.changedTouches[0].clientX - sx;
      const dy = Math.abs(e.changedTouches[0].clientY - sy);
      if (dx < -60 && dy < 50) closeDrawer();
    }, { passive: true });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && drawerIsOpen()) closeDrawer();
    });
    if (mqMobile.addEventListener) mqMobile.addEventListener('change', syncDrawerMode);
    else if (mqMobile.addListener) mqMobile.addListener(syncDrawerMode);
    syncDrawerMode();

    // Keep bottom sheets above the on-screen keyboard.
    if (window.visualViewport) {
      const vv = window.visualViewport;
      const update = () => {
        const kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
        document.documentElement.style.setProperty('--kb', `${kb}px`);
      };
      vv.addEventListener('resize', update);
      vv.addEventListener('scroll', update);
      update();
    }

    // Refresh when the app comes back to the foreground, so changes made on
    // the other phone appear without a manual reload.
    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState !== 'visible' || !state.user || overlays.length) return;
      if (Date.now() - state.loadedAt < 60000) return;
      try {
        await Promise.all([loadEntries(), loadSettings()]);
        if (!['discussion', 'game', 'together'].includes(state.route.section)) render();
        if (window.OU_TV) window.OU_TV.refreshBadge();
      } catch (err) {
        console.warn(err);
      }
    });
  }

  async function boot() {
    bindStatic();
    if ('serviceWorker' in navigator && location.protocol === 'https:') {
      navigator.serviceWorker.register('./service-worker.js').catch((e) => console.warn('Service worker not registered', e));
    }
    if (!window.supabase || !cfg.SUPABASE_URL || !cfg.SUPABASE_KEY) {
      showAuth("Couldn't load the app. Check your connection and refresh the page.");
      $('loginBtn').disabled = true;
      return;
    }
    state.db = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
    state.db.auth.onAuthStateChange((event) => {
      // Never await Supabase calls inside this callback (supabase-js advice).
      setTimeout(() => {
        if (event === 'PASSWORD_RECOVERY') openDialog('passwordDialog');
        if (event === 'SIGNED_OUT' && state.user) showAuth();
      }, 0);
    });
    try {
      const { data } = await state.db.auth.getSession();
      if (data && data.session) await enter(data.session.user);
      else showAuth();
    } catch (err) {
      showAuth(friendlyError('Checking your session', err));
    }
  }

  window.OU_VERSION = VERSION;
  // Shared helpers for togetherverse.js (loaded after this file). One object,
  // so the two scripts never redefine each other's functions.
  window.OU = {
    VERSION, state, $, qsa, esc, sid, cap, plural, q, AppError, friendlyError, isMissingSchema, toast, fail,
    openDialog, closeDialog, confirmAction, setContent, setAdd, go, render, errorBlock, storeGet, storeSet,
    localDate, localDateTime, today, daysBetween, isoDay, fmtDay, fmtTime, relDays, newId, compressImage,
    uploadFile, removeFile, signedUrls, insertEntry, updateEntry, loadEntries, openEntryForm, kids, lineage,
    isDone, levelName, depthOf, PHOTO_BUCKET,
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
