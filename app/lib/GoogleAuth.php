<?php
declare(strict_types=1);

/**
 * 구글 로그인 (OpenID Connect, Authorization Code 방식). 외부 라이브러리 없음.
 * id_token 은 구글 토큰 서버에서 TLS 로 직접 받은 것이라 서명 대신
 * iss / aud / exp / nonce / email_verified 를 검사한다(OIDC Core 3.1.3.7 허용 방식).
 */
final class GoogleAuth
{
    private const AUTH_URL  = 'https://accounts.google.com/o/oauth2/v2/auth';
    private const TOKEN_URL = 'https://oauth2.googleapis.com/token';

    private static function cfg(): array
    {
        $g = (array)config('google', []);
        if (empty($g['client_id']) || empty($g['client_secret']) || empty($g['redirect_uri'])) {
            throw new RuntimeException('app/config.php 의 google client_id / client_secret / redirect_uri 를 설정하세요.');
        }
        return $g;
    }

    public static function begin(): never
    {
        $g = self::cfg();
        $_SESSION['oauth_state'] = bin2hex(random_bytes(16));
        $_SESSION['oauth_nonce'] = bin2hex(random_bytes(16));
        redirect(self::AUTH_URL . '?' . http_build_query([
            'client_id'     => $g['client_id'],
            'redirect_uri'  => $g['redirect_uri'],
            'response_type' => 'code',
            'scope'         => 'openid email profile',
            'state'         => $_SESSION['oauth_state'],
            'nonce'         => $_SESSION['oauth_nonce'],
            'prompt'        => 'select_account',
        ]));
    }

    /** @return array{email:string,name:string,picture:string} */
    public static function finish(array $query): array
    {
        $g = self::cfg();
        $state = (string)($_SESSION['oauth_state'] ?? '');
        $nonce = (string)($_SESSION['oauth_nonce'] ?? '');
        unset($_SESSION['oauth_state'], $_SESSION['oauth_nonce']);

        if (isset($query['error'])) throw new RuntimeException('구글 로그인 취소 또는 오류: ' . (string)$query['error']);
        if ($state === '' || !hash_equals($state, (string)($query['state'] ?? ''))) {
            throw new RuntimeException('로그인 요청이 만료되었습니다. 다시 시도하세요.');
        }
        $code = (string)($query['code'] ?? '');
        if ($code === '') throw new RuntimeException('인증 코드가 없습니다');

        $tok = self::post(self::TOKEN_URL, [
            'code'          => $code,
            'client_id'     => $g['client_id'],
            'client_secret' => $g['client_secret'],
            'redirect_uri'  => $g['redirect_uri'],
            'grant_type'    => 'authorization_code',
        ]);
        if (empty($tok['id_token'])) throw new RuntimeException('id_token 을 받지 못했습니다: ' . (string)($tok['error_description'] ?? $tok['error'] ?? ''));

        $parts = explode('.', (string)$tok['id_token']);
        if (count($parts) !== 3) throw new RuntimeException('id_token 형식 오류');
        $c = json_decode(self::b64url($parts[1]), true);
        if (!is_array($c)) throw new RuntimeException('id_token 해석 실패');

        if (!in_array($c['iss'] ?? '', ['accounts.google.com', 'https://accounts.google.com'], true)) throw new RuntimeException('발급자 불일치');
        $aud = $c['aud'] ?? '';
        if (!(is_array($aud) ? in_array($g['client_id'], $aud, true) : $aud === $g['client_id'])) throw new RuntimeException('client_id 불일치');
        if ((int)($c['exp'] ?? 0) < time() - 60) throw new RuntimeException('id_token 만료');
        if ($nonce === '' || !hash_equals($nonce, (string)($c['nonce'] ?? ''))) throw new RuntimeException('nonce 불일치');
        $verified = $c['email_verified'] ?? false;
        if (empty($c['email']) || !($verified === true || $verified === 'true')) throw new RuntimeException('이메일 인증이 안 된 계정입니다');

        return [
            'email'   => (string)$c['email'],
            'name'    => (string)($c['name'] ?? $c['email']),
            'picture' => (string)($c['picture'] ?? ''),
        ];
    }

    private static function b64url(string $s): string
    {
        $s = strtr($s, '-_', '+/');
        return (string)base64_decode($s . str_repeat('=', (4 - strlen($s) % 4) % 4));
    }

    private static function post(string $url, array $fields): array
    {
        $body = http_build_query($fields);
        if (function_exists('curl_init')) {
            $ch = curl_init($url);
            curl_setopt_array($ch, [
                CURLOPT_POST           => true,
                CURLOPT_POSTFIELDS     => $body,
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_TIMEOUT        => 15,
                CURLOPT_SSL_VERIFYPEER => true,
                CURLOPT_SSL_VERIFYHOST => 2,
                CURLOPT_HTTPHEADER     => ['Content-Type: application/x-www-form-urlencoded'],
            ]);
            $res = curl_exec($ch);
            $err = curl_error($ch);
            if ($res === false) throw new RuntimeException('구글 토큰 서버 연결 실패: ' . $err);
        } else {
            $res = @file_get_contents($url, false, stream_context_create([
                'http' => ['method' => 'POST', 'header' => "Content-Type: application/x-www-form-urlencoded\r\n",
                           'content' => $body, 'timeout' => 15, 'ignore_errors' => true],
                'ssl'  => ['verify_peer' => true, 'verify_peer_name' => true],
            ]));
            if ($res === false) throw new RuntimeException('구글 토큰 서버 연결 실패(curl 없음, allow_url_fopen 확인)');
        }
        $data = json_decode((string)$res, true);
        return is_array($data) ? $data : [];
    }
}
