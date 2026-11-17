'use strict';
/**
 * 본문 에디터 어댑터.
 * 지금은 Toast UI Editor 3.2.2 (위지윅 + Markdown 저장)를 쓴다.
 * 다른 에디터로 바꿀 때는 이 파일만 고치면 된다. app.js 는 아래 함수만 쓴다.
 *
 *   NoteEditor.create(el, { onChange(), uploadImage(blob) → Promise<{url,name}>, onAttach(),
 *                           onSourceInput(본문), onSourceMode(on) })
 *   NoteEditor.set(markdown) → 에디터가 정리한 markdown (저장 비교용)
 *   NoteEditor.get() → markdown
 *   NoteEditor.insertImage(url, alt) / insertLink(url, text) / focus()
 */
window.NoteEditor = (() => {
  let ed = null;
  let suppress = false;
  let opts = {};

  function create(el, options) {
    opts = options;
    // 위지윅 본문은 브라우저 맞춤법 검사를 끔(한글·코드·주소에 빨간 밑줄이 너무 많이 생김). 텍스트 칸은 원래 꺼져 있음
    setTimeout(() => el.querySelectorAll('.ProseMirror').forEach(p => { p.spellcheck = false; p.setAttribute('autocorrect', 'off'); }), 0);
    const attach = document.createElement('button');
    attach.type = 'button';
    attach.className = 'toastui-editor-toolbar-icons ne-attach';
    attach.setAttribute('aria-label', '파일 첨부');
    attach.textContent = '📎';
    attach.addEventListener('click', () => opts.onAttach && opts.onAttach());

    // 글자색 · 배경색 버튼 (위지윅): 각각 [색 바로 입히기 | ▾ 색 고르기]
    const textColorBtn = colorSplit('color'), bgColorBtn = colorSplit('bg');

    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    ed = new toastui.Editor({
      el,
      height: 'auto',
      minHeight: '200px',
      initialEditType: 'wysiwyg',
      previewStyle: 'tab',
      language: 'ko-KR',
      theme: dark ? 'dark' : 'light',
      usageStatistics: false,          // 기본값이면 구글 애널리틱스로 사용 통계를 보낸다
      // 글자색·배경색: 본문에 <span style="color: …; background-color: …">글</span> 로 저장(에버노트에서 가져온 색도 이 모양).
      // 이게 없으면 위지윅이 span 을 지워 버린다
      customHTMLRenderer: {
        htmlInline: {
          span(node, { entering }) {
            return entering ? { type: 'openTag', tagName: 'span', attributes: node.attrs } : { type: 'closeTag', tagName: 'span' };
          },
        },
      },
      autofocus: false,
      placeholder: '내용을 입력하세요',
      // 모바일에서는 앞쪽 버튼만 보이고 나머지는 ⋯ 로 들어간다 → 자주 쓰는 것을 앞에
      toolbarItems: [
        ['task', 'bold', 'ul', 'ol'],
        ['image', { name: 'attach', tooltip: '파일 첨부', el: attach }, 'link'],
        ['heading', 'strike', { name: 'textColor', tooltip: '글자색', el: textColorBtn }, { name: 'bgColor', tooltip: '배경색(형광펜)', el: bgColorBtn }, 'quote', 'hr'],
        ['indent', 'outdent', 'table', 'code', 'codeblock'],
      ],
      hooks: {
        // 붙여넣기·끌어다 놓기·이미지 버튼 → 우리 업로드
        addImageBlobHook: (blob, callback) => {
          opts.uploadImage(blob)
            .then(r => callback(r.url, ''))
            .catch(() => {});
          return false;
        },
      },
      events: {
        change: () => {
          if (!suppress && opts.onChange) opts.onChange();
          if (hlTerms.length || fTerms.length) { clearTimeout(hlTimer); hlTimer = setTimeout(paint, 200); }
        },
        keydown: (type, ev) => hrOnEnter(type, ev),
        // 탭을 바꾸면 커서를 글 맨 앞으로(글 끝에 있으면 입력할 때 끝으로 튐). 화면 위치는 holdScroll 이 지킴
        changeMode: () => { if (!srcOn && ed && ed.moveCursorToStart) ed.moveCursorToStart(false); setTimeout(paint, 50); setTimeout(modeChanged, 0); },
      },
    });
  }

  // ---------- 글자색 · 배경색 ----------
  const TEXT_COLORS = [['', '기본'], ['#e03131', '빨강'], ['#f76707', '주황'], ['#e8a200', '노랑'], ['#2f9e44', '초록'],
    ['#1971c2', '파랑'], ['#7048e8', '보라'], ['#868e96', '회색']];
  const BG_COLORS = [['', '없음'], ['#fff3bf', '노랑'], ['#ffe8cc', '주황'], ['#ffdeeb', '분홍'], ['#d3f9d8', '초록'],
    ['#d0ebff', '파랑'], ['#e5dbff', '보라'], ['#e9ecef', '회색']];
  let colorPop = null;
  function parseSpanStyle(style) {
    const o = {};
    String(style || '').split(';').forEach(p => {
      const i = p.indexOf(':');
      if (i < 0) return;
      const k = p.slice(0, i).trim().toLowerCase(), val = p.slice(i + 1).trim();
      if (k === 'color') o.color = val;
      if (k === 'background-color' || k === 'background') o.bg = val;
    });
    return o;
  }
  const spanStyle = o => [o.color ? `color: ${o.color}` : '', o.bg ? `background-color: ${o.bg}` : ''].filter(Boolean).join('; ');
  // 마지막으로 고른 색(버튼을 누르면 이 색을 바로 입힘). 브라우저마다 기억
  const lastColor = { color: '#e03131', bg: '#fff3bf' };
  try {
    const sv = JSON.parse(localStorage.getItem('note.lastColor') || '{}');
    if (sv.color) lastColor.color = sv.color;
    if (sv.bg) lastColor.bg = sv.bg;
  } catch { /* 없음 */ }
  const splits = {};
  /** [색 바로 입히기 | ▾] 버튼 하나 만들기. kind: 'color' 글자색, 'bg' 배경색 */
  function colorSplit(kind) {
    const wrap = document.createElement('span');
    wrap.className = 'toastui-editor-toolbar-icons ne-color ne-color-' + kind;
    wrap.innerHTML = `<button type="button" class="ncs-main" aria-label="${kind === 'color' ? '글자색' : '배경색'} 입히기">`
      + (kind === 'color' ? '<span class="ncs-a">A</span>' : '<span class="ncs-hl">가</span>')
      + `</button><button type="button" class="ncs-caret" aria-label="${kind === 'color' ? '글자색' : '배경색'} 고르기" aria-haspopup="true">▾</button>`;
    wrap.addEventListener('mousedown', e => e.preventDefault());   // 고른 글자가 풀리지 않게
    // 버튼: 지금 색을 입힘. 고른 글자가 이미 그 색이면 한 번 더 누를 때 그 색을 취소
    wrap.querySelector('.ncs-main').addEventListener('click', e => { e.stopPropagation(); if (colorPop) colorPop.hidden = true; applyColor(kind, lastColor[kind], true); });
    wrap.querySelector('.ncs-caret').addEventListener('click', e => { e.stopPropagation(); toggleColorPop(wrap, kind); });
    splits[kind] = wrap;
    paintSplit(kind);
    return wrap;
  }
  function paintSplit(kind) {
    const w = splits[kind];
    if (!w) return;
    if (kind === 'color') w.querySelector('.ncs-a').style.color = lastColor.color;   // A 글자 = 지금 글자색
    else w.querySelector('.ncs-hl').style.background = lastColor.bg;
  }
  function toggleColorPop(anchor, kind) {
    if (!colorPop) {
      colorPop = document.createElement('div');
      colorPop.className = 'ne-color-pop';
      colorPop.hidden = true;
      colorPop.addEventListener('mousedown', e => e.preventDefault());
      colorPop.addEventListener('click', e => {
        const b = e.target.closest('[data-kind]');
        if (!b) return;
        const k = b.dataset.kind, c = b.dataset.c;
        if (c) {   // 고른 색을 버튼 색으로 기억
          lastColor[k] = c;
          try { localStorage.setItem('note.lastColor', JSON.stringify(lastColor)); } catch { /* 저장 안 돼도 됨 */ }
          paintSplit(k);
        }
        applyColor(k, c);
        colorPop.hidden = true;
      });
      document.body.appendChild(colorPop);
      document.addEventListener('mousedown', e => { if (!colorPop.hidden && !e.target.closest('.ne-color-pop, .ne-color')) colorPop.hidden = true; });
      document.addEventListener('keydown', e => { if (e.key === 'Escape' && !colorPop.hidden) { colorPop.hidden = true; e.stopImmediatePropagation(); } }, true);
    }
    if (!colorPop.hidden && colorPop.dataset.kind === kind) { colorPop.hidden = true; return; }
    const list = kind === 'color' ? TEXT_COLORS : BG_COLORS;
    colorPop.dataset.kind = kind;
    colorPop.innerHTML = `<div class="ncp-row">` + list.map(([c, n]) =>
      `<button type="button" class="ncp-c${c ? '' : ' none'}${c && c === lastColor[kind] ? ' on' : ''}" data-kind="${kind}" data-c="${c}" title="${n}" aria-label="${n}"`
      + ` style="${c ? (kind === 'color' ? `color:${c}` : `background:${c}`) : ''}">${kind === 'color' ? (c ? 'A' : '✕') : (c ? '' : '✕')}</button>`).join('') + '</div>';
    colorPop.hidden = false;
    const r = anchor.getBoundingClientRect(), vw = document.documentElement.clientWidth;
    colorPop.style.top = Math.round(r.bottom + 4) + 'px';
    colorPop.style.left = Math.round(Math.max(4, Math.min(r.left, vw - colorPop.offsetWidth - 4))) + 'px';
  }
  /** 고른 글자에 색 입히기. kind: 'color'(글자) | 'bg'(배경), c: '' 이면 그 색만 지움.
   *  toggle: 고른 글자가 이미 그 색이면 지움(버튼을 한 번 더 누르면 취소) */
  function applyColor(kind, c, toggle) {
    const v = pmView();
    if (!v || srcOn) return;
    // 더블클릭·끌어서 고른 직후엔 에디터가 아직 선택을 못 읽었을 수 있어, 화면의 선택에서 직접 읽는다
    try { if (v.domObserver && v.domObserver.flush) v.domObserver.flush(); } catch { /* 없어도 됨 */ }
    let { from, to, empty } = v.state.selection;
    const ds = window.getSelection();
    if (empty && ds && !ds.isCollapsed && ds.rangeCount && v.dom.contains(ds.anchorNode)) {
      const r = ds.getRangeAt(0);
      from = v.posAtDOM(r.startContainer, r.startOffset); to = v.posAtDOM(r.endContainer, r.endOffset);
      if (from > to) [from, to] = [to, from];
      empty = from === to;
    }
    if (empty) { if (opts.notify) opts.notify('색을 입힐 글자를 먼저 고르세요'); return; }
    const type = v.state.schema.marks.span;
    if (!type) return;
    // 고른 자리의 지금 색(첫 글자 기준)을 읽어 한 가지만 바꾼다 → 글자색과 배경색을 같이 쓸 수 있음
    let cur = {};
    v.state.doc.nodesBetween(from, to, node => {
      if (Object.keys(cur).length) return false;
      const m = node.marks.find(x => x.type === type);
      if (m) cur = parseSpanStyle(m.attrs.htmlAttrs && m.attrs.htmlAttrs.style);
      return true;
    });
    const same = (a, b) => String(a || '').replace(/\s/g, '').toLowerCase() === String(b || '').replace(/\s/g, '').toLowerCase();
    cur[kind] = toggle && c && same(cur[kind], c) ? undefined : (c || undefined);
    let tr = v.state.tr.removeMark(from, to, type);
    const st = spanStyle(cur);
    if (st) tr = tr.addMark(from, to, type.create({ htmlAttrs: { style: st } }));
    v.dispatch(tr);
    v.focus();
  }

  /** 에디터 글. 에디터는 가로선을 *** 로 쓰는데, 기존 노트·소스 탭과 같게 --- 로 바꾼다(코드 블록 안은 그대로) */
  function mdOut() {
    let fence = null;
    return ed.getMarkdown().split('\n').map(l => {
      const f = l.match(/^\s*(`{3,}|~{3,})/);
      if (f) { if (!fence) fence = f[1][0]; else if (f[1][0] === fence) fence = null; return l; }
      return !fence && l === '***' ? '---' : l;
    }).join('\n');
  }

  // ---------- 에버노트처럼 ''' 나 """ (또는 ---, ***) 만 쓴 줄에서 Enter → 가로선 ----------
  const HR_LINE = /^\s*('{3,}|"{3,}|-{3,}|\*{3,})\s*$/;

  function hrOnEnter(type, ev) {
    if (ev.key !== 'Enter' || ev.isComposing || ev.shiftKey || ev.ctrlKey || ev.altKey || ev.metaKey) return;
    if (type === 'wysiwyg') {
      // 커서가 있는 문단 글자가 ''' 이고 커서가 그 끝에 있을 때
      const sel = window.getSelection();
      if (!sel || !sel.isCollapsed || !sel.anchorNode) return;
      const anchor = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement;
      const p = anchor && anchor.closest('p');
      if (!p || p.closest('li, td, th, blockquote') || !HR_LINE.test(p.textContent)) return;
      const [, to] = ed.getSelection();
      const len = p.textContent.length;
      ev.preventDefault();
      ed.setSelection(to - len, to);
      ed.replaceSelection('');
      ed.exec('hr');
    } else if (type === 'markdown') {
      const [[line, ch]] = ed.getSelection();
      const text = ed.getMarkdown().split('\n')[line - 1] || '';
      if (!/'{3,}|"{3,}/.test(text) || !HR_LINE.test(text) || ch - 1 < text.trimEnd().length) return;   // --- 는 원래 가로선
      ev.preventDefault();
      ed.setSelection([line, 1], [line, text.length + 1]);
      ed.replaceSelection('');
      ed.exec('hr');
    }
  }

  function codeBlockExit(e) {
    if (srcOn || !ed || !ed.isWysiwygMode() || e.isComposing || e.ctrlKey || e.altKey || e.metaKey) return;
    if (!(e.key === 'Enter' && !e.shiftKey) && e.key !== 'ArrowDown') return;
    const v = pmView();
    if (!v || !v.hasFocus()) return;
    const sel = v.state.selection;
    if (!sel.empty) return;
    const $f = sel.$from, node = $f.parent;
    if (!/code/i.test(node.type.name) || !node.type.spec.code) return;
    if ($f.parentOffset !== node.content.size) return;   // 코드 맨 끝에서만
    const after = $f.after();
    const isLast = after >= v.state.doc.content.size;
    if (e.key === 'ArrowDown' && !isLast) return;          // 아래에 글이 있으면 원래 ↓ 로 내려감
    if (e.key === 'Enter' && !node.textContent.endsWith('\n')) return;   // 빈 줄에서 한 번 더 Enter 일 때만
    e.preventDefault(); e.stopPropagation();
    let tr = v.state.tr, pos = after;
    if (e.key === 'Enter') { tr = tr.delete($f.pos - 1, $f.pos); pos = after - 1; }   // 마지막 빈 줄은 지움
    tr = tr.insert(pos, v.state.schema.nodes.paragraph.create());
    tr = tr.setSelection(sel.constructor.near(tr.doc.resolve(pos + 1)));
    v.dispatch(tr.scrollIntoView());
  }

  /** 소스 탭: 줄을 "---" 로 바꾸고, 윗줄이 글자면 빈 줄을 하나 띄운다("글\n---" 는 제목이 되므로) */
  function hrInSource(ev) {
    if (ev.key !== 'Enter' || ev.isComposing || ev.shiftKey || ev.ctrlKey || ev.altKey || ev.metaKey) return;
    const v = src.value, pos = src.selectionStart;
    if (pos !== src.selectionEnd) return;
    const start = v.lastIndexOf('\n', pos - 1) + 1;
    let end = v.indexOf('\n', pos); if (end < 0) end = v.length;
    const line = v.slice(start, end);
    if (!HR_LINE.test(line) || v.slice(pos, end).trim() !== '') return;
    const prev = start === 0 ? '' : v.slice(v.lastIndexOf('\n', start - 2) + 1, start - 1);
    const isHrAlready = /^\s*-{3,}\s*$/.test(line);
    if (isHrAlready && prev.trim() === '') return;   // 이미 올바른 가로선
    ev.preventDefault();
    src.setSelectionRange(start, end);
    const pre = prev.trim() !== '' ? '\n' : '';   // 바로 위가 글자면 빈 줄
    insertSource(pre + '---\n');
  }

  // ---------- "소스" 탭: 본문 txt 그대로 보고 고치기 (제목은 위 제목 칸) ----------
  // 여기서 쓴 글은 에디터가 다시 정리하지 않고 그대로 저장된다.
  let src = null, srcTab = null, root = null, srcOn = false, prevTab = null;
  let srcWrap = null, srcHl = null;   // 소스 칸과, 그 밑에 깔아 검색어를 색칠하는 같은 모양의 층
  let srcImgs = null, imgTip = null;   // 소스 탭: 본문 그림 모음 줄, 마우스 올리면 뜨는 미리보기

  function setupSource(el) {
    root = el.querySelector('.toastui-editor-defaultUI');
    const sw = root && root.querySelector('.toastui-editor-mode-switch');
    if (!sw) return;
    src = document.createElement('textarea');
    src.className = 'ne-source';
    src.spellcheck = false;
    src.hidden = true;
    src.setAttribute('aria-label', '본문 원본');
    // textarea 안 글자는 색칠할 수 없어서, 같은 글을 같은 모양으로 밑에 깔고 거기에 <mark> 를 칠한다
    srcWrap = document.createElement('div');
    srcWrap.className = 'ne-src-wrap';
    srcWrap.hidden = true;
    srcHl = document.createElement('div');
    srcHl.className = 'ne-src-hl';
    srcHl.setAttribute('aria-hidden', 'true');
    // 본문만 스크롤: srcWrap 이 스크롤 칸, 그 안의 inner 가 글 길이만큼 늘어나고 밑층(srcHl)은 inner 전체에 깔린다
    const srcInner = document.createElement('div');
    srcInner.className = 'ne-src-inner';
    srcInner.append(srcHl, src);
    srcWrap.append(srcInner);
    sw.parentNode.insertBefore(srcWrap, sw);
    setupSourceImages(sw);

    srcTab = document.createElement('div');
    srcTab.className = 'tab-item ne-source-tab';
    srcTab.setAttribute('role', 'button');
    srcTab.textContent = '소스';   // txt 그대로
    sw.appendChild(srcTab);   // 탭 순서: 위지윅(기본) · 소스
    // 마크다운 탭은 쓰지 않음(소스·위지윅과 겹침) → 숨김. 탭 줄은 소스 · 위지윅 두 개
    sw.querySelectorAll('.tab-item').forEach(t => { if (t.textContent.trim() === '마크다운') t.classList.add('ne-no-md'); });

    // 툴바 말풍선 위치: Toast 는 편집기 맨 위 기준으로 계산해서, 탭 줄을 위로 옮기고 툴바를 붙여 두니 어긋난다
    // → Toast 가 띄운 뒤 버튼 바로 아래로 다시 놓는다
    //    (Toast 가 위치를 바꿀 때마다 다시 놓도록 style 변경을 지켜본다)
    const bar = root.querySelector('.toastui-editor-defaultUI-toolbar');

    // 툴바 버튼 접기(⋯) 끄기: Toast 는 폭이 좁으면 버튼을 ⋯ 로 접는데, 숨겨진 동안 잰 폭 때문에 자꾸 틀리게 접힌다.
    // 툴바 폭을 아주 크게 알려 줘서 접지 않게 하고, 좁으면 CSS 로 다음 줄로 넘긴다
    if (bar) {
      Object.defineProperty(bar, 'clientWidth', { configurable: true, get: () => 100000 });
      // 크기를 한 번 살짝 바꿔 Toast 가 다시 계산(→ 전부 펼침)하게 함
      bar.style.paddingRight = '1px';
      setTimeout(() => { bar.style.paddingRight = ''; }, 300);
    }
    let hoverBtn = null, placing = false;
    const placeTip = () => {
      const tip = bar && bar.querySelector('.toastui-editor-tooltip');
      if (!tip || !hoverBtn || tip.style.display === 'none' || !hoverBtn.offsetWidth) return;
      const rb = hoverBtn.getBoundingClientRect(), rp = (tip.offsetParent || bar).getBoundingClientRect();
      const top = Math.round(rb.bottom - rp.top + 6) + 'px';
      // 버튼 가운데 아래, 단 화면 양끝 밖으로는 안 나가게
      const want = rb.left + rb.width / 2 - tip.offsetWidth / 2;
      const vw = document.documentElement.clientWidth;
      const left = Math.round(Math.max(4, Math.min(want, vw - tip.offsetWidth - 4)) - rp.left) + 'px';
      // 꺽쇠는 말풍선이 끝에서 당겨져도 버튼 가운데를 가리키게
      const arrow = tip.querySelector('.arrow');
      const arrowLeft = Math.round(rb.left + rb.width / 2 - (parseFloat(left) + rp.left) - 5) + 'px';
      if (tip.style.top === top && tip.style.left === left && (!arrow || arrow.style.left === arrowLeft)) return;
      placing = true; tip.style.top = top; tip.style.left = left; if (arrow) arrow.style.left = arrowLeft; placing = false;
    };
    if (bar) {
      bar.addEventListener('mouseover', e => {
        const b = e.target.closest('button') || e.target.closest('.toastui-editor-toolbar-item-wrapper');
        if (b) hoverBtn = b;
        placeTip(); requestAnimationFrame(placeTip);
      }, true);
      const watch = () => {
        const tip = bar.querySelector('.toastui-editor-tooltip');
        if (!tip) return false;
        new MutationObserver(() => { if (!placing) placeTip(); }).observe(tip, { attributes: true, attributeFilter: ['style'], childList: true, subtree: true, characterData: true });
        return true;
      };
      if (!watch()) setTimeout(watch, 500);   // 말풍선은 Toast 가 조금 늦게 만든다

      // 제목·표 같은 버튼 팝업도 누른 버튼 바로 아래로 (툴바가 좌우로 밀려 있어도 맞게, 화면 밖으로 안 나가게)
      let popBtn = null;
      bar.addEventListener('pointerdown', e => { popBtn = e.target.closest('button') || popBtn; }, true);
      const outer = bar.parentElement;   // .toastui-editor-toolbar (팝업이 여기 붙음)
      const placePop = () => {
        const pop = [...outer.querySelectorAll(':scope > .toastui-editor-popup')].find(p => p.style.display !== 'none' && p.offsetWidth);
        if (!pop || !popBtn || !popBtn.offsetWidth) return;
        const rb = popBtn.getBoundingClientRect(), ro = (pop.offsetParent || outer).getBoundingClientRect();
        const maxLeft = document.documentElement.clientWidth - pop.offsetWidth - 8;
        const left = Math.round(Math.max(8, Math.min(rb.left, maxLeft)) - ro.left) + 'px';
        const top = Math.round(rb.bottom - ro.top) + 'px';
        if (pop.style.left === left && pop.style.top === top) return;
        placing = true; pop.style.left = left; pop.style.top = top; placing = false;
      };
      new MutationObserver(() => { if (!placing) placePop(); }).observe(outer, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
    }

    // 본문 글자 크기 가− / 가+ (탭 줄 오른쪽). 브라우저마다 기억 → PC·폰 따로
    const fs = document.createElement('span');
    fs.className = 'ne-font';
    fs.innerHTML = '<button type="button" data-fs="-1" title="본문 글자 작게" aria-label="본문 글자 작게">가−</button>'
      + '<span class="ne-fs-val" title="본문 글자 크기"></span>'
      + '<button type="button" data-fs="1" title="본문 글자 크게" aria-label="본문 글자 크게">가+</button>';
    // 글꼴 고르기 (가− 왼쪽)
    const fam = document.createElement('select');
    fam.className = 'ne-family';
    fam.title = '본문 글꼴 (소스·위지윅)';
    fam.setAttribute('aria-label', '본문 글꼴');
    fam.innerHTML = Object.entries(FONTS).map(([k, f]) => `<option value="${k}">${f.label}</option>`).join('');
    fam.addEventListener('click', e => e.stopPropagation());
    fam.addEventListener('change', () => setFamily(fam.value));
    fs.insertBefore(fam, fs.firstChild);
    sw.appendChild(fs);
    setFamily(fontFamily());
    fs.addEventListener('click', e => {
      const b = e.target.closest('[data-fs]');
      if (!b) return;
      e.stopPropagation();
      setFont(fontSize() + Number(b.dataset.fs));
    });
    setFont(fontSize());

    srcTab.addEventListener('click', () => { if (!srcOn) { enterSource(); modeChanged(); } });
    // 마크다운/위지윅 탭을 누르면 소스에서 나간다 (Toast 의 처리보다 먼저)
    sw.addEventListener('click', e => {
      const t = e.target.closest('.tab-item');
      if (!t || t === srcTab || t.classList.contains('active')) return;
      // 마크다운↔위지윅을 바꾸면 Toast 가 커서를 글 끝에 두고 그리로 스크롤한다 → 보던 위치를 지킨다
      holdScroll();
      // 폰·태블릿: Toast 는 탭을 바꾸며 본문에 커서를 둬서 키보드가 바로 올라온다 → 커서 없이 바꾸고, 본문을 눌러야 편집
      if (matchMedia('(pointer: coarse), (max-width: 767px)').matches) {
        e.stopPropagation(); e.preventDefault();
        const tabs = [...sw.querySelectorAll('.tab-item')];
        const want = t.textContent.trim() === '마크다운' ? 'markdown' : 'wysiwyg';
        if (srcOn) leaveSource(true);
        if (ed.isWysiwygMode() !== (want === 'wysiwyg')) keepScroll(() => ed.changeMode(want, true));
        else tabs.forEach(x => x.classList.toggle('active', x === t));
        dropFocus(null);
        setTimeout(modeChanged, 0);
        return;
      }
      if (srcOn) leaveSource(true);
      setTimeout(modeChanged, 0);   // Toast 가 탭을 바꾼 뒤
    }, true);
    src.addEventListener('keydown', hrInSource);
    // 위지윅 코드 블록에서 빠져나오기: 코드 끝에서 Enter 두 번(빈 줄에서 Enter), 또는 맨 마지막 코드 블록 끝에서 ↓
    // ProseMirror 보다 먼저 받으려고 바깥(root)에서 capture 로 듣는다
    root.addEventListener('keydown', codeBlockExit, true);
    src.addEventListener('input', () => {
      fit();
      if (opts.onSourceInput) opts.onSourceInput(src.value);
      clearTimeout(hlTimer); hlTimer = setTimeout(paint, hlTerms.length || fTerms.length ? 150 : 400);   // 그림 표시도 다시 그림
    });
    // 소스 탭에서도 이미지 붙여넣기 → 업로드 후 그 자리에 ![](주소)
    src.addEventListener('paste', e => {
      const files = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith('image/'));
      if (!files.length || !opts.uploadImage) return;
      e.preventDefault();
      files.forEach(f => opts.uploadImage(f).then(r => insertSource('![](' + r.url + ')\n')).catch(() => {}));
    });
  }

  const FONT_MIN = 11, FONT_MAX = 24, FONT_KEY = 'note.edFont';
  function fontSize() {
    try { const v = Number(localStorage.getItem(FONT_KEY)); if (v >= FONT_MIN && v <= FONT_MAX) return v; } catch { /* 없음 */ }
    return 15;
  }
  function setFont(px) {
    px = Math.max(FONT_MIN, Math.min(FONT_MAX, px));
    try { localStorage.setItem(FONT_KEY, String(px)); } catch { /* 저장 안 돼도 동작 */ }
    root.parentElement.style.setProperty('--ed-font', px + 'px');   // #ed-wysiwyg
    const val = root.querySelector('.ne-fs-val');
    if (val) val.textContent = px;
    root.querySelectorAll('.ne-font [data-fs]').forEach(b => { b.disabled = b.dataset.fs < 0 ? px <= FONT_MIN : px >= FONT_MAX; });
    if (src && !src.hidden) fit();   // 소스 칸 높이 다시 맞춤
  }

  /** 소스 textarea 의 커서 자리에 글 넣기 (되돌리기 되게 execCommand 우선) */
  function insertSource(text) {
    src.focus();
    if (!document.execCommand('insertText', false, text)) {
      src.setRangeText(text, src.selectionStart, src.selectionEnd, 'end');
      src.dispatchEvent(new Event('input'));
    }
  }

  /**
   * Toast(ProseMirror)는 내용을 바꿀 때 화면 위치를 맞춘다며 바깥 스크롤(위쪽 노트 목록 등)까지 움직인다.
   * 내용을 넣는 동안 opts.keepScroll 요소들의 스크롤 위치를 저장했다가 되돌린다.
   */
  function keepScroll(fn) {
    const els = (opts.keepScroll || []).map(s => document.querySelector(s)).filter(Boolean);
    const pos = els.map(el => [el.scrollTop, el.scrollLeft]);
    const restore = () => els.forEach((el, i) => { el.scrollTop = pos[i][0]; el.scrollLeft = pos[i][1]; });
    try { return fn(); } finally { restore(); requestAnimationFrame(restore); }
  }


  /** 지금 스크롤 위치를 잠깐(약 0.4초) 지킨다. 그 사이 Toast 가 움직여도 되돌림 */
  function holdScroll() {
    const els = (opts.keepScroll || []).map(s => document.querySelector(s)).filter(Boolean);
    const pos = els.map(el => [el.scrollTop, el.scrollLeft]);
    const restore = () => els.forEach((el, i) => { el.scrollTop = pos[i][0]; el.scrollLeft = pos[i][1]; });
    requestAnimationFrame(restore);
    [0, 30, 80, 150, 250, 400].forEach(ms => setTimeout(restore, ms));
  }

  // 글 길이만큼 높이를 맞춘다. 짧으면 CSS(flex)가 화면 아래까지 늘려 준다(잴 때만 늘리기를 끔)
  // 높이를 잠깐 auto 로 줄이는 동안 바깥 스크롤(본문 스크롤 칸 등)이 위로 끌려 올라가므로, 스크롤 위치를 저장했다가 되돌린다
  const fit = () => {
    const outs = [];
    for (let el = srcWrap; el; el = el.parentElement) if (el.scrollTop) outs.push([el, el.scrollTop]);
    src.style.flexGrow = '0'; src.style.height = 'auto';
    src.style.height = src.scrollHeight + 2 + 'px';
    src.style.flexGrow = '';
    for (const [el, top] of outs) el.scrollTop = top;
  };

  // 에디터에 마지막으로 넣은 원래 글과, 에디터가 그걸 정리한 모양.
  // 위지윅에서 아무것도 안 고치고 소스로 돌아오면 정리된 모양 말고 원래 txt 를 보여 주려고 기억한다.
  let loadedFrom = '', loadedMd = '';

  function enterSource(given) {
    let text = given;
    if (text === undefined) {
      const md = mdOut();
      text = md === loadedMd ? loadedFrom : md;
    }
    prevTab = root.querySelector('.toastui-editor-mode-switch .tab-item.active');
    root.querySelectorAll('.toastui-editor-mode-switch .tab-item').forEach(t => t.classList.remove('active'));
    srcTab.classList.add('active');
    srcOn = true;
    root.classList.add('ne-source-on');
    src.value = text;
    src.hidden = false; srcWrap.hidden = false;
    fit();
    if (opts.onSourceMode) opts.onSourceMode(true);
    paint();
  }

  /** $apply: 소스에서 고친 본문을 에디터에 넣는다 */
  function leaveSource(apply) {
    if (!srcOn) return;
    // 소스에서 쓴 그대로 먼저 저장하게 한다(에디터로 넘어가면 모양이 정리되므로)
    if (apply && opts.beforeLeaveSource) opts.beforeLeaveSource();
    const body = src.value;
    srcOn = false;
    root.classList.remove('ne-source-on');
    src.hidden = true; srcWrap.hidden = true;
    if (srcImgs) { srcImgs.hidden = true; imgsKey = ''; }
    if (imgTip) imgTip.hidden = true;
    srcTab.classList.remove('active');
    if (prevTab) prevTab.classList.add('active');
    if (apply) {
      // 소스로 연 노트는 에디터에 아직 안 들어가 있으므로 탭을 바꿀 때 넣는다
      suppress = true;
      try { keepScroll(() => ed.setMarkdown(body, false)); } finally { setTimeout(() => { suppress = false; }, 0); }
      loadedFrom = body; loadedMd = mdOut();
    }
    if (opts.onSourceMode) opts.onSourceMode(false);
  }

  function set(md) {
    leaveSource(false);
    suppress = true;
    try {
      keepScroll(() => {
        ed.setMarkdown(md || '', false);
        if (ed.moveCursorToStart) ed.moveCursorToStart(false);
      });
    } finally {
      // change 이벤트가 바로 다음 틱에 올 수도 있어 한 틱 뒤에 푼다
      setTimeout(() => { suppress = false; }, 0);
    }
    loadedFrom = md || ''; loadedMd = mdOut();
    return loadedMd;
  }

  /**
   * 노트를 소스 탭으로 연다. 에디터(Toast)는 건드리지 않아 빠르고 목록 스크롤도 안 움직인다.
   * 위지윅·마크다운 탭을 누를 때 그때 에디터에 넣는다. 돌려주는 값 = 비교 기준 본문(원래 txt 그대로).
   */
  function openSource(body) {
    leaveSource(false);
    enterSource(body);
    lastMode = 'source';
    return body;
  }

  // ---------- 보기 방식(소스·마크다운·위지윅) ----------
  // 사람이 탭을 바꿀 때만 opts.onModeChange 로 알린다(노트를 열며 setMode 로 바꿀 때는 안 알림)
  let lastMode = 'source', quietMode = false;
  // 한글 조합 입력 중 표시 (소스 칸·에디터 어디서든)
  let composingNow = false;
  document.addEventListener('compositionstart', () => { composingNow = true; }, true);
  document.addEventListener('compositionend', () => { composingNow = false; }, true);
  function curMode() {
    if (srcOn) return 'source';
    return ed && ed.isWysiwygMode() ? 'wysiwyg' : 'markdown';
  }
  function modeChanged() {
    const m = curMode();
    if (m === lastMode) return;
    lastMode = m;
    if (!quietMode && opts.onModeChange) opts.onModeChange(m);
  }
  /** 본문에 커서가 들어가 있으면 뺀다(폰에서 키보드가 저절로 올라오지 않게). Toast 가 한 틱 뒤에 다시 넣는 것까지 */
  function dropFocus(wasIn) {
    const out = () => {
      const a = document.activeElement;
      if (a && a !== wasIn && root && root.contains(a) && a.blur) a.blur();
    };
    out(); setTimeout(out, 0); setTimeout(out, 60);
  }

  /** 노트를 연 뒤 그 노트가 마지막으로 보던 방식으로 (커서는 본문에 넣지 않음 → 본문을 눌러야 편집) */
  function setMode(mode) {
    if (!src || !ed) return;
    const before = document.activeElement;
    quietMode = true;
    try {
      if (mode === 'source' || mode === 'markdown') { if (!srcOn) enterSource(); }   // 마크다운 탭은 없앰 → 소스로
      else {
        const want = mode === 'markdown' ? 'markdown' : 'wysiwyg';
        if (srcOn) leaveSource(true);
        if (ed.isWysiwygMode() !== (want === 'wysiwyg')) keepScroll(() => ed.changeMode(want, true));
      }
      lastMode = curMode();
    } finally {
      setTimeout(() => { quietMode = false; }, 0);
      dropFocus(root && root.contains(before) ? before : null);
    }
  }

  // ---------- 검색어 하이라이트 · 찾기 ----------
  // 소스 탭: 밑에 깐 층(srcHl)에 <mark>. 마크다운·위지윅·읽기 보기: 브라우저 하이라이트(CSS Custom Highlight, DOM 을 안 건드림)
  const HAS_HL = !!(window.CSS && CSS.highlights && window.Highlight);
  // hl* = 목록 검색어(연노랑), f* = 이 노트에서 찾기(연파랑, 지금 위치는 주황)
  let hlTerms = [], hlTimer = 0, hlMatches = [], hlEl = null, fTerms = [], fMatches = [], fCur = -1;
  const escH = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const escA = s => escH(s).replace(/"/g, '&quot;');   // 속성 값용

  /** 글 속에서 낱말들 위치 [시작, 끝] (대소문자 무시, 겹치면 합침) */
  function findAll(text, terms) {
    const low = text.toLowerCase(), same = low.length === text.length, hay = same ? low : text;
    let out = [];
    for (const t of terms) {
      const n = same ? t.toLowerCase() : t;
      if (!n) continue;
      for (let i = hay.indexOf(n); i !== -1 && out.length < 5000; i = hay.indexOf(n, i + n.length)) out.push([i, i + n.length]);
    }
    out.sort((a, b) => a[0] - b[0]);
    out = out.reduce((acc, m) => { const p = acc[acc.length - 1]; if (p && m[0] < p[1]) p[1] = Math.max(p[1], m[1]); else acc.push(m); return acc; }, []);
    return out;
  }
  function rangesIn(el, terms) {
    const rs = [];
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n && rs.length < 5000; n = w.nextNode()) {
      for (const [s, e] of findAll(n.data, terms)) { const r = new Range(); r.setStart(n, s); r.setEnd(n, e); rs.push(r); }
    }
    return rs;
  }
  /** 브라우저 하이라이트 칠하기: 목록 검색어(ne-hl) · 찾기(ne-find) · 찾기 지금 위치(ne-hl-cur) */
  function setHL(list, find, cur) {
    if (!HAS_HL) return;
    const put = (name, rs, pri) => {
      if (!rs.length) { CSS.highlights.delete(name); return; }
      const h = new Highlight(...rs); h.priority = pri; CSS.highlights.set(name, h);
    };
    put('ne-hl', list, 0);
    put('ne-find', find, 1);
    put('ne-hl-cur', cur >= 0 && find[cur] ? [find[cur]] : [], 2);
  }
  /** 찾기 자리와 겹치는 목록 검색어 자리는 빼서(찾기가 위) 함께 칠한다 */
  function withoutOverlap(list, find) {
    if (!find.length) return list;
    return list.filter(([s, e]) => !find.some(([fs, fe]) => s < fe && fs < e));
  }
  function paintSource() {
    const text = src.value;
    fMatches = fTerms.length ? findAll(text, fTerms) : [];
    if (fCur >= fMatches.length) fCur = -1;
    hlMatches = hlTerms.length ? withoutOverlap(findAll(text, hlTerms), fMatches) : [];
    const imgs = findImages(text);
    renderSourceImages(imgs);
    // 그림 자리는 검색 색칠과 겹치지 않을 때만 표시(마우스 올리면 미리보기)
    const busy = hlMatches.concat(fMatches);
    const imgMarks = imgs.filter(m => !busy.some(b => b[0] < m.end && m.start < b[1])).map(m => [m.start, m.end, 'img', m.url]);
    const all = hlMatches.map(m => [m[0], m[1], 'l']).concat(fMatches.map((m, i) => [m[0], m[1], i === fCur ? 'f cur' : 'f']), imgMarks);
    if (!all.length) { srcHl.textContent = ''; return; }
    all.sort((x, y) => x[0] - y[0]);
    let html = '', last = 0;
    for (const [st, en, cls, url] of all) {
      if (st < last) continue;
      html += escH(text.slice(last, st)) + `<mark class="${cls}"${url ? ` data-src="${escA(url)}"` : ''}>` + escH(text.slice(st, en)) + '</mark>';
      last = en;
    }
    srcHl.innerHTML = html + escH(text.slice(last)) + '\n';
  }

  // ---------- 소스 탭 그림 미리보기 ----------
  // ![설명](주소) 와 <img src="주소"> 를 찾는다. 주소는 이 사이트 첨부(file.php)·http(s)·data:image 만
  const IMG_MD = /!\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"\n]*")?\s*\)|<img\b[^>\n]*?\bsrc\s*=\s*["']([^"'\n]+)["'][^>\n]*>/gi;
  const okImgUrl = u => /^(file\.php\?|https?:\/\/|data:image\/)/i.test(u);
  function findImages(text) {
    const out = [];
    IMG_MD.lastIndex = 0;
    for (let m; (m = IMG_MD.exec(text));) {
      const url = (m[1] || m[2] || '').replace(/&amp;/g, '&');
      if (okImgUrl(url)) out.push({ start: m.index, end: m.index + m[0].length, url });
    }
    return out;
  }
  function setupSourceImages(sw) {
    // 소스 칸 위: 본문에 든 그림을 작은 그림으로 모아 보여 줌 (누르면 그 자리로)
    srcImgs = document.createElement('div');
    srcImgs.className = 'ne-src-imgs';
    srcImgs.hidden = true;
    sw.parentNode.insertBefore(srcImgs, srcWrap);
    srcImgs.addEventListener('mousedown', e => e.preventDefault());
    // 본문의 그 그림 줄로 가서 선택
    const goTo = b => {
      const [s, en] = b.dataset.at.split(',').map(Number);
      src.focus();
      src.setSelectionRange(s, en);
      const mk = [...srcHl.querySelectorAll('mark.img')].find(m => m.dataset.src === b.dataset.src);
      (mk || src).scrollIntoView({ block: 'center' });
      srcHl.scrollTop = 0; srcHl.scrollLeft = 0;   // 밑층 자체가 스크롤되면 글과 어긋남
    };
    // 작은 그림을 누르면 크게 보기 레이어 (← → 로 넘기기, Esc·바깥 누르면 닫기)
    const lb = document.createElement('div');
    lb.className = 'ne-lightbox';
    lb.hidden = true;
    lb.setAttribute('role', 'dialog');
    lb.setAttribute('aria-label', '그림 크게 보기');
    lb.innerHTML = '<div class="lb-bar"><span class="lb-cnt"></span><button type="button" class="lb-btn lb-open" title="원본 크기로 새 창에서 보기">원본</button>'
      + '<button type="button" class="lb-btn lb-go" title="본문의 이 그림 자리로">본문 위치로</button>'
      + '<button type="button" class="lb-btn lb-dl" title="저장할 곳을 골라 받기">다운로드</button><button type="button" class="lb-btn lb-x" title="닫기 (Esc)" aria-label="닫기">✕</button></div>'
      + '<button type="button" class="lb-nav lb-prev" aria-label="이전 그림">‹</button><img alt=""><button type="button" class="lb-nav lb-next" aria-label="다음 그림">›</button>';
    document.body.appendChild(lb);
    let lbI = 0;
    const lbBtns = () => [...srcImgs.querySelectorAll('[data-src]')];
    const lbShow = i => {
      const bs = lbBtns();
      if (!bs.length) return lbClose();
      lbI = (i + bs.length) % bs.length;
      const url = bs[lbI].dataset.src;
      lb.querySelector('img').src = url;
      lb.querySelector('.lb-cnt').textContent = `${lbI + 1} / ${bs.length}`;
      lb.querySelectorAll('.lb-nav').forEach(n => { n.hidden = bs.length < 2; });
      // 본문에 안 쓴 첨부 그림은 "본문 위치로" 가 없음
      const go = lb.querySelector('.lb-go');
      go.disabled = !bs[lbI].dataset.at;
      go.title = go.disabled ? '본문에 넣지 않은 첨부 그림입니다' : '본문의 이 그림 자리로';
      lb.hidden = false;
    };
    const lbClose = () => { lb.hidden = true; lb.querySelector('img').removeAttribute('src'); };
    lb.addEventListener('click', e => {
      if (e.target.closest('.lb-prev')) return lbShow(lbI - 1);
      if (e.target.closest('.lb-next')) return lbShow(lbI + 1);
      if (e.target.closest('.lb-go')) { const b = lbBtns()[lbI]; if (!b || !b.dataset.at) return; lbClose(); goTo(b); return; }
      if (e.target.closest('.lb-open')) return openOriginal(lb.querySelector('img'));
      if (e.target.closest('.lb-dl')) { const u = lb.querySelector('img').getAttribute('src'); if (u && opts.downloadFile) opts.downloadFile(u); return; }
      if (e.target.closest('.lb-x') || e.target === lb) lbClose();
    });
    document.addEventListener('keydown', e => {
      if (lb.hidden) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); lbClose(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); lbShow(lbI - 1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); lbShow(lbI + 1); }
    }, true);
    srcImgs.addEventListener('click', e => {
      const b = e.target.closest('[data-src]');
      if (b) lbShow(lbBtns().indexOf(b));
    });
    // 원본 보기: 주소창 없는 팝업 창(그림 크기에 맞춤, 화면보다 크면 화면에 맞춤)
    const openOriginal = img => {
      const url = img.getAttribute('src');
      if (!url) return;
      const nw = img.naturalWidth || 800, nh = img.naturalHeight || 600;
      const w = Math.min(Math.max(nw + 16, 320), screen.availWidth - 40), h = Math.min(Math.max(nh + 16, 240), screen.availHeight - 60);
      const x = Math.round((screen.availWidth - w) / 2), y = Math.max(10, Math.round((screen.availHeight - h) / 2));
      const win = window.open(url, 'note-img', `popup=yes,width=${w},height=${h},left=${x},top=${y}`);
      if (win) win.focus();
    };
    // 소스 글의 그림 줄에 마우스를 올리면 그 그림을 띄움 (textarea 위라서 밑층 mark 의 자리로 판단)
    imgTip = document.createElement('div');
    imgTip.className = 'ne-img-tip';
    imgTip.hidden = true;
    imgTip.innerHTML = '<img alt="">';
    document.body.appendChild(imgTip);
    let tipFor = null;
    const hide = () => { imgTip.hidden = true; tipFor = null; };
    srcWrap.addEventListener('mouseleave', hide);
    src.addEventListener('keydown', hide);
    src.addEventListener('mousemove', e => {
      const x = e.clientX, y = e.clientY;
      const mk = [...srcHl.querySelectorAll('mark.img')].find(m => [...m.getClientRects()].some(r => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom));
      if (!mk) { if (tipFor) hide(); return; }
      if (tipFor !== mk.dataset.src) {
        tipFor = mk.dataset.src;
        imgTip.firstChild.src = tipFor;
      }
      imgTip.hidden = false;
      const w = imgTip.offsetWidth, h = imgTip.offsetHeight, vw = document.documentElement.clientWidth, vh = window.innerHeight;
      imgTip.style.left = Math.max(4, Math.min(x + 16, vw - w - 4)) + 'px';
      imgTip.style.top = Math.max(4, y + 20 + h > vh ? y - h - 12 : y + 20) + 'px';
    });
    imgTip.firstChild.addEventListener('load', () => { if (!imgTip.hidden) imgTip.style.visibility = ''; });
  }
  let imgsKey = '';
  // 이 노트에 첨부된 그림 주소들(본문에 안 썼어도 그림 모음에 보여 주려고, app.js 가 알려 줌)
  let attachImgs = [];
  const sameUrl = u => { try { return decodeURIComponent(u.replace(/&amp;/g, '&')); } catch { return u; } };
  function renderSourceImages(imgs) {
    if (!srcImgs) return;
    const inBody = new Set(imgs.map(m => sameUrl(m.url)));
    const extra = attachImgs.filter(u => !inBody.has(sameUrl(u)));
    const n = imgs.length + extra.length;
    const key = imgs.map(m => m.url + '@' + m.start).concat(extra).join('\n');
    if (key === imgsKey && !srcImgs.hidden === !!(srcOn && n)) return;
    imgsKey = key;
    srcImgs.hidden = !(srcOn && n);
    if (srcImgs.hidden) { srcImgs.innerHTML = ''; return; }
    srcImgs.innerHTML = `<span class="ne-si-head">그림 ${n}${extra.length ? `<small>본문 밖 ${extra.length}</small>` : ''}</span>` + imgs.map(m =>
      `<button type="button" data-at="${m.start},${m.end}" data-src="${escA(m.url)}" title="눌러서 크게 보기"><img src="${escA(m.url)}" alt="" loading="lazy"></button>`).join('')
      + extra.map(u =>
      `<button type="button" class="extra" data-src="${escA(u)}" title="본문에 넣지 않은 첨부 그림 · 눌러서 크게 보기"><img src="${escA(u)}" alt="" loading="lazy"></button>`).join('');
  }
  /** 첨부 그림 목록 알려 주기 (노트를 열거나 첨부가 바뀔 때) */
  function setAttachImages(urls) {
    attachImgs = (urls || []).filter(Boolean);
    if (src && srcOn) renderSourceImages(findImages(src.value));
  }
  function pmRoot() {
    if (!ed || !root) return null;
    return root.querySelector(ed.isWysiwygMode() ? '.toastui-editor-ww-container .ProseMirror' : '.toastui-editor-md-container .ProseMirror');
  }
  function paint() {
    if (!src) return;
    if (srcOn && !hlEl) { paintSource(); setHL([], [], -1); return; }
    srcHl.textContent = '';
    const el = hlEl || pmRoot();
    fMatches = el && fTerms.length ? rangesIn(el, fTerms) : [];
    if (fCur >= fMatches.length) fCur = -1;
    hlMatches = el && hlTerms.length ? rangesIn(el, hlTerms) : [];
    setHL(hlMatches, fMatches, fCur);
  }

  /**
   * 하이라이트. $terms: 목록 검색어(연노랑), $find: 이 노트에서 찾기 글(연파랑) - 둘 다 함께 보임.
   * $el: 에디터 대신 칠할 요소(휴지통 읽기 보기 등). 돌려주는 값 = {list: 목록 검색어 개수, find: 찾기 개수}
   */
  function highlight(terms, el, find) {
    const clean = a => (a || []).map(t => String(t).trim()).filter(Boolean);
    hlTerms = clean(terms);
    const nf = clean(find);
    if (nf.join('\u0000') !== fTerms.join('\u0000')) fCur = -1;   // 찾을 글이 바뀌면 처음부터
    fTerms = nf;
    hlEl = el || null;
    paint();
    return { list: hlMatches.length, find: fMatches.length };
  }

  /** 찾기 글의 다음(+1)/이전(-1) 자리로. 돌려주는 값 {i: 몇 번째(0부터), n: 전체} */
  function findStep(dir) {
    paint();
    const n = fMatches.length;
    if (!n) return { i: -1, n: 0 };
    fCur = fCur < 0 ? (dir > 0 ? 0 : n - 1) : (fCur + dir + n) % n;
    if (srcOn && !hlEl) {
      paintSource();
      const [s, e] = fMatches[fCur];
      src.setSelectionRange(s, e);
      srcHl.querySelector('mark.cur')?.scrollIntoView({ block: 'center' });
      srcHl.scrollTop = 0; srcHl.scrollLeft = 0;
    } else {
      setHL(hlMatches, fMatches, fCur);
      fMatches[fCur].startContainer.parentElement?.scrollIntoView({ block: 'center' });
    }
    return { i: fCur, n };
  }

  // ---------- 바꾸기 ----------
  /** 마크다운·위지윅 탭의 ProseMirror 화면 (되돌리기(Ctrl+Z)되게 여기에 바로 고침) */
  function pmView() {
    const m = ed && ed.getCurrentModeEditor && ed.getCurrentModeEditor();
    return m && m.view ? m.view : null;
  }
  const pmPos = (view, r) => [view.posAtDOM(r.startContainer, r.startOffset), view.posAtDOM(r.endContainer, r.endOffset)];

  /** 고친 뒤: 고친 자리 뒤의 첫 찾기 자리로 (없으면 처음으로) */
  function stepFrom(starts, pos) {
    const i = starts.findIndex(s => s >= pos);
    fCur = (i < 0 ? 0 : i) - 1;
    return findStep(1);
  }

  /** 지금 찾은 자리 하나를 $text 로 바꾸고 다음 자리로. 돌려주는 값 {i, n, done: 바꿨는지} */
  function replaceStep(text) {
    paint();
    if (hlEl || !fMatches.length) return { i: -1, n: 0, done: false };
    if (fCur < 0 || fCur >= fMatches.length) return { ...findStep(1), done: false };   // 먼저 자리를 보여 줌
    if (srcOn) {
      const [s, e] = fMatches[fCur];
      src.setSelectionRange(s, e);
      insertSource(text);
      paint();
      return { ...stepFrom(fMatches.map(m => m[0]), s + text.length), done: true };
    }
    const view = pmView();
    if (!view) return { i: -1, n: 0, done: false };
    const [from, to] = pmPos(view, fMatches[fCur]);
    view.dispatch(text ? view.state.tr.insertText(text, from, to) : view.state.tr.delete(from, to));
    paint();
    const v2 = pmView();
    return { ...stepFrom(fMatches.map(r => pmPos(v2, r)[0]), from + text.length), done: true };
  }

  /** 찾기 글을 모두 $text 로. 돌려주는 값 = 바꾼 개수 */
  function replaceAll(text) {
    paint();
    const n = fMatches.length;
    if (hlEl || !n) return 0;
    if (srcOn) {
      const v = src.value;
      let out = '', last = 0;
      for (const [s, e] of fMatches) { out += v.slice(last, s) + text; last = e; }
      out += v.slice(last);
      src.focus(); src.select();
      insertSource(out);   // 한 번에 넣어 Ctrl+Z 한 번으로 되돌림
    } else {
      const view = pmView();
      if (!view) return 0;
      const pos = fMatches.map(r => pmPos(view, r));
      let tr = view.state.tr;
      for (let i = pos.length - 1; i >= 0; i--) {   // 뒤에서부터 고쳐야 앞 자리 번호가 안 바뀜
        const [from, to] = pos[i];
        tr = text ? tr.insertText(text, from, to) : tr.delete(from, to);
      }
      view.dispatch(tr);
    }
    fCur = -1;
    paint();
    return n;
  }

  // ---------- 글꼴 (소스·마크다운·위지윅 같이, 브라우저마다 기억) ----------
  const FONTS = {
    base: { label: '기본 글꼴', css: 'var(--font)' },
    mono: { label: '고정폭 (Consolas)', css: 'Consolas, "D2Coding", "GulimChe", monospace' },
    d2: { label: 'D2Coding', css: '"D2Coding", "D2Coding ligature", Consolas, monospace' },
    malgun: { label: '맑은 고딕', css: '"Malgun Gothic", "Apple SD Gothic Neo", sans-serif' },
    gulim: { label: '굴림체', css: '"GulimChe", "Gulim", monospace' },
    serif: { label: '바탕 (명조)', css: '"Batang", "AppleMyungjo", "Noto Serif KR", serif' },
  };
  const FAM_KEY = 'note.edFamily';
  function fontFamily() { try { const v = localStorage.getItem(FAM_KEY); if (v && FONTS[v]) return v; } catch { /* 없음 */ } return 'base'; }
  function setFamily(k) {
    if (!FONTS[k]) k = 'base';
    try { localStorage.setItem(FAM_KEY, k); } catch { /* 저장 안 돼도 동작 */ }
    root.parentElement.style.setProperty('--ed-family', FONTS[k].css);
    const s = root.querySelector('.ne-family');
    if (s) s.value = k;
    if (src && !src.hidden) fit();
  }

  return {
    replaceStep,
    replaceAll,
    create: (el, options) => { create(el, options); setupSource(el); },
    highlight,
    findStep,
    set,
    // 소스 탭에서는 쓴 그대로를 돌려준다
    get: () => (srcOn ? src.value : mdOut()),
    isSource: () => srcOn,
    /** 소스 탭으로 연다. $caret: 커서 위치(0 = 본문 맨 앞) */
    showSource: caret => {
      if (!src) return;
      if (!srcOn) enterSource();
      if (caret !== undefined) { src.focus(); src.setSelectionRange(caret, caret); }
    },
    openSource,
    setMode,
    mode: () => curMode(),
    // 소스 탭이면 txt 에 Markdown 글자로, 아니면 에디터에 넣는다
    insertImage: (url, alt) => srcOn ? insertSource(`![${alt || ''}](${url})\n`) : ed.exec('addImage', { imageUrl: url, altText: alt || '' }),
    insertLink: (url, text) => srcOn ? insertSource(`[${text.replace(/[\[\]]/g, '')}](${url}) `) : ed.exec('addLink', { linkUrl: url, linkText: text }),
    focus: () => (srcOn ? src.focus() : ed.focus()),
    /** 본문 줄 수: 소스는 줄바꿈 수, 위지윅은 문단(블록) 수 */
    lineCount: () => {
      if (srcOn) return src.value.split('\n').length;
      const v = pmView();
      return v ? v.state.doc.childCount : 1;
    },
    /** 한글 등 조합 입력 중인지 (조합 중에는 글을 건드리지 않음) */
    composing: () => composingNow,
    /** 본문 첫 줄을 떼어 내 돌려준다(제목으로 쓰려고). 커서는 그 아래 줄에 그대로 */
    takeFirstLine: () => {
      if (srcOn) {
        const v = src.value, i = v.indexOf('\n');
        if (i < 0) return null;
        const caret = src.selectionStart;
        src.value = v.slice(i + 1);
        const p = Math.max(0, caret - i - 1);
        src.setSelectionRange(p, p);
        fit();
        src.dispatchEvent(new Event('input'));
        return v.slice(0, i);
      }
      const view = pmView();
      if (!view || view.state.doc.childCount < 2) return null;
      const first = view.state.doc.firstChild;
      view.dispatch(view.state.tr.delete(0, first.nodeSize));   // 문서 고치기라 Ctrl+Z 로 되돌릴 수 있음
      return first.textContent;
    },
    /** 본문 통째로 바꾸기 (소스 탭이면 소스 칸 그대로 유지, 아니면 에디터에) — 첨부 지울 때 씀 */
    replaceBody: md => {
      if (srcOn) {
        const top = src.scrollTop, pos = Math.min(src.selectionStart, md.length);
        src.value = md;
        src.setSelectionRange(pos, pos);
        src.dispatchEvent(new Event('input'));
        src.scrollTop = top;
      } else {
        keepScroll(() => ed.setMarkdown(md || '', false));
      }
    },
    /** 커서 자리에 글 넣기 (소스 탭은 txt 그대로, 마크다운·위지윅은 에디터에) */
    setAttachImages,
    insertText: text => {
      if (srcOn) return insertSource(text);
      ed.focus();
      ed.insertText(text);
    },
  };
})();
