<?php
declare(strict_types=1);
// 구글·네이버·카카오 로그인에서 돌아오는 곳 (public/google_callback.php, naver_callback.php, kakao_callback.php 가 $P 를 정하고 부름)
require __DIR__ . '/bootstrap.php';

try {
    if (!in_array($P ?? '', ['google', 'naver', 'kakao'], true)) throw new RuntimeException('잘못된 로그인 방식입니다');
    $info = Auth::socialFinish($P, $_GET);
    if (Auth::find($P, $info['ids']) === null) {
        // 설정의 계정 칸에 적을 값을 알려 줌 (카카오는 이메일·회원번호 둘 다)
        $num = $P === 'kakao' ? '회원번호 ' . ($info['ids'][0] ?? '?') : '';
        $who = trim($info['email'] . ($info['email'] !== '' && $num !== '' ? ' / ' : '') . $num);
        if ($who === '') $who = '회원번호 ' . ($info['ids'][0] ?? '?');
        if ($P === 'kakao' && $info['email'] === '' && !empty(config('kakao')['email'])) $who .= ' · 이메일을 받지 못함(동의 안 함 또는 인증 안 된 메일)';
        throw new RuntimeException('이 노트를 쓸 수 있는 계정이 아닙니다 (' . Auth::METHODS[$P] . ' ' . $who . ')');
    }
    login_user($P, $info['ids'], $info['name'], $info['picture'], $info['email']);
    redirect('./');
} catch (Throwable $e) {
    $_SESSION['login_err'] = $e->getMessage();
    redirect('./');
}
