<?php
declare(strict_types=1);
require dirname(__DIR__) . '/app/bootstrap.php';

security_headers();
header('Cache-Control: no-store');
// 노트 폴더(data)에 쓸 수 있는지 먼저 확인 (처음 설치 때 권한을 안 준 경우 알기 쉽게)
if (!is_dir(DATA_DIR)) @mkdir(DATA_DIR, 0707, true);
if (!is_dir(DATA_DIR) || !is_writable(DATA_DIR)) {
    http_response_code(500);
    echo '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        . '<title>알지로 노트 설치 확인</title><body style="font-family:sans-serif;max-width:560px;margin:40px auto;padding:0 16px;line-height:1.6">'
        . '<h2>노트 저장 폴더에 쓸 수 없습니다</h2>'
        . '<p>폴더: <code>' . e(DATA_DIR) . '</code></p>'
        . '<p>FTP 프로그램에서 이 폴더(없으면 만들어서)의 권한을 <b>707</b>(또는 웹서버가 쓸 수 있게)로 바꾼 뒤 새로고침하세요.<br>'
        . '다른 곳에 두려면 <code>app/config.php</code> 의 <code>data_dir</code> 를 고칩니다.</p></body>';
    exit;
}
// 바탕화면 프로그램(RgroNote.exe)이 ?desktop=1 로 열면 그 앱 전용 프로필에 쿠키로 기억 → 바깥 링크를 PC 기본 브라우저로
if (isset($_GET['desktop'])) {
    setcookie('note_desktop', '1', ['expires' => time() + 86400 * 3650, 'path' => '/', 'secure' => is_https(), 'httponly' => false, 'samesite' => 'Lax']);
    redirect('./');
}
$desktop = ($_COOKIE['note_desktop'] ?? '') === '1';
/** 바깥 링크 주소: 바탕화면 프로그램 안이면 rgronote: 로 넘겨 기본 브라우저로 */
$ext = fn(string $url) => $desktop ? 'rgronote:open?url=' . rawurlencode($url) : $url;
$user = current_user();
if ($user && !empty($user['must_change'])) redirect('password.php');   // 처음 암호로 들어왔으면 암호부터 바꾸게
$app = (string)config('app_name', '알지로 노트');
$v = '109';   // 정적 파일 캐시 갱신용
$loginErr = (string)($_SESSION['login_err'] ?? '');
$loginId = (string)($_SESSION['login_id'] ?? '');
unset($_SESSION['login_err'], $_SESSION['login_id']);
// 만든 곳·만든 사람 (로그인 화면·사이드바 아래·사용자 정보)
$credit = '<a href="' . e($ext('https://rgro.net')) . '"' . ($desktop ? '' : ' target="_blank"') . ' rel="noopener">알지로넷</a> · <a href="mailto:carrotdi@gmail.com">carrotdi@gmail.com</a>';
?><!doctype html>
<html lang="ko"<?= $desktop ? ' data-desktop="1"' : '' ?>>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<!-- 휴대폰 상단·하단 바 색은 앱이 정하지 않고 휴대폰 기본 설정을 따른다(theme-color 를 일부러 안 넣음) -->
<meta name="color-scheme" content="light dark">
<title><?= e($app) ?></title>
<link rel="manifest" href="manifest.webmanifest?v=<?= $v ?>">
<link rel="icon" href="assets/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="assets/icon-192.png">
<meta name="application-name" content="<?= e($app) ?>">
<meta name="apple-mobile-web-app-title" content="<?= e($app) ?>">
<?php if ($user): ?>
<link rel="stylesheet" href="assets/vendor/toastui/toastui-editor.min.css">
<link rel="stylesheet" href="assets/vendor/toastui/toastui-editor-dark.min.css">
<?php endif; ?>
<link rel="stylesheet" href="assets/app.css?v=<?= $v ?>">
<?php if ($user): ?>
<meta name="csrf" content="<?= e(csrf_token()) ?>">
<script src="assets/vendor/marked.min.js" defer></script>
<script src="assets/vendor/purify.min.js" defer></script>
<script src="assets/vendor/toastui/toastui-editor-all.min.js" defer></script>
<script src="assets/vendor/toastui/ko-kr.min.js" defer></script>
<script src="assets/editor.js?v=<?= $v ?>" defer></script>
<script src="assets/app.js?v=<?= $v ?>" defer></script>
<?php endif; ?>
</head>
<?php if (!$user): ?>
<script src="assets/login.js?v=<?= $v ?>" defer></script>
<body class="login-page">
<div class="login-box">
  <img src="assets/icon.svg" alt="" width="64" height="64">
  <h1><?= e($app) ?></h1>
  <p>Rgro note · 개인 노트</p>
  <?php if ($loginErr !== ''): ?><p class="login-err" role="alert"><?= e($loginErr) ?></p><?php endif; ?>
