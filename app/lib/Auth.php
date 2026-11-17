<?php
declare(strict_types=1);

/**
 * 로그인 방식(아이디·암호 / 구글 / 네이버 / 카카오)과 허용 계정.
 *
 * 설정(config.php):
 *   'login'    => ['password' => true, 'google' => true, 'naver' => false, 'kakao' => false],  // 방식마다 켜고 끄기
 *   'accounts' => [ '<사용자 폴더>' => ['name' =>, 'login_id' =>, 'password' => 처음 암호, 'google' =>, 'naver' =>, 'kakao' =>], ... ]
 *   'users'    => ['구글메일' => '<사용자 폴더>']   (예전 형식, 구글만. 그대로 동작)
 *
 * 계정에 값을 적은 방식만 그 사람에게 허용된다(미리 허용된 계정만 로그인).
 * 아이디·암호: 처음 암호는 config 에 적고, 그 암호로 들어오면 무조건 새 암호로 바꾸게 한다.
 * 바꾼 암호는 data/auth/<사용자>.json 에 해시로만 저장(config 는 고치지 않음). 그 파일을 지우면 처음 암호로 돌아간다.
 */
final class Auth
{
    public const METHODS = ['password' => '아이디·암호', 'google' => 'Google', 'naver' => '네이버', 'kakao' => '카카오'];
    public const PW_MIN = 8;

    /** 새 암호 최소 길이: 설정 password_min, 없으면 로컬 모드(PHP 내장 서버, 이 PC 에서만 씀)는 4, 서버는 8 */
    public static function pwMin(): int
    {
        $v = config('password_min', null);
        if (is_numeric($v) && (int)$v >= 1) return (int)$v;
        return PHP_SAPI === 'cli-server' ? 4 : self::PW_MIN;
    }

    /** 이 방식을 켰는지. 'login' 설정이 없으면 예전처럼 구글만 */
    public static function enabled(string $method): bool
    {
        $login = config('login', null);
        if (!is_array($login)) return $method === 'google';
        return !empty($login[$method]);
    }

    /** 켠 방식 목록 (화면 표시 순서) */
    public static function enabledMethods(): array
    {
        return array_values(array_filter(array_keys(self::METHODS), [self::class, 'enabled']));
    }

    /** [사용자 폴더 => 계정 설정] (예전 'users' 형식도 합침) */
    public static function accounts(): array
    {
        $out = [];
        foreach ((array)config('accounts', []) as $uid => $a) {
            if (!self::validUid((string)$uid) || !is_array($a)) continue;
            $out[(string)$uid] = $a;
        }
        foreach ((array)config('users', []) as $email => $uid) {
            $uid = (string)$uid;
            if (!self::validUid($uid)) continue;
            $out[$uid] ??= [];
            if (empty($out[$uid]['google'])) $out[$uid]['google'] = (string)$email;
            else $out[$uid]['google_more'][] = (string)$email;
        }
        return $out;
    }

    public static function validUid(string $uid): bool
    {
        return (bool)preg_match('/^[a-z0-9_-]{1,40}$/', $uid);
    }

    /**
     * 이 방식의 이 신원으로 들어올 수 있는 사용자 폴더. 없으면 null.
     * $idents: 비교할 값들(네이버·카카오는 회원번호와 이메일 둘 다 넘김) — 대소문자 무시
     */
    public static function find(string $method, string|array $idents): ?string
    {
        if (!isset(self::METHODS[$method]) || !self::enabled($method)) return null;
        $want = array_filter(array_map(fn($s) => strtolower(trim((string)$s)), (array)$idents), 'strlen');
        if (!$want) return null;
        $key = $method === 'password' ? 'login_id' : $method;
        foreach (self::accounts() as $uid => $a) {
            $have = (array)($a[$key] ?? []);
            if ($method === 'google') $have = array_merge($have, (array)($a['google_more'] ?? []));
            foreach ($have as $h) {
                if (in_array(strtolower(trim((string)$h)), $want, true)) return $uid;
            }
        }
        return null;
    }

