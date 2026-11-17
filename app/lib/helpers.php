<?php
declare(strict_types=1);

function config(string $key, mixed $default = null): mixed
{
    return $GLOBALS['APP_CONFIG'][$key] ?? $default;
}

function is_https(): bool
{
    if (!empty($_SERVER['HTTPS']) && strtolower((string)$_SERVER['HTTPS']) !== 'off') return true;
    if ((string)($_SERVER['SERVER_PORT'] ?? '') === '443') return true;
    return strtolower((string)($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '')) === 'https';
}

function is_local_request(): bool
{
    return in_array($_SERVER['REMOTE_ADDR'] ?? '', ['127.0.0.1', '::1'], true);
}

function start_session(): void
{
    if (session_status() === PHP_SESSION_ACTIVE) return;
    $dir = DATA_DIR . '/sessions';
    if (!is_dir($dir)) @mkdir($dir, 0700, true);
    $life = max(1, (int)config('session_days', 30)) * 86400;
    if (is_dir($dir) && is_writable($dir)) {
        ini_set('session.save_path', $dir);
        // 데비안 계열은 gc_probability=0 이라 직접 켠다(우리 폴더라 cron 청소가 없음)
        ini_set('session.gc_probability', '1');
        ini_set('session.gc_divisor', '100');
    }
    ini_set('session.gc_maxlifetime', (string)$life);
    ini_set('session.use_strict_mode', '1');
    ini_set('session.use_only_cookies', '1');
    session_name('RGNOTE');
    session_set_cookie_params([
        'lifetime' => $life,
        'path'     => '/',
        'secure'   => is_https(),
        'httponly' => true,
        'samesite' => 'Lax',   // 구글에서 돌아오는 GET 에 쿠키가 실려야 하므로 Strict 불가
    ]);
    session_start();
}

/** 허용된 구글 계정이면 사용자 폴더 이름, 아니면 null */
function uid_for_email(string $email): ?string
{
    return Auth::find('google', $email);
}

/**
 * 로그인한 사용자. 세션: uid, method(password|google|naver|kakao), ident(비교한 값들), name, email, picture, must_change
 * 설정에서 계정·방식을 빼면 기존 세션도 바로 막힌다
 */
function current_user(): ?array
{
    $u = $_SESSION['user'] ?? null;
    if (!is_array($u) || empty($u['uid'])) return null;
    $method = (string)($u['method'] ?? 'google');          // 예전 세션은 구글
    $ident = $u['ident'] ?? ($u['email'] ?? '');
    if (Auth::find($method, $ident) !== $u['uid']) {
        unset($_SESSION['user']);
        return null;
    }
    $u['email'] = (string)($u['email'] ?? '');
    $u['name'] = (string)($u['name'] ?? '');
    $u['picture'] = (string)($u['picture'] ?? '');
    return $u;
}

/** $ident: 이 방식에서 계정과 비교한 값(들). 허용 계정이 아니면 예외 */
function login_user(string $method, string|array $ident, string $name, string $picture = '', string $email = '', bool $mustChange = false): void
{
    $uid = Auth::find($method, $ident);
    if ($uid === null) throw new RuntimeException('이 노트를 쓸 수 있는 계정이 아닙니다');
    session_regenerate_id(true);
    $acc = Auth::accounts()[$uid] ?? [];
    $_SESSION['user'] = ['uid' => $uid, 'method' => $method, 'ident' => $ident,
                         'name' => $name !== '' ? $name : (string)($acc['name'] ?? $uid),
                         'email' => $email, 'picture' => $picture, 'must_change' => $mustChange];
    $_SESSION['csrf'] = bin2hex(random_bytes(32));
}

function csrf_token(): string
{
    if (empty($_SESSION['csrf'])) $_SESSION['csrf'] = bin2hex(random_bytes(32));
    return (string)$_SESSION['csrf'];
}

function check_csrf(?string $token): bool
{
    return is_string($token) && $token !== '' && hash_equals(csrf_token(), $token);
}

function e(?string $s): string
{
    return htmlspecialchars((string)$s, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

function security_headers(bool $html = true): void
{
    header('X-Content-Type-Options: nosniff');
    header('Referrer-Policy: same-origin');
    header('X-Frame-Options: DENY');
    if (is_https()) header('Strict-Transport-Security: max-age=31536000');
    if ($html) {
        header("Content-Security-Policy: default-src 'self'; "
            . "script-src 'self'; "
            . "style-src 'self' 'unsafe-inline'; "
            . "img-src 'self' data: blob: https:; "
            . "connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://accounts.google.com");
    }
}

function json_out(mixed $data, int $status = 200): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    $out = (string)json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    // 노트 목록(수천 개)은 1MB 를 넘으므로 서버가 압축해 주지 않으면 직접 gzip (모바일 데이터 절약)
    if (strlen($out) > 20000 && function_exists('gzencode') && !ini_get('zlib.output_compression')
        && str_contains((string)($_SERVER['HTTP_ACCEPT_ENCODING'] ?? ''), 'gzip') && !headers_sent()) {
        $gz = gzencode($out, 6);
        if ($gz !== false) {
            header('Content-Encoding: gzip');
            header('Vary: Accept-Encoding');
            $out = $gz;
        }
    }
    header('Content-Length: ' . strlen($out));
    echo $out;
    exit;
}

function json_error(string $msg, int $status = 400, array $extra = []): never
{
    json_out(['ok' => false, 'error' => $msg] + $extra, $status);
}

function redirect(string $url): never
{
    header('Location: ' . $url, true, 302);
    exit;
}

/** 임시 파일에 쓴 뒤 rename 해서 쓰는 도중 끊겨도 파일이 깨지지 않게 한다 */
function atomic_write(string $path, string $data): void
{
    $tmp = $path . '.tmp' . bin2hex(random_bytes(4));
    if (file_put_contents($tmp, $data) !== strlen($data)) {
        @unlink($tmp);
        throw new RuntimeException('파일 쓰기 실패: ' . basename($path));
    }
    if (!rename($tmp, $path)) {
        @unlink($tmp);
        throw new RuntimeException('파일 교체 실패: ' . basename($path));
    }
}