<?php $methods = Auth::enabledMethods(); ?>
<?php if (in_array('password', $methods, true)): ?>
  <form method="post" action="login.php" class="login-form">
    <input type="hidden" name="csrf" value="<?= e(csrf_token()) ?>">
    <input type="text" name="login_id" placeholder="아이디" value="<?= e($loginId) ?>" autocomplete="username" autocapitalize="off" spellcheck="false" required<?= $loginId === '' ? ' autofocus' : '' ?>>
    <input type="password" name="password" placeholder="암호" autocomplete="current-password" required<?= $loginId !== '' ? ' autofocus' : '' ?>>
    <button class="btn primary big">로그인</button>
  </form>
  <?php if (count($methods) > 1): ?><div class="login-or"><span>또는</span></div><?php endif; ?>
<?php endif; ?>
  <div class="login-social">
<?php if (in_array('google', $methods, true)): ?>
    <a class="btn big social google" href="login.php?p=google"><span class="sl">G</span>Google 계정으로 로그인</a>
<?php endif; ?>
<?php if (in_array('kakao', $methods, true)): ?>
    <a class="btn big social kakao" href="login.php?p=kakao"><span class="sl">K</span>카카오로 로그인</a>
<?php endif; ?>
<?php if (in_array('naver', $methods, true)): ?>
    <a class="btn big social naver" href="login.php?p=naver"><span class="sl">N</span>네이버로 로그인</a>
<?php endif; ?>
  </div>
<?php if (!$methods): ?>
  <p class="login-err">켜진 로그인 방식이 없습니다. app/config.php 의 'login' 을 확인하세요.</p>
<?php endif; ?>
<?php if (config('dev_login') === true && is_local_request()): ?>
  <p><a href="login.php?p=dev">개발용 로그인</a></p>
<?php endif; ?>
  <p class="credit"><?= $credit ?></p>
</div>
</body>
<?php else: ?>
<body>
<div id="app" class="show-list">

  <aside id="side">
    <div class="side-head">
      <strong><?= e($app) ?></strong>
      <button class="icon only-mobile" data-act="close-side" aria-label="닫기">✕</button>
    </div>
    <button class="btn primary new-note" data-act="new">＋ 새 노트</button>
    <nav>
      <a href="#" data-view="all" class="nav-item">모든 노트 <span class="cnt" id="cnt-all"></span></a>
      <a href="#" data-view="fixed" class="nav-item"><span class="nl"><i class="ic-slot" data-ic="pin"></i>고정</span><span class="cnt" id="cnt-fixed"></span></a>
      <a href="#" data-view="pinned" class="nav-item"><span class="nl"><i class="ic-slot" data-ic="star"></i>즐겨찾기</span><span class="cnt" id="cnt-pinned"></span></a>
      <div class="nav-group">
        <span>노트북</span>
        <button class="icon" data-act="nb-add" title="노트북 추가">＋</button>
      </div>
      <div id="nb-list"></div>
      <a href="#" data-view="att" class="nav-item"><span class="nl"><i class="ic-slot" data-ic="clip"></i>첨부 있는 노트</span><span class="cnt" id="cnt-att"></span></a>
      <button type="button" class="nav-group nav-toggle" data-act="toggle-tags" aria-expanded="false" aria-controls="tag-list">
        <span><span class="caret">▸</span> 태그 <span class="cnt" id="cnt-tags"></span></span>
      </button>
      <div id="tag-list" hidden></div>
      <a href="#" data-view="trash" class="nav-item trash">휴지통 <span class="cnt" id="cnt-trash"></span></a>
    </nav>
    <form method="post" action="logout.php" class="side-foot">
      <button type="button" class="who" data-act="user-info" title="사용자 정보 · 사용 용량 (<?= e($user['email'] ?: $user['uid']) ?>)"><?= e($user['name'] ?: ($user['email'] ?: $user['uid'])) ?></button>
      <button type="button" class="text-btn" data-act="backup-open">백업·복원</button>
      <input type="hidden" name="csrf" value="<?= e(csrf_token()) ?>">
      <button class="text-btn">로그아웃</button>
      <div class="credit"><?= $credit ?></div>
    </form>
  </aside>

  <dialog id="share-dlg" aria-labelledby="share-title">
    <h3 id="share-title">공유하기</h3>
    <p class="share-what" id="share-what"></p>
    <button type="button" class="pop-item" data-act="share-copy">📋 복사 → 카톡·메신저·메일에 붙여넣기</button>
    <button type="button" class="pop-item" data-act="share-mail">📧 메일 앱으로 보내기</button>
    <button type="button" class="pop-item" data-act="share-gmail">✉ Gmail(웹)로 보내기</button>
    <p class="share-note" id="share-note"></p>
    <div class="dlg-foot"><button type="button" class="btn small" data-act="share-close">닫기</button></div>
  </dialog>
  <dialog id="macro-dlg" aria-labelledby="macro-title">
    <h3 id="macro-title">빠른 입력 관리</h3>
    <p class="macro-help">누르면 본문 커서 자리(제목 칸에 있으면 제목)에 바로 넣습니다. "막대"를 켠 것(최대 5개)은 편집 화면 위에 버튼으로 나오고 Alt+1~5 로도 넣습니다.<br>
      <b>{ }</b> 안에 쓰면 지금 시각으로 바뀜: <code>YYYY</code> 년 · <code>MM</code> 월 · <code>DD</code> 일 · <code>HH</code> 시 · <code>mm</code> 분 · <code>ss</code> 초 · <code>요일</code> · <code>A</code> 오전/오후 · <code>hh</code> 12시간<br>
      예: <code>{YYYY-MM-DD}</code> → 2026-11-17, <code>{YYYY년 M월 D일 (요일) HH:mm}</code></p>
    <div id="macro-rows"></div>
    <button type="button" class="btn small" data-act="macro-add">＋ 추가</button>
    <div class="dlg-foot"><button type="button" class="btn small" data-act="macro-cancel">취소</button> <button type="button" class="btn small primary" data-act="macro-save">저장</button></div>
  </dialog>
  <dialog id="user-dlg" aria-labelledby="user-title">
    <h3 id="user-title">사용자 정보</h3>
    <dl class="user-info" id="user-info"></dl>