    /** 사용자 계정에 허용된 방식 [방식 => 적힌 값] (켜진 방식만) */
    public static function methodsOf(string $uid): array
    {
        $a = self::accounts()[$uid] ?? [];
        $out = [];
        foreach (self::METHODS as $m => $_) {
            $key = $m === 'password' ? 'login_id' : $m;
            if (!empty($a[$key]) && self::enabled($m)) $out[$m] = is_array($a[$key]) ? implode(', ', $a[$key]) : (string)$a[$key];
        }
        return $out;
    }

    // ---------- 아이디·암호 ----------

    private static function authFile(string $uid): string
    {
        $d = DATA_DIR . '/auth';
        if (!is_dir($d)) mkdir($d, 0700, true);
        return $d . '/' . $uid . '.json';
    }

    private static function authData(string $uid): array
    {
        $f = self::authFile($uid);
        return is_file($f) ? (json_decode((string)file_get_contents($f), true) ?: []) : [];
    }

    /**
     * 아이디·암호 확인. 맞으면 ['uid' =>, 'must_change' => bool], 틀리면 예외(메시지는 화면에 그대로).
     * 5번 틀리면 10분 동안 막는다(아이디별 + 접속 주소별).
     */
    public static function checkPassword(string $loginId, string $password): array
    {
        $loginId = trim($loginId);
        $keys = ['id:' . strtolower($loginId), 'ip:' . ($_SERVER['REMOTE_ADDR'] ?? '')];
        $wait = self::throttleWait($keys);
        if ($wait > 0) throw new RuntimeException('여러 번 틀려서 잠시 막았습니다. ' . ceil($wait / 60) . '분 뒤 다시 하세요.');

        $uid = $loginId !== '' ? self::find('password', $loginId) : null;
        $ok = false; $must = false;
        if ($uid !== null) {
            $d = self::authData($uid);
            if (!empty($d['hash'])) {
                $ok = password_verify($password, (string)$d['hash']);
                $must = $ok && !empty($d['must_change']);
            } else {
                // 아직 암호를 바꾼 적 없음 → config 의 처음 암호. 맞아도 반드시 바꾸게 함
                $init = (string)(self::accounts()[$uid]['password'] ?? '');
                $ok = $init !== '' && hash_equals($init, $password);
                $must = true;
            }
        } else {
            password_verify($password, '$2y$12$lLTptW9gm06VUxnyg6LiX.f4NNC3uEzSkkfKeXPx3OOeaMgfvAZqa');   // 시간 차로 아이디 유무가 드러나지 않게
        }
        if (!$ok) {
            self::throttleFail($keys);
            throw new RuntimeException('아이디 또는 암호가 맞지 않습니다');
        }
        self::throttleClear($keys);
        return ['uid' => $uid, 'must_change' => $must];
    }

    /** 새 암호 저장. 처음 암호·지금 암호와 같거나 짧으면 예외 */
    public static function setPassword(string $uid, string $new, string $new2): void
    {
        if ($new !== $new2) throw new RuntimeException('새 암호 두 번이 서로 다릅니다');
        // 길이는 한 번만 재서 비교 (PHP 8.5 일부 빌드에서 opcache 최적화가 mb_strlen 을 두 번 쓴 비교를 잘못 계산했음)
        $len = (int)mb_strlen($new, 'UTF-8');
        $min = self::pwMin();
        if ($len < $min) throw new RuntimeException('암호는 ' . $min . '자 이상으로 하세요');
        if ($len > 200) throw new RuntimeException('암호가 너무 깁니다');
        $a = self::accounts()[$uid] ?? [];
        if (hash_equals((string)($a['password'] ?? "\0"), $new)) throw new RuntimeException('처음 받은 암호와 다른 암호로 정하세요');
        if (strcasecmp((string)($a['login_id'] ?? ''), $new) === 0) throw new RuntimeException('아이디와 다른 암호로 정하세요');
        $d = self::authData($uid);
        if (!empty($d['hash']) && password_verify($new, (string)$d['hash'])) throw new RuntimeException('지금 암호와 다른 암호로 정하세요');
        atomic_write(self::authFile($uid), json_encode(['hash' => password_hash($new, PASSWORD_DEFAULT), 'changed' => time()], JSON_PRETTY_PRINT));
    }

