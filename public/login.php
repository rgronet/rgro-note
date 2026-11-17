<?php
declare(strict_types=1);
require dirname(__DIR__) . '/app/bootstrap.php';

// 로그인 시작/처리. 화면은 index.php(로그인 안 했을 때)에 있다.
//   GET  login.php?p=google|naver|kakao  → 그 방식으로 로그인 시작
//   POST login.php (login_id, password)   → 아이디·암호 로그인
/** 다음 화면으로. 앱 모드 로그인(assets/login.js 가 fetch 로 보냄)은 이동할 주소만 JSON 으로 돌려준다
 *  (fetch 가 리디렉션을 따라가면 한 번만 보이는 오류 문구를 먼저 써 버리므로) */
function login_go(string $url): never
{
    if (($_SERVER['HTTP_X_LOGIN_FETCH'] ?? '') === '1') json_out(['go' => $url]);
    redirect($url);
}

function login_fail(string $msg, string $id = ''): never
{
    $_SESSION['login_err'] = $msg;
    if ($id !== '') $_SESSION['login_id'] = $id;
    login_go('./');
}

if (current_user()) redirect('./');

// 개발용 로그인: 설정에서 켜고 PC 에서 직접 접속할 때만 (첫 번째 계정)
if (config('dev_login') === true && is_local_request() && ($_GET['p'] ?? '') === 'dev') {
    $uid = (string)array_key_first(Auth::accounts());
    $a = Auth::accounts()[$uid] ?? [];
    foreach (Auth::METHODS as $m => $_) {
        $key = $m === 'password' ? 'login_id' : $m;
        if (!empty($a[$key]) && Auth::enabled($m)) { login_user($m, (string)(is_array($a[$key]) ? $a[$key][0] : $a[$key]), '개발용'); redirect('./'); }
    }
    login_fail('개발용 로그인: 켜진 방식에 맞는 계정이 없습니다');
}

try {
    if ($_SERVER['REQUEST_METHOD'] === 'POST') {
        $id = trim((string)($_POST['login_id'] ?? ''));
        if (!check_csrf($_POST['csrf'] ?? null)) login_fail('로그인 화면이 오래되었습니다. 다시 하세요.', $id);
        if (!Auth::enabled('password')) login_fail('아이디·암호 로그인은 꺼져 있습니다');
        $r = Auth::checkPassword($id, (string)($_POST['password'] ?? ''));
        login_user('password', $id, '', '', '', $r['must_change']);
        login_go($r['must_change'] ? 'password.php' : './');
    }
    $p = (string)($_GET['p'] ?? '');
    if (!Auth::enabled($p)) login_fail('허용되지 않은 로그인 방식입니다');
    if (in_array($p, ['google', 'naver', 'kakao'], true)) Auth::socialBegin($p);
    login_fail('허용되지 않은 로그인 방식입니다');
} catch (Throwable $e) {
    login_fail($e->getMessage(), (string)($_POST['login_id'] ?? ''));
}
