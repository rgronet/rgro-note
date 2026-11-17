<?php
declare(strict_types=1);

/**
 * 사용자 데이터 백업(zip 만들기)과 복원(zip 으로 통째로 바꾸기).
 *
 * zip 안 구조:  u1/index.json, u1/notes/<ID>.txt, u1/files/<ID>/<이름>
 *   - 맨 위 폴더 이름은 아무거나 괜찮다(폴더 없이 index.json 이 맨 위에 있어도 됨).
 *   - 윈도우 기본 압축처럼 한글 이름이 CP949 로 저장된 zip 도 읽는다.
 *
 * 복원 순서: 임시 폴더에 전부 풀기 → 검사 → 지금 폴더를 .before-restore-* 로 옮기기 → 임시 폴더를 제자리로.
 * 중간에 실패하면 지금 데이터는 그대로다. 예전 데이터는 최근 3개까지 서버에 남긴다.
 */
final class Backup
{
    private const MAX_FILES = 100000;
    private const MAX_BYTES = 4 * 1024 * 1024 * 1024;   // 풀었을 때 4GB 넘으면 거부(압축 폭탄 방지)
    private const KEEP_OLD  = 3;

    public static function available(): bool
    {
        return class_exists('ZipArchive');
    }

    private static function need(): void
    {
        if (!self::available()) throw new RuntimeException('서버 PHP 에 zip 확장이 없습니다. 호스팅에 zip 확장을 켜 달라고 요청하세요.');
    }

    public static function tmpDir(): string
    {
        $d = DATA_DIR . '/tmp';
        if (!is_dir($d)) mkdir($d, 0700, true);
        // 하루 지난 임시 파일 정리
        foreach (glob($d . '/*') ?: [] as $f) {
            if (is_file($f) && filemtime($f) < time() - 86400) @unlink($f);
        }
        return $d;
    }

    // ---------- 백업 ----------

    /** 사용자 폴더 전체를 zip 으로. 만든 파일 경로를 돌려준다(보낸 뒤 지울 것) */
    public static function make(string $uid): string
    {
        self::need();
        $src = DATA_DIR . '/users/' . $uid;
        if (!is_dir($src)) throw new RuntimeException('데이터가 없습니다');
        $out = self::tmpDir() . '/backup-' . $uid . '-' . bin2hex(random_bytes(6)) . '.zip';
        $zip = new ZipArchive();
        if ($zip->open($out, ZipArchive::CREATE | ZipArchive::EXCL) !== true) throw new RuntimeException('백업 파일을 만들 수 없습니다');

        $add = function (string $abs, string $rel) use ($zip) {
            $zip->addFile($abs, $rel);
            $zip->setMtimeName($rel, (int)filemtime($abs));
            if (preg_match('/\.(png|jpe?g|gif|webp|zip|gz|mp3|mp4|m4a|pdf)$/i', $rel)) {
                $zip->setCompressionName($rel, ZipArchive::CM_STORE);   // 이미 압축된 파일은 다시 압축 안 함(빠름)
            }
        };
        foreach (['index.json', 'index.json.bak', 'macros.json'] as $f) {
            if (is_file("$src/$f")) $add("$src/$f", "$uid/$f");
        }
        foreach (scandir("$src/notes") ?: [] as $f) {
            if (str_ends_with($f, '.txt') && $f[0] !== '.') $add("$src/notes/$f", "$uid/notes/$f");
        }
        foreach (scandir("$src/files") ?: [] as $d) {
            if ($d[0] === '.' || !Store::validId($d) || !is_dir("$src/files/$d")) continue;
            foreach (scandir("$src/files/$d") ?: [] as $f) {
                if ($f[0] === '.' || !is_file("$src/files/$d/$f")) continue;
                $add("$src/files/$d/$f", "$uid/files/$d/$f");
            }
        }
        if (!$zip->close()) { @unlink($out); throw new RuntimeException('백업 파일 저장 실패'); }
        return $out;
    }

    // ---------- 복원 ----------