    /** 지금 암호가 맞는지 (스스로 바꿀 때 확인용) */
    public static function verifyCurrent(string $uid, string $password): bool
    {
        $d = self::authData($uid);
        if (!empty($d['hash'])) return password_verify($password, (string)$d['hash']);
        $init = (string)(self::accounts()[$uid]['password'] ?? '');
        return $init !== '' && hash_equals($init, $password);
    }

    private static function throttleFile(): string
    {
        $d = DATA_DIR . '/auth';
        if (!is_dir($d)) mkdir($d, 0700, true);
        return $d . '/.throttle.json';
    }
    private static function throttleRead(): array
    {
        $f = self::throttleFile();
        $t = is_file($f) ? (json_decode((string)file_get_contents($f), true) ?: []) : [];
        return array_filter($t, fn($r) => ($r['until'] ?? 0) > time() || ($r['last'] ?? 0) > time() - 600);
    }
    private static function throttleWait(array $keys): int
    {
        $t = self::throttleRead();
        $w = 0;
        foreach ($keys as $k) $w = max($w, (int)($t[$k]['until'] ?? 0) - time());
        return $w;
    }
    private static function throttleFail(array $keys): void
    {
        $t = self::throttleRead();
        foreach ($keys as $k) {
            $r = $t[$k] ?? ['n' => 0];
            $r['n'] = (int)$r['n'] + 1;
            $r['last'] = time();
            if ($r['n'] >= 5) { $r['until'] = time() + 600; $r['n'] = 0; }
            $t[$k] = $r;
        }
        @file_put_contents(self::throttleFile(), json_encode($t), LOCK_EX);
    }
    private static function throttleClear(array $keys): void
    {
        $t = self::throttleRead();
        foreach ($keys as $k) unset($t[$k]);
        @file_put_contents(self::throttleFile(), json_encode($t), LOCK_EX);
    }

    // ---------- 네이버 · 카카오 (OAuth 2.0 Authorization Code) ----------

    private const SOCIAL = [
        'naver' => [
            'auth'    => 'https://nid.naver.com/oauth2.0/authorize',
            'token'   => 'https://nid.naver.com/oauth2.0/token',
            'profile' => 'https://openapi.naver.com/v1/nid/me',
        ],
        'kakao' => [
            'auth'    => 'https://kauth.kakao.com/oauth/authorize',
            'token'   => 'https://kauth.kakao.com/oauth/token',
            'profile' => 'https://kapi.kakao.com/v2/user/me',
        ],
    ];

    private static function socialCfg(string $p): array
    {
        $c = (array)config($p, []);
        $need = $p === 'kakao' ? ['client_id', 'redirect_uri'] : ['client_id', 'client_secret', 'redirect_uri'];
        foreach ($need as $k) {
            if (empty($c[$k])) throw new RuntimeException("app/config.php 의 $p {$k} 를 설정하세요.");
        }
        return $c;
    }

    public static function socialBegin(string $p): never
    {
        if ($p === 'google' && self::enabled('google')) GoogleAuth::begin();
        if (!isset(self::SOCIAL[$p]) || !self::enabled($p)) throw new RuntimeException('허용되지 않은 로그인 방식입니다');
        $c = self::socialCfg($p);
        $_SESSION['oauth_state_' . $p] = bin2hex(random_bytes(16));
        $q = ['response_type' => 'code', 'client_id' => $c['client_id'], 'redirect_uri' => $c['redirect_uri'], 'state' => $_SESSION['oauth_state_' . $p]];
        if ($p === 'kakao') {
            $q['prompt'] = 'select_account';
            // 이메일로 계정을 구분할 때: 이메일 동의를 꼭 물어보게 (콘솔에 "카카오계정(이메일)" 동의항목을 켠 경우만)
            if (!empty($c['email'])) $q['scope'] = 'account_email';
        }
        redirect(self::SOCIAL[$p]['auth'] . '?' . http_build_query($q));
    }

