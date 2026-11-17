'use strict';
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const CSRF = $('meta[name=csrf]').content;
  const app = $('#app');
  // ?n=노트ID 로 열린 새 창(목록 더블클릭): 그 노트 하나만 전체화면 편집
  const POPUP = (() => { const n = new URLSearchParams(location.search).get('n'); return n && /^[\w-]{1,40}$/.test(n) ? n : null; })();
  // 창끼리 "노트가 바뀌었다" 알림 (새 창에서 저장 → 원래 창 목록·내용 갱신)
  const sync = 'BroadcastChannel' in window ? new BroadcastChannel('note-sync') : null;
  const isMobile = () => matchMedia('(max-width: 767px)').matches;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const S = {
    notebooks: [], notes: new Map(), view: { type: 'all' }, hits: null,
    cur: null,          // 열린 노트 {id,title,body,notebook,tags,rev,trashed,pinned,created,updated,files}
    base: null,         // 마지막으로 저장(또는 연) 상태 {title, md(에디터가 정리한 본문), tags}
    dirty: false, saving: null, timer: null, uploadMax: 0,
    createdEmpty: null, openSeq: 0, searchSeq: 0,
  };

  // ---------- 서버 ----------
  async function call(a, { params, json, form, keepalive } = {}) {
    let url = 'api.php?a=' + encodeURIComponent(a);
    if (params) url += '&' + new URLSearchParams(params);
    const opt = { headers: { 'X-CSRF-Token': CSRF }, credentials: 'same-origin', keepalive: !!keepalive };
    if (json) { opt.method = 'POST'; opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(json); }
    if (form) { opt.method = 'POST'; opt.body = form; }
    const r = await fetch(url, opt);
    if (r.status === 401) { location.reload(); throw new Error('로그인이 필요합니다'); }
    let j;
    try { j = await r.json(); } catch { throw new Error('서버 응답 오류 (' + r.status + ')'); }
    if (r.status === 409 && j.conflict) return j;
    if (!j.ok) throw new Error(j.error || '오류');
    return j;
  }
  const get = (a, params) => call(a, { params });
  const post = (a, json, keepalive) => call(a, { json, keepalive });

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }
  const fail = e => { console.error(e); toast(e.message || String(e)); };

  function fmtDate(ts, full) {
    const d = new Date(ts * 1000), now = new Date();
    const p = n => String(n).padStart(2, '0');
    const hm = p(d.getHours()) + ':' + p(d.getMinutes());
    if (full) return `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()} ${hm}`;
    if (d.toDateString() === now.toDateString()) return hm;
    if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}월 ${d.getDate()}일`;
    return `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`;
  }
  const fileUrl = (id, name, dl) => `file.php?n=${encodeURIComponent(id)}&f=${encodeURIComponent(name)}${dl ? '&dl=1' : ''}`;
  const nbName = id => (S.notebooks.find(n => n.id === id) || {}).name || '';
  // 바탕화면 프로그램(RgroNote.exe) 안에서는 바깥 http(s) 링크를 rgronote: 로 넘겨 PC 기본 브라우저(평소 프로필)로 연다
  const DESKTOP = document.documentElement.dataset.desktop === '1';
  if (DESKTOP) {
    document.addEventListener('click', e => {
      const a = e.target.closest('a[href]');
      if (!a || e.defaultPrevented || a.closest('.toastui-editor-contents[contenteditable="true"]')) return;
      let u;
      try { u = new URL(a.getAttribute('href'), location.href); } catch { return; }
      if (!/^https?:$/.test(u.protocol) || u.origin === location.origin) return;
      e.preventDefault();
      location.href = 'rgronote:open?url=' + encodeURIComponent(u.href);
    }, true);
  }
  // 고정·즐겨찾기·첨부 아이콘: 이모지 대신 같은 크기·같은 색(currentColor)으로 그리는 SVG
  const ICON = {
    pin: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M14.6 2.6l6.8 6.8-1.9.7-3.6 3.6.6 4.6-1.8 1.8-4-4-5.6 5.6H4v-1.1l5.6-5.6-4-4 1.8-1.8 4.6.6 3.6-3.6z"/></svg>',
    star: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2.5l2.9 6 6.6.8-4.9 4.5 1.3 6.5L12 17.1l-5.9 3.2 1.3-6.5-4.9-4.5 6.6-.8z"/></svg>',
    'star-o': '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" d="M12 3.6l2.5 5.2 5.7.7-4.2 3.9 1.1 5.6L12 16.2l-5.1 2.8L8 13.4 3.8 9.5l5.7-.7z"/></svg>',
    clip: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M20 11.5l-7.8 7.8a5 5 0 01-7.1-7.1l8.1-8.1a3.3 3.3 0 014.7 4.7l-8.1 8.1a1.7 1.7 0 01-2.4-2.4l7.4-7.4"/></svg>',
    image: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 17l5-5 4 4 3-3 6 6"/></g><circle cx="15.5" cy="9" r="1.6" fill="currentColor"/></svg>',
  };
  const ic = (name, cls = '') => `<span class="ico ${cls}">${ICON[name]}</span>`;
  $$('.ic-slot[data-ic]').forEach(el => { el.outerHTML = ic(el.dataset.ic, 'ic-' + el.dataset.ic); });
  const sameTags = (a, b) => a.length === b.length && a.every((t, i) => t === b[i]);

  // ---------- 상태 불러오기 ----------
  async function loadState() {
    const j = await get('state');
    S.notebooks = j.notebooks;
    S.notes = new Map(j.notes.map(n => [n.id, n]));
    S.user = j.user;
    S.uploadMax = j.uploadMax;
    S.macros = Array.isArray(j.macros) ? j.macros : MACRO_DEFAULT;
    renderMacros();
    S.loaded = true;   // 이전에는 목록이 비어 있으면 "불러오는 중…"
    // 기억해 둔 보기의 노트북이 없어졌으면 "모든 노트" 로
    if (S.view.type === 'notebook' && !S.notebooks.some(n => n.id === S.view.id)) S.view = { type: 'all' };
    renderSide(); renderList();
  }

  // 태그 보기는 여러 태그(AND). 예전 형식 {id} 도 받음
  const viewTags = v => (v.type === 'tag' ? (v.ids || (v.id ? [v.id] : [])) : []);

  function applyMeta(meta) {
    const old = S.notes.get(meta.id);
    if (old && old.att && !('att' in meta)) meta.att = old.att;
    S.notes.set(meta.id, meta);
    if (sync) sync.postMessage({ id: meta.id });   // 다른 창(새 창 편집 등)에 바뀌었다고 알림
    if (S.cur && S.cur.id === meta.id) {
      for (const k of ['rev', 'updated', 'created', 'notebook', 'pinned', 'fixed', 'trashed', 'tags']) S.cur[k] = meta[k];
    }
    renderSide(); renderList();
  }

  // ---------- 사이드바 ----------
  function renderSide() {
    const live = [...S.notes.values()].filter(n => !n.trashed);
    $('#cnt-all').textContent = live.length;
    $('#cnt-pinned').textContent = live.filter(n => n.pinned).length || '';
    $('#cnt-fixed').textContent = live.filter(n => n.fixed).length || '';
    $('#cnt-att').textContent = live.filter(n => n.att).length || '';
    $('#cnt-trash').textContent = S.notes.size - live.length || '';
    const v = S.view;
    $('#nb-list').innerHTML = S.notebooks.map(nb => {
      const c = live.filter(n => n.notebook === nb.id).length;
      const act = v.type === 'notebook' && v.id === nb.id ? ' active' : '';
      return `<a href="#" class="nav-item sub${act}" data-view="notebook" data-id="${esc(nb.id)}"><span class="name">${esc(nb.name)}</span><span class="cnt">${c}</span></a>`;
    }).join('');
    const tags = new Map();
    live.forEach(n => n.tags.forEach(t => tags.set(t, (tags.get(t) || 0) + 1)));
    $('#cnt-tags').textContent = tags.size || '';
    $('#tag-list').innerHTML = [...tags.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ko')).map(([t, c]) => {
      const act = viewTags(v).includes(t) ? ' active' : '';
      return `<a href="#" class="nav-item sub${act}" data-view="tag" data-id="${esc(t)}"><span class="name"># ${esc(t)}</span><span class="cnt">${c}</span></a>`;
    }).join('') || '<div class="nav-item sub cnt">태그 없음</div>';
    $$('#side nav > [data-view]').forEach(a => a.classList.toggle('active', a.dataset.view === v.type));

    const titles = { all: '모든 노트', fixed: '고정', pinned: '즐겨찾기', att: '첨부 있는 노트', trash: '휴지통' };
    if (v.type === 'tag') {
      // 거른 태그마다 × 로 뺄 수 있게
      // 누르면 그 조건만 빠진다(다 빠지면 태그로 거르기 전 보기로)
      $('#list-title').innerHTML = viewTags(v).map(t => `<button type="button" class="flt-tag" data-tag="${esc(t)}" title="눌러서 이 태그 조건 빼기">#${esc(t)}</button>`).join('');
      $('#list-title').title = viewTags(v).length > 1 ? '태그를 모두 가진 노트 (AND)' : '';
    } else {
      $('#list-title').textContent = v.type === 'notebook' ? nbName(v.id) : titles[v.type];
      $('#list-title').title = '';
    }
    $('#nb-menu-btn').hidden = v.type !== 'notebook';
    $('#trash-tools').hidden = v.type !== 'trash' || S.notes.size === live.length;

    const sel = $('#ed-nb');
    const cur = sel.value;
    sel.innerHTML = S.notebooks.map(nb => `<option value="${esc(nb.id)}">${esc(nb.name)}</option>`).join('');
    sel.value = S.cur ? S.cur.notebook : cur;
    renderNbLabel();
  }

  // 편집 막대 왼쪽: 지금 노트가 들어 있는 노트북 이름 (누르면 ⋯ 메뉴의 노트북 고르기)
  function renderNbLabel() {
    const lb = $('#ed-nb-label'), c = S.cur;
    lb.hidden = !c;
    if (!c) return;
    const name = c.trashed ? '휴지통' : (nbName(c.notebook) || '노트북 없음');
    lb.textContent = '📁 ' + name;
    lb.disabled = !!c.trashed;
  }

  // ---------- 브라우저에 기억하는 화면 설정 ----------
  const pref = {
    get(k, d) { try { const v = localStorage.getItem('note.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('note.' + k, JSON.stringify(v)); } catch { /* 저장 안 돼도 동작 */ } },
  };

  // ---------- 정렬·기간 필터 ----------
  S.sort = pref.get('sort', { key: 'updated', dir: 'desc' });
  S.filter = { field: 'updated', from: '', to: '' };   // 기간 필터는 새로 열면 비움
  const collator = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' });

  function setSort(key, dir) {
    S.sort = { key, dir };
    pref.set('sort', S.sort);
    $('#sort').value = key + ':' + dir;
    resetList();
    renderList();
  }
  $('#sort').value = S.sort.key + ':' + S.sort.dir;
  $('#sort').addEventListener('change', e => { const [k, d] = e.target.value.split(':'); setSort(k, d); });

  const dayStart = s => s ? new Date(s + 'T00:00:00').getTime() / 1000 : null;
  const dayEnd = s => s ? new Date(s + 'T23:59:59').getTime() / 1000 : null;
  function onFilterChange() {
    S.filter = { field: $('#f-field').value, from: $('#f-from').value, to: $('#f-to').value };
    const on = !!(S.filter.from || S.filter.to);
    $('#filter-btn').classList.toggle('on', on);
    $('#filter-btn').textContent = on ? '기간 ●' : '기간';
    markSearchBusy();
    resetList();
    renderList();
  }
  ['#f-field', '#f-from', '#f-to'].forEach(s => $(s).addEventListener('change', onFilterChange));

  // ---------- 🔍 검색·정렬 줄 펼치기/접기 (브라우저마다 기억) ----------
  function setSearchOpen(open, focus) {
    $('#search-bar').hidden = !open;
    if (!open) { $('#filter').hidden = true; $('#filter-btn').setAttribute('aria-expanded', 'false'); }
    $('#search-btn').setAttribute('aria-expanded', String(open));
    $('#search-btn').setAttribute('aria-label', open ? '검색·정렬 닫기' : '검색·정렬 열기');
    pref.set('searchOpen', open);
    markSearchBusy();
    if (open && focus) $('#q').focus();
  }
  /** 접혀 있어도 검색어나 기간 조건이 걸려 있으면 🔍 에 점 */
  function markSearchBusy() {
    const busy = !!($('#q').value.trim() || S.filter.from || S.filter.to);
    $('#search-btn').classList.toggle('busy', busy && $('#search-bar').hidden);
    $('#search-btn').title = busy ? '검색·정렬 (조건 걸려 있음)' : '검색·정렬';
  }
  $('#q').addEventListener('input', markSearchBusy);
  setSearchOpen(pref.get('searchOpen', false), false);
  // Esc: 목록 검색창(검색 칸·정렬·기간)에서 누르면 검색어를 지우고 검색창을 닫음 → 목록이 원래대로
  $('#search-bar').addEventListener('keydown', e => {
    if (e.key !== 'Escape' || e.isComposing) return;
    e.preventDefault(); e.stopPropagation();
    closeSearch();
  });
  function closeSearch() {
    const q = $('#q');
    if (q.value) { q.value = ''; q.dispatchEvent(new Event('input')); }
    setSearchOpen(false);
    q.blur();
  }

  // ---------- 목록 ----------
  function visibleNotes() {
    const v = S.view;
    let arr = [...S.notes.values()].filter(n => (v.type === 'trash') === !!n.trashed);
    if (v.type === 'notebook') arr = arr.filter(n => n.notebook === v.id);
    if (v.type === 'tag') { const ts = viewTags(v); arr = arr.filter(n => ts.every(t => n.tags.includes(t))); }
    if (v.type === 'pinned') arr = arr.filter(n => n.pinned);
    if (v.type === 'fixed') arr = arr.filter(n => n.fixed);
    if (v.type === 'att') arr = arr.filter(n => n.att);
    if (S.hits) arr = arr.filter(n => S.hits.has(n.id));
    const f = S.filter, from = dayStart(f.from), to = dayEnd(f.to);
    if (from !== null) arr = arr.filter(n => n[f.field] >= from);
    if (to !== null) arr = arr.filter(n => n[f.field] <= to);

    const { key, dir } = S.sort, sign = dir === 'asc' ? 1 : -1;
    const cmp = key === 'title' ? (a, b) => collator.compare(a.title || '', b.title || '')
              : key === 'notebook' ? (a, b) => collator.compare(nbName(a.notebook), nbName(b.notebook))
              : (a, b) => a[key] - b[key];
    // 📌 고정한 노트는 정렬과 상관없이 맨 위(휴지통 제외)
    const fx = n => (n.fixed && !n.trashed ? 0 : 1);
    arr.sort((a, b) => fx(a) - fx(b) || sign * cmp(a, b) || (b.updated - a.updated));
    return arr;
  }

  const fmtDay = ts => { const d = new Date(ts * 1000); return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`; };

  // 위아래 배치의 표: 칸 이름, 정렬 키(없으면 정렬 안 함)
  const COLS = [
    { id: 'mark', label: '', fixedW: 52 },   // 📌 고정 · ★ 즐겨찾기 · 🖼 이미지 · 📎 첨부 표시
    { id: 'created', label: '생성', sort: 'created' },
    { id: 'updated', label: '업데이트', sort: 'updated' },
    { id: 'title', label: '제목', sort: 'title' },
    { id: 'snippet', label: '내용', flex: true },
    { id: 'notebook', label: '위치', sort: 'notebook' },
    { id: 'tags', label: '태그' },
  ];
  S.colW = Object.assign({ created: 88, updated: 88, title: 260, notebook: 100, tags: 120 }, pref.get('colW', {}));
  function applyColW() {
    $('#list').style.setProperty('--cols', COLS.map(c => c.flex ? 'minmax(80px, 1fr)' : (c.fixedW || S.colW[c.id]) + 'px').join(' '));
  }

  function renderHead() {
    const { key, dir } = S.sort;
    $('#list-head').innerHTML = COLS.map(c => {
      const on = c.sort && c.sort === key;
      const arrow = on ? (dir === 'asc' ? ' ▲' : ' ▼') : '';
      const sortAttr = c.sort ? ` data-sort="${c.sort}" title="눌러서 정렬"` : '';
      const grip = c.flex || c.fixedW ? '' : `<span class="col-grip" data-col="${c.id}" title="끌어서 칸 너비 조절"></span>`;
      return `<div class="h${on ? ' on' : ''}"${sortAttr}>${c.label}${arrow}${grip}</div>`;
    }).join('');
  }

  // 노트가 수천 개라 한 번에 다 그리면 느리다 → 처음엔 CHUNK 개만 그리고, 아래로 스크롤하면 CHUNK 개씩 이어 붙인다
  // (노트 정보는 이미 다 받아 둔 상태라 서버 요청은 없고, 화면에 그리는 양만 나눈다)
  const CHUNK = 50;
  let listAll = [], listCtx = null;
  // ---------- 검색어 하이라이트 ----------
  /** 목록 검색 중이면 그 낱말들 */
  function listTerms() {
    const q = $('#q').value.trim();
    return S.hits && q ? q.split(/\s+/).filter(Boolean) : [];
  }
  /** 글을 이스케이프하면서 검색어 부분만 <mark> */
  function hlHtml(text) {
    const terms = listTerms();
    if (!terms.length || !text) return esc(text);
    const low = text.toLowerCase(), same = low.length === text.length;
    const ms = [];
    for (const t of terms) {
      const n = same ? t.toLowerCase() : t;
      for (let i = (same ? low : text).indexOf(n); i !== -1 && ms.length < 50; i = (same ? low : text).indexOf(n, i + n.length)) ms.push([i, i + n.length]);
    }
    if (!ms.length) return esc(text);
    ms.sort((a, b) => a[0] - b[0]);
    let out = '', last = 0;
    for (const [a, b] of ms) {
      if (a < last) continue;
      out += esc(text.slice(last, a)) + '<mark>' + esc(text.slice(a, b)) + '</mark>';
      last = b;
    }
    return out + esc(text.slice(last));
  }
  /** 열린 노트 본문에 하이라이트: 목록 검색어(연노랑)는 그대로 두고, 찾기 막대 글(연파랑)을 함께 칠함. 돌려주는 값 = 찾기 개수 */
  function applyHL() {
    if (!S.cur) return 0;
    const fq = !$('#find-bar').hidden ? $('#find-q').value.trim() : '';
    const r = NoteEditor.highlight(listTerms(), S.cur.trashed ? $('#ed-view') : null, fq ? [fq] : []);
    if (!$('#find-bar').hidden && !fq) $('#find-cnt').textContent = '';
    return r.find;
  }

  // ---------- Ctrl+F: 이 노트에서 찾기 ----------
  function openFind(withReplace) {
    if (!S.cur) return;
    if (withReplace && !S.cur.trashed) setReplOpen(true);
    const bar = $('#find-bar'), inp = $('#find-q');
    // 고른 글이 있으면 그걸로 찾기
    const ae = document.activeElement;
    let sel = '';
    if (ae && ae.tagName === 'TEXTAREA') sel = ae.value.slice(ae.selectionStart, ae.selectionEnd);
    else sel = String(window.getSelection() || '');
    sel = sel.trim();
    if (sel && !sel.includes('\n') && sel.length <= 100) inp.value = sel;   // 고른 글이 있으면 그걸로(없으면 지난번 찾던 글)
    bar.hidden = false;
    inp.focus(); inp.select();
    findRun(0);
  }
  function closeFind() {
    $('#find-bar').hidden = true;
    $('#find-cnt').textContent = '';
    applyHL();   // 목록 검색어 표시로 돌아감
  }
  /** dir: 0 = 처음부터 첫 번째, 1 = 다음, -1 = 이전 */
  function findRun(dir) {
    const n = applyHL();
    if (!$('#find-q').value.trim()) { $('#find-cnt').textContent = ''; return; }
    if (!n) { $('#find-cnt').textContent = '없음'; return; }
    const r = NoteEditor.findStep(dir < 0 ? -1 : 1);
    $('#find-cnt').textContent = `${r.i + 1} / ${r.n}`;
  }
  // ---------- 바꾸기 (찾기 막대 ⇄ / Ctrl+H) ----------
  function setReplOpen(open) {
    $('#repl-row').hidden = !open;
    $('#find-repl-btn').classList.toggle('on', open);
    $('#find-repl-btn').setAttribute('aria-expanded', String(open));
  }
  function replOne() {
    if (!S.cur || S.cur.trashed || !$('#find-q').value.trim()) return;
    const r = NoteEditor.replaceStep($('#repl-q').value);
    $('#find-cnt').textContent = r.n ? `${r.i + 1} / ${r.n}` : '없음';
  }
  function replAll() {
    if (!S.cur || S.cur.trashed || !$('#find-q').value.trim()) return;
    const n = NoteEditor.replaceAll($('#repl-q').value);
    toast(n ? `${n}곳을 바꿨습니다 (Ctrl+Z 로 되돌리기)` : '바꿀 곳이 없습니다');
    findRun(0);
  }
  $('#repl-q').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); if (e.ctrlKey || e.metaKey) replAll(); else replOne(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFind(); }
  });

  let findTimer = 0;
  $('#find-q').addEventListener('input', () => { clearTimeout(findTimer); findTimer = setTimeout(() => findRun(0), 150); });
  $('#find-q').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); findRun(e.shiftKey ? -1 : 1); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFind(); }
  });

  function itemHtml(n) {
    const { table, showNb, dateKey } = listCtx;
    const snip = (S.hits && S.hits.get(n.id)) || n.snippet || '';
    const cls = [S.cur && S.cur.id === n.id ? 'active' : '', S.sel && S.sel.has(n.id) ? 'sel' : ''].filter(Boolean).join(' ');
    const act = cls ? ` class="${cls}"` : '';
    const title = hlHtml(n.title || '제목 없음');
    const marks = markHtml(n);
    // 태그는 하나씩 따로(누르면 그 태그만 보기)
    const tags = n.tags.map(t => `<span class="tg-i" data-tag="${esc(t)}">#${esc(t)}</span>`).join(' ');
    if (table) {
      return `<li data-id="${esc(n.id)}"${act}${n.trashed ? '' : ' draggable="true"'}>
        <div class="mk">${marks}</div>
        <div class="d" title="${fmtDate(n.created, true)}">${fmtDay(n.created)}</div>
        <div class="d" title="${fmtDate(n.updated, true)}">${fmtDay(n.updated)}</div>
        <div class="t${n.title ? '' : ' untitled'}">${title}</div>
        <div class="s">${hlHtml(snip)}</div>
        <div class="nb">${esc(nbName(n.notebook))}</div>
        <div class="tg">${tags}</div>
      </li>`;
    }
    return `<li data-id="${esc(n.id)}"${act}${n.trashed ? '' : ' draggable="true"'}>
      <div class="t${n.title ? '' : ' untitled'}">${title}</div>
      <div class="s">${hlHtml(snip)}</div>
      <div class="m"><span title="${dateKey === 'created' ? '생성' : '수정'} ${fmtDate(n[dateKey], true)}">${dateKey === 'created' ? '생성 ' : ''}${fmtDate(n[dateKey])}</span>${showNb ? `<span>${esc(nbName(n.notebook))}</span>` : ''}${marks ? `<span class="mk">${marks}</span>` : ''}${tags ? `<span>${tags}</span>` : ''}</div>
    </li>`;
  }

  /** 목록의 즐겨찾기(★)·고정(📌) 표시 (휴지통에서는 안 보임) */
  function markHtml(n) {
    const [img, other] = n.att || [0, 0];
    const att = (img ? `<span class="mk-att" title="이미지 ${img}개">${ICON.image}</span>` : '')
      + (other ? `<span class="mk-att" title="첨부파일 ${other}개">${ICON.clip}</span>` : '');
    if (n.trashed) return att;
    return (n.fixed ? `<span class="mk-fix" title="맨 위에 고정">${ICON.pin}</span>` : '') + (n.pinned ? `<span class="mk-fav" title="즐겨찾기">${ICON.star}</span>` : '') + att;
  }
  const IMG_RE = /\.(png|jpe?g|gif|webp|bmp|svg|heic|avif)$/i;
  /** 열린 노트의 첨부 목록으로 목록 표시(🖼·📎) 개수를 맞춤 */
  function syncAtt(id, files) {
    const n = S.notes.get(id);
    if (!n) return;
    const img = files.filter(f => IMG_RE.test(f.name)).length, other = files.length - img;
    const was = n.att || [0, 0];
    if (was[0] === img && was[1] === other) return;
    if (img || other) n.att = [img, other]; else delete n.att;
    renderList();
  }

  // S.page = 지금까지 그린 묶음 수. 저장 등으로 다시 그릴 때도 그만큼은 유지해서 스크롤 위치가 튀지 않게 한다
  function renderList() {
    listAll = visibleNotes();
    const table = S.layout === 'rows' && !isMobile();
    listCtx = { table, showNb: S.view.type !== 'notebook', dateKey: S.sort.key === 'created' ? 'created' : 'updated' };
    if (table) renderHead();
    S.page = Math.max(1, S.page || 1);
    const arr = listAll.slice(0, S.page * CHUNK);
    $('#notes').innerHTML = arr.map(itemHtml).join('') || `<li class="empty">${!S.loaded ? '불러오는 중…' : S.hits ? '검색 결과가 없습니다' : (S.filter.from || S.filter.to) ? '이 기간에 노트가 없습니다' : '노트가 없습니다'}</li>`;
    renderCount();
    fillList();
  }

  // ---------- 목록 여러 개 선택: Shift+클릭 = 하나씩 넣고 빼기, Ctrl+클릭 = 구간, Ctrl+C = 복사, Esc = 풀기 ----------
  S.sel = new Set();
  S.selAnchor = null;
  function paintSel() {
    $$('#notes li[data-id]').forEach(li => li.classList.toggle('sel', S.sel.has(li.dataset.id)));
    const n = S.sel.size;
    const cnt = $('#sel-count');
    if (cnt) { cnt.hidden = !n; cnt.textContent = n ? `${n}개 선택 · Ctrl+C 제목 복사 · Del 휴지통 · Esc 풀기` : ''; }
  }
  function clearSel() {
    if (!S.sel.size) return;
    S.sel.clear();
    paintSel();
  }
  function selClick(li, e) {
    const id = li.dataset.id;
    if (e.shiftKey) {
      // 처음 고를 때는 지금 열린 노트도 같이
      if (!S.sel.size && S.cur && S.cur.id !== id && listAll.some(n => n.id === S.cur.id)) S.sel.add(S.cur.id);
      if (S.sel.has(id)) S.sel.delete(id); else S.sel.add(id);
      S.selAnchor = id;
    } else {
      const ids = listAll.map(n => n.id);
      const from = ids.indexOf(S.selAnchor || (S.cur && S.cur.id) || id), to = ids.indexOf(id);
      if (from < 0 || to < 0) { S.sel = new Set([id]); }
      else {
        const [a, b] = from < to ? [from, to] : [to, from];
        S.sel = new Set(ids.slice(a, b + 1));
      }
    }
    paintSel();
  }
  /** 선택한(없으면 열린) 노트들의 제목만 한 줄에 하나씩 복사 (목록 순서) */
  async function copyListRows() {
    const ids = S.sel.size ? listAll.filter(n => S.sel.has(n.id)) : (S.cur ? listAll.filter(n => n.id === S.cur.id) : []);
    if (!ids.length) return false;
    const text = ids.map(n => String(n.title || '제목 없음').replace(/[\r\n]+/g, ' ').trim()).join('\n');
    const ok = await copyText(text);
    toast(ok ? `제목 ${ids.length}개를 복사했습니다` : '복사하지 못했습니다');
    return true;
  }
  document.addEventListener('keydown', e => {
    const t = e.target;
    const typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    if (e.key === 'Escape' && S.sel.size && !typing && !document.querySelector('dialog[open]')) { clearSel(); return; }
    // Ctrl+A: 글 쓰는 칸 밖이면 목록의 노트 전체 선택 (지금 보기·검색 조건에 맞는 노트 모두)
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'a' && !typing && !document.querySelector('dialog[open]')
        && !POPUP && S.layout !== 'full' && listAll.length) {
      e.preventDefault();
      S.sel = new Set(listAll.map(n => n.id));
      S.selAnchor = listAll[0].id;
      paintSel();
      toast(`노트 ${S.sel.size.toLocaleString()}개를 골랐습니다`);
      return;
    }
    // 목록 쪽(글 쓰는 칸 밖)에서 Esc: 떠 있는 메뉴가 없고 검색창이 열려 있으면 닫음
    if (e.key === 'Escape' && !typing && !$('#search-bar').hidden && S.layout !== 'full' && !document.querySelector('dialog[open]')
        && $('#ctx-menu').hidden && $('#tag-drop').hidden && $('#ed-menu').hidden && $('#macro-menu').hidden) { closeSearch(); return; }
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'c' || typing) return;
    if (String(window.getSelection && window.getSelection()) !== '') return;   // 글자를 고른 상태면 원래 복사
    if (!S.sel.size) return;   // 여러 개 고른 게 없으면 브라우저 기본 동작
    e.preventDefault();
    copyListRows();
  });
  // ---------- 노트를 끌어서 왼쪽 노트북에 놓으면 그 노트북으로 옮기기 (한 번 물어봄) ----------
  // 고른 노트(Shift·Ctrl+클릭, Ctrl+A) 위에서 끌면 고른 것 모두, 아니면 끈 노트 하나
  let dragIds = null;
  $('#notes').addEventListener('dragstart', e => {
    const li = e.target.closest && e.target.closest('li[data-id]');
    if (!li) return;
    dragIds = S.sel.size && S.sel.has(li.dataset.id) ? listAll.filter(n => S.sel.has(n.id)).map(n => n.id) : [li.dataset.id];
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragIds.map(id => (S.notes.get(id) || {}).title || '').join('\n'));
    // 끄는 동안 보이는 꼬리표: "노트 N개" 또는 제목
    const tag = document.createElement('div');
    tag.className = 'drag-tag';
    tag.textContent = dragIds.length > 1 ? `📄 노트 ${dragIds.length.toLocaleString()}개` : '📄 ' + ((S.notes.get(dragIds[0]) || {}).title || '제목 없음');
    document.body.appendChild(tag);
    e.dataTransfer.setDragImage(tag, 12, 12);
    setTimeout(() => tag.remove(), 0);
    app.classList.add('dragging-notes');
  });
  $('#notes').addEventListener('dragend', () => { dragIds = null; app.classList.remove('dragging-notes'); $$('.nav-item.drop-on').forEach(x => x.classList.remove('drop-on')); });
  const dropNb = e => dragIds && e.target.closest && e.target.closest('#side .nav-item[data-view="notebook"][data-id]');
  $('#side').addEventListener('dragover', e => {
    const t = dropNb(e);
    if (!t) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    $$('.nav-item.drop-on').forEach(x => { if (x !== t) x.classList.remove('drop-on'); });
    t.classList.add('drop-on');
  });
  $('#side').addEventListener('dragleave', e => {
    const t = dropNb(e);
    if (t && !t.contains(e.relatedTarget)) t.classList.remove('drop-on');
  });
  $('#side').addEventListener('drop', async e => {
    const t = dropNb(e);
    if (!t) return;
    e.preventDefault();
    t.classList.remove('drop-on');
    const ids = dragIds || [];
    dragIds = null;
    const nb = t.dataset.id, name = nbName(nb);
    const move = ids.filter(id => { const n = S.notes.get(id); return n && !n.trashed && n.notebook !== nb; });
    if (!move.length) { toast(`이미 "${name}" 노트북에 있습니다`); return; }
    const what = move.length > 1 ? `노트 ${move.length.toLocaleString()}개를` : `"${(S.notes.get(move[0]) || {}).title || '제목 없음'}" 노트를`;
    if (!confirm(`${what} "${name}" 노트북으로 옮길까요?`)) return;
    await moveNotes(move, nb);
  });
  /** 노트들을 노트북으로 옮김. 많아도 목록은 끝에 한 번만 다시 그림 */
  async function moveNotes(ids, nb) {
    let done = 0, failed = 0;
    for (const id of ids) {
      try {
        if (S.cur && S.cur.id === id) { await saveFields({ notebook: nb }); done++; continue; }
        const m = S.notes.get(id);
        if (!m) continue;
        const j = await post('save', { id, rev: m.rev, notebook: nb });
        if (j.conflict) { failed++; continue; }
        if (m.att && !('att' in j.note)) j.note.att = m.att;
        S.notes.set(id, j.note);
        done++;
        if (ids.length > 20 && done % 20 === 0) toast(`옮기는 중… ${done} / ${ids.length}`);
      } catch (err) { failed++; }
    }
    clearSel();
    renderSide(); renderList();
    toast(`"${nbName(nb)}" 노트북으로 ${done.toLocaleString()}개 옮겼습니다` + (failed ? ` (${failed}개 실패 — 새로고침 뒤 다시)` : ''));
  }

  // Shift+클릭 때 글자가 드래그 선택되지 않게
  $('#notes').addEventListener('mousedown', e => {
    if ((e.shiftKey || e.ctrlKey || e.metaKey) && e.target.closest('li[data-id]')) e.preventDefault();
  });

  function markActive() {
    const id = S.cur ? S.cur.id : null;
    $$('#notes li.active').forEach(li => { if (li.dataset.id !== id) li.classList.remove('active'); });
    if (id) $(`#notes li[data-id="${CSS.escape(id)}"]`)?.classList.add('active');
  }

  function shownCount() { return Math.min(listAll.length, S.page * CHUNK); }
  function renderCount() {
    const total = listAll.length, shown = shownCount();
    // 아래로 스크롤하면 이어서 불러오므로 "더 보기" 버튼은 두지 않고 개수만
    $('#pager').innerHTML = !total ? '' : shown < total
      ? `<span class="pg-info">${shown} / ${total}개</span>`
      : `<span class="pg-info">${total}개</span>`;
    // 여러 개 고른 개수 (목록 아래)
    $('#pager').insertAdjacentHTML('beforeend', ' <span id="sel-count" hidden></span>');
    if (S.sel && S.sel.size) paintSel();
  }

  function loadMore() {
    if (shownCount() >= listAll.length) return false;
    const from = shownCount();
    S.page++;
    $('#notes').insertAdjacentHTML('beforeend', listAll.slice(from, shownCount()).map(itemHtml).join(''));
    renderCount();
    return true;
  }

  // 화면이 커서 첫 묶음으로 스크롤이 안 생기면 스크롤이 생길 때까지 더 그린다
  function fillList() {
    const el = $('#notes');
    let guard = 20;
    while (guard-- > 0 && el.clientHeight && el.scrollHeight - el.clientHeight < 200 && loadMore()) { /* 계속 */ }
  }
  // 목록에서 더블클릭 → 그 노트만 새 창에서 전체화면으로 편집 (같은 노트는 같은 창을 다시 씀)
  $('#notes').addEventListener('dblclick', async e => {
    if (e.target.closest('.tg-i')) return;   // 태그는 한 번 누르기로 거름(아래 click)
    const li = e.target.closest('li[data-id]');
    if (!li || isMobile()) return;
    window.getSelection()?.removeAllRanges();
    await openInWindow(li.dataset.id);
  });
  /** 노트 하나를 새 창에서 전체화면으로 (같은 노트는 같은 창을 다시 씀) */
  async function openInWindow(id) {
    await flush();
    // 전에 새 창 크기·위치를 바꿨으면 그대로, 아니면 화면 가운데 큼직하게
    const r = pref.get('popupRect', null);
    const w = r ? r.w : Math.min(1200, screen.availWidth - 40), h = r ? r.h : screen.availHeight - 60;
    const x = r ? r.x : Math.round((screen.availWidth - w) / 2), y = r ? r.y : 20;
    const win = window.open('./?n=' + encodeURIComponent(id), 'note-' + id, `width=${w},height=${h},left=${x},top=${y}`);
    if (win) win.focus(); else toast('팝업이 막혔습니다. 브라우저에서 이 사이트의 팝업을 허용해 주세요');
  }
  $('#notes').addEventListener('scroll', () => {
    const el = $('#notes');
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 400) loadMore();
  }, { passive: true });

  // 목록을 처음부터 다시 보여 줄 때(보기·검색·정렬·필터가 바뀜)
  function resetList() {
    S.page = 1;
    $('#notes').scrollTop = 0;
  }

  // ---------- 화면 배치: 좌우(cols) / 위아래(rows) / 내용 전체(full) ----------
  function setLayout(l, save = true) {
    if (!['cols', 'rows', 'full'].includes(l)) l = 'cols';
    if (save) S.layoutBack = null;
    S.layout = l;
    app.classList.remove('layout-cols', 'layout-rows', 'layout-full');
    app.classList.add('layout-' + l);
    $$('.layout-sw [data-layout]').forEach(b => b.classList.toggle('on', b.dataset.layout === l));
    if (save) pref.set('layout2', l);
    if (l !== 'full' && !POPUP) pref.set('layoutPrev', l);   // "이전화면" 이 돌아갈 배치
    renderList();   // 위아래 배치는 표, 나머지는 카드
  }

  /** 전체화면 → 그 전에 쓰던 배치(좌우/위아래)로 */
  function prevLayout() {
    setLayout(S.layoutBack || pref.get('layoutPrev', 'cols'));
    requestAnimationFrame(() => document.querySelector('#notes li.active')?.scrollIntoView({ block: 'nearest' }));
  }

  // ---------- 끌어서 크기 조절: 사이드바 너비, 목록 너비(좌우) / 목록 높이(위아래), 표 칸 너비 ----------
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  S.size = Object.assign({ side: 230, list: 320, listH: 0 }, pref.get('size', {}));
  function applySize() {
    app.style.setProperty('--side-w', S.size.side + 'px');
    app.style.setProperty('--list-w', S.size.list + 'px');
    app.style.setProperty('--list-h', S.size.listH ? S.size.listH + 'px' : '45%');
  }

  // 끌기 공통: 누른 요소에 포인터를 붙잡아 두고, 놓으면 저장
  function drag(el, e, onMove, onEnd, cursor) {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
    document.body.style.cursor = cursor;
    const sx = e.clientX, sy = e.clientY;
    const move = ev => onMove(ev.clientX - sx, ev.clientY - sy);
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      document.body.classList.remove('resizing');
      document.body.style.cursor = '';
      onEnd();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  $$('.split').forEach(sp => {
    sp.addEventListener('pointerdown', e => {
      if (isMobile() || e.button !== 0) return;
      const which = sp.dataset.split, rows = S.layout === 'rows';
      const st = { ...S.size, h: $('#list').getBoundingClientRect().height };
      sp.classList.add('drag');
      drag(sp, e, (dx, dy) => {
        if (which === 'side') S.size.side = clamp(st.side + dx, 160, 480);
        else if (rows) S.size.listH = clamp(st.h + dy, 120, window.innerHeight - 160);
        else S.size.list = clamp(st.list + dx, 220, window.innerWidth - S.size.side - 320);
        applySize();
      }, () => { sp.classList.remove('drag'); pref.set('size', S.size); },
      which === 'list' && rows ? 'row-resize' : 'col-resize');
    });
    // 두 번 누르면 기본 크기
    sp.addEventListener('dblclick', () => {
      if (sp.dataset.split === 'side') S.size.side = 230;
      else if (S.layout === 'rows') S.size.listH = 0;
      else S.size.list = 320;
      applySize(); pref.set('size', S.size);
    });
  });

  // 표 머리글의 칸 경계를 끌어 칸 너비 조절
  let justResized = false;
  $('#list-head').addEventListener('pointerdown', e => {
    const g = e.target.closest('.col-grip');
    if (!g || e.button !== 0) return;
    e.stopPropagation();
    const id = g.dataset.col, w0 = S.colW[id];
    drag(g, e, dx => { S.colW[id] = clamp(w0 + dx, 50, 800); applyColW(); },
      () => { pref.set('colW', S.colW); justResized = true; setTimeout(() => { justResized = false; }, 0); }, 'col-resize');
  });
  $('#list-head').addEventListener('dblclick', e => {
    const g = e.target.closest('.col-grip');
    if (!g) return;
    delete S.colW[g.dataset.col];
    S.colW = Object.assign({ created: 88, updated: 88, title: 260, notebook: 100, tags: 120 }, S.colW);
    applyColW(); pref.set('colW', S.colW);
  });
  $('#list-head').addEventListener('click', e => {
    if (justResized) return;
    const h = e.target.closest('[data-sort]');
    if (!h) return;
    const k = h.dataset.sort;
    // 같은 칸을 다시 누르면 방향만 바꿈. 날짜는 최신순, 글자는 ㄱ→ㅎ 부터
    const dir = S.sort.key === k ? (S.sort.dir === 'asc' ? 'desc' : 'asc') : (k === 'created' || k === 'updated' ? 'desc' : 'asc');
    setSort(k, dir);
  });

  // ---------- 태그 목록 접기/펼치기 (기본 접힘) ----------
  function setTagsOpen(open) {
    S.tagsOpen = open;
    $('#tag-list').hidden = !open;
    const b = $('[data-act="toggle-tags"]');
    b.setAttribute('aria-expanded', String(open));
    b.querySelector('.caret').textContent = open ? '▾' : '▸';
    pref.set('tagsOpen', open);
  }

  // 표가 화면보다 넓어 가로로 밀면 머리글도 같이 민다
  $('#notes').addEventListener('scroll', () => { $('#list-head').scrollLeft = $('#notes').scrollLeft; }, { passive: true });

  // PC ↔ 휴대폰 폭이 바뀌면 표/카드 목록을 다시 그림
  matchMedia('(max-width: 767px)').addEventListener('change', () => renderList());

  applySize();
  applyColW();
  setTagsOpen(pref.get('tagsOpen', false));
  // 마지막에 보던 보기(노트북·태그 등)로 시작
  { const v = pref.get('view', null); if (!POPUP && v && ['all', 'fixed', 'pinned', 'att', 'trash', 'notebook', 'tag'].includes(v.type)) S.view = v.type === 'tag' ? { type: 'tag', ids: viewTags(v), back: v.back || { type: 'all' } } : v; }

  /** 태그 조건 넣기/빼기. 이미 태그로 거르고 있으면 AND 로 더하고, 다 빼면 거르기 전 보기로 */
  async function toggleTagFilter(t) {
    const cur = viewTags(S.view);
    const next = cur.includes(t) ? cur.filter(x => x !== t) : [...cur, t];
    if (next.length) return setView({ type: 'tag', ids: next, back: S.view.type === 'tag' ? S.view.back : S.view });
    let back = S.view.back || { type: 'all' };
    if (back.type === 'notebook' && !S.notebooks.some(n => n.id === back.id)) back = { type: 'all' };
    return setView(back);
  }
  setLayout(pref.get('layout2', (() => { try { return localStorage.getItem('note.layout') || 'cols'; } catch { return 'cols'; } })()));

  async function setView(v) {
    if (S.sel && S.sel.size) { S.sel.clear(); S.selAnchor = null; }   // 다른 보기로 가면 여러 개 선택은 풂
    await flush();
    await cleanupEmpty();
    // 태그 보기는 들어오기 전 보기(노트북 등)를 back 에 기억 → 조건을 다 빼면 거기로 돌아감
    if (v.type === 'tag') v = { type: 'tag', ids: viewTags(v), back: v.back || (S.view.type === 'tag' ? S.view.back : S.view) || { type: 'all' } };
    S.view = v;
    if (!POPUP) pref.set('view', v);   // 새로고침·다시 접속해도 이 보기(노트북 등)로
    resetList();
    $('#q').value = ''; S.hits = null; markSearchBusy();
    renderSide(); renderList();
    app.classList.remove('side-open');
    if (isMobile()) showList(true);
  }

  // ---------- 검색 ----------
  let searchTimer;
  $('#q').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      const q = $('#q').value.trim();
      const seq = ++S.searchSeq;
      resetList();
      if (!q) { S.hits = null; renderList(); applyHL(); return; }
      try {
        const j = await get('search', { q, trash: S.view.type === 'trash' ? '1' : '' });
        if (seq !== S.searchSeq) return;
        S.hits = new Map(j.hits.map(h => [h.id, h.snippet]));
        renderList();
        applyHL();   // 열려 있는 노트 본문에도 검색어 표시
      } catch (e) { fail(e); }
    }, 300);
  });

  // ---------- 에디터 ----------
  NoteEditor.create($('#ed-wysiwyg'), {
    onChange: () => { markDirty(); autoTitle(); },
    onAttach: () => { if (S.cur && !S.cur.trashed) $('#file-input').click(); },
    notify: msg => toast(msg),
    // 탭을 바꾸면 이 노트의 보기 방식으로 기억(서버에 저장 → 다음에 열 때, 다른 기기에서도 그 방식으로)
    onModeChange: mode => {
      const c = S.cur;
      if (!c || c.trashed || c.view === mode) return;
      c.view = mode;
      const m = S.notes.get(c.id);
      if (m) m.view = mode;
      post('note_view', { id: c.id, view: mode }).catch(() => {});
    },
    // 그림 크게 보기의 "다운로드": 저장할 곳 고르는 창 → 받기
    downloadFile: url => downloadAs(url),
    // 에디터에 내용을 넣을 때 이 요소들의 스크롤은 그대로 둔다
    keepScroll: ['#notes', '#list-head', '#ed-body', '#ed-wysiwyg .toastui-editor-main', '#ed-wysiwyg .ne-src-wrap', '#ed-view'],
    onSourceInput: () => { if (S.cur) { markDirty(); autoTitle(); } },
    beforeLeaveSource: () => { if (S.dirty) save().catch(fail); },
    uploadImage: async blob => {
      const name = blob.name && blob.name !== 'image.png' ? blob.name : pasteName(blob.type);
      const r = await uploadFile(new File([blob], name, { type: blob.type }));
      return { url: fileUrl(S.cur.id, r.name), name: r.name };
    },
  });

  function pasteName(type) {
    const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    return `paste-${stamp}.${((type || '').split('/')[1] || 'png').replace('jpeg', 'jpg')}`;
  }

  // ---------- 노트 열기 ----------
  async function openNote(id) {
    if (S.cur && S.cur.id === id) { if (isMobile()) showEditor(); return; }
    await flush();
    await cleanupEmpty();
    const seq = ++S.openSeq;
    let j;
    try { j = await get('note', { id }); } catch (e) { return fail(e); }
    if (seq !== S.openSeq) return;
    S.cur = { ...j.note, files: j.files };
    syncAtt(j.note.id, j.files || []);
    S.dirty = false;
    renderEditor();
    // 다른 노트는 맨 위부터 (본문만 스크롤되는 칸들)
    $$('#ed-body, #ed-view, #ed-wysiwyg .toastui-editor-main, #ed-wysiwyg .ne-src-wrap').forEach(el => { el.scrollTop = 0; });
    markActive();   // 목록 전체를 다시 그리지 않는다(빠르고, 더블클릭 대상이 바뀌지 않게)
    if (isMobile()) showEditor();
  }

  function renderEditor() {
    const c = S.cur;
    $('#ed-empty').hidden = !!c;
    $('#ed-body').hidden = !c;
    const bar = ['#btn-more', '#btn-macro', '#macro-bar', '#btn-pin', '#btn-fix', '#btn-trash', '#btn-restore', '#btn-purge', '#save-state'];
    renderNbLabel();
    if (!c) { bar.forEach(s => $(s).hidden = true); S.base = null; $('#find-bar').hidden = true; NoteEditor.highlight([]); return; }
    const tr = !!c.trashed;
    $('#btn-more').hidden = false; $('#ed-nb').value = c.notebook; $('#ed-nb').disabled = tr;
    $('#btn-pin').hidden = tr; $('#btn-fix').hidden = tr; renderMarkBtns();
    $('#btn-macro').hidden = tr; $('#macro-bar').hidden = tr;
    $('#find-repl-btn').hidden = tr; if (tr) setReplOpen(false);
    $('#btn-trash').hidden = tr;
    $('#btn-restore').hidden = !tr; $('#btn-purge').hidden = !tr;
    $('#save-state').hidden = false; $('#save-state').textContent = '';
    $('#ed-title').value = c.title; $('#ed-title').readOnly = tr;
    closePops(); renderTagPick();
    // 휴지통 노트는 읽기 전용 보기, 나머지는 바로 편집
    $('#ed-wysiwyg').hidden = tr;
    $('#ed-view').hidden = !tr;
    if (tr) { renderMd(); S.base = null; setTimeout(applyHL, 0); }
    else {
      // 기본 보기 = 소스(txt 그대로). 에디터(위지윅)에는 그 탭을 누를 때 넣는다(빠르고 목록 스크롤이 안 움직임)
      S.base = { title: c.title, md: NoteEditor.openSource(c.body), tags: [...c.tags] };
      // 기본 보기 = 위지윅(새 노트도). 이 노트를 마지막으로 소스로 봤으면 소스로 (예전 마크다운 탭으로 본 노트도 소스)
      if (c.view !== 'source' && c.view !== 'markdown') NoteEditor.setMode('wysiwyg');
      // 제목 없는 노트: 지금 본문 줄 수를 기억(1줄 → 2줄이 되는 순간 첫 줄을 제목으로)
      S.autoLines = c.title.trim() ? null : NoteEditor.lineCount();
      setTimeout(applyHL, 0);   // 검색어·찾기 글 표시
    }
    renderFiles();
    renderMeta();
  }

  function renderMeta() {
    const c = S.cur;
    $('#ed-meta').textContent = `만든 날 ${fmtDate(c.created, true)} · 수정 ${fmtDate(c.updated, true)}${c.trashed ? ' · 휴지통' : ''}`;
  }

  // 휴지통 노트 보기 (읽기 전용)
  /** 본문 마크다운 → 안전한 HTML (읽기 보기·인쇄에 씀) */
  function mdToHtml(md) {
    if (!(window.marked && window.DOMPurify)) return '<div style="white-space:pre-wrap">' + esc(md) + '</div>';
    if (!mdToHtml.ready) {
      // 글 속 HTML 태그는 글자로 보여 주되, 줄바꿈 <br> 만은 적용(표 칸 안 줄바꿈)
      marked.use({ renderer: { html(h) { const t = typeof h === 'string' ? h : h.text; return /^<br\s*\/?>$/i.test(t.trim()) ? '<br>' : esc(t); } } });
      mdToHtml.ready = true;
    }
    return DOMPurify.sanitize(marked.parse(md, { gfm: true, breaks: true }));
  }

  function renderMd() {
    const c = S.cur, el = $('#ed-view');
    el.innerHTML = mdToHtml(c.body);
    el.querySelectorAll('a').forEach(a => {
      if (/^https?:/i.test(a.getAttribute('href') || '')) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    });
    el.querySelectorAll('input[type=checkbox]').forEach(cb => { cb.disabled = true; });
  }

  function renderFiles() {
    const c = S.cur;
    const files = c.files || [];
    // 소스 탭 그림 모음: 본문에 안 쓴 첨부 그림도 보이게
    NoteEditor.setAttachImages(files.filter(f => IMG_RE.test(f.name)).map(f => fileUrl(c.id, f.name)));
    $('#ed-files').innerHTML = (files.length ? `<span class="ef-head">첨부 ${files.length}개</span>` : '') + files.map(f =>
      `<span class="ef-item"><a href="${esc(fileUrl(c.id, f.name, true))}" data-name="${esc(f.name)}" title="눌러서 저장할 곳 고르기 · ${fmtSize(f.size || 0)}">${IMG_RE.test(f.name) ? ICON.image : ICON.clip} ${esc(f.name)}</a>`
      + (c.trashed ? '' : `<button type="button" class="ef-del" data-fdel="${esc(f.name)}" title="이 첨부 지우기 (본문의 그림·링크도 같이)" aria-label="${esc(f.name)} 지우기">✕</button>`)
      + '</span>').join('');
  }

  /** 첨부 지우기: 서버 파일을 지우고, 본문에서 그 파일을 가리키는 그림·링크도 뺀다 */
  async function deleteFile(name) {
    const c = S.cur;
    if (!c || c.trashed) return;
    const url = fileUrl(c.id, name), dl = fileUrl(c.id, name, true);
    const body = NoteEditor.get();
    const used = body.includes(url) || body.includes(dl);
    if (!confirm(`첨부 "${name}" 을(를) 지울까요?` + (used ? '\n본문에 들어 있는 이 그림·링크도 같이 지웁니다.' : '') + '\n되돌릴 수 없습니다.')) return;
    try {
      const j = await post('file_delete', { id: c.id, name });
      if (S.cur !== c) return;
      c.files = j.files;
      renderFiles();
      syncAtt(c.id, j.files);
      if (used) {
        const q = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const u = `(?:${q(url)}|${q(dl)})(?:\\s+"[^"]*")?`;
        const next = body
          .replace(new RegExp(`[ \\t]*!\\[[^\\]]*\\]\\(${u}\\)[ \\t]*\\n?`, 'g'), '')   // 그림
          .replace(new RegExp(`\\[([^\\]]*)\\]\\(${u}\\)[ \\t]?`, 'g'), '')               // 링크
          .replace(new RegExp(`<img[^>]*${q(url)}[^>]*>`, 'g'), '');
        NoteEditor.replaceBody(next);
        markDirty(300);
      }
      toast('첨부를 지웠습니다');
    } catch (e) { fail(e); }
  }
  $('#ed-files').addEventListener('click', e => {
    const b = e.target.closest('[data-fdel]');
    if (b) deleteFile(b.dataset.fdel);
  });

  // ---------- ⋯ 메뉴: 공유 · 복사 · 내보내기 · PDF · 인쇄 · 노트 정보 ----------
  /** 지금 화면에 있는 제목·본문(아직 저장 안 된 것 포함) */
  function curText() {
    const c = S.cur;
    const body = c.trashed ? c.body : NoteEditor.get();
    return { title: c.title || '제목 없음', body };
  }
  const fmtSize = n => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
  const safeName = s => (s.replace(/[\\/:*?"<>|\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || '노트');

  function renderNoteInfo() {
    const c = S.cur;
    if (!c) return;
    const { title, body } = curText();
    const bytes = new TextEncoder().encode(title + '\n' + body).length;
    const files = c.files || [];
    const fileBytes = files.reduce((s, f) => s + (f.size || 0), 0);
    const rows = [
      ['제목', esc(title)],
      ['위치', esc(c.trashed ? '휴지통' : nbName(c.notebook) || '-')],
      ['태그', c.tags.length ? esc('#' + c.tags.join(' #')) : '-'],
      ['작성일', esc(fmtDate(c.created, true))],
      ['수정일', esc(fmtDate(c.updated, true))],
      ['크기', `${fmtSize(bytes)} · ${body.length.toLocaleString()}자 · ${body ? body.split('\n').length.toLocaleString() : 0}줄`],
      ['첨부', files.length ? `${files.length}개 (${fmtSize(fileBytes)})` : '없음'],
    ];
    $('#ed-info').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
    $('#mi-share').hidden = false;
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* 아래 방법으로 */ }
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }

  async function noteCopy() {
    const { title, body } = curText();
    toast(await copyText(title + '\n\n' + body) ? '제목과 내용을 복사했습니다' : '복사하지 못했습니다');
  }

  async function osShare() {
    const { title, body } = curText();
    if (!navigator.share) return false;
    try { await navigator.share({ title, text: title + '\n\n' + body }); return true; }
    catch (e) { return e && e.name === 'AbortError'; }   // 취소는 그냥 끝
  }

  // 폰: 폰의 공유 창(카톡 등) 바로. PC: Windows 공유 창은 쓸 곳이 적어서 우리 공유 창(복사·메일·Gmail)을 띄운다
  async function noteShare() {
    if (isMobile() || matchMedia('(pointer: coarse)').matches) {
      if (await osShare()) return;
      const { title, body } = curText();
      toast(await copyText(title + '\n\n' + body) ? '이 브라우저는 공유가 안 돼서 내용을 복사했습니다' : '공유하지 못했습니다');
      return;
    }
    const { title, body } = curText();
    $('#share-what').textContent = `「${title}」 · ${body.length.toLocaleString()}자`;
    $('#share-note').textContent = body.length > MAIL_MAX ? `메일·Gmail 은 주소 길이 제한 때문에 본문 앞 ${MAIL_MAX.toLocaleString()}자까지만 들어갑니다. 전체는 복사해서 붙여넣으세요.` : '';
    $('#share-dlg').showModal();
  }

  const MAIL_MAX = 1500;   // mailto·Gmail 주소에 넣는 본문 길이(너무 길면 열리지 않음)
  function mailParts() {
    const { title, body } = curText();
    const cut = body.length > MAIL_MAX ? body.slice(0, MAIL_MAX) + '\n\n… (이하 생략)' : body;
    return { subject: title, body: cut };
  }
  async function shareAction(act) {
    const { title, body } = curText();
    if (act === 'share-copy') {
      toast(await copyText(title + '\n\n' + body) ? '복사했습니다. 보낼 곳에 붙여넣으세요 (Ctrl+V)' : '복사하지 못했습니다');
    } else if (act === 'share-mail') {
      const m = mailParts();
      location.href = 'mailto:?subject=' + encodeURIComponent(m.subject) + '&body=' + encodeURIComponent(m.body);
    } else if (act === 'share-gmail') {
      const m = mailParts();
      window.open('https://mail.google.com/mail/?view=cm&fs=1&su=' + encodeURIComponent(m.subject) + '&body=' + encodeURIComponent(m.body), '_blank', 'noopener');
    }
    // (Windows 공유 창은 PC 에서 돌다가 닫혀 버려서 뺐다. 폰은 폰의 공유 창을 그대로 씀)
    $('#share-dlg').close();
  }

  /**
   * 저장할 곳 고르기. 크롬·엣지(PC)는 "다른 이름으로 저장" 창, 안 되는 브라우저(폰 등)는 null → 기본 다운로드 폴더.
   * 창은 버튼을 누른 순간에만 열 수 있어서, 파일을 만들기 전에 먼저 연다. 취소하면 false.
   */
  async function pickSave(name, mime, ext) {
    if (!window.showSaveFilePicker) return null;
    try {
      return await window.showSaveFilePicker({ suggestedName: name, types: [{ description: ext.toUpperCase() + ' 파일', accept: { [mime]: ['.' + ext] } }] });
    } catch (e) {
      if (e && e.name === 'AbortError') return false;   // 사용자가 취소
      return null;   // 막혀 있으면 기본 다운로드로
    }
  }
  async function saveBlob(handle, blob, name) {
    if (handle) {
      const w = await handle.createWritable();
      await w.write(blob); await w.close();
      return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  /** 저장 형식 그대로(첫 줄 제목 + 본문) .txt 로 저장 */
  async function noteExport() {
    const { title, body } = curText();
    const name = safeName(title) + '.txt';
    const handle = await pickSave(name, 'text/plain', 'txt');
    if (handle === false) return;
    await saveBlob(handle, new Blob([title + '\n' + body], { type: 'text/plain;charset=utf-8' }), name);
    toast(((S.cur.files || []).length ? '본문만 저장했습니다 (첨부 파일은 따로 받으세요)' : '저장했습니다'));
  }

  // PDF 라이브러리는 PDF 를 처음 만들 때만 불러온다(약 560KB)
  function loadScript(src) {
    return new Promise((res, rej) => {
      if (document.querySelector(`script[src="${src}"]`)) return res();
      const s = document.createElement('script');
      s.src = src; s.onload = res; s.onerror = () => rej(new Error('PDF 도구를 불러오지 못했습니다'));
      document.head.appendChild(s);
    });
  }

  /** 인쇄용과 같은 모양을 그림으로 떠서 A4 PDF 파일로 저장 (쪽 나눔은 문단 경계에서) */
  async function notePdf() {
    const c = S.cur;
    const { title, body } = curText();
    const name = safeName(title) + '.pdf';
    const handle = await pickSave(name, 'application/pdf', 'pdf');
    if (handle === false) return;
    toast('PDF 만드는 중…');
    await loadScript('assets/vendor/pdf/html2canvas.min.js');
    await loadScript('assets/vendor/pdf/jspdf.umd.min.js');

    // 화면 밖에 A4 폭(약 718px = 190mm)으로 그린다
    const W = 718;
    const box = document.createElement('div');
    box.className = 'pdf-sheet';
    box.style.cssText = `position:fixed;left:-20000px;top:0;width:${W}px;background:#fff;color:#111;`;
    box.innerHTML = `<h1 class="t">${esc(title)}</h1><div class="m">${esc(noteMetaLine(c))}</div><article>${mdToHtml(body)}</article>`;
    document.body.appendChild(box);
    try {
      await Promise.race([
        Promise.all([...box.querySelectorAll('img')].map(im => im.complete ? 0 : new Promise(r => { im.onload = im.onerror = r; }))),
        new Promise(r => setTimeout(r, 3000)),
      ]);
      const { jsPDF } = window.jspdf;
      const pdf = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
      const margin = 10, pageW = 210 - margin * 2, pageH = 297 - margin * 2;
      const pxPerMm = W / pageW, pagePx = Math.floor(pageH * pxPerMm);
      const total = box.scrollHeight;
      // 쪽을 나눌 수 있는 자리 = 문단(블록)이 시작하는 높이
      const tops = [...box.querySelectorAll('h1.t, .m, article > *, article li, article tr')]
        .map(el => el.getBoundingClientRect().top - box.getBoundingClientRect().top).filter(y => y > 0).sort((a, b) => a - b);
      const scale = 2;
      let y = 0, page = 0;
      while (y < total - 1) {
        let end = Math.min(total, y + pagePx);
        if (end < total) {
          const brk = tops.filter(t => t > y + pagePx * 0.5 && t <= y + pagePx).pop();
          if (brk) end = brk;
        }
        const h = Math.ceil(end - y);
        const canvas = await html2canvas(box, { scale, backgroundColor: '#ffffff', useCORS: true, logging: false, x: 0, y, width: W, height: h, windowWidth: W, scrollX: 0, scrollY: 0 });
        if (page++) pdf.addPage();
        pdf.addImage(canvas.toDataURL('image/jpeg', 0.85), 'JPEG', margin, margin, pageW, h / pxPerMm);
        toast(`PDF 만드는 중… ${page}쪽 (${Math.min(100, Math.round(end / total * 100))}%)`);
        y = end;
        if (page > 300) break;   // 너무 긴 글 안전장치
      }
      await saveBlob(handle, pdf.output('blob'), name);
      toast(`PDF로 저장했습니다 (${page}쪽)`);
    } finally {
      box.remove();
    }
  }

  function noteMetaLine(c) {
    return [c.trashed ? '휴지통' : nbName(c.notebook), '작성 ' + fmtDate(c.created, true), '수정 ' + fmtDate(c.updated, true)]
      .concat(c.tags.length ? ['#' + c.tags.join(' #')] : []).filter(Boolean).join(' · ');
  }

  /** 인쇄용 화면을 숨은 틀에 만들어 인쇄 창을 연다 */
  async function notePrint() {
    const c = S.cur;
    const { title, body } = curText();
    const meta = noteMetaLine(c);
    const ifr = document.createElement('iframe');
    ifr.setAttribute('aria-hidden', 'true');
    ifr.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
    document.body.appendChild(ifr);
    const d = ifr.contentDocument;
    d.open();
    d.write(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${esc(safeName(title))}</title>
<style>
  @page { margin: 16mm 14mm; }
  body { font: 11pt/1.7 -apple-system, "Malgun Gothic", "Apple SD Gothic Neo", sans-serif; color: #111; margin: 0; }
  h1.t { font-size: 18pt; margin: 0 0 4px; }
  .m { color: #666; font-size: 9pt; border-bottom: 1px solid #ccc; padding-bottom: 8px; margin-bottom: 14px; }
  img { max-width: 100%; }
  pre, code { font-family: Consolas, "D2Coding", monospace; font-size: 9.5pt; }
  pre { background: #f5f5f5; padding: 8px 10px; white-space: pre-wrap; word-break: break-all; border-radius: 4px; }
  table { border-collapse: collapse; } td, th { border: 1px solid #ccc; padding: 3px 6px; }
  blockquote { border-left: 3px solid #ccc; margin: 0; padding-left: 10px; color: #444; }
  a { color: #1a5fb4; word-break: break-all; }
  p { margin: 2px 0; }
</style></head><body><h1 class="t">${esc(title)}</h1><div class="m">${esc(meta)}</div><article>${mdToHtml(body)}</article></body></html>`);
    d.close();
    // 그림이 다 뜬 뒤에 인쇄(최대 3초 기다림)
    await Promise.race([
      Promise.all([...d.images].map(im => im.complete ? 0 : new Promise(r => { im.onload = im.onerror = r; }))),
      new Promise(r => setTimeout(r, 3000)),
    ]);
    const w = ifr.contentWindow;
    const done = () => setTimeout(() => ifr.remove(), 500);
    w.addEventListener('afterprint', done);
    setTimeout(done, 60000);
    w.focus();
    w.print();
  }

  // ---------- 저장 ----------
  function markDirty(delay = 1000) {
    if (!S.cur || S.cur.trashed) return;
    S.dirty = true;
    $('#save-state').textContent = '수정됨';
    clearTimeout(S.timer);
    S.timer = setTimeout(() => save().catch(fail), delay);
  }

  async function save(keepalive) {
    clearTimeout(S.timer);
    if (S.saving) await S.saving;
    const c = S.cur, base = S.base;
    if (!c || !base || !S.dirty) return;
    S.dirty = false;

    // 에디터가 정리한 모양이 열었을 때와 같으면 원래 txt 를 그대로 둔다(열기만 해도 txt 가 바뀌지 않게)
    const md = NoteEditor.get();
    const bodyChanged = md !== base.md;
    const payload = { id: c.id, rev: c.rev };
    if (c.title !== base.title) payload.title = c.title;
    if (bodyChanged) payload.body = md;
    if (!sameTags(c.tags, base.tags)) payload.tags = c.tags;
    if (Object.keys(payload).length === 2) { $('#save-state').textContent = ''; return; }

    $('#save-state').textContent = '저장 중…';
    S.saving = (async () => {
      try {
        const j = await post('save', payload, keepalive);
        if (j.conflict) return handleConflict(c, md);
        c.rev = j.note.rev;
        if (bodyChanged) c.body = md;
        if (S.base === base) S.base = { title: payload.title ?? base.title, md, tags: payload.tags ?? base.tags };
        applyMeta(j.note);
        if (S.cur === c) { $('#save-state').textContent = '저장됨'; renderMeta(); }
      } catch (e) {
        if (S.cur === c) { S.dirty = true; $('#save-state').textContent = '저장 실패'; }
        throw e;
      } finally { S.saving = null; }
    })();
    return S.saving;
  }
  const flush = () => save().catch(fail);

  async function saveFields(fields) {
    await flush();
    const c = S.cur;
    if (!c) return;
    const j = await post('save', { id: c.id, rev: c.rev, ...fields });
    if (j.conflict) return handleConflict(c, NoteEditor.get());
    serverCheck(fields, j.note);
    c.rev = j.note.rev;
    applyMeta(j.note);
    renderMarkBtns();
  }

  /** 서버 PHP 가 예전 것이면 고정 값이 저장되지 않는다 → 알려 줌 */
  function serverCheck(fields, note) {
    if ('fixed' in fields && !!note.fixed !== !!fields.fixed) {
      alert('고정이 서버에 저장되지 않았습니다.\n서버의 app/lib/Store.php 와 public/api.php 를 새 파일로 올려 주세요.');
    }
  }

  /** 편집 막대의 ☆(즐겨찾기) · 📌(고정) 버튼 모양 */
  function renderMarkBtns() {
    const c = S.cur;
    if (!c) return;
    const p = $('#btn-pin'), f = $('#btn-fix');
    p.classList.toggle('on', !!c.pinned); p.innerHTML = ic(c.pinned ? 'star' : 'star-o'); p.title = c.pinned ? '즐겨찾기에서 빼기' : '즐겨찾기에 추가';
    p.setAttribute('aria-pressed', String(!!c.pinned));
    f.classList.toggle('on', !!c.fixed); f.title = c.fixed ? '고정 풀기' : '목록 맨 위에 고정'; f.setAttribute('aria-pressed', String(!!c.fixed));
  }

  /** 열려 있지 않은 노트도 즐겨찾기·고정 등을 바꾼다 (목록 오른쪽 클릭 메뉴) */
  async function noteFields(id, fields) {
    if (S.cur && S.cur.id === id) return saveFields(fields);
    const m = S.notes.get(id);
    if (!m) return;
    const j = await post('save', { id, rev: m.rev, ...fields });
    if (j.conflict) { await loadState(); toast('다른 곳에서 먼저 바뀌었습니다. 다시 해 주세요'); return; }
    applyMeta(j.note);
    serverCheck(fields, j.note);
  }

  async function handleConflict(mine, md) {
    const j = await post('save', { title: (mine.title || '제목 없음') + ' (충돌 사본)', body: md, notebook: mine.notebook, tags: mine.tags });
    applyMeta(j.note);
    alert('다른 기기에서 먼저 수정된 노트입니다.\n지금 작성한 내용은 "(충돌 사본)" 새 노트로 저장했습니다.');
    S.cur = null; S.dirty = false;
    // save() 안에서 불리므로 저장이 끝난 뒤에 연다(바로 열면 flush 가 자기 자신을 기다림)
    setTimeout(() => loadState().then(() => openNote(j.note.id)).catch(fail), 0);
  }

  // 새로 만들고 아무것도 안 쓴 노트는 나갈 때 지운다
  async function cleanupEmpty() {
    const c = S.cur, id = S.createdEmpty;
    S.createdEmpty = null;
    if (!c || c.id !== id || c.title.trim() || NoteEditor.get().trim() || (c.files || []).length) return;
    try {
      S.dirty = false;
      await post('trash', { id }); await post('purge', { ids: [id] });
      S.notes.delete(id);
      if (S.cur === c) { S.cur = null; renderEditor(); }
      renderSide(); renderList();
    } catch (e) { console.warn(e); }
  }

  // ---------- 제목·태그·노트북 ----------
  $('#ed-title').addEventListener('input', e => { if (S.cur) { S.cur.title = e.target.value.replace(/[\r\n]/g, ' '); markDirty(); } });

  // Esc: 제목·본문(텍스트·위지윅)을 고치는 중이면 커서를 빼서 편집에서 빠져나옴 (떠 있는 메뉴·상자가 있으면 그걸 먼저 닫음)
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || e.isComposing) return;
    const a = document.activeElement;
    if (!a || !(a.id === 'ed-title' || (a.closest && a.closest('#ed-wysiwyg') && (a.isContentEditable || a.tagName === 'TEXTAREA')))) return;
    if (document.querySelector('dialog[open]')) return;
    if (!$('#tag-drop').hidden || !$('#ed-menu').hidden || !$('#macro-menu').hidden || !$('#ctx-menu').hidden) return;
    if ([...document.querySelectorAll('#ed-wysiwyg .toastui-editor-popup')].some(p => p.offsetParent && getComputedStyle(p).display !== 'none')) return;
    e.preventDefault(); e.stopImmediatePropagation();
    a.blur();
    window.getSelection && window.getSelection().removeAllRanges();
  }, true);

  /**
   * 제목을 비워 둔 채 본문을 쓰다가 1줄 → 2줄이 되는 순간(Enter) 첫 줄을 제목으로 옮긴다.
   * 처음부터 여러 줄인 노트, 제목이 있는 노트는 건드리지 않는다. 한글 조합 중에는 기다렸다가.
   */
  S.autoLines = null;
  function autoTitle() {
    const c = S.cur;
    if (!c || c.trashed) return;
    if ($('#ed-title').value.trim()) { S.autoLines = null; return; }
    if (NoteEditor.composing()) return;
    const n = NoteEditor.lineCount();
    const prev = S.autoLines;
    S.autoLines = n;
    if (prev !== 1 || n < 2) return;
    const first = NoteEditor.takeFirstLine();
    // 마크다운 기호(# - * > [ ] ** ` 등)는 제목에서 뺌
    const t = String(first || '').replace(/^\s*(#{1,6}\s+|[-*+]\s+\[[ xX]\]\s+|[-*+>]\s+|\d+\.\s+)/, '').replace(/\*\*|__|`/g, '').trim().slice(0, 200);
    if (!t) { S.autoLines = NoteEditor.lineCount(); return; }
    const ti = $('#ed-title');
    ti.value = t;
    ti.dispatchEvent(new Event('input', { bubbles: true }));
    S.autoLines = null;
    toast('첫 줄을 제목으로 옮겼습니다');
  }
  $('#ed-title').addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    // 한글 입력 중에 Enter 를 누르면 조합이 끝난 뒤에 본문으로 옮긴다(안 그러면 마지막 글자가 본문으로 따라감)
    // 키 이벤트 안에서 옮기면 브라우저가 포커스를 되돌리는 경우가 있어 이벤트가 끝난 뒤에 옮긴다
    const go = () => setTimeout(() => NoteEditor.focus(), 0);
    if (e.isComposing) e.target.addEventListener('compositionend', go, { once: true });
    else go();
  });

  // ---------- 태그 고르기: 최근 쓴 태그 10개 + "…" 를 누르면 전체 목록 ----------
  const TAG_MAX = 40;   // 한 줄 후보로 그려 볼 최근 태그 수(넘치는 건 숨김)
  /** 태그 → [마지막으로 쓴 노트의 수정 시각, 노트 수]. 최근 쓴 순서로 */
  function tagsByRecent() {
    const m = new Map();
    for (const n of S.notes.values()) {
      if (n.trashed) continue;
      for (const t of n.tags) {
        const v = m.get(t);
        if (!v) m.set(t, [n.updated, 1]); else { if (n.updated > v[0]) v[0] = n.updated; v[1]++; }
      }
    }
    return [...m.entries()].sort((a, b) => b[1][0] - a[1][0]);
  }

  // 최근 쓴 순서로 한 줄에 들어가는 만큼 보여 주고, 넘치는 태그는 "더보기" 로
  function renderTagPick() {
    const c = S.cur, box = $('#tag-pick');
    if (!c || c.trashed) { box.innerHTML = ''; return; }
    const all = tagsByRecent().map(([t]) => t);
    // 이 노트에 붙은 태그를 맨 앞에, 그다음 최근 쓴 순서
    const show = [...c.tags, ...all.filter(t => !c.tags.includes(t)).slice(0, TAG_MAX)];
    box.innerHTML = show.map(t => `<button type="button" class="tag-chip${c.tags.includes(t) ? ' on' : ''}" data-tag="${esc(t)}" aria-pressed="${c.tags.includes(t)}">#${esc(t)}</button>`).join('')
      + `<button type="button" class="tag-more" data-act="tag-more" aria-expanded="${!$('#tag-drop').hidden}">${all.length ? '더보기' : '＋ 태그'}</button>`;
    fitTagPick();
    if (!$('#tag-drop').hidden) renderTagAll();
  }

  /** 한 줄을 넘치는 칩은 숨기고, "더보기" 에 숨은 개수를 붙인다 */
  function fitTagPick() {
    const box = $('#tag-pick'), more = box.querySelector('.tag-more');
    if (!more || !box.clientWidth) return;
    if (!tagsByRecent().length) { more.textContent = '＋ 태그'; more.title = '태그 추가'; return; }
    const chips = [...box.querySelectorAll('.tag-chip')];
    chips.forEach(ch => { ch.hidden = false; });
    more.textContent = '더보기 ▾';
    // 폰: 숨기지 않고 전부 한 줄에 두고 손가락으로 좌우로 밀어서 봄("더보기"는 오른쪽 끝에 붙어 있음)
    if (isMobile()) { more.title = `태그 전체 보기 (${tagsByRecent().length}개)`; return; }
    const limit = box.clientWidth - more.offsetWidth - 16;   // "더보기 (00) ▾" 자리를 남김
    let hidden = 0, over = false;
    const left = box.getBoundingClientRect().left;
    const rights = chips.map(ch => ch.getBoundingClientRect().right - left);   // 숨기기 전에 한 번에 잰다
    chips.forEach((ch, i) => {
      if (over || rights[i] > limit) { over = true; ch.hidden = true; hidden++; }   // 최근 순서를 지키려고 넘친 뒤로는 다 숨김
    });
    const total = tagsByRecent().length;
    const shown = chips.length - hidden;
    more.textContent = total > shown ? `더보기 (${total - shown}) ▾` : '더보기 ▾';
    more.title = `태그 전체 보기 (${total}개)`;
  }
  if (window.ResizeObserver) {
    let fr = 0;
    new ResizeObserver(() => { cancelAnimationFrame(fr); fr = requestAnimationFrame(fitTagPick); }).observe($('#tag-pick'));
  }

  function renderTagAll() {
    const c = S.cur;
    if (!c) return;
    const q = $('#tag-q').value.trim().toLowerCase();
    const list = tagsByRecent().filter(([t]) => !q || t.toLowerCase().includes(q));
    const raw = cleanTag($('#tag-q').value);
    const exact = raw && (tagsByRecent().some(([t]) => t.toLowerCase() === raw.toLowerCase()) || c.tags.some(t => t.toLowerCase() === raw.toLowerCase()));
    const add = raw && !exact && !c.trashed
      ? `<li class="tag-new" data-new="${esc(raw)}" role="option"><span class="ck">＋</span><span>"#${esc(raw)}" 새 태그로 추가</span><span class="n">Enter</span></li>` : '';
    $('#tag-all').innerHTML = add + (list.map(([t, [, cnt]]) => {
      const on = c.tags.includes(t);
      return `<li data-tag="${esc(t)}" role="option" aria-selected="${on}"><span class="ck">${on ? '✓' : ''}</span><span>#${esc(t)}</span><span class="n">${cnt}</span></li>`;
    }).join('') || (add ? '' : `<li class="empty">${q ? '맞는 태그가 없습니다' : '태그가 없습니다 · 위 칸에 쓰고 Enter 로 추가'}</li>`));
  }
  /** 새 태그 이름 다듬기: 앞의 #·쉼표 빼고 공백 정리 */
  function cleanTag(s) {
    return String(s || '').replace(/[,#]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 50);
  }
  function addNewTag(t) {
    const c = S.cur;
    t = cleanTag(t);
    if (!c || c.trashed || !t) return;
    if (!c.tags.includes(t)) toggleTag(t);
    $('#tag-q').value = '';
    renderTagAll();
    toast(`#${t} 태그를 붙였습니다`);
  }

  function toggleTag(t) {
    const c = S.cur;
    if (!c || c.trashed) return;
    c.tags = c.tags.includes(t) ? c.tags.filter(x => x !== t) : [...c.tags, t];
    markDirty(10);
    renderTagPick();
  }

  function closePops(except) {
    if (except !== 'tag') { $('#tag-drop').hidden = true; $('#tag-q').value = ''; }
    if (except !== 'menu') { $('#ed-menu').hidden = true; $('#btn-more').setAttribute('aria-expanded', 'false'); }
    if (except !== 'macro') { $('#macro-menu').hidden = true; $('#btn-macro').setAttribute('aria-expanded', 'false'); }
    $('[data-act="tag-more"]')?.setAttribute('aria-expanded', String(!$('#tag-drop').hidden));
  }

  $('#tag-pick').addEventListener('click', e => {
    const b = e.target.closest('[data-tag]');
    if (b) toggleTag(b.dataset.tag);
  });
  $('#tag-all').addEventListener('click', e => {
    const nw = e.target.closest('li[data-new]');
    if (nw) { addNewTag(nw.dataset.new); $('#tag-q').focus(); return; }
    const li = e.target.closest('li[data-tag]');
    if (li) toggleTag(li.dataset.tag);
  });
  $('#tag-q').addEventListener('input', renderTagAll);
  $('#tag-q').addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    // 같은 이름 태그가 있으면 그걸 붙이고/떼고, 없으면 새 태그로 추가
    const raw = cleanTag($('#tag-q').value);
    if (!raw) return;
    const same = $$('#tag-all li[data-tag]').find(li => li.dataset.tag.toLowerCase() === raw.toLowerCase());
    if (same) { toggleTag(same.dataset.tag); $('#tag-q').select(); return; }
    const nw = $('#tag-all li[data-new]');
    if (nw) { addNewTag(nw.dataset.new); return; }
    const first = $('#tag-all li[data-tag]');
    if (first) { toggleTag(first.dataset.tag); $('#tag-q').select(); }
  });
  // 바깥을 누르거나 Esc → 떠 있는 상자 닫기
  document.addEventListener('mousedown', e => {
    if (!e.target.closest('#tag-drop, [data-act="tag-more"], #ed-menu, #btn-more, #ed-nb-label, #macro-menu, #btn-macro')) closePops();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && (!$('#tag-drop').hidden || !$('#ed-menu').hidden || !$('#macro-menu').hidden)) { closePops(); e.stopImmediatePropagation(); }
  }, true);
  $('#ed-nb').addEventListener('change', e => { closePops(); saveFields({ notebook: e.target.value }).then(() => toast('노트북을 옮겼습니다')).catch(fail); });
  document.addEventListener('keydown', e => {
    // Ctrl+H: 찾기·바꾸기
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'h' && S.cur && !S.cur.trashed && !$('#ed-body').hidden && !document.querySelector('dialog[open]')) {
      e.preventDefault(); openFind(true);
    }
    // Ctrl+F (브라우저 찾기 대신)
    //  - 글 내용(제목·태그·본문)이나 이 노트 찾기 칸에 있으면 → 이 노트에서 찾기
    //  - 그 밖(목록·사이드바 등)이면 → 목록 검색창. 목록이 안 보이는 화면(내용 전체보기·새 창·폰 편집 화면)은 이 노트에서 찾기
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f' && !document.querySelector('dialog[open]')) {
      const a = document.activeElement;
      const inNote = !!(a && a.closest && a.closest('#ed-body, #find-bar'));
      const listShown = !POPUP && S.layout !== 'full' && !(isMobile() && app.classList.contains('show-editor'));
      if (!inNote && listShown) { e.preventDefault(); setSearchOpen(true, true); $('#q').select(); }
      else if (S.cur && !$('#ed-body').hidden) { e.preventDefault(); openFind(); }
    }
    if (e.key === 'Escape' && S.layout === 'full' && !POPUP && !e.isComposing && !document.querySelector('dialog[open]')) prevLayout();
  });

  // Ctrl+S: 바로 저장 / F5·Ctrl+R: 페이지 대신 노트 목록만 새로고침 (편집기가 키를 먹기 전에 먼저 받음)
  document.addEventListener('keydown', e => {
    const k = (e.key || '').toLowerCase(), mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey && k === 's') {
      e.preventDefault(); e.stopPropagation();
      saveNow();
    } else if ((e.key === 'F5' && !mod) || (mod && !e.shiftKey && !e.altKey && k === 'r')) {
      e.preventDefault(); e.stopPropagation();
      refreshList();
    }
  }, true);

  async function saveNow() {
    if (!S.cur || S.cur.trashed) return;
    if (S.dirty || S.saving) {
      await flush();
      toast(S.dirty ? '저장하지 못했습니다' : '저장했습니다');
    } else toast('이미 저장되어 있습니다');
  }

  /** 서버에서 노트 목록을 다시 받는다 (고치던 글은 먼저 저장) */
  async function refreshList() {
    const btn = $('#refresh-btn');
    btn.classList.add('spin');
    try {
      await flush();
      await refreshFromServer();
      toast('목록을 새로 불러왔습니다');
    } finally { setTimeout(() => btn.classList.remove('spin'), 400); }
  }

  // ---------- 첨부 ----------
  async function uploadFile(f) {
    const c = S.cur;
    if (!c || c.trashed) throw new Error('노트가 없습니다');
    if (S.uploadMax && f.size > S.uploadMax) throw new Error(`${f.name}: 파일이 너무 큽니다`);
    const fd = new FormData();
    fd.append('id', c.id);
    fd.append('file', f, f.name);
    $('#save-state').textContent = '업로드 중…';
    try {
      const j = await call('upload', { params: { id: c.id }, form: fd });
      c.files = [...(c.files || []), { name: j.name, size: f.size }];
      if (S.cur === c) renderFiles();
      syncAtt(c.id, c.files);
      return j;
    } catch (e) { fail(e); throw e; }
    finally { if (S.cur === c) $('#save-state').textContent = ''; }
  }

  // 📎 버튼: 이미지는 본문에 그림으로, 나머지는 링크로
  $('#file-input').addEventListener('change', async e => {
    const files = [...e.target.files];
    e.target.value = '';
    for (const f of files) {
      const c = S.cur;
      try {
        const j = await uploadFile(f);
        if (S.cur !== c) continue;
        if (j.image) NoteEditor.insertImage(fileUrl(c.id, j.name), '');
        else NoteEditor.insertLink(fileUrl(c.id, j.name), '📎 ' + j.name);
      } catch { /* 이미 알림 */ }
    }
  });

  // ---------- 모바일 화면 전환 ----------
  function showEditor() {
    if (!app.classList.contains('show-editor')) {
      app.classList.add('show-editor');
      history.pushState({ ed: 1 }, '');
    }
  }
  function showList(skipHistory) {
    if (app.classList.contains('show-editor')) {
      app.classList.remove('show-editor');
      if (!skipHistory && history.state && history.state.ed) history.back();
    }
  }
  window.addEventListener('popstate', async () => {
    if (app.classList.contains('show-editor')) {
      app.classList.remove('show-editor');
      await flush(); await cleanupEmpty();
    } else if (app.classList.contains('side-open')) {
      app.classList.remove('side-open');
    }
  });

  // ---------- 버튼 ----------
  document.addEventListener('click', async e => {
    const nav = e.target.closest('[data-view]');
    if (nav) { e.preventDefault(); setView({ type: nav.dataset.view, id: nav.dataset.id }); return; }
    // 목록의 태그 / 목록 위 태그 조건을 누르면 조건을 넣거나 뺀다
    const tg = e.target.closest('#notes .tg-i, #list-title .flt-tag');
    if (tg) { await toggleTagFilter(tg.dataset.tag); return; }
    const li = e.target.closest('#notes li[data-id]');
    if (li) {
      if (e.shiftKey || e.ctrlKey || e.metaKey) { selClick(li, e); return; }   // 여러 개 선택
      clearSel();
      S.selAnchor = li.dataset.id;
      openNote(li.dataset.id);
      return;
    }
    const lay = e.target.closest('.layout-sw [data-layout]');
    if (lay) { setLayout(lay.dataset.layout); return; }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    try {
      switch (b.dataset.act) {
        case 'new': await newNote(); break;
        case 'more': loadMore(); break;
        case 'toggle-search': setSearchOpen($('#search-bar').hidden, true); break;
        case 'tag-more': {
          const open = $('#tag-drop').hidden;
          closePops(open ? 'tag' : undefined);
          $('#tag-drop').hidden = !open;
          b.setAttribute('aria-expanded', String(open));
          if (open) { renderTagAll(); $('#tag-q').focus(); }
          break;
        }
        case 'ed-more': {
          const open = $('#ed-menu').hidden;
          closePops(open ? 'menu' : undefined);
          $('#ed-menu').hidden = !open;
          b.setAttribute('aria-expanded', String(open));
          if (open) renderNoteInfo();
          break;
        }
        case 'note-share': closePops(); await noteShare(); break;
        case 'share-copy': case 'share-mail': case 'share-gmail': await shareAction(b.dataset.act); break;
        case 'share-close': $('#share-dlg').close(); break;
        case 'note-copy': closePops(); await noteCopy(); break;
        case 'note-export': closePops(); await noteExport(); break;
        case 'note-pdf': closePops(); await notePdf(); break;
        case 'note-print': closePops(); await notePrint(); break;
        case 'note-find': closePops(); openFind(); break;
        case 'find-next': findRun(1); break;
        case 'find-prev': findRun(-1); break;
        case 'find-close': closeFind(); break;
        case 'find-repl': { const open = $('#repl-row').hidden; setReplOpen(open); if (open) $('#repl-q').focus(); break; }
        case 'repl-one': replOne(); break;
        case 'repl-all': replAll(); break;
        case 'refresh': await refreshList(); break;
        case 'fix': await saveFields({ fixed: !S.cur.fixed }); toast(S.cur && S.cur.fixed ? '목록 맨 위에 고정했습니다' : '고정을 풀었습니다'); break;
        case 'user-info': await showUserInfo(); break;
        case 'user-close': $('#user-dlg').close(); break;
        case 'macro-menu': case 'macro-edit': case 'macro-add': case 'macro-save': case 'macro-cancel': await macroAction(b.dataset.act); break;
        case 'prev-layout': prevLayout(); break;
        case 'close-win': await flush(); window.close(); break;
        case 'toggle-tags': setTagsOpen(!S.tagsOpen); break;
        case 'backup-open':
          await flush();
          $('#restore-msg').textContent = '';
          $('#backup-dlg').showModal();
          break;
        case 'backup-close': $('#backup-dlg').close(); break;
        case 'restore-run': await runRestore(); break;
        case 'enex-run': await runEnex(); break;
        case 'toggle-filter': {
          const f = $('#filter'), open = f.hidden;
          f.hidden = !open;
          b.setAttribute('aria-expanded', String(open));
          if (open) $('#f-from').focus();
          break;
        }
        case 'filter-clear':
          $('#f-from').value = ''; $('#f-to').value = '';
          onFilterChange();
          break;
        case 'open-side': app.classList.add('side-open'); break;
        case 'close-side': app.classList.remove('side-open'); break;
        case 'back': await flush(); await cleanupEmpty(); showList(); break;
        case 'pin': await saveFields({ pinned: !S.cur.pinned }); break;
        case 'trash': await trashCur(); break;
        case 'restore': {
          const j = await post('restore', { id: S.cur.id });
          applyMeta(j.note); renderEditor(); toast('복원했습니다');
          break;
        }
        case 'purge':
          if (!confirm('이 노트를 영구 삭제할까요? 되돌릴 수 없습니다.')) break;
          await post('purge', { ids: [S.cur.id] });
          S.notes.delete(S.cur.id); S.cur = null;
          renderEditor(); renderSide(); renderList(); showList();
          break;
        case 'empty-trash': {
          const n = [...S.notes.values()].filter(x => x.trashed).length;
          if (!n || !confirm(`휴지통의 노트 ${n}개를 영구 삭제할까요? 되돌릴 수 없습니다.`)) break;
          await post('empty_trash', {});
          for (const [id, x] of S.notes) if (x.trashed) S.notes.delete(id);
          if (S.cur && S.cur.trashed) S.cur = null;
          renderEditor(); renderSide(); renderList();
          break;
        }
        case 'nb-add': {
          const name = prompt('새 노트북 이름');
          if (!name || !name.trim()) break;
          const j = await post('nb_create', { name });
          if (!S.notebooks.some(n => n.id === j.notebook.id)) S.notebooks.push(j.notebook);
          await setView({ type: 'notebook', id: j.notebook.id });
          break;
        }
        case 'nb-menu': await nbEdit(S.view.id); break;
      }
    } catch (err) { fail(err); }
  });

  /** 노트북 이름 바꾸기 / 지우기 */
  async function nbEdit(id) {
    const old = nbName(id);
    const name = prompt('노트북 이름 바꾸기\n(노트북을 지우려면 "삭제" 라고 입력)', old);
    if (name === null || name.trim() === '' || name === old) return;
    if (name.trim() === '삭제') {
      if (!confirm(`"${old}" 노트북을 삭제할까요? (노트가 남아 있으면 지워지지 않습니다)`)) return;
      await post('nb_delete', { nb: id });
      await loadState(); await setView({ type: 'all' });
    } else {
      await post('nb_rename', { nb: id, name });
      S.notebooks.find(n => n.id === id).name = name.trim();
      renderSide(); renderList();
    }
  }

  // ---------- 빠른 입력(매크로): 날짜·시간 템플릿, 자주 쓰는 문구 ----------
  // 서버(macros.json)에 저장 → PC·폰 같이 씀. 아직 저장한 적 없으면 아래 기본값
  const MACRO_DEFAULT = [
    { name: '날짜', text: '{YYYY-MM-DD}', bar: true },
    { name: '시간', text: '{HH:mm:ss}', bar: true },
    { name: '날짜·시간', text: '{YYYY-MM-DD HH:mm}', bar: true },
    { name: '오늘 제목', text: '## {YYYY.MM.DD (요일)}\n', bar: false },
  ];
  const MACRO_BAR_MAX = 5;
  S.macros = MACRO_DEFAULT;

  /** { } 안의 날짜 글자를 지금 시각으로 바꾼다. 예: {YYYY-MM-DD HH:mm:ss}, {M월 D일 (요일) A hh:mm} */
  const TPL_TOKENS = /YYYY|YY|MM|DD|HH|hh|mm|ss|요일|M|D|H|A/g;
  function fillTemplate(text, d = new Date()) {
    const p = n => String(n).padStart(2, '0');
    const h = d.getHours();
    const map = {
      YYYY: d.getFullYear(), YY: String(d.getFullYear()).slice(2), MM: p(d.getMonth() + 1), M: d.getMonth() + 1,
      DD: p(d.getDate()), D: d.getDate(), HH: p(h), H: h, hh: p(h % 12 || 12), mm: p(d.getMinutes()), ss: p(d.getSeconds()),
      '요일': '일월화수목금토'[d.getDay()], A: h < 12 ? '오전' : '오후',
    };
    return text.replace(/\{([^{}\n]{1,60})\}/g, (all, inner) =>
      /YYYY|YY|MM|DD|HH|hh|mm|ss|요일/.test(inner) || /^[MDHA\s:.\-/년월일시분초]+$/.test(inner) ? inner.replace(TPL_TOKENS, t => map[t]) : all);
  }

  // 마지막으로 글을 쓰던 곳: 제목 칸이면 제목에, 아니면 본문(소스·마크다운·위지윅) 커서 자리에 넣는다
  let macroTarget = 'body';
  document.addEventListener('focusin', e => {
    if (e.target.id === 'ed-title') macroTarget = 'title';
    else if (e.target.closest && e.target.closest('#ed-wysiwyg')) macroTarget = 'body';
  });

  function runMacro(m) {
    if (!m) return;
    const c = S.cur;
    if (!c || c.trashed || $('#ed-body').hidden) { toast('편집 중인 노트가 없습니다'); return; }
    const text = fillTemplate(m.text);
    if (macroTarget === 'title') {
      const t = $('#ed-title');
      t.focus();
      t.setRangeText(text.replace(/\s*\n\s*/g, ' '), t.selectionStart, t.selectionEnd, 'end');
      t.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      NoteEditor.insertText(text);
    }
  }

  function renderMacros() {
    const bar = S.macros.map((m, i) => [m, i]).filter(([m]) => m.bar).slice(0, MACRO_BAR_MAX);
    $('#macro-bar').innerHTML = bar.map(([m, i], k) =>
      `<button type="button" class="macro-btn" data-macro="${i}" title="${esc(fillTemplate(m.text))} 넣기 (Alt+${k + 1})">${esc(m.name)}</button>`).join('');
  }
  function renderMacroMenu() {
    $('#macro-menu').innerHTML = (S.macros.length ? S.macros.map((m, i) => {
      const k = S.macros.filter(x => x.bar).slice(0, MACRO_BAR_MAX).indexOf(m);
      return `<button type="button" class="pop-item macro-item" data-macro="${i}"><span class="mi-name">${esc(m.name)}</span>`
        + `<span class="mi-prev">${esc(fillTemplate(m.text).replace(/\n/g, '⏎'))}</span>${k >= 0 ? `<kbd>Alt+${k + 1}</kbd>` : ''}</button>`;
    }).join('') : '<p class="mi-empty">등록한 빠른 입력이 없습니다</p>')
      + '<div class="pop-sep"></div><button type="button" class="pop-item" data-act="macro-edit">⚙ 빠른 입력 관리…</button>';
  }
  // 누를 때 본문 커서(포커스)를 빼앗지 않게
  ['#macro-bar', '#macro-menu', '#btn-macro'].forEach(s => $(s).addEventListener('mousedown', e => { if (e.target.closest('[data-macro], #btn-macro')) e.preventDefault(); }));
  document.addEventListener('click', e => {
    const b = e.target.closest('#macro-bar [data-macro], #macro-menu [data-macro]');
    if (!b) return;
    closePops();
    runMacro(S.macros[Number(b.dataset.macro)]);
  });
  // Alt+1 ~ Alt+5: 막대의 빠른 입력
  document.addEventListener('keydown', e => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || !/^Digit[1-9]$/.test(e.code)) return;
    const m = S.macros.filter(x => x.bar).slice(0, MACRO_BAR_MAX)[Number(e.code.slice(5)) - 1];
    if (!m || !S.cur) return;
    e.preventDefault();
    runMacro(m);
  }, true);

  // ----- 관리 창 -----
  let macroDraft = [];
  function readMacroRows() {
    macroDraft = $$('#macro-rows .macro-row').map(r => ({
      name: r.querySelector('.m-name').value, text: r.querySelector('.m-text').value, bar: r.querySelector('.m-bar').checked,
    }));
  }
  function drawMacroRows() {
    $('#macro-rows').innerHTML = macroDraft.map((m, i) => `<div class="macro-row" data-i="${i}">
      <input class="m-name" maxlength="30" placeholder="이름" value="${esc(m.name)}" aria-label="이름">
      <textarea class="m-text" rows="${Math.min(4, Math.max(1, m.text.split('\n').length))}" placeholder="넣을 글 (예: {YYYY-MM-DD})" aria-label="넣을 글">${esc(m.text)}</textarea>
      <label class="m-bar-l" title="편집 막대에 버튼으로 (최대 ${MACRO_BAR_MAX}개)"><input type="checkbox" class="m-bar"${m.bar ? ' checked' : ''}> 막대</label>
      <span class="m-tools"><button type="button" class="icon" data-mv="-1" title="위로" aria-label="위로">▲</button><button type="button" class="icon" data-mv="1" title="아래로" aria-label="아래로">▼</button><button type="button" class="icon" data-mdel title="지우기" aria-label="지우기">✕</button></span>
      <div class="m-prev">${m.text ? '→ ' + esc(fillTemplate(m.text)) : ''}</div>
    </div>`).join('') || '<p class="mi-empty">아래 "＋ 추가"로 만드세요</p>';
  }
  function openMacroDlg() {
    closePops();
    macroDraft = S.macros.map(m => ({ ...m }));
    drawMacroRows();
    $('#macro-dlg').showModal();
  }
  $('#macro-rows').addEventListener('input', e => {
    const row = e.target.closest('.macro-row');
    if (!row) return;
    if (e.target.classList.contains('m-text')) {
      row.querySelector('.m-prev').textContent = e.target.value ? '→ ' + fillTemplate(e.target.value) : '';
    }
  });
  $('#macro-rows').addEventListener('change', e => {
    if (!e.target.classList.contains('m-bar') || !e.target.checked) return;
    if ($$('#macro-rows .m-bar').filter(x => x.checked).length > MACRO_BAR_MAX) {
      e.target.checked = false;
      toast(`막대에는 ${MACRO_BAR_MAX}개까지 놓을 수 있습니다`);
    }
  });
  $('#macro-rows').addEventListener('click', e => {
    const row = e.target.closest('.macro-row');
    if (!row) return;
    const i = Number(row.dataset.i), mv = e.target.closest('[data-mv]');
    if (!mv && !e.target.closest('[data-mdel]')) return;
    readMacroRows();
    if (mv) {
      const j = i + Number(mv.dataset.mv);
      if (j < 0 || j >= macroDraft.length) return;
      [macroDraft[i], macroDraft[j]] = [macroDraft[j], macroDraft[i]];
    } else macroDraft.splice(i, 1);
    drawMacroRows();
  });
  async function macroAction(act) {
    if (act === 'macro-edit') return openMacroDlg();
    if (act === 'macro-cancel') return $('#macro-dlg').close();
    if (act === 'macro-add') {
      readMacroRows();
      macroDraft.push({ name: '', text: '', bar: macroDraft.filter(m => m.bar).length < MACRO_BAR_MAX });
      drawMacroRows();
      $$('#macro-rows .m-name').pop()?.focus();
      return;
    }
    if (act === 'macro-save') {
      readMacroRows();
      const list = macroDraft.filter(m => m.text.trim());
      const j = await post('macros', { macros: list });
      S.macros = j.macros;
      renderMacros(); renderMacroMenu();
      $('#macro-dlg').close();
      toast('빠른 입력을 저장했습니다');
    }
    if (act === 'macro-menu') {
      const open = $('#macro-menu').hidden;
      closePops(open ? 'macro' : undefined);
      if (open) renderMacroMenu();   // 미리보기 시각을 지금으로
      $('#macro-menu').hidden = !open;
      $('#btn-macro').setAttribute('aria-expanded', String(open));
    }
  }

  // ---------- 사용자 정보 (왼쪽 아래 이름을 누름) ----------
  async function showUserInfo() {
    const dlg = $('#user-dlg'), box = $('#user-info');
    const all = [...S.notes.values()], live = all.filter(n => !n.trashed);
    const tags = new Set(); live.forEach(n => n.tags.forEach(t => tags.add(t)));
    const last = live.reduce((m, n) => Math.max(m, n.updated || 0), 0);
    const u = S.user || {}, trashN = all.length - live.length;
    const rows = usage => [
      ['이름', esc(u.name || '-')],
      ['메일', esc(u.email || '-')],
      ['로그인', esc((u.method || '-') + (u.uid ? ` (${u.uid})` : ''))],
      ['노트', `${live.length.toLocaleString()}개` + (trashN ? ` <span class="muted">(+ 휴지통 ${trashN.toLocaleString()}개)</span>` : '')],
      ['즐겨찾기 · 고정', `${live.filter(n => n.pinned).length}개 · ${live.filter(n => n.fixed).length}개`],
      ['노트북 · 태그', `${S.notebooks.length}개 · ${tags.size}개`],
      ['마지막 수정', last ? esc(fmtDate(last, true)) : '-'],
      ['사용 용량', usage && usage.err ? `<span class="muted">계산하지 못했습니다: ${esc(usage.err)}</span>` : usage ? `<b>${fmtSize(usage.total)}</b>` : '계산 중…'],
      ['└ 노트 글', usage && !usage.err ? `${fmtSize(usage.notesBytes)} (파일 ${usage.noteFiles.toLocaleString()}개)` : ''],
      ['└ 첨부', usage && !usage.err ? `${fmtSize(usage.filesBytes)} (${usage.files.toLocaleString()}개)` : ''],
      ['└ 목록 정보', usage && !usage.err ? fmtSize(usage.otherBytes) : ''],
      ['첨부 한 개 최대', S.uploadMax ? fmtSize(S.uploadMax) : '-'],
    ].filter(r => r[1] !== '');
    const draw = usage => { box.innerHTML = rows(usage).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join(''); };
    draw(null);
    dlg.showModal();
    try { draw((await get('usage')).usage); }
    catch (e) { draw({ err: /알 수 없는 요청/.test(e.message) ? '서버의 public/api.php 를 새 파일로 올려 주세요' : e.message }); }
  }

  // ---------- 오른쪽 클릭 메뉴 ----------
  // 글을 쓰는 곳(입력칸·본문)과 고른 글은 브라우저 메뉴(복사·붙여넣기·맞춤법) 그대로,
  // 목록·노트북·태그·편집 막대는 이 앱 메뉴, 나머지는 메뉴를 안 띄움
  const ctx = $('#ctx-menu');
  let ctxItems = [];
  function closeCtx() { if (!ctx.hidden) { ctx.hidden = true; ctxItems = []; } }
  let ctxXY = [0, 0];
  function openCtx(x, y, items) {
    ctxXY = [x, y];
    ctxItems = items.filter(Boolean);
    ctx.innerHTML = ctxItems.map((it, i) => it === '-' ? '<div class="pop-sep"></div>'
      : `<button type="button" class="pop-item${it.danger ? ' danger' : ''}" role="menuitem" data-ctx="${i}">${it.label}</button>`).join('');
    ctx.hidden = false;
    const w = ctx.offsetWidth, h = ctx.offsetHeight, vw = document.documentElement.clientWidth, vh = window.innerHeight;
    ctx.style.left = Math.max(4, Math.min(x, vw - w - 4)) + 'px';
    ctx.style.top = Math.max(4, y + h > vh - 4 ? y - h : y) + 'px';
  }
  ctx.addEventListener('click', async e => {
    const b = e.target.closest('[data-ctx]');
    if (!b) return;
    const it = ctxItems[Number(b.dataset.ctx)];
    closeCtx();
    try { await it.run(); } catch (err) { fail(err); }
  });
  ctx.addEventListener('contextmenu', e => e.preventDefault());
  document.addEventListener('mousedown', e => { if (!e.target.closest('#ctx-menu')) closeCtx(); }, true);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !ctx.hidden) { e.stopImmediatePropagation(); closeCtx(); } }, true);
  window.addEventListener('resize', closeCtx);
  window.addEventListener('blur', closeCtx);
  document.addEventListener('scroll', closeCtx, true);

  const pinLabel = n => (n.pinned ? `${ic('star-o', 'mi-ic ic-star')}즐겨찾기에서 빼기` : `${ic('star', 'mi-ic ic-star')}즐겨찾기에 추가`);
  const fixLabel = n => (n.fixed ? `${ic('pin', 'mi-ic ic-pin off')}고정 풀기` : `${ic('pin', 'mi-ic ic-pin')}목록 맨 위에 고정`);

  /** 노트를 열고(이미 열려 있으면 그대로) $fn 실행 */
  const withNote = (id, fn) => async () => { await openNote(id); if (S.cur && S.cur.id === id) await fn(); };

  function noteMenu(id) {
    const n = S.notes.get(id);
    if (!n) return [];
    if (n.trashed) return [
      { label: '📄 보기', run: () => openNote(id) },
      '-',
      { label: '↩ 복원', run: async () => { const j = await post('restore', { id }); applyMeta(j.note); if (S.cur && S.cur.id === id) renderEditor(); toast('복원했습니다'); } },
      { label: '🗑 영구 삭제', danger: true, run: async () => {
        if (!confirm(`"${n.title || '제목 없음'}" 노트를 영구 삭제할까요? 되돌릴 수 없습니다.`)) return;
        await post('purge', { ids: [id] });
        S.notes.delete(id);
        if (S.cur && S.cur.id === id) { S.cur = null; renderEditor(); }
        renderSide(); renderList();
      } },
    ];
    return [
      { label: '📄 열기', run: () => openNote(id) },
      !isMobile() && { label: '🗗 새 창으로 보기', run: () => openInWindow(id) },
      '-',
      { label: pinLabel(n), run: () => noteFields(id, { pinned: !n.pinned }) },
      { label: fixLabel(n), run: () => noteFields(id, { fixed: !n.fixed }) },
      '-',
      { label: '📁 노트북 옮기기 ▸', run: () => openCtx(ctxXY[0], ctxXY[1], S.notebooks.map(nb => ({
        label: (nb.id === n.notebook ? '✓ ' : '　 ') + esc(nb.name),
        run: async () => { if (nb.id !== n.notebook) { await noteFields(id, { notebook: nb.id }); toast(`"${nb.name}" 노트북으로 옮겼습니다`); } },
      }))) },
      '-',
      // 아래는 편집 화면 ⋯ 메뉴와 같은 것: 그 노트를 연 뒤 실행
      { label: '📤 공유하기', run: withNote(id, noteShare) },
      { label: '📋 내용 복사', run: withNote(id, noteCopy) },
      { label: '📋 제목 복사', run: async () => toast(await copyText(n.title || '') ? '제목을 복사했습니다' : '복사하지 못했습니다') },
      { label: '💾 내보내기 (.txt)', run: withNote(id, noteExport) },
      { label: '📄 PDF로 저장', run: withNote(id, notePdf) },
      { label: '🖨 인쇄', run: withNote(id, notePrint) },
      '-',
      { label: '🗑 휴지통으로', danger: true, run: async () => {
        if (S.cur && S.cur.id === id) return trashCur();
        const j = await post('trash', { id }); applyMeta(j.note); toast('휴지통으로 옮겼습니다');
      } },
    ];
  }

  document.addEventListener('contextmenu', e => {
    const t = e.target;
    closeCtx();
    // 글 쓰는 곳 · 본문 · 링크 · 글을 고른 상태 → 브라우저 메뉴 그대로
    if (t.closest('input, textarea, select, [contenteditable="true"], .ProseMirror, #ed-view, a[href]:not([data-view])')) return;
    if (String(window.getSelection() || '').trim()) return;
    e.preventDefault();
    const at = items => openCtx(e.clientX, e.clientY, items);
    const li = t.closest('#notes li[data-id]');
    if (li) return at(noteMenu(li.dataset.id));
    const nb = t.closest('#nb-list [data-view="notebook"]');
    if (nb) return at([
      { label: '📂 이 노트북 보기', run: () => setView({ type: 'notebook', id: nb.dataset.id }) },
      { label: '＋ 이 노트북에 새 노트', run: async () => { await setView({ type: 'notebook', id: nb.dataset.id }); await newNote(); } },
      '-',
      { label: '✎ 이름 바꾸기 · 삭제', run: () => nbEdit(nb.dataset.id) },
    ]);
    const tg = t.closest('#tag-list [data-view="tag"], #notes .tg-i');
    if (tg) { const name = tg.dataset.id || tg.dataset.tag; return at([{ label: `# ${esc(name)} 태그로 거르기`, run: () => toggleTagFilter(name) }]); }
    if (t.closest('#side')) return at([
      { label: '＋ 새 노트', run: () => newNote() },
      { label: '＋ 노트북 추가', run: () => $('[data-act="nb-add"]').click() },
    ]);
    if (t.closest('#list')) return at([
      { label: '＋ 새 노트', run: () => newNote() },
      { label: '⟳ 목록 새로고침 (F5)', run: () => refreshList() },
    ]);
    if (t.closest('#editor') && S.cur && !S.cur.trashed) return at([
      { label: '💾 저장 (Ctrl+S)', run: () => saveNow() },
      { label: '🔎 이 노트에서 찾기 (Ctrl+F)', run: () => openFind() },
      { label: '⇄ 찾아 바꾸기 (Ctrl+H)', run: () => openFind(true) },
      '-',
      { label: pinLabel(S.cur), run: () => saveFields({ pinned: !S.cur.pinned }) },
      { label: fixLabel(S.cur), run: () => saveFields({ fixed: !S.cur.fixed }) },
    ]);
  });

  // ---------- 백업 받기: 저장 위치(폴더·파일 이름) 고르는 창을 띄운 뒤 받음 ----------
  // 크롬·엣지(PC)는 showSaveFilePicker 로 저장 창을 띄우고, 안 되는 브라우저(폰 등)는 예전처럼 바로 내려받기
  const canPickSave = () => !!(window.showSaveFilePicker && window.isSecureContext);
  /**
   * 저장 위치 고르는 창을 띄우고 $url 을 받아 그 파일에 쓴다.
   * 돌려주는 값: 'saved' | 'cancel' | 'fallback'(창을 못 띄움 → 부르는 쪽이 그냥 내려받기)
   * $o: { pickerId: 마지막 폴더를 따로 기억할 이름, types, msg(문구) => {}, isOk(응답) => bool, busy }
   */
  async function saveAs(url, name, o = {}) {
    if (!canPickSave()) return 'fallback';
    const msg = o.msg || (() => {});
    let handle;
    try {
      const opt = { suggestedName: name, id: o.pickerId || 'note-file', startIn: 'downloads' };
      if (o.types) opt.types = o.types;
      handle = await window.showSaveFilePicker(opt);
    } catch (err) {
      return err.name === 'AbortError' ? 'cancel' : 'fallback';
    }
    if (o.busy) msg(o.busy);
    let w;
    try {
      const r = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
      if (!r.ok || (o.isOk && !o.isOk(r))) throw new Error(`서버 오류 (${r.status})`);
      const total = Number(r.headers.get('Content-Length')) || 0;
      w = await handle.createWritable();
      const rd = r.body.getReader();
      let got = 0;
      for (;;) {
        const { done, value } = await rd.read();
        if (done) break;
        await w.write(value);
        got += value.length;
        msg(`저장 중… ${fmtSize(got)}${total ? ` / ${fmtSize(total)}` : ''}`);
      }
      await w.close();
      w = null;
      msg(`저장했습니다: ${handle.name} (${fmtSize(got)})`);
      return 'saved';
    } catch (err) {
      if (w) try { await w.abort(); } catch (_) { /* 무시 */ }
      throw err;
    }
  }

  $('#backup-dl').addEventListener('click', async e => {
    if (!canPickSave()) return;   // 폰 등: 예전처럼 바로 내려받기
    e.preventDefault();
    const btn = $('#backup-dl'), msg = $('#backup-msg'), d = new Date(), p = n => String(n).padStart(2, '0');
    const name = `note-backup-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.zip`;
    btn.classList.add('disabled');
    try {
      const r = await saveAs(btn.href, name, {
        pickerId: 'note-backup', types: [{ description: '백업 zip', accept: { 'application/zip': ['.zip'] } }],
        busy: '백업 만드는 중…', msg: t => { msg.textContent = t; },
        isOk: res => (res.headers.get('Content-Type') || '').includes('zip'),
      });
      if (r === 'saved') toast('백업을 저장했습니다');
      if (r === 'fallback') { msg.textContent = '저장 창을 열 수 없어 바로 내려받습니다'; location.href = btn.href; }
    } catch (err) {
      msg.textContent = '백업 실패: ' + err.message;
    } finally {
      btn.classList.remove('disabled');
    }
  });

  /** 그림·첨부 주소를 저장 위치 골라서 받기. 이 사이트 첨부(file.php)는 원래 파일 이름으로 */
  async function downloadAs(url) {
    let u;
    try { u = new URL(url, location.href); } catch { return; }
    const own = u.origin === location.origin && /\/file\.php$/.test(u.pathname);
    if (own) u.searchParams.set('dl', '1');
    const name = (own ? u.searchParams.get('f') : decodeURIComponent(u.pathname.split('/').pop() || '')) || 'image';
    const ext = (name.match(/\.([A-Za-z0-9]{1,16})$/) || [])[1];
    const fallback = () => { const a = document.createElement('a'); a.href = u.href; a.download = name; a.rel = 'noopener'; document.body.appendChild(a); a.click(); a.remove(); };
    try {
      const r = await saveAs(u.href, name, {
        pickerId: 'note-attach',
        types: ext ? [{ description: ext.toUpperCase() + ' 파일', accept: { 'application/octet-stream': ['.' + ext] } }] : undefined,
        msg: t => { $('#save-state').textContent = t; },
      });
      if (r === 'saved') { toast(`"${name}" 을(를) 저장했습니다`); setTimeout(() => { $('#save-state').textContent = ''; }, 2500); }
      if (r === 'fallback') fallback();
    } catch (err) {
      $('#save-state').textContent = '';
      if (own) toast('받기 실패: ' + err.message); else fallback();   // 다른 사이트 그림은 막힐 수 있어 그냥 내려받기로
    }
  }

  // 편집 화면 첨부 칩을 누르면: 저장 위치 고르는 창 → 받기 (안 되는 브라우저는 그냥 내려받기)
  $('#ed-files').addEventListener('click', async e => {
    const a = e.target.closest('.ef-item a');
    if (!a || !canPickSave() || e.ctrlKey || e.shiftKey || e.metaKey) return;
    e.preventDefault();
    const name = a.dataset.name;
    const ext = (name.match(/\.([A-Za-z0-9]{1,16})$/) || [])[1];
    try {
      const r = await saveAs(a.href, name, {
        pickerId: 'note-attach',
        types: ext ? [{ description: ext.toUpperCase() + ' 파일', accept: { 'application/octet-stream': ['.' + ext] } }] : undefined,
        msg: t => { $('#save-state').textContent = t; },
      });
      if (r === 'saved') { toast(`"${name}" 을(를) 저장했습니다`); setTimeout(() => { $('#save-state').textContent = ''; }, 2500); }
      if (r === 'fallback') location.href = a.href;
    } catch (err) {
      $('#save-state').textContent = '';
      toast('받기 실패: ' + err.message);
    }
  });

  // ---------- 에버노트(.enex) 가져오기: 복원처럼 4MB 씩 올린 뒤 서버에서 노트북 하나로 변환 ----------
  const enexNb = name => name.replace(/\.enex$/i, '').replace(/\s*\(\s*[\d,]+\s*(개\s*노트|notes?)\s*\)$/i, '') || '에버노트';
  $('#enex-file').addEventListener('change', e => {
    const fs = [...e.target.files];
    $('#enex-run').disabled = !fs.length;
    $('#enex-result').hidden = true;
    $('#enex-msg').textContent = fs.map(f => `${f.name} (${(f.size / 1048576).toFixed(1)}MB) → 노트북 "${enexNb(f.name)}"`).join('\n');
  });

  /** 가져오기가 끝나면 눈에 띄는 결과 상자: 성공(초록) / 일부 실패(주황) / 실패(빨강) + 가져온 노트북 바로 열기 */
  function showEnexResult(sum, nFiles, refresh) {
    const box = $('#enex-result');
    const kind = !sum.ok ? 'fail' : (sum.fail || sum.errors) ? 'warn' : 'ok';
    const title = { ok: '✅ 가져오기 완료', warn: '⚠️ 가져오기 완료 (일부 실패)', fail: '❌ 가져오지 못했습니다' }[kind];
    const parts = [];
    if (sum.ok) {
      parts.push(`새 노트 <b>${sum.added.toLocaleString()}</b>개`);
      if (sum.files) parts.push(`첨부 ${sum.files.toLocaleString()}개`);
      if (sum.skipped) parts.push(`이미 있어서 건너뜀 ${sum.skipped.toLocaleString()}개`);
      if (refresh) parts.push(`다시 변환 ${sum.refreshed.toLocaleString()}개`);
      if (sum.errors) parts.push(`노트 실패 ${sum.errors}개`);
    }
    const fileLine = nFiles > 1 ? `파일 ${nFiles}개 중 ${sum.ok}개 성공${sum.fail ? `, ${sum.fail}개 실패` : ''}` : (sum.fail ? '파일을 가져오지 못했습니다' : '');
    const nbBtns = sum.nbs.map(name => {
      const nb = S.notebooks.find(n => n.name === name);
      return nb ? `<button type="button" class="btn small" data-enex-nb="${esc(nb.id)}">📒 ${esc(name)} 열기</button>` : '';
    }).join('');
    box.className = 'enex-result ' + kind;
    box.innerHTML = `<div class="er-title">${title}</div>`
      + (parts.length ? `<div class="er-sum">${parts.join(' · ')}</div>` : '')
      + (fileLine ? `<div class="er-files">${esc(fileLine)}</div>` : '')
      + (sum.added === 0 && sum.ok && !sum.errors && !refresh ? '<div class="er-files">새로 들어간 노트는 없습니다 (모두 이미 가져온 노트)</div>' : '')
      + (nbBtns ? `<div class="er-nbs">${nbBtns}</div>` : '')
      + (sum.fail || sum.errors ? '<div class="er-files">자세한 내용은 아래를 보세요</div>' : '');
    box.hidden = false;
    box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  $('#enex-result').addEventListener('click', e => {
    const b = e.target.closest('[data-enex-nb]');
    if (!b) return;
    $('#backup-dlg').close();
    setView({ type: 'notebook', id: b.dataset.enexNb });
  });

  async function runEnex() {
    const files = [...$('#enex-file').files];
    if (!files.length) return;
    const refresh = $('#enex-refresh').checked;
    const msg = $('#enex-msg'), prog = $('#enex-prog'), btn = $('#enex-run');
    const CHUNK = 4 * 1024 * 1024;
    const totalSize = files.reduce((a, f) => a + f.size, 0) || 1;
    const lines = [];
    let sent = 0, added = 0;
    const sum = { ok: 0, fail: 0, added: 0, files: 0, skipped: 0, refreshed: 0, errors: 0, nbs: [] };
    const box = $('#enex-result');
    box.hidden = true;
    btn.disabled = true; $('#enex-file').disabled = true; prog.hidden = false; prog.value = 0;
    try {
      for (const [k, file] of files.entries()) {
        const head = files.length > 1 ? `[${k + 1}/${files.length}] ` : '';
        const upload = [...crypto.getRandomValues(new Uint8Array(12))].map(b => b.toString(16).padStart(2, '0')).join('');
        try {
          for (let off = 0; off < file.size; off += CHUNK) {
            const fd = new FormData();
            fd.append('kind', 'enex');
            fd.append('upload', upload);
            fd.append('offset', String(off));
            fd.append('chunk', file.slice(off, off + CHUNK), 'chunk');
            await call('restore_chunk', { form: fd });
            const done = sent + Math.min(off + CHUNK, file.size);
            prog.value = Math.round(done / totalSize * 95);
            msg.textContent = [...lines, `${head}${file.name} 올리는 중… ${prog.value}%`].join('\n');
          }
          msg.textContent = [...lines, `${head}${file.name} 변환하는 중… (노트가 많으면 몇 분 걸립니다)`].join('\n');
          const r = await post('enex_finish', { upload, size: file.size, name: file.name, refresh });
          added += r.added;
          sum.ok++; sum.added += r.added; sum.files += r.files; sum.skipped += r.skipped || 0;
          sum.refreshed += r.refreshed || 0; sum.errors += r.errors || 0;
          if (!sum.nbs.includes(r.notebook)) sum.nbs.push(r.notebook);
          let line = `✔ "${r.notebook}": 새 노트 ${r.added}개, 첨부 ${r.files}개`
            + (r.skipped ? `, 이미 있음 ${r.skipped}개` : '')
            + (refresh ? `, 다시 변환 ${r.refreshed}개` + (r.edited ? `(고친 노트 ${r.edited}개는 그대로)` : '') : '')
            + (r.errors ? `, 실패 ${r.errors}개` : '');
          if (r.errorList && r.errorList.length) line += '\n   ' + r.errorList.slice(0, 5).join('\n   ');
          lines.push(line);
        } catch (e) {
          sum.fail++;
          lines.push(`✖ ${file.name}: ${e.message}`);
        }
        sent += file.size;
        msg.textContent = lines.join('\n');
      }
      prog.value = 100;
      resetList();
      await loadState();
      showEnexResult(sum, files.length, refresh);
      toast(sum.fail && !sum.ok ? '가져오지 못했습니다' : `가져오기 완료 · 새 노트 ${added}개`);
    } finally {
      prog.hidden = true;
      btn.disabled = false; $('#enex-file').disabled = false;
    }
  }

  // ---------- 백업 zip 으로 복원: 4MB 씩 나눠 올린 뒤 서버에서 통째로 바꿈 ----------
  $('#restore-file').addEventListener('change', e => {
    $('#restore-run').disabled = !e.target.files.length;
    $('#restore-result').hidden = true;
    $('#restore-msg').textContent = e.target.files.length ? `${e.target.files[0].name} (${(e.target.files[0].size / 1048576).toFixed(1)}MB)` : '';
  });

  /** 복원이 끝나면 눈에 띄는 결과 상자: 완료(초록) / 실패(빨강) */
  function showRestoreResult(ok, r, name) {
    const box = $('#restore-result');
    box.className = 'enex-result ' + (ok ? 'ok' : 'fail');
    if (ok) {
      const parts = [`노트 <b>${(r.notes || 0).toLocaleString()}</b>개`, `첨부 ${(r.files || 0).toLocaleString()}개`];
      if (r.skipped) parts.push(`건너뜀 ${r.skipped}개`);
      box.innerHTML = '<div class="er-title">✅ 복원 완료</div>'
        + `<div class="er-sum">${parts.join(' · ')}</div>`
        + `<div class="er-files">${esc(name)} 으로 바꿨습니다.`
        + (r.kept ? ` 바꾸기 전 데이터는 서버에 보관했습니다 (${esc(String(r.kept))}).` : '') + '</div>'
        + '<div class="er-nbs"><button type="button" class="btn small" data-act="backup-close">닫고 노트 보기</button></div>';
    } else {
      box.innerHTML = '<div class="er-title">❌ 복원하지 못했습니다</div>'
        + `<div class="er-sum">${esc(r.err || '알 수 없는 오류')}</div>`
        + '<div class="er-files">지금 노트는 바뀌지 않고 그대로입니다.</div>';
    }
    box.hidden = false;
    box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  async function runRestore() {
    const file = $('#restore-file').files[0];
    if (!file) return;
    if (!confirm(`"${file.name}" 으로 지금 노트를 모두 바꿀까요?\n지금 데이터는 서버에 자동 보관됩니다.`)) return;
    const msg = $('#restore-msg'), prog = $('#restore-prog'), btn = $('#restore-run');
    const CHUNK = 4 * 1024 * 1024;
    const upload = [...crypto.getRandomValues(new Uint8Array(12))].map(b => b.toString(16).padStart(2, '0')).join('');
    btn.disabled = true; prog.hidden = false; prog.value = 0;
    try {
      for (let off = 0; off < file.size; off += CHUNK) {
        const fd = new FormData();
        fd.append('upload', upload);
        fd.append('offset', String(off));
        fd.append('chunk', file.slice(off, off + CHUNK), 'chunk');
        await call('restore_chunk', { form: fd });
        prog.value = Math.round(Math.min(off + CHUNK, file.size) / file.size * 90);
        msg.textContent = `올리는 중… ${prog.value}%`;
      }
      msg.textContent = '서버에서 푸는 중…';
      const r = await post('restore_finish', { upload, size: file.size });
      prog.value = 100;
      msg.textContent = '';
      S.cur = null; S.dirty = false; resetList();
      renderEditor();
      await loadState();
      showRestoreResult(true, r, file.name);
      toast(`복원 완료 · 노트 ${(r.notes || 0).toLocaleString()}개`);
    } catch (e) {
      msg.textContent = '';
      showRestoreResult(false, { err: e.message }, file.name);
      toast('복원하지 못했습니다');
    } finally {
      btn.disabled = false;
      prog.hidden = true;
    }
  }

  async function newNote() {
    await flush(); await cleanupEmpty();
    const v = S.view;
    if (v.type === 'trash') { S.view = { type: 'all' }; }
    resetList();   // 새 노트는 맨 위에 생긴다
    const notebook = v.type === 'notebook' ? v.id : (S.cur ? S.cur.notebook : S.notebooks[0].id);
    const j = await post('save', { title: '', body: '', notebook, tags: viewTags(v) });
    applyMeta(j.note);
    S.cur = null;
    await openNote(j.note.id);
    S.createdEmpty = j.note.id;
    $('#ed-title').focus();
    app.classList.remove('side-open');
  }

  async function trashCur() {
    await flush();
    const j = await post('trash', { id: S.cur.id });
    applyMeta(j.note);
    S.cur = null; S.createdEmpty = null;
    renderEditor(); renderList(); showList();
    toast('휴지통으로 옮겼습니다');
    if (POPUP) setTimeout(() => window.close(), 600);
  }

  /** 목록에서 Del: 여러 개 골랐으면 그것들, 아니면 열린 노트를 휴지통으로 (휴지통 보기에서는 안 함) */
  async function trashFromList() {
    if (S.view.type === 'trash') return;
    const ids = S.sel.size ? listAll.filter(n => S.sel.has(n.id) && !n.trashed).map(n => n.id)
      : (S.cur && !S.cur.trashed ? [S.cur.id] : []);
    if (!ids.length) return;
    if (ids.length > 1 && !confirm(`노트 ${ids.length}개를 휴지통으로 보낼까요?\n(휴지통에서 다시 복원할 수 있습니다)`)) return;
    // 지울 노트 다음 줄을 기억해 두었다가 지운 뒤 그 노트를 연다(목록을 이어서 정리하기 쉽게)
    const order = listAll.map(n => n.id);
    const last = Math.max(...ids.map(id => order.indexOf(id)));
    const next = order.slice(last + 1).find(id => !ids.includes(id)) || order.slice(0, last).reverse().find(id => !ids.includes(id)) || null;
    if (S.cur && ids.includes(S.cur.id)) await flush();
    let done = 0;
    for (const id of ids) {
      try { const j = await post('trash', { id }); applyMeta(j.note); done++; } catch (e) { fail(e); }
    }
    S.sel.clear(); S.selAnchor = null;
    if (S.cur && ids.includes(S.cur.id)) { S.cur = null; S.createdEmpty = null; renderEditor(); }
    renderList();
    if (next && !isMobile()) openNote(next);
    toast(done > 1 ? `노트 ${done}개를 휴지통으로 옮겼습니다` : '휴지통으로 옮겼습니다');
  }
  document.addEventListener('keydown', e => {
    if (e.key !== 'Delete' || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || e.isComposing) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;   // 글 쓰는 중이면 원래 Delete
    if (document.querySelector('dialog[open]') || !$('#ctx-menu').hidden) return;
    e.preventDefault();
    trashFromList().catch(fail);
  });

  // ---------- 다른 기기에서 고친 내용 반영, 닫을 때 저장 ----------
  async function refreshFromServer() {
    if (S.dirty || S.saving) return;
    try {
      const keep = $('#notes').scrollTop;
      await loadState();
      $('#notes').scrollTop = keep;
      const c = S.cur, m = c && S.notes.get(c.id);
      if (c && !m) { S.cur = null; renderEditor(); }
      else if (c && m.rev !== c.rev) { S.cur = null; await openNote(m.id); }
    } catch (e) { console.warn(e); }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { if (S.dirty) save(true).catch(() => {}); return; }
    refreshFromServer();
  });
  if (sync) {
    let t;
    sync.onmessage = () => { clearTimeout(t); t = setTimeout(refreshFromServer, 300); };
  }
  window.addEventListener('beforeunload', e => {
    if (S.dirty) { save(true).catch(() => {}); e.preventDefault(); }
  });

  // ---------- 시작 ----------
  renderEditor();
  if (POPUP) {
    // 새 창: 노트 하나만 전체화면으로. 배치 설정은 건드리지 않는다
    app.classList.add('popup');
    setLayout('full', false);
    // 이 창의 크기·위치를 기억 → 다음 새 창을 같은 크기로 연다
    // (window.open 의 width/height 는 창 안쪽 크기라서 innerWidth/innerHeight 를 저장)
    const saveRect = () => {
      if (!window.outerWidth || document.fullscreenElement) return;
      pref.set('popupRect', { w: window.innerWidth, h: window.innerHeight, x: window.screenX, y: window.screenY });
    };
    let rt;
    window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(saveRect, 300); });
    window.addEventListener('pagehide', saveRect);   // 창만 옮긴 경우(위치)는 닫을 때 저장
    loadState().then(async () => {
      if (!S.notes.has(POPUP)) { $('#ed-empty').textContent = '노트를 찾을 수 없습니다.'; return; }
      await openNote(POPUP);
      document.title = (S.cur && S.cur.title) || '알지로 노트';
    }).catch(fail);
  } else {
    loadState().catch(fail);
  }
})();