    /** @return array{notes:int, files:int, skipped:int, kept:string} */
    public static function restore(string $uid, string $zipPath): array
    {
        self::need();
        $zip = new ZipArchive();
        if ($zip->open($zipPath, ZipArchive::RDONLY) !== true) throw new RuntimeException('zip 파일을 열 수 없습니다(손상되었거나 zip 이 아님)');

        try {
            // 1) 이름 읽기 (CP949 이름이면 UTF-8 로)
            $names = [];
            for ($i = 0; $i < $zip->numFiles; $i++) {
                $raw = (string)$zip->getNameIndex($i, ZipArchive::FL_ENC_RAW);
                if (!mb_check_encoding($raw, 'UTF-8')) {
                    $conv = @mb_convert_encoding($raw, 'UTF-8', 'CP949');
                    $raw = is_string($conv) && mb_check_encoding($conv, 'UTF-8') ? $conv : '';
                }
                $n = str_replace('\\', '/', $raw);
                if ($n === '' || str_ends_with($n, '/')) continue;
                $names[$i] = $n;
            }
            if (count($names) > self::MAX_FILES) throw new RuntimeException('zip 안 파일이 너무 많습니다');

            // 2) index.json(없으면 notes/) 위치로 맨 위 폴더 찾기
            $prefix = null;
            foreach (['#^((?:[^/]+/)?)index\.json$#', '#^((?:[^/]+/)?)notes/[^/]+\.txt$#'] as $re) {
                foreach ($names as $n) {
                    if (preg_match($re, $n, $m) && ($prefix === null || strlen($m[1]) < strlen($prefix))) $prefix = $m[1];
                }
                if ($prefix !== null) break;
            }
            if ($prefix === null) throw new RuntimeException('노트 백업 zip 이 아닙니다(index.json 이나 notes 폴더가 없음)');

            // 3) 풀 파일 고르기 (정해진 모양만, 경로 바깥으로 나가는 이름은 버림)
            $plan = []; $bytes = 0; $skipped = 0; $noteCount = 0; $fileCount = 0;
            foreach ($names as $i => $n) {
                if (!str_starts_with($n, $prefix)) { $skipped++; continue; }
                $rel = substr($n, strlen($prefix));
                if ($rel === 'index.json' || $rel === 'index.json.bak' || $rel === 'macros.json') {
                    $plan[$i] = $rel;
                } elseif (preg_match('#^notes/([A-Za-z0-9_-]{6,64})\.txt$#', $rel)) {
                    $plan[$i] = $rel; $noteCount++;
                } elseif (preg_match('#^files/([A-Za-z0-9_-]{6,64})/([^/]+)$#', $rel, $m)
                          && $m[2][0] !== '.' && !str_contains($m[2], "\0") && $m[2] !== '..') {
                    $plan[$i] = $rel; $fileCount++;
                } else {
                    $skipped++;   // _notes, .lock 등
                    continue;
                }
                $st = $zip->statIndex($i);
                $bytes += (int)($st['size'] ?? 0);
            }
            if ($noteCount === 0) throw new RuntimeException('zip 안에 노트(notes/*.txt)가 없습니다');
            if ($bytes > self::MAX_BYTES) throw new RuntimeException('풀었을 때 너무 큽니다');

            // 4) 임시 폴더에 풀기 (같은 디스크라야 rename 이 한 번에 됨)
            $users = DATA_DIR . '/users';
            $tmp = $users . '/.restore-' . $uid . '-' . bin2hex(random_bytes(4));
            mkdir($tmp . '/notes', 0700, true);
            mkdir($tmp . '/files', 0700, true);
            try {
                foreach ($plan as $i => $rel) {
                    $dest = $tmp . '/' . $rel;
                    $dir = dirname($dest);
                    if (!is_dir($dir)) mkdir($dir, 0700, true);
                    $in = method_exists($zip, 'getStreamIndex') ? $zip->getStreamIndex($i) : false;
                    if ($in) {
                        $out = fopen($dest, 'wb');
                        if (!$out) throw new RuntimeException('파일을 쓸 수 없습니다: ' . $rel);
                        stream_copy_to_stream($in, $out);
                        fclose($in); fclose($out);
                    } else {
                        $data = $zip->getFromIndex($i);
                        if ($data === false || file_put_contents($dest, $data) === false) throw new RuntimeException('풀기 실패: ' . $rel);
                    }
                    $st = $zip->statIndex($i);
                    if (!empty($st['mtime'])) @touch($dest, (int)$st['mtime']);
                }
                if (is_file("$tmp/index.json")) {
                    $idx = json_decode((string)file_get_contents("$tmp/index.json"), true);
                    if (!is_array($idx) || !isset($idx['notes']) || !is_array($idx['notes'])) {
                        throw new RuntimeException('백업의 index.json 이 손상되었습니다');
                    }
                }
            } catch (Throwable $e) {
                self::rmdir($tmp);
                throw $e;
            }
        } finally {
            $zip->close();
        }

        // 5) 바꿔치기: 지금 폴더 → .before-restore-*, 임시 폴더 → 제자리
        $cur = $users . '/' . $uid;
        $kept = '';
        if (is_dir($cur)) {
            $kept = '.before-restore-' . $uid . '-' . date('Ymd-His');
            if (!rename($cur, $users . '/' . $kept)) { self::rmdir($tmp); throw new RuntimeException('지금 데이터를 옮기지 못했습니다(다른 작업 중일 수 있음). 잠시 뒤 다시 하세요.'); }
        }
        if (!rename($tmp, $cur)) {
            if ($kept !== '') rename($users . '/' . $kept, $cur);
            self::rmdir($tmp);
            throw new RuntimeException('복원 폴더를 제자리로 옮기지 못했습니다. 지금 데이터는 그대로입니다.');
        }
        self::pruneOld($uid);
        return ['notes' => $noteCount, 'files' => $fileCount, 'skipped' => $skipped, 'kept' => $kept];
    }

    /** 복원 전 데이터는 최근 KEEP_OLD 개만 남김 */
    private static function pruneOld(string $uid): void
    {
        $old = glob(DATA_DIR . '/users/.before-restore-' . $uid . '-*', GLOB_ONLYDIR) ?: [];
        rsort($old);
        foreach (array_slice($old, self::KEEP_OLD) as $d) self::rmdir($d);
    }

    public static function rmdir(string $dir): void
    {
        if (!is_dir($dir)) return;
        foreach (scandir($dir) ?: [] as $f) {
            if ($f === '.' || $f === '..') continue;
            is_dir("$dir/$f") && !is_link("$dir/$f") ? self::rmdir("$dir/$f") : @unlink("$dir/$f");
        }
        @rmdir($dir);
    }
}
