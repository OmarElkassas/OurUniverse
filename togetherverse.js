'use strict';
/*
 * O&H Togetherverse (v40). Loaded after app.js and built on its shared
 * helpers (window.OU). No build step.
 *
 *  1. Setup, mode list, shared components (shell, states, form sheet,
 *     reactions, media, celebration)
 *  2. Notifications (badge, realtime, recent activity)
 *  3. Hub and dashboard panel
 *  4. Reveal Together
 *  5. Match a Date
 *  6. Our Monthly Quest
 *  7. Open When
 *  8. Our Creative Studio
 *  9. Memory Capsules
 * 10. Click/change routing and public API (window.OU_TV)
 *
 * Privacy: hidden answers, votes, sealed letters and secret capsule entries
 * are protected by the database (see supabase/005_togetherverse.sql). This
 * file never requests the other person's private rows; even if it did, the
 * database would return nothing.
 */
(function () {
  const OU = window.OU;
  if (!OU) return;
  const { $, esc, q, toast } = OU;
  const db = () => OU.state.db;
  const me = () => OU.state.user.id;
  const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const SEALED = 'sealed';

  /* ------------------------------------------------------------------ */
  /* 1. Setup and shared components                                      */
  /* ------------------------------------------------------------------ */

  const ICON = {
    reveal: '<path d="M4 12a8 8 0 0 1 8-8v16a8 8 0 0 1-8-8z"/><circle cx="12" cy="12" r="8"/>',
    quest: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 9.3h16M4 14.6h16M9.3 4v16M14.6 4v16"/>',
    letters: '<rect x="3.5" y="6" width="17" height="12" rx="2"/><path d="m4 7 8 6 8-6"/>',
    match: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>',
    studio: '<path d="M4 20l4-1 10-10-3-3L5 16z"/><path d="m13.5 7.5 3 3"/>',
    capsules: '<path d="M7 4h10M7 20h10M8 4c0 5 8 5 8 8s-8 3-8 8M16 4c0 5-8 5-8 8"/>',
  };
  const MODES = [
    { id: 'reveal', name: 'Reveal Together', blurb: 'Answer the same question privately, then reveal both answers at once.' },
    { id: 'quest', name: 'Our Monthly Quest', blurb: 'Sixteen small things to do together this month.' },
    { id: 'letters', name: 'Open When', blurb: 'Letters that stay sealed until the right moment.' },
    { id: 'match', name: 'Match a Date', blurb: 'Vote on date ideas privately and see what you both love.' },
    { id: 'studio', name: 'Our Creative Studio', blurb: 'Plan, make and keep creative projects together.' },
    { id: 'capsules', name: 'Memory Capsules', blurb: 'Seal messages and photos for a future date.' },
  ];
  const MODE = Object.fromEntries(MODES.map((m) => [m.id, m]));
  const icon = (id, cls) => `<svg class="${cls || 'tv-icon'}" viewBox="0 0 24 24" aria-hidden="true">${ICON[id]}</svg>`;

  const tv = {
    hub: null,
    timers: [],
    channel: null,
    library: null,
    matchSkip: new Set(),
    lastVote: null,
    suggest: null,
    justRevealed: null,
    justOpened: null,
    editingAnswer: false,
  };
  const names = () => ({ me: (tv.hub && tv.hub.me_name) || OU.state.members.get(me()) || 'You',
    other: (tv.hub && tv.hub.other_name) || [...OU.state.members.entries()].filter(([k]) => k !== me()).map(([, v]) => v)[0] || 'your partner' });
  const nameOf = (uid) => (uid === me() ? 'You' : OU.state.members.get(uid) || names().other);
  const go = (rest) => OU.go('together', rest || null);
  const set = (html) => OU.setContent(`<div class="tv">${html}</div>`);
  const current = () => OU.state.route.section === 'together';

  function shell(mode, inner, sub) {
    const m = MODE[mode];
    return `<nav class="tv-crumb" aria-label="Where you are">
        <button type="button" data-act="tv-go" data-to="">✦ Togetherverse</button>
        <span aria-hidden="true">›</span>
        ${sub ? `<button type="button" data-act="tv-go" data-to="${esc(mode)}">${esc(m.name)}</button><span aria-hidden="true">›</span><span aria-current="page" dir="auto">${esc(sub)}</span>`
              : `<span aria-current="page">${esc(m.name)}</span>`}
      </nav>
      <header class="tv-mode-head">
        <span class="tv-mode-icon">${icon(mode)}</span>
        <div><h3>${esc(m.name)}</h3><p>${esc(m.blurb)}</p></div>
      </header>
      <div class="tv-body">${inner}</div>`;
  }
  const loading = (text) => `<div class="state-box" role="status"><span class="spinner" aria-hidden="true"></span><p>${esc(text)}</p></div>`;
  const empty = (text, action) => `<div class="state-box tv-empty"><p>${esc(text)}</p>${action || ''}</div>`;
  const errorBox = (text) => `<div class="state-box error" role="alert"><p>${esc(text)}</p><button type="button" class="btn primary" data-act="tv-refresh">Try again</button></div>`;
  const badge = (text, tone) => `<span class="tv-badge ${tone ? 'tone-' + tone : ''}">${esc(text)}</span>`;

  async function rpc(action, fn, args) {
    const { data } = await q(action, db().rpc(fn, args || {}));
    return data;
  }
  async function rows(action, builder) {
    const { data } = await q(action, builder);
    return data || [];
  }
  const hint = (err) => err && err.cause && err.cause.hint;
  // Database messages written for people (raise exception … in 005) are
  // shown as they are; anything else goes through the app's wording.
  const plain = (err) => (err && err.cause && err.cause.code === 'P0001' && err.cause.message) || (err && err.cause && err.cause.code === '22023' && err.cause.message) || (err && err.message) || String(err);

  function countdown(iso) {
    const ms = new Date(iso) - Date.now();
    if (ms <= 0) return 'now';
    const d = Math.floor(ms / 86400000);
    const h = Math.floor((ms % 86400000) / 3600000);
    if (d >= 2) return `in ${d} days`;
    if (d === 1) return `in 1 day ${h} h`;
    const m = Math.max(1, Math.floor((ms % 3600000) / 60000));
    return h ? `in ${h} h ${m} min` : `in ${m} min`;
  }
  const when = (iso) => { const d = new Date(iso); return `${OU.fmtDay(d)}, ${OU.fmtTime(d)}`; };
  const shortDate = (iso) => OU.fmtDay(new Date(iso));
  const aed = (n) => `AED ${Number(n).toLocaleString('en-GB', { maximumFractionDigits: 2 })}`;
  const localInput = (d) => `${OU.isoDay(d)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

  // ---- one reusable form sheet ----
  let formHandler = null;
  let formChange = null;
  function formDialog({ title, body, submit, onSubmit, onOpen, onChange }) {
    $('tvDialogTitle').textContent = title;
    $('tvFormBody').innerHTML = body;
    $('tvSubmit').textContent = submit || 'Save';
    $('tvSubmit').hidden = !onSubmit;
    $('tvFormError').hidden = true;
    formHandler = onSubmit || null;
    formChange = onChange || null;
    OU.openDialog('tvDialog');
    if (onOpen) onOpen($('tvForm'));
    setTimeout(() => { const f = $('tvForm').querySelector('input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea, select'); if (f) f.focus(); }, 60);
  }
  function formError(message) {
    const b = $('tvFormError');
    b.textContent = message;
    b.hidden = false;
    b.scrollIntoView({ block: 'nearest' });
  }
  function bindForm() {
    $('tvForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!formHandler) return;
      const btn = $('tvSubmit');
      const label = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Saving…';
      $('tvFormError').hidden = true;
      try {
        const keepOpen = await formHandler(new FormData($('tvForm')), $('tvForm'));
        if (keepOpen !== true) {
          formHandler = null;
          await OU.closeDialog('tvDialog');
        }
      } catch (err) {
        console.warn(err);
        formError(plain(err));
      } finally {
        btn.disabled = false;
        btn.textContent = label;
      }
    });
    $('tvForm').addEventListener('change', (e) => { if (formChange) formChange(e.target, $('tvForm')); });
    $('tvForm').addEventListener('click', async (e) => {
      const f = e.target.closest('[data-fill]');
      if (f) {
        const field = $('tvForm').querySelector(`[name="${f.dataset.target}"]`);
        if (field) { field.value = f.dataset.fill; field.focus(); }
        return;
      }
      // Buttons inside the sheet (swap, undo, reactions) use the same actions.
      const a = e.target.closest('[data-act^="tv-"]');
      if (!a) return;
      try { await onClick(a.dataset.act, a); } catch (err) { console.warn(err); formError(plain(err)); }
    });
  }
  const field = (label, html, hintText) => `<div class="field"><label>${esc(label)}${html}</label>${hintText ? `<p class="hint">${esc(hintText)}</p>` : ''}</div>`;
  const input = (name, value, attrs) => `<input name="${name}" value="${esc(value == null ? '' : value)}" ${attrs || ''}>`;
  const area = (name, value, attrs) => `<textarea name="${name}" ${attrs || ''}>${esc(value || '')}</textarea>`;
  const select = (name, options, value) => `<select name="${name}">${options.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const str = (fd, k) => { const v = fd.get(k); return v == null ? '' : String(v).trim(); };
  const num = (fd, k) => { const v = str(fd, k); return v === '' ? null : Number(v); };
  const fileOf = (fd, k) => { const f = fd.get(k); return f && f.size ? f : null; };

  // ---- celebration (only for real moments; respects reduced motion) ----
  let celebrateTimer = null;
  function celebrate(text) {
    toast(text);
    if (reduced()) return;
    const el = $('tvCelebrate');
    $('tvCelebrateText').textContent = text;
    el.hidden = false;
    el.classList.remove('go');
    void el.offsetWidth;
    el.classList.add('go');
    clearTimeout(celebrateTimer);
    celebrateTimer = setTimeout(() => { el.hidden = true; el.classList.remove('go'); }, 1900);
  }

  // ---- reactions ----
  const EMOJI = ['❤️', '😂', '🥹', '🔥', '👏', '🤍'];
  async function loadReactions(kind, ids) {
    if (!ids.length) return [];
    return rows('Loading reactions', db().from('tv_reactions').select('target_id, user_id, emoji').eq('target_kind', kind).in('target_id', ids));
  }
  function reactionBar(kind, id, list) {
    const mine = list.find((r) => r.target_id === id && r.user_id === me());
    const theirs = list.filter((r) => r.target_id === id && r.user_id !== me());
    return `<div class="tv-react" role="group" aria-label="Reactions">
      ${EMOJI.map((e) => `<button type="button" class="tv-react-btn ${mine && mine.emoji === e ? 'on' : ''}" aria-pressed="${!!(mine && mine.emoji === e)}"
        data-act="tv-react" data-kind="${kind}" data-target="${esc(id)}" data-emoji="${e}" aria-label="React ${e}">${e}</button>`).join('')}
      ${theirs.length ? `<span class="tv-react-other">${esc(names().other)} ${esc(theirs[0].emoji)}</span>` : ''}
    </div>`;
  }
  async function toggleReaction(el) {
    const { kind, target, emoji } = el.dataset;
    const on = el.getAttribute('aria-pressed') === 'true';
    if (on) {
      await q('Removing the reaction', db().from('tv_reactions').delete().eq('target_kind', kind).eq('target_id', target).eq('user_id', me()));
    } else {
      await q('Reacting', db().from('tv_reactions').upsert({ target_kind: kind, target_id: target, user_id: me(), emoji }, { onConflict: 'target_kind,target_id,user_id' }));
    }
    const bar = el.closest('.tv-react');
    bar.querySelectorAll('.tv-react-btn').forEach((b) => {
      const pressed = !on && b.dataset.emoji === emoji;
      b.classList.toggle('on', pressed);
      b.setAttribute('aria-pressed', String(pressed));
    });
  }

  // ---- media ----
  async function mediaTags(bucket, items) {
    const paths = items.flatMap((i) => [i.photo_path, i.audio_path]).filter(Boolean);
    if (!paths.length) return {};
    const urls = await OU.signedUrls(bucket, paths);
    const map = {};
    paths.forEach((p, i) => { map[p] = urls[i]; });
    return map;
  }
  const photoTag = (map, path, alt) => (path ? `<div class="photo">${map[path] ? `<img src="${esc(map[path])}" alt="${esc(alt)}" loading="lazy">` : ''}</div>` : '');
  const audioTag = (map, path) => (path && map[path] ? `<audio controls preload="none" src="${esc(map[path])}">Your browser can't play this voice note.</audio>` : '');
  const fileFields = (photo, audio) => `${photo ? field('Photo (optional)', '<input type="file" name="photo" accept="image/*">', 'Resized before upload. Private to the two of you.') : ''}
    ${audio ? field('Voice note (optional)', '<input type="file" name="audio" accept="audio/*">', 'Up to 5 MB (about five minutes).') : ''}`;

  /* ------------------------------------------------------------------ */
  /* 2. Notifications                                                    */
  /* ------------------------------------------------------------------ */

  async function refreshBadge() {
    if (!OU.state.user) return;
    try {
      const res = await db().from('tv_notifications').select('id', { count: 'exact', head: true }).is('read_at', null);
      const n = res && !res.error ? res.count || 0 : 0;
      const b = $('tvBadge');
      b.hidden = !n;
      b.textContent = n > 9 ? '9+' : String(n);
      b.setAttribute('aria-label', `${n} new`);
    } catch (_) { /* badge is optional */ }
  }
  function start() {
    refreshBadge();
    if (tv.channel || !db().channel) return;
    try {
      tv.channel = db().channel('tv-notifications')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'tv_notifications', filter: `recipient_id=eq.${me()}` }, (payload) => {
          const n = payload && payload.new;
          if (n && n.message) toast(n.message);
          refreshBadge();
          refreshIfIdle();
        })
        .subscribe();
    } catch (err) {
      console.warn('Realtime unavailable; refresh on return still works.', err);
      tv.channel = null;
    }
  }
  function stop() {
    if (tv.channel) {
      try { db().removeChannel(tv.channel); } catch (_) { /* ignore */ }
    }
    tv.channel = null;
    leave();
  }
  // Re-render the open Togetherverse screen, but never while someone is
  // typing or a sheet is open.
  function refreshIfIdle() {
    if (!current()) return;
    const a = document.activeElement;
    if (document.querySelector('dialog[open]')) return;
    if (a && $('content').contains(a) && /^(TEXTAREA|INPUT|SELECT)$/.test(a.tagName)) return;
    // Any typed-but-unsaved text in the view also blocks the refresh.
    if ([...$('content').querySelectorAll('textarea, input[type=text], input:not([type])')].some((el) => el.value.trim())) { refreshBadge(); return; }
    OU.render();
  }
  async function markRead(ids) {
    if (!ids.length) return;
    try {
      await q('Updating', db().from('tv_notifications').update({ read_at: new Date().toISOString() }).in('id', ids));
    } catch (err) { console.warn(err); }
    refreshBadge();
  }

  /* ------------------------------------------------------------------ */
  /* 3. Hub and dashboard panel                                          */
  /* ------------------------------------------------------------------ */

  function revealText(st) {
    if (!st) return ['No active reveal', null];
    const n = names();
    switch (st.status) {
      case 'waiting_for_both': return ['Waiting for both answers', 'action'];
      case 'ready_to_reveal': return ['Ready to reveal', 'ready'];
      default:
        if (st.status === `waiting_for_${n.me.toLowerCase()}`) return ['Waiting for your answer', 'action'];
        return [`Waiting for ${n.other}`, null];
    }
  }
  function daysLeftInMonth() {
    const t = OU.today();
    const end = new Date(t.getFullYear(), t.getMonth() + 1, 0);
    return OU.daysBetween(t, end) + 1;
  }
  function modeLines(h) {
    const out = {};
    const [rt, rTone] = revealText(h.reveal);
    out.reveal = { lines: [rt], tone: rTone };
    if (!h.quest) out.quest = { lines: ['No board for this month yet'], tone: 'action' };
    else if (h.quest.status === 'draft') out.quest = { lines: ['This month\'s board is ready to start'], tone: 'action' };
    else out.quest = { lines: [`${h.quest.done} of ${h.quest.total} done · ${OU.plural(h.quest.lines, 'line')}`, `${OU.plural(daysLeftInMonth(), 'day')} left this month`] };
    const L = h.letters;
    out.letters = { lines: [L.available ? `${OU.plural(L.available, 'letter')} you can open` : 'No letters to open right now',
      [L.locked ? `${L.locked} locked` : '', L.my_drafts ? `${L.my_drafts} draft${L.my_drafts > 1 ? 's' : ''} of yours` : ''].filter(Boolean).join(' · ')].filter(Boolean),
      tone: L.available ? 'ready' : null };
    const M = h.match;
    out.match = { lines: [M.to_vote ? `${OU.plural(M.to_vote, 'idea')} waiting for your vote` : 'You\'re up to date',
      [M.new_matches ? `${M.new_matches} new match${M.new_matches > 1 ? 'es' : ''}` : '', M.planned ? `${M.planned} planned` : ''].filter(Boolean).join(' · ')].filter(Boolean),
      tone: M.new_matches ? 'ready' : M.to_vote ? 'action' : null };
    out.studio = { lines: [h.studio.active ? `${OU.plural(h.studio.active, 'active project')}` : 'No projects yet', h.studio.completed ? `${h.studio.completed} finished` : ''].filter(Boolean) };
    const C = h.capsules;
    out.capsules = { lines: [C.ready_to_open ? `${OU.plural(C.ready_to_open, 'capsule')} ready to open` : C.next_open_at ? `Next opens ${countdown(C.next_open_at)}` : C.collecting ? `${C.collecting} collecting` : 'No capsules yet',
      C.collecting && (C.ready_to_open || C.next_open_at) ? `${C.collecting} collecting` : ''].filter(Boolean), tone: C.ready_to_open ? 'ready' : null };
    return out;
  }

  async function viewHub() {
    set(`<header class="tv-hero"><p class="eyebrow">O&amp;H</p><h2>O&amp;H Togetherverse</h2><p>Play, create, discover, and make memories together.</p></header>${loading('Loading Togetherverse…')}`);
    let h;
    let notes = [];
    try {
      [h, notes] = await Promise.all([
        rpc('Loading Togetherverse', 'tv_hub'),
        rows('Loading activity', db().from('tv_notifications').select('id, message, route, created_at, read_at').order('created_at', { ascending: false }).limit(8)),
      ]);
    } catch (err) {
      if (!current()) return;
      set(OU.isMissingSchema(err)
        ? `<header class="tv-hero"><h2>O&amp;H Togetherverse</h2></header><div class="state-box error" role="alert"><p>Togetherverse needs a database update first.</p><p class="muted">Run <code>supabase/005_togetherverse.sql</code> and <code>006_seed_togetherverse.sql</code> in the Supabase SQL editor.</p></div>`
        : errorBox(err.message));
      return;
    }
    if (!current() || OU.state.route.id) return;
    tv.hub = h;
    const lines = modeLines(h);
    const unread = notes.filter((n) => !n.read_at);
    set(`<header class="tv-hero">
        <p class="eyebrow">O&amp;H</p>
        <h2>O&amp;H Togetherverse</h2>
        <p>Play, create, discover, and make memories together.</p>
        <p class="tv-hero-note">Everything here is private to the two of you. Answers, votes, sealed letters and secret capsule entries stay hidden from the other person until the moment they are meant to be seen.</p>
      </header>
      <section class="tv-modes" aria-label="Modes">
        ${MODES.map((m) => {
          const l = lines[m.id];
          return `<button type="button" class="tv-mode-card ${l.tone ? 'tone-' + l.tone : ''}" data-act="tv-go" data-to="${m.id}">
            <span class="tv-mode-icon">${icon(m.id)}</span>
            <span class="tv-mode-text"><b>${esc(m.name)}</b>
              ${l.lines.map((t, i) => `<span class="${i ? 'sub' : 'main'}">${esc(t)}</span>`).join('')}</span>
            <span class="tv-go" aria-hidden="true">›</span>
          </button>`;
        }).join('')}
      </section>
      <section class="panel tv-activity" aria-labelledby="tvActTitle">
        <div class="panel-head"><h3 id="tvActTitle">Recent activity</h3>
          ${unread.length ? '<button type="button" class="btn link small" data-act="tv-read-all">Mark all as read</button>' : ''}</div>
        ${notes.length ? `<ul class="tv-notes">${notes.map((n) => `<li class="${n.read_at ? '' : 'unread'}">
            <button type="button" data-act="tv-note" data-id="${esc(n.id)}" data-route="${esc(n.route)}">
              <span class="t">${esc(n.message)}</span><span class="s">${esc(OU.relDays(OU.daysBetween(new Date(n.created_at), new Date())).replace(/^./, (c) => c.toUpperCase()))}</span>
            </button></li>`).join('')}</ul>` : '<p class="muted">Nothing yet. Start anything above and it will show up here for both of you.</p>'}
      </section>`);
  }

  async function dashboardPanel(slot) {
    if (!slot) return;
    let h;
    try { h = await rpc('Loading Togetherverse', 'tv_hub'); } catch (_) { return; }
    if (!h || !document.contains(slot)) return;
    tv.hub = h;
    const items = [];
    const [rt, tone] = revealText(h.reveal);
    if (tone) items.push([rt, 'reveal']);
    if (h.letters.available) items.push([`${OU.plural(h.letters.available, 'Open When letter')} ready for you`, 'letters']);
    if (h.match.new_matches) items.push([`${h.match.new_matches} date match${h.match.new_matches > 1 ? 'es' : ''} to plan`, 'match']);
    if (h.capsules.ready_to_open) items.push(['A Memory Capsule is ready to open', 'capsules']);
    if (!h.quest) items.push(['Create this month\'s quest board', 'quest']);
    if (!items.length) return;
    slot.innerHTML = `<section class="panel tv-dash" aria-labelledby="tvDashTitle">
      <div class="panel-head"><h3 id="tvDashTitle">Togetherverse</h3><button type="button" class="btn link" data-act="go" data-section="together">Open</button></div>
      <ul class="mini-list">${items.slice(0, 4).map(([t, m]) => `<li><span class="tv-mini-icon">${icon(m)}</span>
        <button type="button" class="mini-list-main" data-act="go" data-section="together" data-target="${m}"><span class="t">${esc(t)}</span><span class="s">${esc(MODE[m].name)}</span></button></li>`).join('')}</ul>
    </section>`;
  }

  /* ------------------------------------------------------------------ */
  /* 4. Reveal Together                                                  */
  /* ------------------------------------------------------------------ */

  async function viewReveal(id) {
    if (id) return revealResult(id);
    set(shell('reveal', loading('Loading your current round…')));
    let st;
    let hist;
    try {
      [st, hist] = await Promise.all([
        rpc('Loading your current round', 'reveal_state', { p_round: null }),
        rows('Loading history', db().from('reveal_rounds').select('id, prompt, revealed_at').not('revealed_at', 'is', null).is('archived_at', null).order('revealed_at', { ascending: false }).limit(12)),
      ]);
      if (!tv.hub) tv.hub = await rpc('Loading', 'tv_hub');
    } catch (err) {
      if (current()) set(shell('reveal', errorBox(err.message)));
      return;
    }
    if (!current()) return;
    const history = hist.length ? `<section class="panel"><div class="panel-head"><h3>Revealed together</h3></div>
      <ul class="tv-list">${hist.map((r) => `<li><button type="button" data-act="tv-go" data-to="reveal/${esc(r.id)}"><span class="t" dir="auto">${esc(r.prompt)}</span><span class="s">${esc(shortDate(r.revealed_at))}</span></button></li>`).join('')}</ul></section>` : '';
    if (!st) {
      set(shell('reveal', `${revealStartBlock()}${history}`));
      fillRevealCategories();
      return;
    }
    set(shell('reveal', `${revealRoundBlock(st)}${history}`));
    bindAnswerBox(st);
  }

  function revealStartBlock() {
    const s = tv.suggest;
    return `<section class="panel">
      <p class="tv-lead">No active reveal. Start a question together.</p>
      <p class="muted small">You each answer privately. Neither of you can see the other's answer, not even through the database, until you both submit and choose to reveal.</p>
      <div class="tv-two">
        <div class="tv-start-box">
          <h4>Draw a question</h4>
          <label>Topic<select id="tvRevealCat" data-tv-change="reveal-cat"><option value="">Any topic</option></select></label>
          ${s ? `<p class="tv-suggest" dir="auto">${esc(s.body)}</p>
            <div class="tv-row"><button type="button" class="btn primary" data-act="tv-reveal-use">Use this question</button>
            <button type="button" class="btn ghost" data-act="tv-reveal-draw">Draw another</button></div>`
          : '<button type="button" class="btn primary" data-act="tv-reveal-draw">Draw a question</button>'}
        </div>
        <div class="tv-start-box">
          <h4>Or write your own</h4>
          <label for="tvCustomPrompt">Your question</label>
          <textarea id="tvCustomPrompt" maxlength="300" rows="3" dir="auto" placeholder=""></textarea>
          <button type="button" class="btn ghost" data-act="tv-reveal-custom">Start with this question</button>
        </div>
      </div>
    </section>`;
  }
  async function fillRevealCategories() {
    try {
      const cats = await rows('Loading topics', db().from('deck_categories').select('id, name').eq('kind', 'discussion').eq('is_active', true).order('sort_order'));
      const sel = $('tvRevealCat');
      if (!sel) return;
      sel.insertAdjacentHTML('beforeend', cats.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join(''));
      if (tv.suggestCat) sel.value = tv.suggestCat;
    } catch (err) { console.warn(err); }
  }
  async function revealDraw() {
    const cat = ($('tvRevealCat') && $('tvRevealCat').value) || '';
    tv.suggestCat = cat;
    let cards = db().from('deck_cards').select('id, body, category_id').eq('is_active', true);
    if (cat) cards = cards.eq('category_id', cat);
    else {
      const cats = await rows('Loading topics', db().from('deck_categories').select('id').eq('kind', 'discussion').eq('is_active', true));
      cards = cards.in('category_id', cats.map((c) => c.id));
    }
    const [list, recent] = await Promise.all([
      rows('Drawing a question', cards.limit(1000)),
      rows('Checking recent questions', db().from('reveal_rounds').select('prompt').order('created_at', { ascending: false }).limit(200)),
    ]);
    const used = new Set(recent.map((r) => r.prompt.trim().toLowerCase()));
    const fresh = list.filter((c) => !used.has(c.body.trim().toLowerCase()) && (!tv.suggest || c.id !== tv.suggest.id));
    if (!fresh.length) { toast('You have used every question in this topic recently. Try another topic or write your own.'); return; }
    tv.suggest = fresh[Math.floor(Math.random() * fresh.length)];
    OU.render();
  }
  async function revealStart(prompt, source, card) {
    try {
      await rpc('Starting the round', 'reveal_start', { p_prompt: prompt, p_source: source, p_card: card || null, p_force: false });
    } catch (err) {
      if (hint(err) === 'recent') {
        const ok = await OU.confirmAction({ title: 'You answered this one recently', text: 'You revealed this question together in the last 90 days. Use it again anyway?', ok: 'Use it again', danger: false });
        if (!ok) return;
        await rpc('Starting the round', 'reveal_start', { p_prompt: prompt, p_source: source, p_card: card || null, p_force: true });
      } else if (hint(err) === 'open') {
        toast('A round is already open. Showing it now.');
      } else throw err;
    }
    tv.suggest = null;
    tv.editingAnswer = false;
    OU.render();
  }

  function revealRoundBlock(st) {
    const n = names();
    const statusText = {
      waiting_for_both: 'Neither of you has submitted yet.',
      ready_to_reveal: 'Both of you have answered.',
    }[st.status] || (st.my_status === 'submitted' ? `Your answer has been submitted. Waiting for ${n.other}'s answer.` : `${n.other} has answered. Your answer is next.`);
    const draftKey = 'reveal.draft.' + st.round_id;
    const local = OU.storeGet(draftKey, null);
    const draft = local && typeof local === 'object' && !local.synced && local.text ? local.text
      : (st.my_draft != null && st.my_draft !== '' ? st.my_draft : (local && local.text) || '');
    let action;
    if (st.status === 'ready_to_reveal') {
      action = `<div class="tv-sealed-pair" aria-hidden="true"><div class="tv-sealed">${esc(n.me)}</div><div class="tv-sealed">${esc(n.other)}</div></div>
        <button type="button" class="btn primary tv-big" data-act="tv-reveal-open" data-id="${esc(st.round_id)}">Reveal together</button>
        <button type="button" class="btn link small" data-act="tv-reveal-edit">Change my answer first</button>`;
    } else if (st.my_status === 'submitted' && !tv.editingAnswer) {
      action = `<p class="tv-submitted">✓ Submitted. ${esc(n.other)} can't see it.</p>
        <button type="button" class="btn ghost" data-act="tv-reveal-edit">Edit my answer</button>`;
    } else {
      action = `<label for="tvAnswer">Your answer</label>
        <textarea id="tvAnswer" maxlength="1000" rows="5" dir="auto">${esc(draft)}</textarea>
        <p class="hint"><span id="tvAnswerCount">${1000 - draft.length}</span> characters left. ${esc(n.other)} won't see your answer, or how much you've written, until you reveal together.</p>
        <div class="tv-row">
          <button type="button" class="btn primary" data-act="tv-reveal-submit" data-id="${esc(st.round_id)}">Submit my answer</button>
          <button type="button" class="btn ghost" data-act="tv-reveal-save" data-id="${esc(st.round_id)}">Save draft</button>
        </div>`;
    }
    return `<section class="tv-prompt-card">
        <p class="eyebrow">THE QUESTION</p>
        <p class="tv-prompt" dir="auto">${esc(st.prompt)}</p>
        <div class="tv-status-row">
          ${badge(st.my_status === 'submitted' ? 'You: submitted' : st.my_status === 'draft' ? 'You: draft saved' : 'You: not answered', st.my_status === 'submitted' ? 'done' : 'wait')}
          ${badge(`${n.other}: ${st.other_submitted ? 'submitted' : 'not submitted'}`, st.other_submitted ? 'done' : 'wait')}
        </div>
        <p class="tv-status-text" role="status">${esc(statusText)}</p>
        <div class="tv-answer">${action}</div>
        <div class="tv-row end">
          <button type="button" class="btn link small" data-act="tv-refresh">Refresh</button>
          <button type="button" class="btn link small danger-link" data-act="tv-reveal-cancel" data-id="${esc(st.round_id)}">Cancel this round</button>
        </div>
      </section>`;
  }
  function bindAnswerBox(st) {
    const box = $('tvAnswer');
    if (!box) return;
    box.addEventListener('input', () => {
      $('tvAnswerCount').textContent = String(1000 - box.value.length);
      OU.storeSet('reveal.draft.' + st.round_id, { text: box.value, synced: false });
    });
  }
  async function revealSave(roundId, submit) {
    const box = $('tvAnswer');
    const body = box ? box.value : '';
    if (submit && !body.trim()) { toast('Write an answer before submitting.', 'error'); box && box.focus(); return; }
    const btns = document.querySelectorAll('.tv-answer .btn');
    btns.forEach((b) => { b.disabled = true; });
    try {
      const st = await rpc(submit ? 'Submitting your answer' : 'Saving your draft', 'reveal_save', { p_round: roundId, p_body: body, p_submit: submit });
      OU.storeSet('reveal.draft.' + roundId, submit ? null : { text: body, synced: true });
      tv.editingAnswer = false;
      toast(submit ? (st.status === 'ready_to_reveal' ? 'Both of you have answered.' : 'Your answer has been submitted.') : 'Draft saved. Only you can see it.');
      OU.render();
    } catch (err) {
      btns.forEach((b) => { b.disabled = false; });
      toast(`${plain(err)} Your text has been kept.`, 'error');
    }
  }
  async function revealOpen(roundId) {
    await rpc('Revealing', 'reveal_open', { p_round: roundId });
    tv.justRevealed = roundId;
    go('reveal/' + roundId);
  }

  async function revealResult(id) {
    set(shell('reveal', loading('Opening your answers…'), 'Answers'));
    let round;
    let answers;
    let reacts;
    try {
      const r = await rows('Loading the round', db().from('reveal_rounds').select('*').eq('id', id));
      round = r[0];
      answers = round ? await rows('Loading answers', db().from('reveal_answers').select('user_id, body, submitted_at').eq('round_id', id)) : [];
      reacts = round ? await loadReactions('reveal', [id]) : [];
    } catch (err) {
      if (current()) set(shell('reveal', errorBox(err.message), 'Answers'));
      return;
    }
    if (!current()) return;
    if (!round) { set(shell('reveal', empty('This round no longer exists.', '<button type="button" class="btn primary" data-act="tv-go" data-to="reveal">Back to Reveal Together</button>'), 'Answers')); return; }
    if (!round.revealed_at) { set(shell('reveal', empty('These answers are still sealed. They open when you both reveal together.', '<button type="button" class="btn primary" data-act="tv-go" data-to="reveal">Back to the round</button>'), 'Answers')); return; }
    const mine = answers.find((a) => a.user_id === me());
    const theirs = answers.find((a) => a.user_id !== me());
    const anim = tv.justRevealed === id && !reduced();
    tv.justRevealed = null;
    set(shell('reveal', `<section class="tv-prompt-card">
        <p class="eyebrow">THE QUESTION</p>
        <p class="tv-prompt" dir="auto">${esc(round.prompt)}</p>
        <div class="tv-answers ${anim ? 'tv-reveal-anim' : ''}">
          <article class="tv-answer-card"><h4>${esc(names().me)}</h4><p dir="auto">${esc(mine ? mine.body : '')}</p></article>
          <article class="tv-answer-card"><h4>${esc(names().other)}</h4><p dir="auto">${esc(theirs ? theirs.body : '')}</p></article>
        </div>
        ${reactionBar('reveal', id, reacts)}
        <p class="muted small">Revealed ${esc(when(round.revealed_at))}</p>
        <div class="tv-row">
          <button type="button" class="btn ghost" data-act="tv-reveal-memory" data-id="${esc(id)}">Save to Memories</button>
          <button type="button" class="btn ghost" data-act="tv-reveal-note" data-id="${esc(id)}">Talk more: save as a decision</button>
          <button type="button" class="btn primary" data-act="tv-go" data-to="reveal">New question</button>
        </div>
      </section>`, 'Answers'));
    tv.lastRound = { round, mine, theirs };
  }
  async function revealToMemory() {
    const r = tv.lastRound;
    if (!r) return;
    await OU.insertEntry({
      type: 'memory', parent_id: null, title: r.round.prompt.slice(0, 200), status: 'Idea', completed: false,
      category: 'Reveal Together', target_date: OU.isoDay(new Date(r.round.revealed_at)),
      details: `${names().me}: ${r.mine ? r.mine.body : ''}\n\n${names().other}: ${r.theirs ? r.theirs.body : ''}`,
    });
    toast('Saved to Memories');
  }

  /* ------------------------------------------------------------------ */
  /* 5. Match a Date                                                     */
  /* ------------------------------------------------------------------ */

  const SETTING = { together: 'Together', remote: 'On a call', either: 'Together or apart' };
  const PLACE = { home: 'At home', out: 'Going out', either: 'Home or out' };
  const PREP = { none: 'No preparation', some: 'Some preparation', booking: 'Booking needed' };
  const MOODS = ['relaxing', 'creative', 'food', 'adventurous', 'romantic', 'practical'];
  const BUDGETS = [['free', 'Free', 0, 0], ['u100', 'Under AED 100', 1, 100], ['m250', 'AED 100–250', 100, 250], ['m500', 'AED 250–500', 250, 500], ['special', 'Special occasion', 500, 99999]];
  const DURATIONS = [['short', '30 min', 0, 45], ['mid', '1–2 h', 46, 150], ['half', 'Half day', 151, 300], ['full', 'Full day', 301, 1440]];
  const budgetText = (c) => (c.budget_max === 0 ? 'Free' : c.budget_min === c.budget_max ? aed(c.budget_max) : `${aed(c.budget_min)}–${c.budget_max}`);
  const durText = (m) => (m < 60 ? `${m} min` : m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} h`);
  const filters = () => OU.storeGet('tv.match.filters', {});

  function cardChips(c) {
    return [SETTING[c.setting], PLACE[c.place], budgetText(c), durText(c.minutes), PREP[c.prep], c.mood, c.city]
      .filter(Boolean).map((t) => `<span class="chip">${esc(t)}</span>`).join('');
  }
  function passesFilters(c, f) {
    if (f.setting && !(c.setting === f.setting || c.setting === 'either')) return false;
    if (f.place && !(c.place === f.place || c.place === 'either')) return false;
    if (f.mood && c.mood !== f.mood) return false;
    if (f.prep && c.prep !== f.prep) return false;
    if (f.budget) {
      const b = BUDGETS.find((x) => x[0] === f.budget);
      if (b && !(c.budget_max >= b[2] && c.budget_max <= b[3])) return false;
    }
    if (f.duration) {
      const d = DURATIONS.find((x) => x[0] === f.duration);
      if (d && !(c.minutes >= d[2] && c.minutes <= d[3])) return false;
    }
    return true;
  }

  async function viewMatch(sub) {
    const tab = sub || 'vote';
    set(shell('match', loading('Finding ideas that match your preferences…')));
    let cards;
    let votes;
    let results;
    try {
      [cards, votes, results] = await Promise.all([
        rows('Loading date ideas', db().from('date_cards').select('*').eq('is_active', true).order('created_at')),
        rows('Loading your votes', db().from('date_votes').select('card_id, vote')),
        rows('Loading matches', db().from('date_results').select('*')),
      ]);
    } catch (err) {
      if (current()) set(shell('match', errorBox(err.message)));
      return;
    }
    if (!current()) return;
    const myVote = new Map(votes.map((v) => [v.card_id, v.vote]));
    const result = new Map(results.map((r) => [r.card_id, r]));
    const byId = new Map(cards.map((c) => [c.id, c]));
    tv.match = { byId };
    const tabs = `<div class="tv-tabs" role="tablist">
      ${[['vote', 'Vote'], ['matches', 'Matches'], ['add', 'Add an idea']].map(([k, l]) => `<button type="button" role="tab" aria-selected="${tab === k}" class="${tab === k ? 'active' : ''}" data-act="tv-go" data-to="${k === 'vote' ? 'match' : 'match/' + k}">${l}</button>`).join('')}
    </div>`;
    if (tab === 'matches') {
      const list = results.filter((r) => r.outcome !== 'none' && byId.has(r.card_id)).sort((a, b) => String(b.decided_at).localeCompare(String(a.decided_at)));
      const open = list.filter((r) => !r.entry_id && !r.dismissed_at);
      const planned = list.filter((r) => r.entry_id);
      const card = (r) => {
        const c = byId.get(r.card_id);
        return `<article class="card tv-date ${r.outcome}">
          <div class="card-top">${badge(r.outcome === 'match' ? 'You both love this' : 'Possible match', r.outcome === 'match' ? 'ready' : 'wait')}</div>
          <h3 dir="auto">${esc(c.title)}</h3><p class="details" dir="auto">${esc(c.description)}</p>
          <div class="row-meta">${cardChips(c)}</div>
          ${r.entry_id ? `<div class="card-actions"><button type="button" class="mini" data-act="go" data-section="dateidea">Open in Date Ideas</button></div>`
            : `<div class="card-actions"><button type="button" class="mini" data-act="tv-plan-date" data-id="${esc(c.id)}">Plan it</button>
               <button type="button" class="mini" data-act="tv-dismiss-match" data-id="${esc(c.id)}">Not now</button></div>`}
        </article>`;
      };
      set(shell('match', `${tabs}
        ${open.length ? `<h4 class="tv-h">To talk about</h4><div class="cards">${open.map(card).join('')}</div>` : empty('No new matches yet. Keep voting: a match appears when you both choose Love it, or a possible match with a Maybe.')}
        ${planned.length ? `<h4 class="tv-h">Planned</h4><div class="cards">${planned.map(card).join('')}</div>` : ''}
        <p class="muted small">Ideas where either of you said "Not for me" are quietly left out. There's no list of who voted what, though with two of you, a missing idea can say a little.</p>`));
      return;
    }
    if (tab === 'add') {
      set(shell('match', `${tabs}<section class="panel"><p>Add a date idea of your own. It goes into the deck for both of you to vote on.</p>
        <button type="button" class="btn primary" data-act="tv-add-idea">Write a date idea</button></section>`));
      return;
    }
    const f = filters();
    const waiting = votes.filter((v) => !result.has(v.card_id)).length;
    const deck = cards.filter((c) => !c.flagged_duplicate && !myVote.has(c.id) && !result.has(c.id) && !tv.matchSkip.has(c.id) && passesFilters(c, f));
    const nFilters = Object.values(f).filter(Boolean).length;
    const chipGroup = (key, label, opts) => `<div class="tv-filter"><span class="tv-filter-label">${esc(label)}</span>
      ${opts.map(([v, l]) => `<button type="button" class="chip-toggle ${f[key] === v ? 'active' : ''}" aria-pressed="${f[key] === v}" data-act="tv-filter" data-key="${key}" data-val="${esc(v)}">${esc(l)}</button>`).join('')}</div>`;
    const c = deck[0];
    set(shell('match', `${tabs}
      <details class="tv-filters" ${nFilters ? 'open' : ''}><summary>Filters${nFilters ? ` (${nFilters})` : ''}</summary>
        ${chipGroup('setting', 'Who', [['together', 'Together'], ['remote', 'On a call']])}
        ${chipGroup('place', 'Where', [['home', 'At home'], ['out', 'Going out']])}
        ${chipGroup('budget', 'Budget', BUDGETS.map((b) => [b[0], b[1]]))}
        ${chipGroup('duration', 'Time', DURATIONS.map((d) => [d[0], d[1]]))}
        ${chipGroup('mood', 'Mood', MOODS.map((m) => [m, OU.cap(m)]))}
        ${chipGroup('prep', 'Preparation', Object.entries(PREP))}
        ${nFilters ? '<button type="button" class="btn link small" data-act="tv-filter-clear">Clear filters</button>' : ''}
      </details>
      ${waiting ? `<p class="muted small" role="status">${OU.plural(waiting, 'idea')} you've voted on ${waiting === 1 ? 'is' : 'are'} waiting for ${esc(names().other)}. Your votes stay private.</p>` : ''}
      ${c ? `<article class="tv-date-card" id="tvDateCard" data-id="${esc(c.id)}">
          <p class="muted small">${OU.plural(deck.length, 'idea')} to go</p>
          <h3 dir="auto">${esc(c.title)}</h3>
          <p class="tv-date-desc" dir="auto">${esc(c.description)}</p>
          <div class="row-meta">${cardChips(c)}</div>
          ${c.materials ? `<p class="small"><b>You'll need:</b> <span dir="auto">${esc(c.materials)}</span></p>` : ''}
          <div class="tv-vote" role="group" aria-label="Your vote">
            <button type="button" class="btn tv-vote-no" data-act="tv-vote" data-vote="no" data-id="${esc(c.id)}">Not for me</button>
            <button type="button" class="btn tv-vote-maybe" data-act="tv-vote" data-vote="maybe" data-id="${esc(c.id)}">Maybe</button>
            <button type="button" class="btn primary tv-vote-love" data-act="tv-vote" data-vote="love" data-id="${esc(c.id)}">♥ Love it</button>
          </div>
          <p class="hint">Tip: you can also swipe the card right for Love it or left for Not for me.</p>
          <div class="tv-row small-row">
            <button type="button" class="btn link small" data-act="tv-skip-idea" data-id="${esc(c.id)}">Skip for now</button>
            <button type="button" class="btn link small" data-act="tv-save-idea" data-id="${esc(c.id)}">Save to Date Ideas</button>
            <button type="button" class="btn link small" data-act="tv-dup-idea" data-id="${esc(c.id)}">Report duplicate</button>
            ${tv.lastVote ? '<button type="button" class="btn link small" data-act="tv-undo-vote">Undo last vote</button>' : ''}
          </div>
        </article>`
      : empty(nFilters ? 'No ideas match these filters. Try clearing one.' : 'You have reviewed all current ideas.',
        `${tv.matchSkip.size ? '<button type="button" class="btn ghost" data-act="tv-unskip">Show skipped ideas</button>' : ''}${tv.lastVote ? '<button type="button" class="btn link" data-act="tv-undo-vote">Undo last vote</button>' : ''}<button type="button" class="btn primary" data-act="tv-add-idea">Add an idea</button>`)}`));
    bindSwipe();
  }
  function bindSwipe() {
    const card = $('tvDateCard');
    if (!card) return;
    let x0 = null;
    card.addEventListener('pointerdown', (e) => { if (e.target.closest('button')) return; x0 = e.clientX; });
    card.addEventListener('pointerup', (e) => {
      if (x0 == null) return;
      const dx = e.clientX - x0;
      x0 = null;
      if (Math.abs(dx) > 90) vote(card.dataset.id, dx > 0 ? 'love' : 'no').catch(OU.fail);
    });
  }
  async function vote(cardId, v) {
    document.querySelectorAll('.tv-vote .btn').forEach((b) => { b.disabled = true; });
    let outcome;
    try {
      outcome = await rpc('Saving your vote', 'date_vote', { p_card: cardId, p_vote: v });
    } catch (err) {
      document.querySelectorAll('.tv-vote .btn').forEach((b) => { b.disabled = false; });
      if (hint(err) === 'decided' || hint(err) === 'gone') { toast(plain(err)); OU.render(); return; }
      toast('Your vote was not saved. Please try again.', 'error');
      return;
    }
    tv.lastVote = outcome === 'waiting' ? cardId : null;
    const c = tv.match && tv.match.byId.get(cardId);
    if (outcome === 'match') celebrate(`It's a match: ${c ? c.title : 'a date you both love'}`);
    else if (outcome === 'possible') toast('A possible match. Look at it together under Matches.');
    OU.render();
  }
  function ideaForm(card) {
    const c = card || {};
    formDialog({
      title: card ? 'Edit date idea' : 'Add a date idea',
      submit: 'Save idea',
      body: `${field('Title', input('title', c.title, 'maxlength="60" required dir="auto"'))}
        ${field('What you would do', area('description', c.description, 'rows="4" maxlength="600" required dir="auto"'), 'Be concrete: where, what, and one detail that makes it yours.')}
        <div class="form-grid">
          ${field('Who', select('setting', Object.entries(SETTING), c.setting || 'together'))}
          ${field('Where', select('place', Object.entries(PLACE), c.place || 'either'))}
          ${field('Mood', select('mood', MOODS.map((m) => [m, OU.cap(m)]), c.mood || 'relaxing'))}
        </div>
        <div class="form-grid">
          ${field('Budget from (AED)', input('budget_min', c.budget_min || 0, 'type="number" min="0" inputmode="numeric"'))}
          ${field('Budget up to (AED)', input('budget_max', c.budget_max || 0, 'type="number" min="0" inputmode="numeric"'))}
          ${field('Minutes', input('minutes', c.minutes || 90, 'type="number" min="10" max="1440" inputmode="numeric"'))}
        </div>
        <div class="form-grid">
          ${field('Preparation', select('prep', Object.entries(PREP), c.prep || 'none'))}
          ${field('City (optional)', input('city', c.city, 'maxlength="60" dir="auto"'))}
        </div>
        ${field('You will need (optional)', input('materials', c.materials, 'maxlength="300" dir="auto"'))}`,
      onSubmit: async (fd) => {
        const row = {
          title: str(fd, 'title'), description: str(fd, 'description'), setting: str(fd, 'setting'), place: str(fd, 'place'),
          mood: str(fd, 'mood'), prep: str(fd, 'prep'), budget_min: num(fd, 'budget_min') || 0, budget_max: num(fd, 'budget_max') || 0,
          minutes: num(fd, 'minutes') || 90, city: str(fd, 'city') || null, materials: str(fd, 'materials') || null,
        };
        if (row.title.length < 3) throw new Error('Give the idea a short title.');
        if (row.description.length < 10) throw new Error('Describe the idea in a sentence or two.');
        if (row.budget_max < row.budget_min) row.budget_max = row.budget_min;
        await q('Saving the idea', db().from('date_cards').insert(Object.assign(row, { source: 'custom', created_by: me() })));
        toast('Idea added. It is now in the deck for both of you.');
        go('match');
      },
    });
  }
  async function planDate(cardId) {
    const c = tv.match.byId.get(cardId);
    const entry = await OU.insertEntry({
      type: 'dateidea', parent_id: null, title: c.title, status: 'Planned', completed: false, category: 'Match a Date',
      budget: c.budget_max || null, details: c.description + (c.materials ? `\n\nYou'll need: ${c.materials}` : ''),
    });
    await q('Linking the plan', db().from('date_results').update({ entry_id: entry.id }).eq('card_id', cardId));
    toast('Added to Date Ideas as Planned');
    OU.render();
  }

  /* ------------------------------------------------------------------ */
  /* 6. Our Monthly Quest                                                */
  /* ------------------------------------------------------------------ */

  const THEMES = ['', 'Creative Month', 'At-Home Moments', 'Food and Discovery', 'Our Memories', 'Wedding Planning With Fun', 'Small Surprises', 'Try Something New', 'Long-Distance Connection'];
  const monthStart = (d) => OU.isoDay(new Date(d.getFullYear(), d.getMonth(), 1));
  const monthName = (iso) => OU.localDate(iso).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const LINES = [[0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11], [12, 13, 14, 15], [0, 4, 8, 12], [1, 5, 9, 13], [2, 6, 10, 14], [3, 7, 11, 15], [0, 5, 10, 15], [3, 6, 9, 12]];
  const linesDone = (cells) => { const done = new Set(cells.filter((c) => c.completed_at).map((c) => c.position)); return LINES.filter((l) => l.every((p) => done.has(p))).length; };

  async function library() {
    if (tv.library) return tv.library;
    const res = await fetch('./content/quest_library.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('The quest library could not be loaded.');
    tv.library = (await res.json()).quests;
    return tv.library;
  }
  // 16 varied quests: at most two per category, nothing used on the last two
  // boards, rollovers first.
  function pickQuests(lib, avoid, carry) {
    const out = carry.slice(0, 16).map((c) => ({ title: c.title, instructions: c.instructions, setting: c.setting, minutes: c.minutes, budget_aed: c.budget_aed, category: c.category, source: 'rollover', library_id: c.library_id }));
    const taken = new Set(out.map((c) => c.title.toLowerCase()));
    const perCat = {};
    out.forEach((c) => { perCat[c.category] = (perCat[c.category] || 0) + 1; });
    const shuffled = lib.slice().sort(() => Math.random() - 0.5);
    for (const pass of [2, 3, 16]) {
      for (const qd of shuffled) {
        if (out.length >= 16) break;
        if (taken.has(qd.title.toLowerCase())) continue;
        if (pass === 2 && avoid.has(qd.id)) continue;
        if ((perCat[qd.category] || 0) >= pass) continue;
        out.push({ title: qd.title, instructions: qd.instructions, setting: qd.setting, minutes: qd.minutes, budget_aed: qd.budget_aed, category: qd.category, source: 'library', library_id: qd.id });
        taken.add(qd.title.toLowerCase());
        perCat[qd.category] = (perCat[qd.category] || 0) + 1;
      }
    }
    return out.slice(0, 16);
  }

  async function viewQuest(boardId) {
    set(shell('quest', loading('Preparing this month\'s quests…')));
    const thisMonth = monthStart(new Date());
    let boards;
    let cells = [];
    let board;
    try {
      boards = await rows('Loading boards', db().from('quest_boards').select('*').order('month', { ascending: false }).limit(12));
      board = boardId ? boards.find((b) => b.id === boardId) : boards.find((b) => b.month === thisMonth);
      if (board) cells = await rows('Loading quests', db().from('quest_cells').select('*').eq('board_id', board.id).order('position'));
    } catch (err) {
      if (current()) set(shell('quest', errorBox('The board could not be loaded. Existing progress has not been changed.')));
      return;
    }
    if (!current()) return;
    tv.quest = { board, cells, boards };
    const past = boards.filter((b) => b.month < thisMonth);
    const archive = past.length ? `<section class="panel"><div class="panel-head"><h3>Earlier boards</h3></div><ul class="tv-list">${past.slice(0, 6).map((b) => `<li><button type="button" data-act="tv-go" data-to="quest/${esc(b.id)}"><span class="t">${esc(monthName(b.month))}${b.theme ? ' · ' + esc(b.theme) : ''}</span><span class="s">Open</span></button></li>`).join('')}</ul></section>` : '';
    if (!board) {
      const prev = past[0];
      let carry = 0;
      if (prev) {
        try {
          const pc = await rows('Checking last month', db().from('quest_cells').select('id').eq('board_id', prev.id).is('completed_at', null));
          carry = pc.length;
        } catch (_) { carry = 0; }
      }
      set(shell('quest', `<section class="panel">
          <p class="tv-lead">No quest board exists for ${esc(monthName(thisMonth))}.</p>
          <p class="muted small">A board has 16 small, achievable things to do together or apart. You can swap any of them before you start.</p>
          <label>Theme (optional)<select id="tvQuestTheme">${THEMES.map((t) => `<option value="${esc(t)}">${esc(t || 'No theme')}</option>`).join('')}</select></label>
          ${carry ? `<label class="check-row"><input type="checkbox" id="tvQuestCarry"> Bring the ${OU.plural(carry, 'unfinished quest')} from ${esc(monthName(prev.month))}</label>` : ''}
          <button type="button" class="btn primary" data-act="tv-quest-create" data-prev="${esc(prev ? prev.id : '')}">Create this month's board</button>
        </section>${archive}`));
      return;
    }
    const ended = board.month < thisMonth;
    const done = cells.filter((c) => c.completed_at).length;
    const lines = linesDone(cells);
    const head = `<section class="tv-quest-head">
        <div><p class="eyebrow">${esc(monthName(board.month).toUpperCase())}</p><h3>${esc(board.theme || 'This month\'s quests')}</h3></div>
        <div class="tv-quest-stats">
          <span><b>${done}</b> of ${cells.length} done</span><span><b>${lines}</b> ${lines === 1 ? 'line' : 'lines'}</span>
          ${ended ? '<span>Board ended</span>' : board.status === 'active' ? `<span><b>${daysLeftInMonth()}</b> days left</span>` : '<span>Not started</span>'}
        </div>
        <div class="progress progress-lg" role="progressbar" aria-label="Board progress" aria-valuemin="0" aria-valuemax="16" aria-valuenow="${done}"><i style="width:${Math.round((done / 16) * 100)}%"></i></div>
      </section>`;
    const draft = board.status === 'draft' && !ended;
    const grid = `<div class="tv-quest-grid ${draft ? 'draft' : ''}" role="list">${Array.from({ length: 16 }, (_, i) => {
      const c = cells.find((x) => x.position === i);
      if (!c) return `<div class="tv-quest-cell empty" role="listitem"><button type="button" data-act="tv-quest-edit" data-pos="${i}">＋ Add a quest</button></div>`;
      return `<div class="tv-quest-cell ${c.completed_at ? 'done' : ''}" role="listitem">
        <button type="button" data-act="tv-quest-cell" data-id="${esc(c.id)}" aria-label="${esc(c.title)}${c.completed_at ? ', done' : ''}">
          <span class="tv-q-title" dir="auto">${esc(c.title)}</span>
          <span class="tv-q-meta">${c.completed_at ? '✓ Done' : esc(SETTING[c.setting] || '')}</span>
        </button></div>`;
    }).join('')}</div>`;
    set(shell('quest', `${head}
      ${draft ? `<p class="muted small" role="status">This board hasn't started yet. Tap a quest to swap or edit it, then start the board.</p>` : ''}
      ${grid}
      ${draft ? `<div class="tv-row"><button type="button" class="btn primary" data-act="tv-quest-start" data-id="${esc(board.id)}">Start the board</button>
        <button type="button" class="btn ghost" data-act="tv-quest-discard" data-id="${esc(board.id)}">Start over</button></div>` : ''}
      ${ended && cells.length - done ? `<p class="muted small">${OU.plural(cells.length - done, 'quest')} weren't finished. You can bring them into a new month's board.</p>` : ''}
      ${archive}`));
  }

  async function createBoard(prevId) {
    const theme = ($('tvQuestTheme') && $('tvQuestTheme').value) || null;
    const carry = $('tvQuestCarry') && $('tvQuestCarry').checked;
    const lib = await library();
    const recent = tv.quest.boards.slice(0, 2).map((b) => b.id);
    const used = recent.length ? await rows('Checking recent quests', db().from('quest_cells').select('library_id').in('board_id', recent)) : [];
    const carried = carry && prevId ? await rows('Loading unfinished quests', db().from('quest_cells').select('*').eq('board_id', prevId).is('completed_at', null)) : [];
    const picks = pickQuests(lib, new Set(used.map((u) => u.library_id).filter(Boolean)), carried);
    let board;
    try {
      const { data } = await q('Creating the board', db().from('quest_boards').insert({ month: monthStart(new Date()), theme, status: 'draft', created_by: me() }).select('*'));
      board = data[0];
    } catch (err) {
      if (/duplicate|unique/i.test(err.raw || '')) { toast('A board for this month was just created on the other phone.'); OU.render(); return; }
      throw err;
    }
    await q('Adding quests', db().from('quest_cells').insert(picks.map((p, i) => Object.assign({ board_id: board.id, position: i }, p))));
    toast('Board created. Swap anything you like, then start it.');
    OU.render();
  }

  function questCellSheet(cell) {
    const b = tv.quest.board;
    const ended = b.month < monthStart(new Date());
    const meta = [SETTING[cell.setting], cell.minutes ? durText(cell.minutes) : '', cell.budget_aed ? `About ${aed(cell.budget_aed)}` : 'No cost', cell.category].filter(Boolean);
    if (b.status === 'draft' && !ended) {
      formDialog({
        title: 'Swap or edit this quest',
        submit: 'Save quest',
        body: `<p class="tv-q-sheet-title" dir="auto">${esc(cell.title)}</p>
          <button type="button" class="btn ghost block" data-act="tv-quest-swap" data-id="${esc(cell.id)}">Swap for a different quest</button>
          <hr class="tv-hr">
          ${field('Title', input('title', cell.title, 'maxlength="120" required dir="auto"'))}
          ${field('Short instructions', area('instructions', cell.instructions, 'rows="2" maxlength="300" dir="auto"'))}
          <div class="form-grid">${field('Who', select('setting', Object.entries(SETTING), cell.setting))}
          ${field('About how much (AED)', input('budget_aed', cell.budget_aed || 0, 'type="number" min="0" max="2000"'))}</div>`,
        onSubmit: async (fd) => {
          const title = str(fd, 'title');
          if (title.length < 3) throw new Error('Give the quest a title.');
          await q('Saving the quest', db().from('quest_cells').update({ title, instructions: str(fd, 'instructions') || null, setting: str(fd, 'setting'), budget_aed: num(fd, 'budget_aed'), source: 'custom' }).eq('id', cell.id));
          OU.render();
        },
      });
      return;
    }
    if (cell.completed_at) {
      formDialog({
        title: 'Quest done',
        body: `<p class="tv-q-sheet-title" dir="auto">${esc(cell.title)}</p>
          <p class="muted small">Completed by ${esc(nameOf(cell.completed_by))} on ${esc(shortDate(cell.completed_at))}.</p>
          ${cell.note ? `<p dir="auto">${esc(cell.note)}</p>` : ''}
          <div id="tvQuestPhoto"></div>
          <div id="tvQuestReact"></div>
          ${ended ? '' : `<button type="button" class="btn link small" data-act="tv-quest-undo" data-id="${esc(cell.id)}">Mark as not done</button>`}`,
        onOpen: async () => {
          if (cell.photo_path) {
            const [u] = await OU.signedUrls(OU.PHOTO_BUCKET, [cell.photo_path]);
            if (u && $('tvQuestPhoto')) $('tvQuestPhoto').innerHTML = `<div class="photo"><img src="${esc(u)}" alt="Photo for ${esc(cell.title)}"></div>`;
          }
          const rs = await loadReactions('quest', [cell.id]);
          if ($('tvQuestReact')) $('tvQuestReact').innerHTML = reactionBar('quest', cell.id, rs);
        },
      });
      return;
    }
    formDialog({
      title: 'Complete this quest',
      submit: 'Mark as done',
      body: `<p class="tv-q-sheet-title" dir="auto">${esc(cell.title)}</p>
        ${cell.instructions ? `<p dir="auto">${esc(cell.instructions)}</p>` : ''}
        <div class="row-meta">${meta.map((m) => `<span class="chip">${esc(m)}</span>`).join('')}</div>
        ${ended || b.status !== 'active' ? '<p class="muted">This board has ended, so quests can no longer be completed.</p>' : `
        ${field('A note (optional)', area('note', '', 'rows="2" maxlength="500" dir="auto"'))}
        ${fileFields(true, false)}
        <label class="check-row"><input type="checkbox" name="memory"> Also save this to Memories</label>
        <p class="hint">No proof needed. A photo is only if you'd like to keep one.</p>`}`,
      onSubmit: ended || b.status !== 'active' ? null : async (fd) => {
        const file = fileOf(fd, 'photo');
        const photo = file ? await OU.uploadFile(file, { prefix: `quest/${b.id}` }) : null;
        const res = await rpc('Saving', 'quest_complete', { p_cell: cell.id, p_note: str(fd, 'note') || null, p_photo: photo });
        if (fd.get('memory')) {
          await OU.insertEntry({ type: 'memory', parent_id: null, title: cell.title, category: 'Monthly Quest', details: str(fd, 'note') || null, target_date: OU.isoDay(new Date()), photo_path: photo, status: 'Idea', completed: false });
        }
        if (res && res.new_lines > 0) celebrate(res.new_lines > 1 ? `${res.new_lines} lines complete!` : 'A full line complete!');
        else toast(res && res.already ? 'That quest was already done.' : 'Quest done');
        OU.render();
      },
    });
  }
  async function swapQuest(cellId) {
    const lib = await library();
    const onBoard = new Set(tv.quest.cells.map((c) => c.title.toLowerCase()));
    const options = lib.filter((x) => !onBoard.has(x.title.toLowerCase()));
    if (!options.length) { toast('Every quest in the library is already on the board.'); return; }
    const pick = options[Math.floor(Math.random() * options.length)];
    await q('Swapping the quest', db().from('quest_cells').update({ title: pick.title, instructions: pick.instructions, setting: pick.setting, minutes: pick.minutes, budget_aed: pick.budget_aed, category: pick.category, source: 'library', library_id: pick.id }).eq('id', cellId));
    await OU.closeDialog('tvDialog');
    OU.render();
  }

  /* ------------------------------------------------------------------ */
  /* 7. Open When                                                        */
  /* ------------------------------------------------------------------ */

  const STARTERS = ['Open when you miss me', 'Open when you have had a difficult day', 'Open when you cannot sleep', 'Open when you need encouragement',
    'Open when we have disagreed', 'Open when you want to laugh', 'Open when you are excited about our future', 'Open on our anniversary',
    'Open before our wedding', 'Open after we move into our home', 'Open whenever you choose'];
  const CONDITION = { anytime: 'Whenever you choose', mood: 'When you feel it is the right moment', date: 'On a date', manual: 'When I release it', plan: 'When a plan item is done' };

  function letterCanOpen(l) {
    if (l.status !== 'sealed') return false;
    if (l.condition === 'anytime' || l.condition === 'mood') return true;
    if (l.condition === 'date') return new Date(l.open_at) <= new Date();
    if (l.condition === 'manual') return !!l.released_at;
    if (l.condition === 'plan') { const e = OU.state.byId.get(String(l.plan_entry_id)); return !!e && OU.isDone(e); }
    return false;
  }
  function lockText(l) {
    if (l.condition === 'date') return `Opens ${countdown(l.open_at)} (${when(l.open_at)})`;
    if (l.condition === 'manual') return `Opens when ${nameOf(l.sender_id)} releases it`;
    if (l.condition === 'plan') { const e = OU.state.byId.get(String(l.plan_entry_id)); return `Opens when "${e ? e.title : 'a plan item'}" is done`; }
    return '';
  }

  async function viewLetters(id) {
    if (id) return letterView(id);
    set(shell('letters', loading('Loading your letters…')));
    let letters;
    try {
      letters = await rows('Loading your letters', db().from('open_when_letters').select('*').order('created_at', { ascending: false }));
    } catch (err) {
      if (current()) set(shell('letters', errorBox(err.message)));
      return;
    }
    if (!current()) return;
    tv.letters = new Map(letters.map((l) => [l.id, l]));
    const toMe = letters.filter((l) => l.recipient_id === me());
    const mine = letters.filter((l) => l.sender_id === me());
    const available = toMe.filter(letterCanOpen);
    const locked = toMe.filter((l) => l.status === 'sealed' && !letterCanOpen(l));
    const opened = toMe.filter((l) => l.status === 'opened');
    const drafts = mine.filter((l) => l.status === 'draft');
    const sent = mine.filter((l) => l.status !== 'draft');
    const earlier = OU.state.entries.filter((e) => e.type === 'letter').length;
    const env = (l, kind) => `<article class="tv-envelope ${kind}">
        <div class="tv-env-flap" aria-hidden="true"></div>
        <p class="tv-env-from">${kind === 'sent' || kind === 'draft' ? `To ${esc(nameOf(l.recipient_id))}` : `From ${esc(nameOf(l.sender_id))}`}</p>
        <h3 dir="auto">${esc(l.cover_title)}</h3>
        ${l.cover_note ? `<p class="tv-env-note" dir="auto">${esc(l.cover_note)}</p>` : ''}
        <p class="tv-env-cond">${esc(kind === 'locked' ? lockText(l) : kind === 'sent' ? (l.status === 'opened' ? `Opened ${shortDate(l.opened_at)}` : l.status === 'withdrawn' ? 'Withdrawn' : `Sealed · ${CONDITION[l.condition]}${l.condition === 'date' ? ': ' + when(l.open_at) : ''}`) : kind === 'opened' ? `Opened ${shortDate(l.opened_at)}` : kind === 'draft' ? 'Draft: only you can see this' : CONDITION[l.condition])}</p>
        <div class="tv-row">${{
          available: `<button type="button" class="btn primary" data-act="tv-ow-open" data-id="${esc(l.id)}">Open the letter</button>`,
          opened: `<button type="button" class="btn ghost" data-act="tv-go" data-to="letters/${esc(l.id)}">Read again</button>`,
          draft: `<button type="button" class="btn primary" data-act="tv-ow-seal" data-id="${esc(l.id)}">Seal and send</button><button type="button" class="btn ghost" data-act="tv-ow-edit" data-id="${esc(l.id)}">Edit</button><button type="button" class="btn link small danger-link" data-act="tv-ow-delete" data-id="${esc(l.id)}">Delete</button>`,
          sent: `<button type="button" class="btn ghost" data-act="tv-go" data-to="letters/${esc(l.id)}">Preview</button>${l.status === 'sealed' && l.condition === 'manual' && !l.released_at ? `<button type="button" class="btn primary" data-act="tv-ow-release" data-id="${esc(l.id)}">Release it now</button>` : ''}${l.status === 'sealed' ? `<button type="button" class="btn link small danger-link" data-act="tv-ow-withdraw" data-id="${esc(l.id)}">Withdraw</button>` : ''}${l.status === 'withdrawn' ? `<button type="button" class="btn link small danger-link" data-act="tv-ow-delete" data-id="${esc(l.id)}">Delete</button>` : ''}`,
          locked: '',
        }[kind]}</div>
      </article>`;
    const group = (title, list, kind, emptyText) => `<section class="tv-group"><h4 class="tv-h">${esc(title)} <span class="muted">${list.length}</span></h4>
      ${list.length ? `<div class="tv-envelopes">${list.map((l) => env(l, kind)).join('')}</div>` : `<p class="muted small">${esc(emptyText)}</p>`}</section>`;
    set(shell('letters', `<div class="tv-row"><button type="button" class="btn primary" data-act="tv-ow-new">Write a letter</button></div>
      ${!letters.length ? empty('No letters are waiting yet. Write one for a moment you want to be there for.') : ''}
      ${group('Available now', available, 'available', 'Nothing to open right now.')}
      ${group('Locked', locked, 'locked', 'No locked letters.')}
      ${opened.length ? group('Opened', opened, 'opened', '') : ''}
      ${drafts.length ? group('Drafts written by me', drafts, 'draft', '') : ''}
      ${sent.length ? group('Sent by me', sent, 'sent', '') : ''}
      ${earlier ? `<section class="panel"><div class="panel-head"><h3>Earlier letters</h3></div><p class="muted small">${OU.plural(earlier, 'letter')} from before Open When. They are kept exactly as they were.</p><button type="button" class="btn ghost" data-act="go" data-section="letter">Open earlier letters</button></section>` : ''}
      <p class="muted small">Open When is for moments you choose. It isn't a substitute for talking, or for professional support if things feel heavy.</p>`));
  }

  async function letterForm(existing) {
    let body = { title: '', body: '', song: '', photo_path: null, audio_path: null };
    if (existing) {
      const b = await rows('Loading the letter', db().from('open_when_bodies').select('*').eq('letter_id', existing.id));
      if (b[0]) body = b[0];
    }
    const l = existing || { cover_title: '', cover_note: '', condition: 'anytime' };
    const plans = OU.state.entries.filter((e) => e.type === 'plan' && !OU.isDone(e));
    const condFields = (c) => `
      <div class="field" data-cond="mood" ${c === 'mood' ? '' : 'hidden'}><label>Which feeling or moment (shown on the envelope)${input('mood', l.mood, 'maxlength="60" dir="auto"')}</label></div>
      <div class="field" data-cond="date" ${c === 'date' ? '' : 'hidden'}><label>Opens on${input('open_at', l.open_at ? localInput(new Date(l.open_at)) : '', 'type="datetime-local"')}</label><p class="hint">Shown in each person's own time zone.</p></div>
      <div class="field" data-cond="plan" ${c === 'plan' ? '' : 'hidden'}><label>Plan item${select('plan_entry_id', [['', 'Choose a plan item']].concat(plans.map((p) => [p.id, p.title])), l.plan_entry_id || '')}</label></div>`;
    formDialog({
      title: existing ? 'Edit letter' : `Write a letter to ${names().other}`,
      submit: 'Save draft',
      body: `${field('On the envelope', input('cover_title', l.cover_title, 'maxlength="120" required dir="auto"'), `${names().other} will see this before opening.`)}
        <div class="tv-starters">${STARTERS.map((s) => `<button type="button" class="chip chip-btn" data-fill="${esc(s)}" data-target="cover_title">${esc(s)}</button>`).join('')}</div>
        ${field('Short cover note (optional)', input('cover_note', l.cover_note, 'maxlength="200" dir="auto"'))}
        ${field('When can it be opened?', select('condition', Object.entries(CONDITION), l.condition))}
        <div id="tvCondFields">${condFields(l.condition)}</div>
        <hr class="tv-hr">
        <p class="hint">Everything below stays sealed until ${esc(names().other)} opens it. You can edit it until you seal it.</p>
        ${field('Letter title (optional)', input('title', body.title, 'maxlength="120" dir="auto"'))}
        ${field('Your letter', area('body', body.body, 'rows="9" maxlength="10000" dir="auto"'))}
        ${field('A song (optional)', input('song', body.song, 'maxlength="200" dir="auto" placeholder=""'), 'A song title or link.')}
        ${body.photo_path ? '<p class="hint">A photo is attached. Choose a new one to replace it.</p>' : ''}
        ${body.audio_path ? '<p class="hint">A voice note is attached. Choose a new one to replace it.</p>' : ''}
        ${fileFields(true, true)}`,
      onChange: (el, form) => {
        if (el.name !== 'condition') return;
        form.querySelectorAll('[data-cond]').forEach((d) => { d.hidden = d.dataset.cond !== el.value; });
      },
      onSubmit: async (fd) => {
        const cond = str(fd, 'condition');
        const row = { cover_title: str(fd, 'cover_title'), cover_note: str(fd, 'cover_note') || null, condition: cond,
          mood: cond === 'mood' ? str(fd, 'mood') || null : null, open_at: null, plan_entry_id: null };
        if (row.cover_title.length < 2) throw new Error('Write what goes on the envelope.');
        if (cond === 'date') {
          const v = str(fd, 'open_at');
          if (!v) throw new Error('Choose the date and time it opens.');
          const d = OU.localDateTime(v);
          if (d <= new Date()) throw new Error('Choose a time in the future.');
          row.open_at = d.toISOString();
        }
        if (cond === 'plan') {
          row.plan_entry_id = str(fd, 'plan_entry_id') || null;
          if (!row.plan_entry_id) throw new Error('Choose the plan item.');
        }
        let id = existing && existing.id;   // set after the first insert, so a retry updates
        if (id) await q('Saving the letter', db().from('open_when_letters').update(row).eq('id', id));
        else {
          const { data } = await q('Saving the letter', db().from('open_when_letters').insert(Object.assign(row, { sender_id: me(), recipient_id: otherId(), status: 'draft' })).select('id'));
          id = data[0].id;
          existing = { id };
        }
        const b = { letter_id: id, title: str(fd, 'title') || null, body: str(fd, 'body'), song: str(fd, 'song') || null };
        const photo = fileOf(fd, 'photo');
        const audio = fileOf(fd, 'audio');
        if (photo) b.photo_path = await OU.uploadFile(photo, { bucket: SEALED, prefix: `ow/${id}` });
        if (audio) b.audio_path = await OU.uploadFile(audio, { bucket: SEALED, prefix: `ow/${id}`, kind: 'audio' });
        await q('Saving the letter', db().from('open_when_bodies').upsert(b, { onConflict: 'letter_id' }));
        if (photo && body.photo_path) OU.removeFile(SEALED, body.photo_path);
        if (audio && body.audio_path) OU.removeFile(SEALED, body.audio_path);
        toast('Draft saved. Only you can see it.');
        OU.render();
      },
    });
  }
  const otherId = () => [...OU.state.members.keys()].find((k) => k !== me());

  async function letterView(id) {
    set(shell('letters', loading('Opening the letter…'), 'Letter'));
    let l;
    let b;
    let media = {};
    try {
      l = (await rows('Loading the letter', db().from('open_when_letters').select('*').eq('id', id)))[0];
      b = l ? (await rows('Loading the letter', db().from('open_when_bodies').select('*').eq('letter_id', id)))[0] : null;
      if (b) media = await mediaTags(SEALED, [b]);
    } catch (err) {
      if (current()) set(shell('letters', errorBox('The letter could not be opened. It remains locked.'), 'Letter'));
      return;
    }
    if (!current()) return;
    if (!l) { set(shell('letters', empty('This letter is no longer here.', '<button type="button" class="btn primary" data-act="tv-go" data-to="letters">Back to letters</button>'), 'Letter')); return; }
    if (!b) { set(shell('letters', empty('This letter is still sealed.', '<button type="button" class="btn primary" data-act="tv-go" data-to="letters">Back to letters</button>'), 'Letter')); return; }
    const anim = tv.justOpened === id && !reduced();
    tv.justOpened = null;
    const preview = l.sender_id === me() && l.status !== 'opened';
    set(shell('letters', `<article class="tv-letter ${anim ? 'tv-open-anim' : ''}">
        ${preview ? `<p class="tv-preview-note">Preview: ${esc(names().other)} ${l.status === 'draft' ? "can't see this draft yet" : "hasn't opened this yet"}.</p>` : ''}
        <p class="eyebrow">${esc(l.cover_title.toUpperCase())}</p>
        ${b.title ? `<h3 dir="auto">${esc(b.title)}</h3>` : ''}
        <p class="tv-letter-body" dir="auto">${esc(b.body)}</p>
        ${photoTag(media, b.photo_path, 'Photo in the letter')}
        ${audioTag(media, b.audio_path)}
        ${b.song ? `<p class="small"><b>Song:</b> ${/^https?:\/\//i.test(b.song) ? `<a href="${esc(b.song)}" target="_blank" rel="noopener noreferrer">${esc(b.song)}</a>` : `<span dir="auto">${esc(b.song)}</span>`}</p>` : ''}
        <p class="tv-letter-sign">From ${esc(nameOf(l.sender_id))}${l.opened_at ? ` · opened ${esc(shortDate(l.opened_at))}` : ''}</p>
        ${l.status === 'opened' ? reactionBar('letter', id, await loadReactions('letter', [id]).catch(() => [])) : ''}
      </article>
      <div class="tv-row"><button type="button" class="btn ghost" data-act="tv-go" data-to="letters">Back to letters</button></div>`, 'Letter'));
  }

  /* ------------------------------------------------------------------ */
  /* 8. Our Creative Studio                                              */
  /* ------------------------------------------------------------------ */

  const KINDS = { artwork: 'Artwork', moodboard: 'Mood board', playlist: 'Playlist', photo: 'Photo challenge', story: 'Story', recipe: 'Recipe', home: 'Home design', wedding: 'Wedding planning', travel: 'Travel board', custom: 'Custom project' };
  const VISUAL = new Set(['artwork', 'moodboard', 'photo', 'home', 'wedding', 'travel']);
  const STATUSES = [['idea', 'Idea'], ['preparing', 'Preparing'], ['active', 'In progress'], ['paused', 'Paused'], ['completed', 'Completed'], ['archived', 'Archived']];
  const TYPE_FIELDS = {
    artwork: [['canvas', 'Artwork or canvas'], ['size', 'Size'], ['style', 'Style'], ['materials', 'Colouring materials'], ['where_to_buy', 'Where to buy'], ['display', 'How we want to display it']],
    moodboard: [['topic', 'What the board is about']],
    playlist: [['app', 'Where the playlist lives'], ['theme', 'Theme or occasion']],
    photo: [['theme', 'Theme'], ['rules', 'Rules']],
    story: [['genre', 'Genre'], ['rule', 'How you take turns']],
    recipe: [['cuisine', 'Cuisine'], ['serves', 'Serves']],
    home: [['room', 'Room'], ['style', 'Style']],
    wedding: [['area', 'Part of the wedding']],
    travel: [['destination', 'Destination'], ['when', 'When']],
    custom: [],
  };
  const hex = (c) => (/^#[0-9a-f]{6}$/i.test(String(c || '')) ? c : '#cccccc');
  const statusLabel = (s) => (STATUSES.find((x) => x[0] === s) || [s, s])[1];

  async function viewStudio(id) {
    if (id) return studioProject(id);
    set(shell('studio', loading('Loading your shared projects…')));
    let projects;
    try {
      projects = await rows('Loading projects', db().from('studio_projects').select('*').order('updated_at', { ascending: false }).limit(100));
    } catch (err) {
      if (current()) set(shell('studio', errorBox(err.message)));
      return;
    }
    if (!current()) return;
    const active = projects.filter((p) => !['completed', 'archived'].includes(p.status));
    const gallery = projects.filter((p) => p.status === 'completed' && p.in_gallery);
    const card = (p) => `<button type="button" class="tv-project" data-act="tv-go" data-to="studio/${esc(p.id)}">
        <span class="tv-project-kind">${esc(KINDS[p.kind])}</span>
        <b dir="auto">${esc(p.title)}</b>
        <span class="s">${esc(statusLabel(p.status))}${p.progress != null && p.status !== 'completed' ? ` · ${p.progress}%` : ''}${p.target_date ? ` · by ${esc(OU.fmtDay(OU.localDate(p.target_date)))}` : ''}</span>
        ${(p.palette || []).length ? `<span class="tv-swatches" aria-hidden="true">${p.palette.slice(0, 6).map((c) => `<i style="background:${hex(c.hex)}"></i>`).join('')}</span>` : ''}
      </button>`;
    set(shell('studio', `<div class="tv-row">
        <button type="button" class="btn primary" data-act="tv-studio-new">New project</button>
        ${projects.some((p) => p.title === 'Our First Colouring Project') ? '' : '<button type="button" class="btn ghost" data-act="tv-studio-template">Start "Our First Colouring Project"</button>'}
      </div>
      ${!projects.length ? empty('Start your first creative project together.') : ''}
      ${active.length ? `<h4 class="tv-h">In progress</h4><div class="tv-projects">${active.map(card).join('')}</div>` : ''}
      ${gallery.length ? `<h4 class="tv-h">Studio Gallery</h4><div class="tv-projects gallery">${gallery.map(card).join('')}</div>` : ''}`));
  }

  function projectForm(p) {
    const v = p || { kind: 'artwork', status: 'idea', details: {} };
    const typeFields = (kind, details) => (TYPE_FIELDS[kind] || []).map(([k, l]) => field(l, input('d_' + k, (details || {})[k], 'maxlength="200" dir="auto"'))).join('');
    formDialog({
      title: p ? 'Edit project' : 'New project',
      submit: p ? 'Save' : 'Create project',
      body: `${field('Title', input('title', v.title, 'maxlength="120" required dir="auto"'))}
        <div class="form-grid">${field('Type', select('kind', Object.entries(KINDS), v.kind))}${field('Status', select('status', STATUSES, v.status))}
        ${field('Budget (AED, optional)', input('budget_aed', v.budget_aed, 'type="number" min="0" step="any"'))}</div>
        ${field('Short description', area('description', v.description, 'rows="3" maxlength="1000" dir="auto"'))}
        <div class="form-grid">${field('Start date', input('start_date', v.start_date, 'type="date"'))}${field('Target date (optional)', input('target_date', v.target_date, 'type="date"'))}</div>
        <div id="tvTypeFields">${typeFields(v.kind, v.details)}</div>`,
      onChange: (el, form) => { if (el.name === 'kind') form.querySelector('#tvTypeFields').innerHTML = typeFields(el.value, v.details); },
      onSubmit: async (fd) => {
        const kind = str(fd, 'kind');
        const details = {};
        (TYPE_FIELDS[kind] || []).forEach(([k]) => { const x = str(fd, 'd_' + k); if (x) details[k] = x; });
        const row = { title: str(fd, 'title'), kind, status: str(fd, 'status'), description: str(fd, 'description') || null,
          budget_aed: num(fd, 'budget_aed'), start_date: str(fd, 'start_date') || null, target_date: str(fd, 'target_date') || null, details };
        if (row.title.length < 2) throw new Error('Give the project a title.');
        if (p) {
          await updateProject(p, row);
          OU.render();
        } else {
          const { data } = await q('Creating the project', db().from('studio_projects').insert(Object.assign(row, { created_by: me() })).select('id'));
          go('studio/' + data[0].id);
        }
      },
    });
  }
  // Guarded update: if the other phone changed the project meanwhile, nothing
  // is overwritten and the latest version is loaded.
  async function updateProject(p, patch) {
    const { data } = await q('Saving the project', db().from('studio_projects').update(patch).eq('id', p.id).eq('updated_at', p.updated_at).select('*'));
    if (!data || !data.length) {
      toast('This project was changed on the other phone. Showing the latest version; please try again.', 'error');
      OU.render();
      throw new Error('This project was changed on the other phone. Close this and try again.');
    }
    Object.assign(p, data[0]);
    return data[0];
  }
  async function studioTemplate() {
    const { data } = await q('Creating the project', db().from('studio_projects').insert({
      title: 'Our First Colouring Project', kind: 'artwork', status: 'preparing', created_by: me(),
      description: 'A large colouring artwork we finish together, a section at a time.', details: {},
    }).select('id'));
    const id = data[0].id;
    await q('Adding steps', db().from('studio_items').insert([
      'Choose the artwork or canvas, and its size', 'Choose the colouring materials', 'Decide where to buy everything',
      'Pick the date of the first session', 'Take a progress photo after each session', 'Take the final photo', 'Decide how we want to display it',
    ].map((t, i) => ({ project_id: id, kind: 'task', text: t, sort_order: i, created_by: me() }))));
    go('studio/' + id);
  }

  async function studioProject(id) {
    set(shell('studio', loading('Loading the project…'), 'Project'));
    let p;
    let items;
    let media;
    try {
      p = (await rows('Loading the project', db().from('studio_projects').select('*').eq('id', id)))[0];
      items = p ? await rows('Loading the project', db().from('studio_items').select('*').eq('project_id', id).order('sort_order').order('created_at')) : [];
      media = await mediaTags(OU.PHOTO_BUCKET, items.concat(p && p.cover_path ? [{ photo_path: p.cover_path }] : []));
    } catch (err) {
      if (current()) set(shell('studio', errorBox(err.message), 'Project'));
      return;
    }
    if (!current()) return;
    if (!p) { set(shell('studio', empty('This project no longer exists.', '<button type="button" class="btn primary" data-act="tv-go" data-to="studio">Back to the studio</button>'), 'Project')); return; }
    tv.project = { p, items };
    const by = (k) => items.filter((i) => i.kind === k);
    const tasks = by('task');
    const mats = by('material');
    const doneTasks = tasks.filter((t) => t.done).length;
    const progress = tasks.length ? Math.round((doneTasks / tasks.length) * 100) : p.progress || 0;
    const est = mats.reduce((s, m) => s + Number(m.est_price || 0) * Number(m.qty || 1), 0);
    const act = mats.reduce((s, m) => s + Number(m.act_price || 0), 0);
    const n = names();
    const favs = p.favourites || {};
    const completed = p.status === 'completed';
    const section = (key, title, inner, open) => `<details class="tv-acc" ${open ? 'open' : ''}><summary>${esc(title)}</summary><div class="tv-acc-body">${inner}</div></details>`;
    const insp = by('inspiration');
    set(shell('studio', `<section class="tv-project-head">
        <span class="tv-project-kind">${esc(KINDS[p.kind])}</span>
        <h3 dir="auto">${esc(p.title)}</h3>
        <div class="row-meta">
          <label class="status-select"><span class="sr-only">Project status</span><select class="status" data-tv-change="studio-status">${STATUSES.map(([v, l]) => `<option value="${v}" ${p.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          ${p.target_date ? `<span class="chip">Target ${esc(OU.fmtDay(OU.localDate(p.target_date)))}</span>` : ''}
          ${p.budget_aed != null ? `<span class="chip">Budget ${esc(aed(p.budget_aed))}</span>` : ''}
        </div>
        <div class="progress progress-lg" role="progressbar" aria-label="Project progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress}"><i style="width:${progress}%"></i></div>
        <p class="muted small">${tasks.length ? `${doneTasks} of ${OU.plural(tasks.length, 'step')} done` : `${progress}%`}</p>
        ${tasks.length ? '' : `<label class="small">Progress<input type="range" min="0" max="100" step="5" value="${progress}" data-tv-change="studio-progress" aria-label="Progress percentage"></label>`}
      </section>
      ${section('overview', 'Overview', `${p.description ? `<p dir="auto">${esc(p.description)}</p>` : '<p class="muted">No description yet.</p>'}
        ${(TYPE_FIELDS[p.kind] || []).filter(([k]) => (p.details || {})[k]).map(([k, l]) => `<p class="small"><b>${esc(l)}:</b> <span dir="auto">${esc(p.details[k])}</span></p>`).join('')}
        ${p.start_date ? `<p class="small"><b>Started:</b> ${esc(OU.fmtDay(OU.localDate(p.start_date)))}</p>` : ''}
        <button type="button" class="btn ghost small" data-act="tv-studio-edit">Edit details</button>`, true)}
      ${section('inspiration', `Inspiration (${insp.length})`, `<div class="tv-insp">${insp.map((i) => `<div class="tv-insp-item">
          ${i.photo_path ? photoTag(media, i.photo_path, 'Inspiration image') : ''}
          ${i.color ? `<span class="tv-swatch" style="background:${hex(i.color)}" aria-hidden="true"></span><span class="small">${esc(i.color)}</span>` : ''}
          ${i.text ? `<p dir="auto">${esc(i.text)}</p>` : ''}
          ${i.url ? `<a href="${esc(i.url)}" target="_blank" rel="noopener noreferrer" class="small">${esc(hostOf(i.url))} ↗</a>` : ''}
          <span class="by">${esc(nameOf(i.created_by))}</span>
          <button type="button" class="btn link small" data-act="tv-item-delete" data-id="${esc(i.id)}" aria-label="Remove this inspiration">Remove</button>
        </div>`).join('') || '<p class="muted">Add images, notes, links or colours that inspire you.</p>'}</div>
        <button type="button" class="btn ghost small" data-act="tv-insp-add">Add inspiration</button>`)}
      ${VISUAL.has(p.kind) ? section('palette', 'Colour palette', `<div class="tv-palette">${(p.palette || []).map((c, i) => `<div class="tv-pal">
          <span class="tv-swatch big" style="background:${hex(c.hex)}" aria-hidden="true"></span>
          <span class="small">${c.fav ? '★ ' : ''}${esc(c.name || c.hex)}</span><span class="muted small">${esc(c.hex)}</span>
          <span class="tv-pal-tools">
            <button type="button" class="mini" data-act="tv-pal-move" data-i="${i}" data-dir="-1" aria-label="Move ${esc(c.name || c.hex)} left">‹</button>
            <button type="button" class="mini" data-act="tv-pal-fav" data-i="${i}" aria-label="Mark ${esc(c.name || c.hex)} as favourite">★</button>
            <button type="button" class="mini" data-act="tv-pal-move" data-i="${i}" data-dir="1" aria-label="Move ${esc(c.name || c.hex)} right">›</button>
            <button type="button" class="mini danger" data-act="tv-pal-del" data-i="${i}" aria-label="Remove ${esc(c.name || c.hex)}">×</button>
          </span></div>`).join('') || '<p class="muted">No colours yet.</p>'}</div>
        <div class="tv-row"><label class="small">Colour<input type="color" id="tvPalColor" value="#b9864d"></label>
          <label class="small">Name (optional)<input id="tvPalName" maxlength="40" dir="auto"></label>
          <button type="button" class="btn ghost small" data-act="tv-pal-add">Add colour</button></div>`) : ''}
      ${section('materials', `Materials and budget (${mats.length})`, `${mats.length ? `<ul class="tv-mats">${mats.map((m) => `<li>
          <label class="check-row"><input type="checkbox" ${m.purchased ? 'checked' : ''} data-tv-change="mat-bought" data-id="${esc(m.id)}"> <span dir="auto">${esc(m.text)}</span></label>
          <span class="small muted">${m.qty ? `× ${esc(m.qty)} · ` : ''}${m.est_price != null ? `est. ${esc(aed(m.est_price))}` : ''}${m.act_price != null ? ` · paid ${esc(aed(m.act_price))}` : ''}${m.store ? ` · ${esc(m.store)}` : ''}${m.purchased && m.purchased_by ? ` · bought by ${esc(nameOf(m.purchased_by))}` : ''}</span>
          ${m.url ? `<a href="${esc(m.url)}" target="_blank" rel="noopener noreferrer" class="small">${esc(hostOf(m.url))} ↗</a>` : ''}
          <span class="tv-row"><button type="button" class="btn link small" data-act="tv-mat-edit" data-id="${esc(m.id)}">Edit</button><button type="button" class="btn link small" data-act="tv-item-delete" data-id="${esc(m.id)}">Remove</button></span>
        </li>`).join('')}</ul>
        <p class="small"><b>Estimated:</b> ${esc(aed(est))} · <b>Spent:</b> ${esc(aed(act))}${p.budget_aed != null ? ` · <b>Budget:</b> ${esc(aed(p.budget_aed))}` : ''}</p>` : '<p class="muted">No materials yet.</p>'}
        <button type="button" class="btn ghost small" data-act="tv-mat-edit">Add material</button>`)}
      ${section('tasks', `Steps (${doneTasks}/${tasks.length})`, `<ul class="tv-tasks">${tasks.map((t) => `<li><label class="check-row"><input type="checkbox" ${t.done ? 'checked' : ''} data-tv-change="task-done" data-id="${esc(t.id)}"> <span dir="auto">${esc(t.text)}</span></label>
          <button type="button" class="btn link small" data-act="tv-item-delete" data-id="${esc(t.id)}" aria-label="Remove step">Remove</button></li>`).join('')}</ul>
        <div class="tv-row"><label class="sr-only" for="tvTaskText">New step</label><input id="tvTaskText" maxlength="200" placeholder="" dir="auto"><button type="button" class="btn ghost small" data-act="tv-task-add">Add step</button></div>`, tasks.length > 0 && !completed)}
      ${section('notes', `Notes (${by('note').length})`, `${by('note').map((x) => `<div class="tv-note"><p dir="auto">${esc(x.text)}</p><span class="by">${esc(nameOf(x.created_by))} · ${esc(shortDate(x.created_at))}</span></div>`).join('') || '<p class="muted">No notes yet.</p>'}
        <div class="tv-row"><label class="sr-only" for="tvNoteText">New note</label><textarea id="tvNoteText" rows="2" maxlength="500" dir="auto"></textarea><button type="button" class="btn ghost small" data-act="tv-note-add">Add note</button></div>`)}
      ${section('result', completed ? 'Final result' : 'Finish the project', completed ? `
        ${by('result').map((r) => photoTag(media, r.photo_path, 'Final result')).join('')}
        ${p.final_note ? `<p dir="auto">${esc(p.final_note)}</p>` : ''}
        ${Object.entries(favs).map(([uid, t]) => `<p class="small"><b>${esc(nameOf(uid))}'s favourite part:</b> <span dir="auto">${esc(t)}</span></p>`).join('')}
        ${favs[me()] ? '' : '<button type="button" class="btn ghost small" data-act="tv-studio-fav">Add your favourite part</button>'}
        <label class="check-row"><input type="checkbox" ${p.in_gallery ? 'checked' : ''} data-tv-change="studio-gallery"> Show in the Studio Gallery</label>
        ${p.memory_entry_id ? '<p class="small">✓ Saved to Memories</p>' : '<button type="button" class="btn ghost small" data-act="tv-studio-memory">Save to Memories</button>'}
        ${reactionBar('studio', p.id, await loadReactions('studio', [p.id]).catch(() => []))}
        <p class="muted small">Completed ${p.completed_at ? esc(shortDate(p.completed_at)) : ''}</p>`
      : `<p class="muted">When it's finished, add a photo, a few words and your favourite part.</p><button type="button" class="btn primary" data-act="tv-studio-complete">Complete the project</button>`, completed)}
      <div class="tv-row end"><button type="button" class="btn link small danger-link" data-act="tv-studio-delete">Delete project</button></div>`, 'Project'));
  }
  function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (_) { return 'link'; } }
  async function addItem(row) {
    await q('Saving', db().from('studio_items').insert(Object.assign({ project_id: tv.project.p.id, created_by: me() }, row)));
    OU.render();
  }
  function inspirationForm() {
    formDialog({
      title: 'Add inspiration',
      body: `${field('Note or idea (optional)', area('text', '', 'rows="3" maxlength="500" dir="auto"'))}
        ${field('Link (optional)', input('url', '', 'type="url" maxlength="500" inputmode="url"'), 'Only links starting with https:// are saved. Images are never copied from links.')}
        ${field('Image (optional)', '<input type="file" name="photo" accept="image/*">', 'Upload only images you took or are allowed to use.')}
        <label class="check-row"><input type="checkbox" name="has_color"> Add a colour</label>
        ${field('Colour', '<input type="color" name="color" value="#c98290">')}`,
      onSubmit: async (fd) => {
        const text = str(fd, 'text') || null;
        let url = str(fd, 'url') || null;
        if (url && !/^https?:\/\/[^\s<>"]+$/i.test(url)) throw new Error('That link doesn\'t look right. It should start with https://');
        const file = fileOf(fd, 'photo');
        const color = fd.get('has_color') ? str(fd, 'color') : null;
        if (!text && !url && !file && !color) throw new Error('Add a note, a link, an image or a colour.');
        const photo = file ? await OU.uploadFile(file, { prefix: `studio/${tv.project.p.id}` }) : null;
        await addItem({ kind: 'inspiration', text, url, photo_path: photo, color });
      },
    });
  }
  function materialForm(m) {
    const v = m || {};
    formDialog({
      title: m ? 'Edit material' : 'Add material',
      body: `${field('Material', input('text', v.text, 'maxlength="200" required dir="auto"'))}
        <div class="form-grid">${field('Quantity', input('qty', v.qty, 'type="number" min="0" step="any"'))}
        ${field('Estimated price each (AED)', input('est_price', v.est_price, 'type="number" min="0" step="any"'))}
        ${field('Actual price paid (AED)', input('act_price', v.act_price, 'type="number" min="0" step="any"'))}</div>
        ${field('Store (optional)', input('store', v.store, 'maxlength="120" dir="auto"'))}
        ${field('Link (optional)', input('url', v.url, 'type="url" maxlength="500"'))}`,
      onSubmit: async (fd) => {
        const row = { text: str(fd, 'text'), qty: num(fd, 'qty'), est_price: num(fd, 'est_price'), act_price: num(fd, 'act_price'), store: str(fd, 'store') || null, url: str(fd, 'url') || null };
        if (!row.text) throw new Error('Name the material.');
        if (row.url && !/^https?:\/\/[^\s<>"]+$/i.test(row.url)) throw new Error('The link should start with https://');
        if (m) { await q('Saving', db().from('studio_items').update(row).eq('id', m.id)); OU.render(); } else await addItem(Object.assign({ kind: 'material' }, row));
      },
    });
  }
  function completeForm() {
    const p = tv.project.p;
    formDialog({
      title: 'Complete the project',
      submit: 'Mark as completed',
      body: `${field('A few words about how it turned out', area('final_note', p.final_note, 'rows="3" maxlength="2000" dir="auto"'))}
        ${field('Your favourite part', input('fav', (p.favourites || {})[me()], 'maxlength="300" dir="auto"'))}
        ${field('Final photo (optional)', '<input type="file" name="photo" accept="image/*">')}
        <label class="check-row"><input type="checkbox" name="memory" checked> Also save it to Memories</label>`,
      onSubmit: async (fd) => {
        const file = fileOf(fd, 'photo');
        const photo = file ? await OU.uploadFile(file, { prefix: `studio/${p.id}` }) : null;
        if (photo) await q('Saving the photo', db().from('studio_items').insert({ project_id: p.id, kind: 'result', photo_path: photo, created_by: me() }));
        const favourites = Object.assign({}, p.favourites || {});
        if (str(fd, 'fav')) favourites[me()] = str(fd, 'fav');
        const patch = { status: 'completed', completed_at: new Date().toISOString(), final_note: str(fd, 'final_note') || null, favourites, progress: 100 };
        if (fd.get('memory')) {
          const e = await OU.insertEntry({ type: 'memory', parent_id: null, title: p.title, category: 'Creative Studio', details: patch.final_note, photo_path: photo, target_date: OU.isoDay(new Date()), status: 'Idea', completed: false });
          patch.memory_entry_id = e.id;
        }
        await updateProject(p, patch);
        celebrate('Project complete!');
        OU.render();
      },
    });
  }
  async function updatePalette(fn) {
    const p = tv.project.p;
    const pal = (p.palette || []).slice();
    fn(pal);
    await updateProject(p, { palette: pal });
    OU.render();
  }

  /* ------------------------------------------------------------------ */
  /* 9. Memory Capsules                                                  */
  /* ------------------------------------------------------------------ */

  const ENTRY_KINDS = { message: 'Message', prediction: 'Prediction', favourite: 'Current favourite', wish: 'Future wish', song: 'Song', photo: 'Photo', voice: 'Voice note', memory: 'A memory' };

  async function viewCapsules(id) {
    if (id) return capsuleView(id);
    set(shell('capsules', loading('Loading your capsules…')));
    let caps;
    let ov;
    try {
      [caps, ov] = await Promise.all([
        rows('Loading capsules', db().from('capsules').select('*').order('open_at')),
        rpc('Loading capsules', 'capsule_overview'),
      ]);
    } catch (err) {
      if (current()) set(shell('capsules', errorBox(err.message)));
      return;
    }
    if (!current()) return;
    const o = new Map((ov || []).map((x) => [x.capsule_id, x]));
    const now = new Date();
    const ready = caps.filter((c) => c.status === 'sealed' && new Date(c.open_at) <= now);
    const collecting = caps.filter((c) => c.status === 'collecting');
    const sealed = caps.filter((c) => c.status === 'sealed' && new Date(c.open_at) > now);
    const opened = caps.filter((c) => c.status === 'opened').reverse();
    const card = (c, kind) => {
      const x = o.get(c.id) || {};
      return `<button type="button" class="tv-capsule ${kind}" data-act="tv-go" data-to="capsules/${esc(c.id)}">
        <span class="tv-capsule-icon">${icon('capsules')}</span>
        <span class="tv-mode-text"><b dir="auto">${esc(c.title)}</b>
          <span class="main">${esc(kind === 'ready' ? 'Ready to open' : kind === 'sealed' ? `Sealed · opens ${countdown(c.open_at)}` : kind === 'opened' ? `Opened ${shortDate(c.opened_at)}` : `Collecting · opens ${shortDate(c.open_at)}`)}</span>
          ${kind === 'collecting' ? `<span class="sub">You: ${OU.plural(x.my_entries || 0, 'entry', 'entries')} · ${esc(names().other)}: ${OU.plural(x.other_entries || 0, 'entry', 'entries')}${x.i_am_ready ? ' · you are ready to seal' : ''}${x.other_ready ? ` · ${esc(names().other)} is ready` : ''}</span>` : ''}
        </span><span class="tv-go" aria-hidden="true">›</span></button>`;
    };
    set(shell('capsules', `<div class="tv-row"><button type="button" class="btn primary" data-act="tv-cap-new">Create a capsule</button></div>
      ${!caps.length ? empty('Create a capsule for a future moment.') : ''}
      ${ready.length ? `<h4 class="tv-h">Ready to open</h4><div class="tv-capsules">${ready.map((c) => card(c, 'ready')).join('')}</div>` : ''}
      ${collecting.length ? `<h4 class="tv-h">Collecting</h4><div class="tv-capsules">${collecting.map((c) => card(c, 'collecting')).join('')}</div>` : ''}
      ${sealed.length ? `<h4 class="tv-h">Sealed</h4><div class="tv-capsules">${sealed.map((c) => card(c, 'sealed')).join('')}</div>` : ''}
      ${opened.length ? `<h4 class="tv-h">Opened</h4><div class="tv-capsules">${opened.map((c) => card(c, 'opened')).join('')}</div>` : ''}`));
  }
  function nextAnniversary() {
    const start = OU.localDate(OU.state.settings.relationship_start || '');
    if (!start) return null;
    const t = new Date();
    let d = new Date(t.getFullYear(), start.getMonth(), start.getDate(), 20, 0);
    if (d <= t) d = new Date(t.getFullYear() + 1, start.getMonth(), start.getDate(), 20, 0);
    return d;
  }
  function capsuleForm(c) {
    const t = new Date();
    const presets = [['year', 'One year from today', new Date(t.getFullYear() + 1, t.getMonth(), t.getDate(), 20, 0)],
      ['anniv', 'Our next anniversary', nextAnniversary()], ['eoy', 'New Year\'s Eve', new Date(t.getMonth() === 11 && t.getDate() === 31 ? t.getFullYear() + 1 : t.getFullYear(), 11, 31, 20, 0)]].filter((p) => p[2]);
    formDialog({
      title: c ? 'Edit capsule' : 'Create a capsule',
      submit: c ? 'Save' : 'Create capsule',
      body: `${field('Title', input('title', c ? c.title : '', 'maxlength="120" required dir="auto"'))}
        <div class="tv-starters">${['Open on our next anniversary', 'Open before our wedding', 'Open one year from today', 'Our current favourites', 'Predictions for next year', 'What we never want to forget'].map((s) => `<button type="button" class="chip chip-btn" data-fill="${esc(s)}" data-target="title">${esc(s)}</button>`).join('')}</div>
        ${field('Cover note (optional)', input('cover_note', c ? c.cover_note : '', 'maxlength="300" dir="auto"'))}
        ${field('Opens', select('preset', presets.map((p) => [p[0], `${p[1]} (${when(p[2].toISOString())})`]).concat([['custom', 'Choose a date and time']]), c ? 'custom' : presets[0][0]))}
        <div class="field" id="tvCapCustom" ${c ? '' : 'hidden'}><label>Date and time${input('open_at', c ? localInput(new Date(c.open_at)) : '', 'type="datetime-local"')}</label><p class="hint">Shown in each person's own time zone.</p></div>`,
      onChange: (el, form) => { if (el.name === 'preset') form.querySelector('#tvCapCustom').hidden = el.value !== 'custom'; },
      onSubmit: async (fd) => {
        const title = str(fd, 'title');
        if (title.length < 2) throw new Error('Give the capsule a title.');
        const pre = str(fd, 'preset');
        const d = pre === 'custom' ? OU.localDateTime(str(fd, 'open_at')) : (presets.find((p) => p[0] === pre) || [])[2];
        if (!d) throw new Error('Choose when it opens.');
        if (d <= new Date(Date.now() + 3600000)) throw new Error('Choose an opening time at least an hour from now.');
        const row = { title, cover_note: str(fd, 'cover_note') || null, open_at: d.toISOString() };
        if (c) { await q('Saving the capsule', db().from('capsules').update(row).eq('id', c.id)); OU.render(); } else {
          const { data } = await q('Creating the capsule', db().from('capsules').insert(Object.assign(row, { created_by: me(), status: 'collecting' })).select('id'));
          go('capsules/' + data[0].id);
        }
      },
    });
  }
  function entryForm(cap, e) {
    const v = e || { kind: 'message', visibility: 'shared' };
    let savedId = e && e.id;
    formDialog({
      title: e ? 'Edit entry' : 'Add to the capsule',
      submit: 'Save entry',
      body: `<div class="form-grid">${field('Type', select('kind', Object.entries(ENTRY_KINDS), v.kind))}</div>
        <fieldset class="tv-vis"><legend>Who can see it before the capsule opens?</legend>
          <label class="check-row"><input type="radio" name="visibility" value="shared" ${v.visibility === 'shared' ? 'checked' : ''}> Shared: ${esc(names().other)} can see it while you both collect</label>
          <label class="check-row"><input type="radio" name="visibility" value="secret" ${v.visibility === 'secret' ? 'checked' : ''}> Secret: only you, until the capsule opens</label>
        </fieldset>
        ${field('Title (optional)', input('title', v.title, 'maxlength="120" dir="auto"'))}
        ${field('Message', area('body', v.body, 'rows="5" maxlength="4000" dir="auto"'))}
        ${fileFields(true, true)}
        <p class="hint">After sealing, nobody can read or change the contents, including your own, until it opens.</p>`,
      onSubmit: async (fd) => {
        const row = { kind: str(fd, 'kind'), visibility: str(fd, 'visibility') || 'shared', title: str(fd, 'title') || null, body: str(fd, 'body') || null };
        const photo = fileOf(fd, 'photo');
        const audio = fileOf(fd, 'audio');
        if (!row.body && !row.title && !photo && !audio) throw new Error('Write something, or add a photo or voice note.');
        let id = savedId;
        if (id) await q('Saving the entry', db().from('capsule_entries').update(row).eq('id', id));
        else {
          const { data } = await q('Saving the entry', db().from('capsule_entries').insert(Object.assign(row, { capsule_id: cap.id, author_id: me() })).select('id'));
          id = data[0].id;
          savedId = id;
        }
        const media = {};
        if (photo) media.photo_path = await OU.uploadFile(photo, { bucket: SEALED, prefix: `cap/${cap.id}/${id}` });
        if (audio) media.audio_path = await OU.uploadFile(audio, { bucket: SEALED, prefix: `cap/${cap.id}/${id}`, kind: 'audio' });
        if (Object.keys(media).length) await q('Saving the entry', db().from('capsule_entries').update(media).eq('id', id));
        toast(row.visibility === 'secret' ? 'Secret entry saved. Only you can see it.' : 'Entry saved');
        OU.render();
      },
    });
  }

  async function capsuleView(id) {
    set(shell('capsules', loading('Loading the capsule…'), 'Capsule'));
    let c;
    let entries = [];
    let ov;
    let media = {};
    let reacts = [];
    try {
      c = (await rows('Loading the capsule', db().from('capsules').select('*').eq('id', id)))[0];
      if (c) {
        [entries, ov] = await Promise.all([
          rows('Loading entries', db().from('capsule_entries').select('*').eq('capsule_id', id).order('created_at')),
          rpc('Loading the capsule', 'capsule_overview'),
        ]);
        media = await mediaTags(SEALED, entries);
        if (c.status === 'opened') reacts = await loadReactions('capsule_entry', entries.map((e) => e.id));
      }
    } catch (err) {
      if (current()) set(shell('capsules', errorBox(err.message), 'Capsule'));
      return;
    }
    if (!current()) return;
    if (!c) { set(shell('capsules', empty('This capsule no longer exists.', '<button type="button" class="btn primary" data-act="tv-go" data-to="capsules">Back to capsules</button>'), 'Capsule')); return; }
    tv.capsule = { c, entries };
    const x = (ov || []).find((r) => r.capsule_id === id) || {};
    const n = names();
    const due = new Date(c.open_at) <= new Date();
    const entryCard = (e, i, opened) => `<article class="tv-entry ${e.visibility} ${opened ? 'tv-seq' : ''}" style="${opened ? `--i:${i}` : ''}">
        <div class="card-top"><span class="pill">${esc(ENTRY_KINDS[e.kind])}</span>${e.visibility === 'secret' ? badge(opened ? 'Was secret' : 'Secret: only you', 'secret') : ''}<span class="by">${esc(nameOf(e.author_id))}</span></div>
        ${e.title ? `<h4 dir="auto">${esc(e.title)}</h4>` : ''}
        ${e.body ? `<p dir="auto">${esc(e.body)}</p>` : ''}
        ${photoTag(media, e.photo_path, 'Photo in the capsule')}
        ${audioTag(media, e.audio_path)}
        ${opened ? reactionBar('capsule_entry', e.id, reacts) : (e.author_id === me() ? `<div class="tv-row"><button type="button" class="btn link small" data-act="tv-entry-edit" data-id="${esc(e.id)}">Edit</button><button type="button" class="btn link small danger-link" data-act="tv-entry-delete" data-id="${esc(e.id)}">Delete</button></div>` : '')}
      </article>`;
    let inner;
    if (c.status === 'collecting') {
      const mine = entries.filter((e) => e.author_id === me());
      const shared = entries.filter((e) => e.author_id !== me());
      inner = `<section class="tv-capsule-head"><p class="eyebrow">COLLECTING</p><h3 dir="auto">${esc(c.title)}</h3>
          ${c.cover_note ? `<p dir="auto">${esc(c.cover_note)}</p>` : ''}
          <p>Opens ${esc(when(c.open_at))} (${esc(countdown(c.open_at))})</p></section>
        <div class="tv-row"><button type="button" class="btn primary" data-act="tv-entry-add">Add an entry</button><button type="button" class="btn ghost small" data-act="tv-cap-edit">Edit capsule</button></div>
        <h4 class="tv-h">Yours (${mine.length})</h4>${mine.map((e, i) => entryCard(e, i, false)).join('') || '<p class="muted small">Nothing from you yet.</p>'}
        <h4 class="tv-h">${esc(n.other)}'s shared entries (${shared.length})</h4>${shared.map((e, i) => entryCard(e, i, false)).join('') || '<p class="muted small">None yet.</p>'}
        ${x.other_secret ? `<p class="muted small" role="status">${esc(n.other)} has also added ${OU.plural(x.other_secret, 'secret entry', 'secret entries')}. You'll see ${x.other_secret === 1 ? 'it' : 'them'} when the capsule opens.</p>` : ''}
        <section class="panel tv-seal">
          <h4>Sealing</h4>
          <p class="small">The capsule seals when you both confirm. After that, nothing can be added, changed or read until ${esc(when(c.open_at))}. Adding or editing anything cancels earlier confirmations.</p>
          <p role="status">${x.i_am_ready ? '✓ You are ready.' : 'You haven\'t confirmed yet.'} ${x.other_ready ? `✓ ${esc(n.other)} is ready.` : `${esc(n.other)} hasn't confirmed yet.`}</p>
          <button type="button" class="btn ${x.i_am_ready ? 'ghost' : 'primary'}" data-act="tv-cap-ready" data-on="${x.i_am_ready ? '0' : '1'}">${x.i_am_ready ? 'I\'m not ready after all' : 'I\'m ready to seal'}</button>
        </section>
        ${c.created_by === me() ? '<div class="tv-row end"><button type="button" class="btn link small danger-link" data-act="tv-cap-delete">Delete capsule</button></div>' : ''}`;
    } else if (c.status === 'sealed' && !due) {
      inner = `<section class="tv-capsule-head sealed"><span class="tv-capsule-icon big">${icon('capsules')}</span><p class="eyebrow">SEALED</p><h3 dir="auto">${esc(c.title)}</h3>
          <p class="tv-countdown" id="tvCountdown" data-at="${esc(c.open_at)}">Opens ${esc(countdown(c.open_at))}</p>
          <p class="small">${esc(when(c.open_at))} · sealed ${esc(shortDate(c.sealed_at))}</p>
          <p class="muted small">Its contents are locked. Not even the database will show them to either of you before then.</p></section>
        ${c.created_by === me() ? '<div class="tv-row end"><button type="button" class="btn link small danger-link" data-act="tv-cap-delete">Emergency delete</button></div>' : ''}`;
      tv.timers.push(setInterval(() => { const el = $('tvCountdown'); if (!el) return; if (new Date(el.dataset.at) <= new Date()) OU.render(); else el.textContent = `Opens ${countdown(el.dataset.at)}`; }, 60000));
    } else if (c.status === 'sealed') {
      inner = `<section class="tv-capsule-head ready"><span class="tv-capsule-icon big">${icon('capsules')}</span><p class="eyebrow">READY TO OPEN</p><h3 dir="auto">${esc(c.title)}</h3>
          <p>It's time. Open it together if you can.</p>
          <button type="button" class="btn primary tv-big" data-act="tv-cap-open">Open the capsule</button></section>`;
    } else {
      const anim = tv.justOpened === id && !reduced();
      tv.justOpened = null;
      inner = `<section class="tv-capsule-head"><p class="eyebrow">OPENED ${esc(shortDate(c.opened_at).toUpperCase())}</p><h3 dir="auto">${esc(c.title)}</h3>${c.cover_note ? `<p dir="auto">${esc(c.cover_note)}</p>` : ''}</section>
        <div class="tv-entries ${anim ? 'tv-seq-anim' : ''}">${entries.map((e, i) => entryCard(e, i, true)).join('') || '<p class="muted">This capsule was empty.</p>'}</div>
        <div class="tv-row">${c.memory_entry_id ? '<p class="small">✓ Saved to Memories</p>' : '<button type="button" class="btn ghost" data-act="tv-cap-memory">Save to Memories</button>'}</div>`;
    }
    set(shell('capsules', inner, 'Capsule'));
  }
  async function capsuleDelete() {
    const { c } = tv.capsule;
    if (c.status === 'collecting') {
      const ok = await OU.confirmAction({ title: `Delete "${c.title}"?`, text: 'This deletes the capsule and every entry in it, for both of you. This can\'t be undone.', ok: 'Delete capsule' });
      if (!ok) return;
    }
    formDialog({
      title: c.status === 'collecting' ? 'Confirm deletion' : 'Emergency delete',
      submit: 'Delete for good',
      body: `<p>${c.status === 'sealed' ? 'This capsule is sealed. Deleting it destroys everything inside, including entries neither of you has seen. This is recorded and can\'t be undone.' : 'Type the title to confirm.'}</p>
        ${field(`Type "${c.title}" to confirm`, input('confirm', '', 'required dir="auto" autocomplete="off"'))}`,
      onSubmit: async (fd) => {
        const paths = await rpc('Deleting the capsule', 'capsule_delete', { p_capsule: c.id, p_confirm_title: str(fd, 'confirm') });
        (paths || []).forEach((p) => OU.removeFile(SEALED, p));
        toast('Capsule deleted');
        go('capsules');
      },
    });
  }
  async function capsuleToMemory() {
    const { c, entries } = tv.capsule;
    const text = entries.map((e) => `${nameOf(e.author_id)} (${ENTRY_KINDS[e.kind]}${e.visibility === 'secret' ? ', was secret' : ''}): ${[e.title, e.body].filter(Boolean).join(' – ')}`).join('\n\n');
    const e = await OU.insertEntry({ type: 'memory', parent_id: null, title: c.title, category: 'Memory Capsule', details: text.slice(0, 9000) || null, target_date: OU.isoDay(new Date(c.opened_at)), status: 'Idea', completed: false });
    await q('Linking', db().from('capsules').update({ memory_entry_id: e.id }).eq('id', c.id));
    toast('Saved to Memories. Photos and voice notes stay in the capsule.');
    OU.render();
  }

  /* ------------------------------------------------------------------ */
  /* 10. Routing and public API                                          */
  /* ------------------------------------------------------------------ */

  function view(rest) {
    const [mode, id] = String(rest || '').split('/');
    const page = { reveal: viewReveal, match: viewMatch, quest: viewQuest, letters: viewLetters, studio: viewStudio, capsules: viewCapsules }[mode];
    document.title = `${mode && MODE[mode] ? MODE[mode].name : 'O&H Togetherverse'} · Our Universe`;
    if (!page) return viewHub();
    return page(id || null).catch((err) => { console.warn(err); if (current()) set(shell(mode, errorBox(err.message))); });
  }
  function leave() {
    tv.timers.forEach(clearInterval);
    tv.timers = [];
  }

  async function confirmThen(opts, fn) {
    const ok = await OU.confirmAction(opts);
    if (ok) await fn();
  }

  async function onClick(act, el) {
    const id = el.dataset.id;
    switch (act) {
      case 'tv-go': return go(el.dataset.to);
      case 'tv-refresh': return OU.render();
      case 'tv-note': await markRead([id]); location.hash = el.dataset.route || '#/together'; return undefined;
      case 'tv-read-all': {
        const list = await rows('Loading', db().from('tv_notifications').select('id').is('read_at', null));
        await markRead(list.map((n) => n.id));
        return OU.render();
      }
      case 'tv-react': return toggleReaction(el);
      // reveal
      case 'tv-reveal-draw': return revealDraw();
      case 'tv-reveal-use': return tv.suggest && revealStart(tv.suggest.body, 'deck', tv.suggest.id);
      case 'tv-reveal-custom': {
        const t = ($('tvCustomPrompt').value || '').trim();
        if (t.length < 3) { toast('Write your question first.', 'error'); $('tvCustomPrompt').focus(); return undefined; }
        return revealStart(t, 'custom', null);
      }
      case 'tv-reveal-save': return revealSave(id, false);
      case 'tv-reveal-submit': return revealSave(id, true);
      case 'tv-reveal-edit': tv.editingAnswer = true; return OU.render();
      case 'tv-reveal-open': el.disabled = true; return revealOpen(id).catch((err) => { el.disabled = false; toast(plain(err), 'error'); });
      case 'tv-reveal-cancel': return confirmThen({ title: 'Cancel this round?', text: 'Nobody will see the answers to this question, ever. You can start a new one straight away.', ok: 'Cancel the round' },
        async () => { await rpc('Cancelling', 'reveal_archive', { p_round: id }); OU.render(); });
      case 'tv-reveal-memory': return revealToMemory();
      case 'tv-reveal-note': return OU.openEntryForm({ type: 'decision', preset: { title: '', details: tv.lastRound ? tv.lastRound.round.prompt : '' } });
      // match
      case 'tv-vote': return vote(id, el.dataset.vote);
      case 'tv-skip-idea': tv.matchSkip.add(id); return OU.render();
      case 'tv-unskip': tv.matchSkip.clear(); return OU.render();
      case 'tv-undo-vote': {
        const cid = tv.lastVote;
        tv.lastVote = null;
        const ok = await rpc('Undoing', 'date_unvote', { p_card: cid });
        toast(ok ? 'Vote undone' : `${names().other} has already voted on that one, so it can't be undone.`);
        return OU.render();
      }
      case 'tv-save-idea': {
        const c = tv.match.byId.get(id);
        await OU.insertEntry({ type: 'dateidea', parent_id: null, title: c.title, details: c.description, status: 'Idea', completed: false, category: 'Match a Date', budget: c.budget_max || null });
        toast('Saved to Date Ideas');
        return undefined;
      }
      case 'tv-dup-idea': return confirmThen({ title: 'Report as a duplicate?', text: 'It will be hidden from the deck for both of you.', ok: 'Hide it', danger: false },
        async () => { await rpc('Reporting', 'date_flag_duplicate', { p_card: id }); OU.render(); });
      case 'tv-filter': {
        const f = filters();
        f[el.dataset.key] = f[el.dataset.key] === el.dataset.val ? null : el.dataset.val;
        OU.storeSet('tv.match.filters', f);
        return OU.render();
      }
      case 'tv-filter-clear': OU.storeSet('tv.match.filters', {}); return OU.render();
      case 'tv-add-idea': return ideaForm(null);
      case 'tv-plan-date': return planDate(id);
      case 'tv-dismiss-match': await q('Saving', db().from('date_results').update({ dismissed_at: new Date().toISOString() }).eq('card_id', id)); return OU.render();
      // quest
      case 'tv-quest-create': el.disabled = true; return createBoard(el.dataset.prev).catch((err) => { el.disabled = false; throw err; });
      case 'tv-quest-cell': return questCellSheet(tv.quest.cells.find((c) => c.id === id));
      case 'tv-quest-swap': return swapQuest(id);
      case 'tv-quest-edit': return formDialog({
        title: 'Add a quest', submit: 'Add',
        body: `${field('Title', input('title', '', 'maxlength="120" required dir="auto"'))}${field('Short instructions', area('instructions', '', 'rows="2" maxlength="300" dir="auto"'))}`,
        onSubmit: async (fd) => {
          if (str(fd, 'title').length < 3) throw new Error('Give the quest a title.');
          await q('Adding the quest', db().from('quest_cells').insert({ board_id: tv.quest.board.id, position: Number(el.dataset.pos), title: str(fd, 'title'), instructions: str(fd, 'instructions') || null, source: 'custom' }));
          OU.render();
        },
      });
      case 'tv-quest-start': return confirmThen({ title: 'Start this month\'s board?', text: 'Quests can be completed once it starts. You can still edit unfinished quests later.', ok: 'Start the board', danger: false },
        async () => { await q('Starting the board', db().from('quest_boards').update({ status: 'active', activated_at: new Date().toISOString() }).eq('id', id)); celebrate('Your board has started'); OU.render(); });
      case 'tv-quest-discard': return confirmThen({ title: 'Start over?', text: 'This removes the unstarted board so you can create a new one. Nothing has been completed on it yet.', ok: 'Remove the board' },
        async () => { await q('Removing the board', db().from('quest_boards').delete().eq('id', id).eq('status', 'draft')); OU.render(); });
      case 'tv-quest-undo': await rpc('Updating', 'quest_uncomplete', { p_cell: id }); await OU.closeDialog('tvDialog'); return OU.render();
      // letters
      case 'tv-ow-new': return letterForm(null);
      case 'tv-ow-edit': return letterForm(tv.letters.get(id));
      case 'tv-ow-seal': return confirmThen({ title: 'Seal and send this letter?', text: `${names().other} will see the envelope straight away. Once sealed, you can't edit it, but you can withdraw it before it's opened.`, ok: 'Seal and send', danger: false },
        async () => { await rpc('Sealing the letter', 'ow_seal', { p_letter: id }); celebrate('Letter sealed and sent'); OU.render(); });
      case 'tv-ow-open': {
        const l = tv.letters.get(id);
        const ok = await OU.confirmAction({ title: l.cover_title, text: l.condition === 'mood' || l.condition === 'anytime' ? 'Open it now? It will stay opened.' : 'It\'s ready. Open it now?', ok: 'Open it', danger: false });
        if (!ok) return undefined;
        try { await rpc('Opening the letter', 'ow_open', { p_letter: id }); } catch (err) { toast(`${plain(err)} It remains locked.`, 'error'); return OU.render(); }
        tv.justOpened = id;
        return go('letters/' + id);
      }
      case 'tv-ow-release': return confirmThen({ title: 'Release this letter now?', text: `${names().other} will be able to open it.`, ok: 'Release it', danger: false },
        async () => { await rpc('Releasing', 'ow_release', { p_letter: id }); OU.render(); });
      case 'tv-ow-withdraw': return confirmThen({ title: 'Withdraw this letter?', text: `${names().other} won't see it any more. It stays in your sent letters as withdrawn.`, ok: 'Withdraw' },
        async () => { await rpc('Withdrawing', 'ow_withdraw', { p_letter: id }); OU.render(); });
      case 'tv-ow-delete': return confirmThen({ title: 'Delete this letter?', text: 'This can\'t be undone.', ok: 'Delete' },
        async () => {
          const b = (await rows('Loading', db().from('open_when_bodies').select('photo_path, audio_path').eq('letter_id', id)))[0];
          await q('Deleting', db().from('open_when_letters').delete().eq('id', id));
          if (b) { OU.removeFile(SEALED, b.photo_path); OU.removeFile(SEALED, b.audio_path); }
          OU.render();
        });
      // studio
      case 'tv-studio-new': return projectForm(null);
      case 'tv-studio-template': return studioTemplate();
      case 'tv-studio-edit': return projectForm(tv.project.p);
      case 'tv-insp-add': return inspirationForm();
      case 'tv-mat-edit': return materialForm(id ? tv.project.items.find((i) => i.id === id) : null);
      case 'tv-task-add': {
        const t = ($('tvTaskText').value || '').trim();
        if (!t) { $('tvTaskText').focus(); return undefined; }
        return addItem({ kind: 'task', text: t, sort_order: tv.project.items.length });
      }
      case 'tv-note-add': {
        const t = ($('tvNoteText').value || '').trim();
        if (!t) { $('tvNoteText').focus(); return undefined; }
        return addItem({ kind: 'note', text: t });
      }
      case 'tv-item-delete': return confirmThen({ title: 'Remove this?', text: 'It is removed for both of you.', ok: 'Remove' },
        async () => {
          const it = tv.project.items.find((i) => i.id === id);
          await q('Removing', db().from('studio_items').delete().eq('id', id));
          if (it && it.photo_path) OU.removeFile(OU.PHOTO_BUCKET, it.photo_path);
          OU.render();
        });
      case 'tv-pal-add': {
        const hex = $('tvPalColor').value;
        const name = ($('tvPalName').value || '').trim();
        if (!/^#[0-9a-f]{6}$/i.test(hex)) return undefined;
        return updatePalette((p) => p.push({ hex, name, fav: false }));
      }
      case 'tv-pal-del': return updatePalette((p) => p.splice(Number(el.dataset.i), 1));
      case 'tv-pal-fav': return updatePalette((p) => { const c = p[Number(el.dataset.i)]; c.fav = !c.fav; });
      case 'tv-pal-move': return updatePalette((p) => {
        const i = Number(el.dataset.i);
        const j = i + Number(el.dataset.dir);
        if (j < 0 || j >= p.length) return;
        [p[i], p[j]] = [p[j], p[i]];
      });
      case 'tv-studio-complete': return completeForm();
      case 'tv-studio-fav': return formDialog({
        title: 'Your favourite part', body: field('What you liked most', input('fav', '', 'maxlength="300" required dir="auto"')),
        onSubmit: async (fd) => { const f = Object.assign({}, tv.project.p.favourites || {}); f[me()] = str(fd, 'fav'); await updateProject(tv.project.p, { favourites: f }); OU.render(); },
      });
      case 'tv-studio-memory': {
        const p = tv.project.p;
        const photo = (tv.project.items.find((i) => i.kind === 'result' && i.photo_path) || {}).photo_path || null;
        const e = await OU.insertEntry({ type: 'memory', parent_id: null, title: p.title, category: 'Creative Studio', details: p.final_note, photo_path: photo, target_date: OU.isoDay(new Date(p.completed_at || Date.now())), status: 'Idea', completed: false });
        await updateProject(p, { memory_entry_id: e.id });
        toast('Saved to Memories');
        return OU.render();
      }
      case 'tv-studio-delete': return confirmThen({ title: `Delete "${tv.project.p.title}"?`, text: 'This deletes the project, its inspiration, materials and steps for both of you. Memories made from it are kept.', ok: 'Delete project' },
        async () => {
          const photos = tv.project.items.map((i) => i.photo_path).filter(Boolean);
          await q('Deleting', db().from('studio_projects').delete().eq('id', tv.project.p.id));
          photos.forEach((p) => OU.removeFile(OU.PHOTO_BUCKET, p));
          go('studio');
        });
      // capsules
      case 'tv-cap-new': return capsuleForm(null);
      case 'tv-cap-edit': return capsuleForm(tv.capsule.c);
      case 'tv-entry-add': return entryForm(tv.capsule.c, null);
      case 'tv-entry-edit': return entryForm(tv.capsule.c, tv.capsule.entries.find((e) => e.id === id));
      case 'tv-entry-delete': return confirmThen({ title: 'Delete this entry?', text: 'This can\'t be undone.', ok: 'Delete' },
        async () => {
          const e = tv.capsule.entries.find((x) => x.id === id);
          await q('Deleting', db().from('capsule_entries').delete().eq('id', id));
          if (e) { OU.removeFile(SEALED, e.photo_path); OU.removeFile(SEALED, e.audio_path); }
          OU.render();
        });
      case 'tv-cap-ready': {
        if (el.dataset.on === '1') {
          const ok = await OU.confirmAction({ title: 'Ready to seal?', text: `When ${names().other} confirms too, the capsule seals. Nobody can add, change or read anything in it until ${when(tv.capsule.c.open_at)}.`, ok: 'I\'m ready', danger: false });
          if (!ok) return undefined;
        }
        try {
          const st = await rpc('Updating', 'capsule_set_ready', { p_capsule: tv.capsule.c.id, p_ready: el.dataset.on === '1' });
          if (st === 'sealed') celebrate('Capsule sealed');
        } catch (err) { toast(`${plain(err)} Its current status has not changed.`, 'error'); }
        return OU.render();
      }
      case 'tv-cap-open':
        el.disabled = true;
        try { await rpc('Opening the capsule', 'capsule_open', { p_capsule: tv.capsule.c.id }); } catch (err) { toast(`${plain(err)} Its current status has not changed.`, 'error'); return OU.render(); }
        tv.justOpened = tv.capsule.c.id;
        celebrate('The capsule is open');
        return OU.render();
      case 'tv-cap-memory': return capsuleToMemory();
      case 'tv-cap-delete': return capsuleDelete();
      default: return undefined;
    }
  }

  async function onChange(el) {
    const kind = el.dataset.tvChange;
    if (kind === 'reveal-cat') { tv.suggest = null; tv.suggestCat = el.value; return undefined; }
    if (kind === 'studio-status') {
      const patch = { status: el.value };
      if (el.value === 'completed' && !tv.project.p.completed_at) patch.completed_at = new Date().toISOString();
      await updateProject(tv.project.p, patch);
      return OU.render();
    }
    if (kind === 'studio-progress') { await updateProject(tv.project.p, { progress: Number(el.value) }); return OU.render(); }
    if (kind === 'studio-gallery') { await updateProject(tv.project.p, { in_gallery: el.checked }); return undefined; }
    if (kind === 'task-done') { await q('Saving', db().from('studio_items').update({ done: el.checked }).eq('id', el.dataset.id)); return OU.render(); }
    if (kind === 'mat-bought') {
      await q('Saving', db().from('studio_items').update({ purchased: el.checked, purchased_by: el.checked ? me() : null }).eq('id', el.dataset.id));
      return OU.render();
    }
    return undefined;
  }

  bindForm();
  // The generic sheet must never close on a stray backdrop tap (it holds typed text).
  window.OU_TV = { view, leave, start, stop, refreshBadge, dashboardPanel, onClick, onChange };
})();
