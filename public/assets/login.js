// 로그인·암호 바꾸기 화면: 앱으로 쓸 때(PC 바탕화면 프로그램, 휴대폰 홈 화면 앱)는
// 크롬·엣지·삼성 인터넷·안드로이드 자동완성(삼성 패스, 구글 자동완성)의 "비밀번호를 저장할까요?" 창이 안 뜨게 한다.
// 일반 웹 브라우저에서는 아무것도 바꾸지 않는다.
//
// 브라우저·안드로이드는 type="password" 칸(또는 이름이 password 같은 칸)이 있는 양식을 보내면 저장 창을 띄운다.
// - 칸의 type 만 text 로 바꾸면, 휴대폰 크롬은 "암호 보기" 버튼으로 바뀐 것으로 보고 계속 암호 칸 취급을 한다.
//   → 원래 칸은 아예 빼고 처음부터 보통 글 칸인 새 칸을 넣는다(글자는 ● 로 가림: -webkit-text-security).
// - 칸 이름(name)·자동완성 표시도 없애서 안드로이드 자동완성 서비스가 아이디·암호 칸으로 알아보지 못하게 하고,
//   보낼 때는 원래 이름으로 직접 모아 fetch 로 보낸다(페이지 이동 = "로그인 양식을 보냈다"는 신호를 안 줌).
(() => {
  // 홈 화면 앱은 manifest 의 start_url(./?app=1)로 열린다 → 이 창(탭)에서는 계속 앱으로 기억
  try {
    if (new URLSearchParams(location.search).get('app') === '1') sessionStorage.setItem('note.app', '1');
  } catch { /* 저장 안 돼도 아래 판단으로 */ }
  let remembered = false;
  try { remembered = sessionStorage.getItem('note.app') === '1'; } catch { /* 없음 */ }

  const isApp = document.documentElement.dataset.desktop === '1'   // PC 바탕화면 프로그램(RgroNote.exe)
    || remembered                                                    // 홈 화면 앱으로 시작한 창
    || matchMedia('(display-mode: standalone)').matches             // 설치한 앱(PWA)
    || matchMedia('(display-mode: fullscreen)').matches
    || matchMedia('(display-mode: minimal-ui)').matches
    || navigator.standalone === true;                                // 아이폰 홈 화면 앱
  if (!isApp) return;

  document.querySelectorAll('form.login-form').forEach(form => {
    if (!form.querySelector('input[type="password"]')) return;
    const fields = [];   // [새 칸, 보낼 이름]
    form.querySelectorAll('input').forEach(old => {
      if (old.type === 'hidden') return;
      const key = old.getAttribute('name');
      if (old.hidden || old.type === 'password' || /username/.test(old.getAttribute('autocomplete') || '')) {
        // 원래 칸을 빼고, 처음부터 보통 글 칸인 새 칸으로 바꿔 넣음 (숨은 아이디 칸은 그냥 뺌)
        if (old.hidden) { fields.push([null, key, old.value]); old.remove(); return; }
        const inp = document.createElement('input');
        inp.type = 'text';
        if (old.type === 'password') inp.className = 'pw-mask';
        inp.placeholder = old.placeholder;
        inp.value = old.value;
        inp.required = old.required;
        if (old.minLength > 0) inp.minLength = old.minLength;
        inp.autofocus = old.autofocus;
        inp.setAttribute('autocomplete', 'off');
        inp.setAttribute('autocapitalize', 'off');
        inp.setAttribute('autocorrect', 'off');
        inp.spellcheck = false;
        inp.setAttribute('data-lpignore', 'true');      // 암호 관리 확장 무시
        inp.setAttribute('data-form-type', 'other');    // 일부 암호 관리자(대시레인 등) 무시
        inp.setAttribute('aria-label', old.placeholder);
        old.replaceWith(inp);
        fields.push([inp, key]);
        if (old.autofocus) setTimeout(() => inp.focus(), 0);
      }
    });
    form.setAttribute('autocomplete', 'off');

    form.addEventListener('submit', async e => {
      e.preventDefault();
      const btn = form.querySelector('button');
      if (btn) btn.disabled = true;
      const fd = new FormData();
      form.querySelectorAll('input[type="hidden"][name]').forEach(h => fd.append(h.name, h.value));
      for (const [inp, key, val] of fields) if (key) fd.append(key, inp ? inp.value : val);
      try {
        const r = await fetch(form.getAttribute('action') || location.href, {
          method: 'POST', body: fd, credentials: 'same-origin', redirect: 'follow',
          headers: { 'X-Login-Fetch': '1' },
        });
        // 보낸 뒤 암호 칸을 비워, 물어볼 거리를 남기지 않음
        fields.forEach(([inp]) => { if (inp && inp.classList.contains('pw-mask')) inp.value = ''; });
        if ((r.headers.get('Content-Type') || '').includes('json')) { location.replace((await r.json()).go || './'); return; }
        if (r.redirected) { location.replace(r.url); return; }
        // 암호 바꾸기 화면처럼 같은 주소에 결과를 그려 주는 경우
        const html = await r.text();
        document.open(); document.write(html); document.close();
      } catch {
        if (btn) btn.disabled = false;
        alert('서버에 연결하지 못했습니다. 다시 해 주세요.');
      }
    });
  });
})();