    /** @return array{ids:string[], name:string, email:string, picture:string} */
    public static function socialFinish(string $p, array $query): array
    {
        if ($p === 'google' && self::enabled('google')) {
            $g = GoogleAuth::finish($query);   // 구글은 OpenID Connect(id_token 검사)라 따로 처리, 돌려주는 모양만 맞춤
            return ['ids' => [$g['email']], 'email' => $g['email'], 'name' => $g['name'], 'picture' => $g['picture']];
        }
        if (!isset(self::SOCIAL[$p]) || !self::enabled($p)) throw new RuntimeException('허용되지 않은 로그인 방식입니다');
        $c = self::socialCfg($p);
        $label = self::METHODS[$p];
        $state = (string)($_SESSION['oauth_state_' . $p] ?? '');
        unset($_SESSION['oauth_state_' . $p]);
        if (isset($query['error'])) throw new RuntimeException("$label 로그인 취소 또는 오류: " . (string)($query['error_description'] ?? $query['error']));
        if ($state === '' || !hash_equals($state, (string)($query['state'] ?? ''))) throw new RuntimeException('로그인 요청이 만료되었습니다. 다시 시도하세요.');
        $code = (string)($query['code'] ?? '');
        if ($code === '') throw new RuntimeException('인증 코드가 없습니다');

        $f = ['grant_type' => 'authorization_code', 'client_id' => $c['client_id'], 'redirect_uri' => $c['redirect_uri'], 'code' => $code];
        if (!empty($c['client_secret'])) $f['client_secret'] = $c['client_secret'];
        if ($p === 'naver') $f['state'] = $state;
        $tok = self::http(self::SOCIAL[$p]['token'], $f);
        $at = (string)($tok['access_token'] ?? '');
        if ($at === '') throw new RuntimeException("$label 토큰을 받지 못했습니다: " . (string)($tok['error_description'] ?? $tok['error'] ?? ''));

        $me = self::http(self::SOCIAL[$p]['profile'], null, ['Authorization: Bearer ' . $at]);
        if ($p === 'naver') {
            $r = (array)($me['response'] ?? []);
            if (($me['resultcode'] ?? '') !== '00' || empty($r['id'])) throw new RuntimeException('네이버 회원 정보를 받지 못했습니다');
            $email = (string)($r['email'] ?? '');
            return ['ids' => array_filter([(string)$r['id'], $email]), 'email' => $email,
                    'name' => (string)($r['name'] ?? $r['nickname'] ?? $email), 'picture' => (string)($r['profile_image'] ?? '')];
        }
        if (empty($me['id'])) throw new RuntimeException('카카오 회원 정보를 받지 못했습니다');
        $acc = (array)($me['kakao_account'] ?? []);
        $email = !empty($acc['is_email_verified']) ? (string)($acc['email'] ?? '') : '';
        $prof = (array)($acc['profile'] ?? []);
        return ['ids' => array_filter([(string)$me['id'], $email]), 'email' => $email,
                'name' => (string)($prof['nickname'] ?? $me['properties']['nickname'] ?? ''), 'picture' => (string)($prof['thumbnail_image_url'] ?? '')];
    }

    /** POST(폼) 또는 GET, JSON 응답 */
    private static function http(string $url, ?array $form, array $headers = []): array
    {
        if ($form !== null) $headers[] = 'Content-Type: application/x-www-form-urlencoded;charset=utf-8';
        if (function_exists('curl_init')) {
            $ch = curl_init($url);
            $o = [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 15, CURLOPT_SSL_VERIFYPEER => true, CURLOPT_SSL_VERIFYHOST => 2, CURLOPT_HTTPHEADER => $headers];
            if ($form !== null) { $o[CURLOPT_POST] = true; $o[CURLOPT_POSTFIELDS] = http_build_query($form); }
            curl_setopt_array($ch, $o);
            $res = curl_exec($ch);
            if ($res === false) throw new RuntimeException('로그인 서버 연결 실패: ' . curl_error($ch));
        } else {
            $http = ['method' => $form !== null ? 'POST' : 'GET', 'header' => implode("\r\n", $headers) . "\r\n", 'timeout' => 15, 'ignore_errors' => true];
            if ($form !== null) $http['content'] = http_build_query($form);
            $res = @file_get_contents($url, false, stream_context_create(['http' => $http, 'ssl' => ['verify_peer' => true, 'verify_peer_name' => true]]));
            if ($res === false) throw new RuntimeException('로그인 서버 연결 실패(curl 없음, allow_url_fopen 확인)');
        }
        $d = json_decode((string)$res, true);
        return is_array($d) ? $d : [];
    }
}