<?php if (($user['method'] ?? '') === 'password' || !empty((Auth::accounts()[$user['uid']] ?? [])['login_id']) && Auth::enabled('password')): ?>
    <p class="user-pw"><a class="btn small" href="password.php">🔑 암호 바꾸기</a></p>
<?php endif; ?>
    <p class="credit">만든 곳: <?= $credit ?></p>
    <div class="dlg-foot"><button type="button" class="btn small" data-act="user-close">닫기</button></div>
  </dialog>
  <div id="ctx-menu" class="pop" role="menu" hidden></div>
  <dialog id="backup-dlg" aria-labelledby="backup-title">
    <h3 id="backup-title">백업 · 복원</h3>
    <section>
      <h4>백업 받기</h4>
      <p>노트, 첨부, 노트북, 태그, 날짜를 모두 zip 하나로 내려받습니다.</p>
      <a class="btn primary" href="api.php?a=backup" id="backup-dl" download>백업 zip 내려받기</a>
      <p id="backup-msg" class="backup-msg" role="status"></p>
    </section>
    <details class="enex-box">
      <summary>에버노트(.enex) 가져오기</summary>
      <p>에버노트 데스크톱 앱에서 노트북 우클릭 → 내보내기 → ENEX 로 저장한 파일을 고르세요. 여러 개 한꺼번에 됩니다.
         <b>파일 이름이 노트북 이름</b>이 되고, 지금 노트는 그대로 둔 채 더하기만 합니다. 다시 가져와도 이미 있는 노트는 건너뜁니다.</p>
      <input type="file" id="enex-file" accept=".enex" multiple>
      <label class="enex-opt"><input type="checkbox" id="enex-refresh"> 이미 가져온 노트도 다시 변환 (가져온 뒤 고친 노트는 그대로)</label>
      <div class="restore-row">
        <button type="button" class="btn primary" data-act="enex-run" id="enex-run" disabled>가져오기</button>
        <progress id="enex-prog" max="100" value="0" hidden></progress>
      </div>
      <div id="enex-result" class="enex-result" role="alert" hidden></div>
      <p id="enex-msg" role="status"></p>
    </details>
    <details class="enex-box restore-box">
      <summary>zip 으로 복원</summary>
      <p>백업 zip 으로 지금 노트를 <b>통째로 바꿉니다.</b> 지금 데이터는 서버에 자동 보관됩니다(최근 3번).
         PC 의 <code>data/users/u1</code> 폴더를 압축한 zip 도 됩니다.</p>
      <input type="file" id="restore-file" accept=".zip,application/zip">
      <div class="restore-row">
        <button type="button" class="btn danger" data-act="restore-run" id="restore-run" disabled>복원</button>
        <progress id="restore-prog" max="100" value="0" hidden></progress>
      </div>
      <div id="restore-result" class="enex-result" role="alert" hidden></div>
      <p id="restore-msg" role="status"></p>
    </details>
    <div class="dlg-foot"><button type="button" class="btn" data-act="backup-close">닫기</button></div>
  </dialog>
  <div id="side-dim" data-act="close-side"></div>
  <div class="split" id="split-side" data-split="side" title="끌어서 너비 조절" aria-hidden="true"></div>

  <section id="list">
    <div class="bar">
      <button class="icon only-mobile" data-act="open-side" aria-label="메뉴">☰</button>
      <h2 id="list-title">모든 노트</h2>
      <span class="layout-sw list-sw" role="group" aria-label="화면 배치">
        <button data-layout="cols" title="목록 왼쪽 · 내용 오른쪽">▥</button>
        <button data-layout="rows" title="목록 위 · 내용 아래">▤</button>
        <button data-layout="full" title="내용 전체보기">⛶</button>
      </span>
      <span class="spacer"></span>
      <button class="icon" data-act="refresh" id="refresh-btn" title="목록 새로고침 (F5)" aria-label="목록 새로고침">⟳</button>
      <button class="icon" data-act="toggle-search" id="search-btn" title="검색·정렬" aria-label="검색·정렬 열기" aria-expanded="false" aria-controls="search-bar">🔍</button>
      <button class="icon" data-act="nb-menu" id="nb-menu-btn" hidden title="노트북 관리">⋯</button>
    </div>
    <div class="search" id="search-bar" hidden>
      <input type="search" id="q" placeholder="검색 (제목·내용·태그)" autocomplete="off">
      <select id="sort" aria-label="정렬">
        <option value="updated:desc">수정일 ↓</option>
        <option value="updated:asc">수정일 ↑</option>
        <option value="created:desc">생성일 ↓</option>
        <option value="created:asc">생성일 ↑</option>
        <option value="title:asc">제목 ㄱ→ㅎ</option>
        <option value="title:desc">제목 ㅎ→ㄱ</option>
      </select>
      <button type="button" class="btn small" id="filter-btn" data-act="toggle-filter" aria-expanded="false">기간</button>
    </div>
    <div id="filter" hidden>
      <select id="f-field" aria-label="기준 날짜">
        <option value="updated">수정일</option>
        <option value="created">생성일</option>
      </select>
      <input type="date" id="f-from" aria-label="시작일">
      <span>~</span>
      <input type="date" id="f-to" aria-label="종료일">
      <button type="button" class="btn small" data-act="filter-clear">지우기</button>
    </div>
    <div id="trash-tools" hidden><button class="btn danger small" data-act="empty-trash">휴지통 비우기</button></div>
    <div id="list-head" role="row"></div>
    <ul id="notes"></ul>
    <nav id="pager" aria-label="페이지"></nav>
    <button class="fab only-mobile" data-act="new" aria-label="새 노트">＋</button>
  </section>
  <div class="split" id="split-list" data-split="list" title="끌어서 크기 조절" aria-hidden="true"></div>

  <main id="editor">
    <div class="bar">
      <button class="icon only-mobile" data-act="back" aria-label="목록">←</button>
      <button class="btn small" data-act="prev-layout" id="btn-prev" title="전체화면 전의 배치로 (Esc)">← 이전화면</button>
      <span class="layout-sw" role="group" aria-label="화면 배치">
        <button data-layout="cols" title="목록 왼쪽 · 내용 오른쪽">▥</button>
        <button data-layout="rows" title="목록 위 · 내용 아래">▤</button>
        <button data-layout="full" title="내용 전체보기">⛶</button>
      </span>
      <button type="button" class="nb-label" id="ed-nb-label" data-act="ed-more" title="이 노트의 노트북 (눌러서 옮기기)" hidden></button>
      <span class="spacer"></span>
      <span id="save-state"></span>
      <button class="btn small" data-act="close-win" id="btn-close-win" title="저장하고 창 닫기">닫기</button>
      <span id="macro-bar" class="macro-bar" role="group" aria-label="빠른 입력"></span>
      <span class="more-wrap">
        <button class="icon" data-act="macro-menu" id="btn-macro" title="빠른 입력 (날짜·시간·자주 쓰는 문구)" aria-haspopup="true" aria-expanded="false">⚡</button>
        <div id="macro-menu" class="pop" hidden></div>
      </span>
      <button class="icon" data-act="fix" id="btn-fix" title="목록 맨 위에 고정"><i class="ic-slot" data-ic="pin"></i></button>
      <button class="icon" data-act="pin" id="btn-pin" title="즐겨찾기에 추가"><i class="ic-slot" data-ic="star-o"></i></button>
      <button class="icon" data-act="trash" id="btn-trash" title="휴지통으로">🗑</button>
      <button class="btn small" data-act="restore" id="btn-restore" hidden>복원</button>
      <button class="btn small danger" data-act="purge" id="btn-purge" hidden>영구 삭제</button>
      <span class="more-wrap">
        <button class="icon" data-act="ed-more" id="btn-more" title="더 보기" aria-haspopup="true" aria-expanded="false">⋯</button>
        <div id="ed-menu" class="pop" hidden>
          <label class="pop-row">노트북 <select id="ed-nb" aria-label="노트북"></select></label>
          <div class="pop-sep"></div>
          <button type="button" class="pop-item" data-act="note-share" id="mi-share">📤 공유하기</button>
          <button type="button" class="pop-item" data-act="note-copy">📋 내용 복사</button>
          <button type="button" class="pop-item" data-act="note-export">💾 내보내기 (.txt)</button>
          <button type="button" class="pop-item" data-act="note-pdf">📄 PDF로 저장</button>
          <button type="button" class="pop-item" data-act="note-print">🖨 인쇄</button>
          <button type="button" class="pop-item" data-act="note-find">🔎 이 노트에서 찾기 (Ctrl+F)</button>
          <div class="pop-sep"></div>
          <dl class="pop-info" id="ed-info" aria-label="노트 정보"></dl>
        </div>
      </span>
    </div>
    <div id="find-bar" role="search" hidden>
      <input type="search" id="find-q" placeholder="이 노트에서 찾기 (Enter 다음, Shift+Enter 이전)" autocomplete="off" aria-label="이 노트에서 찾기">
      <span id="find-cnt" aria-live="polite"></span>
      <button type="button" class="icon" data-act="find-prev" title="이전 (Shift+Enter)" aria-label="이전">▲</button>
      <button type="button" class="icon" data-act="find-next" title="다음 (Enter)" aria-label="다음">▼</button>
      <button type="button" class="icon" data-act="find-repl" id="find-repl-btn" title="바꾸기 열기 (Ctrl+H)" aria-label="바꾸기 열기" aria-expanded="false">⇄</button>
      <button type="button" class="icon" data-act="find-close" title="닫기 (Esc)" aria-label="찾기 닫기">✕</button>
      <div id="repl-row" hidden>
        <input type="text" id="repl-q" placeholder="바꿀 글 (비우면 지움)" autocomplete="off" aria-label="바꿀 글">
        <button type="button" class="btn small" data-act="repl-one" title="지금 자리 바꾸고 다음으로 (Enter)">바꾸기</button>
        <button type="button" class="btn small" data-act="repl-all" title="찾은 곳 모두 바꾸기 (Ctrl+Enter)">모두 바꾸기</button>
      </div>
    </div>
    <div id="ed-empty" class="empty">노트를 선택하거나 새로 만드세요.</div>
    <div id="ed-body" hidden>
      <input id="ed-title" placeholder="제목" maxlength="200" autocomplete="off" spellcheck="false">
      <div id="tag-box">
        <div id="tag-pick" role="group" aria-label="최근 쓴 태그"></div>
        <div id="tag-drop" class="pop" hidden>
          <input type="search" id="tag-q" placeholder="태그 찾기 · 새 태그 추가 (Enter)" autocomplete="off" enterkeyhint="done">
          <ul id="tag-all"></ul>
        </div>
      </div>
      <div id="ed-wysiwyg"></div>
      <article id="ed-view" class="md" hidden></article>
      <div id="ed-files"></div>
      <div id="ed-meta"></div>
    </div>
    <input type="file" id="file-input" multiple hidden>
  </main>
</div>
<div id="toast" role="status"></div>
</body>
<?php endif; ?>
</html>
