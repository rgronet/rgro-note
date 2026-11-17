<?php
declare(strict_types=1);
require dirname(__DIR__) . '/app/bootstrap.php';

// 암호 바꾸기. 처음 받은 암호로 들어오면 여기로 와야만 노트를 쓸 수 있다.
security_headers();
header('Cache-Control: no-store');
$user = current_user();
if (!$user) redirect('./');
$uid = (string)$user['uid'];
$acc = Auth::accounts()[$uid] ?? [];
if (empty($acc['login_id']) || !Auth::enabled('password')) redirect('./');   // 아이디·암호 계정이 아님

$forced = !empty($user['must_change']);
$err = ''; $done = false;
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    try {
        if (!check_csrf($_POST['csrf'] ?? null)) throw new RuntimeException('화면이 오래되었습니다. 다시 하세요.');
        // 스스로 바꿀 때는 지금 암호 확인 (처음 암호로 막 들어온 경우는 방금 확인했으므로 생략)
        if (!$forced && !Auth::verifyCurrent($uid, (string)($_POST['current'] ?? ''))) throw new RuntimeException('지금 암호가 맞지 않습니다');
        Auth::setPassword($uid, (string)($_POST['new'] ?? ''), (string)($_POST['new2'] ?? ''));
        $_SESSION['user']['must_change'] = false;
        session_regenerate_id(true);
        $done = true;
    } catch (RuntimeException $e) {
        $err = $e->getMessage();
    }
}
$app = (string)config('app_name', '알지로 노트');
?><!doctype html>
<html lang="ko"<?= ($_COOKIE['note_desktop'] ?? '') === '1' ? ' data-desktop="1"' : '' ?>><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>암호 바꾸기 - <?= e($app) ?></title>
<link rel="icon" href="assets/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="assets/app.css?v=81">
<script src="assets/login.js?v=81" defer></script></head>
<body class="login-page"><div class="login-box">
  <img src="assets/icon.svg" alt="" width="48" height="48">
  <h1>암호 바꾸기</h1>
<?php if ($done): ?>
  <p>암호를 바꿨습니다. 다음부터 새 암호로 로그인하세요.</p>
  <a class="btn primary big" href="./">노트로 가기</a>
<?php else: ?>
  <p><?= $forced ? '처음 받은 암호로 들어왔습니다.<br>계속 쓰려면 <b>새 암호로 바꿔야 합니다.</b>' : e((string)$acc['login_id']) . ' 의 암호를 바꿉니다.' ?></p>
  <?php if ($err !== ''): ?><p class="login-err" role="alert"><?= e($err) ?></p><?php endif; ?>
  <form method="post" class="login-form" autocomplete="on">
    <input type="hidden" name="csrf" value="<?= e(csrf_token()) ?>">
    <input type="text" name="username" value="<?= e((string)$acc['login_id']) ?>" autocomplete="username" hidden>
<?php if (!$forced): ?>
    <input type="password" name="current" placeholder="지금 암호" autocomplete="current-password" required>
<?php endif; ?>
    <input type="password" name="new" placeholder="새 암호 (<?= Auth::pwMin() ?>자 이상)" autocomplete="new-password" minlength="<?= Auth::pwMin() ?>" required autofocus>
    <input type="password" name="new2" placeholder="새 암호 한 번 더" autocomplete="new-password" minlength="<?= Auth::pwMin() ?>" required>
    <button class="btn primary big">암호 바꾸기</button>
  </form>
  <form method="post" action="logout.php" class="login-alt">
    <input type="hidden" name="csrf" value="<?= e(csrf_token()) ?>">
    <?php if (!$forced): ?><a href="./">취소</a> · <?php endif; ?><button class="text-btn">로그아웃</button>
  </form>
<?php endif; ?>
</div></body></html>
