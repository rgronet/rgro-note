<?php
declare(strict_types=1);
require_once __DIR__ . '/Enml.php';

/**
 * 에버노트 ENEX 파일 하나를 노트북 하나로 가져온다.
 * CLI(app/tools/import_enex.php)와 웹(api.php enex_finish)이 같이 쓴다.
 *
 * - 같은 노트(제목+만든 시각+노트북)는 다시 가져와도 건너뛴다.
 * - $refresh : 이미 가져온 노트를 지금 변환 규칙으로 다시 쓴다(웹에서 고친 노트는 그대로).
 */
final class EnexImport
{
    public const TOTAL = ['added' => 0, 'skipped' => 0, 'files' => 0, 'errors' => 0, 'titled' => 0,
                          'refreshed' => 0, 'same' => 0, 'edited' => 0, 'notes' => 0];

    /** 파일 이름에서 노트북 이름: 에버노트가 붙이는 " (3368개 노트)" / " (12 notes)" 는 뺀다 */
    public static function notebookName(string $fileName): string
    {
        $base = pathinfo($fileName, PATHINFO_FILENAME);
        $name = preg_replace('/\s*\(\s*[\d,]+\s*(개\s*노트|notes?)\s*\)$/iu', '', $base) ?: $base;
        $name = trim((string)preg_replace('/[\x00-\x1f\x7f]+/u', ' ', $name));
        return mb_substr($name !== '' ? $name : '에버노트', 0, 100);
    }

    /** 정말 ENEX 인지 앞부분만 보고 확인 */
    public static function looksLikeEnex(string $file): bool
    {
        $h = @fopen($file, 'rb');
        if (!$h) return false;
        $head = (string)fread($h, 4096);
        fclose($h);
        return stripos($head, '<en-export') !== false;
    }

    /**
     * @param callable|null $log  진행 메시지(문자열)를 받는다. CLI 는 echo, 웹은 null
     * @param array|null    $errors 실패한 노트 메시지가 쌓인다
     * @return array 개수(TOTAL 의 키)
     */
    public static function run(Store $store, string $file, string $nbName, bool $refresh = false,
                               ?callable $log = null, ?array &$errors = null): array
    {
        $errors = [];
        $total = self::TOTAL;
        $r = new XMLReader();
        if (!$r->open($file, 'UTF-8', LIBXML_PARSEHUGE | LIBXML_NONET)) throw new RuntimeException('ENEX 파일을 열 수 없습니다');

        $tmpDir = (defined('DATA_DIR') ? DATA_DIR . '/tmp' : sys_get_temp_dir()) . DIRECTORY_SEPARATOR . 'enex_' . bin2hex(random_bytes(4));
        if (!is_dir($tmpDir)) mkdir($tmpDir, 0700, true);
        try {
            $store->mutate(function (array &$idx) use ($r, $store, $nbName, $tmpDir, &$total, $refresh, $log, &$errors) {
                $nb = $store->notebookIdInto($idx, $nbName);
                while ($r->read() && !($r->nodeType === XMLReader::ELEMENT && $r->name === 'note'));
                for (; $r->nodeType === XMLReader::ELEMENT && $r->name === 'note'; $r->next('note')) {
                    $total['notes']++;
                    $title = null;
                    try {
                        $result = self::one($store, $idx, $nb, $nbName, $r->readOuterXml(), $tmpDir, $refresh, $total, $title);
                        match ($result[0]) {
                            'added'     => [$total['added']++, $total['files'] += $result[1]],
                            'refreshed' => $total['refreshed']++,
                            'same'      => $total['same']++,
                            'edited'    => $total['edited']++,
                            default     => $total['skipped']++,
                        };
                        if ($log && $total['notes'] % 100 === 0) $log("  {$total['notes']} ...");
                    } catch (Throwable $e) {
                        $total['errors']++;
                        $m = mb_substr((string)($title ?? '?'), 0, 40) . ' — ' . $e->getMessage();
                        if (count($errors) < 20) $errors[] = $m;
                        if ($log) $log('  ! 실패: ' . $m);
                    }
                }
            });
        } finally {
            $r->close();
            foreach (glob($tmpDir . DIRECTORY_SEPARATOR . '*') ?: [] as $t) @unlink($t);
            @rmdir($tmpDir);
        }
        return $total;
    }

    private static function time(string $s): int
    {
        $d = DateTime::createFromFormat('Ymd\THis\Z', trim($s), new DateTimeZone('UTC'));
        return $d ? $d->getTimestamp() : time();
    }

    /** 노트 하나 → [결과, 첨부 수] */
    private static function one(Store $store, array &$idx, string $nb, string $nbName, string $xml, string $tmpDir,
                                bool $refresh, array &$total, ?string &$title): array
    {
        $note = simplexml_load_string($xml, 'SimpleXMLElement', LIBXML_NOCDATA | LIBXML_PARSEHUGE | LIBXML_NONET);
        if (!$note) throw new RuntimeException('XML 해석 실패');

        $title   = (string)$note->title;
        $created = self::time((string)($note->created ?: $note->updated));
        $updated = isset($note->updated) ? self::time((string)$note->updated) : $created;
        $tags = [];
        foreach ($note->tag as $t) $tags[] = (string)$t;

        // 첨부: 임시 파일로 풀고 hash => [이름, mime]
        $media = []; $fileList = []; $tmps = [];
        $i = 0;
        foreach ($note->resource as $res) {
            $bin = base64_decode(preg_replace('/\s+/', '', (string)$res->data) ?? '', true);
            if ($bin === false || $bin === '') continue;
            $hash = md5($bin);
            $mime = strtolower((string)$res->mime);
            $name = trim((string)($res->{'resource-attributes'}->{'file-name'} ?? ''));
            if ($name === '') {
                $ext = ['image/png' => 'png', 'image/jpeg' => 'jpg', 'image/gif' => 'gif', 'image/webp' => 'webp',
                        'application/pdf' => 'pdf', 'audio/mpeg' => 'mp3', 'audio/wav' => 'wav', 'audio/amr' => 'amr'][$mime] ?? 'bin';
                $name = 'file' . (++$i) . '.' . $ext;
            }
            if (isset($media[$hash])) continue;
            $tmp = $tmpDir . DIRECTORY_SEPARATOR . $hash;
            file_put_contents($tmp, $bin);
            $tmps[] = $tmp;
            $media[$hash] = [$name, $mime];
            $fileList[$hash] = [$tmp, $name];
        }

        try {
            $md = Enml::toMarkdown((string)$note->content, $media);

            // 새 에버노트 작업(Tasks)
            $tasks = [];
            foreach ($note->task as $t) {
                $done = strtolower((string)$t->taskStatus) === 'completed';
                $tasks[] = '- [' . ($done ? 'x' : ' ') . '] ' . trim((string)$t->title);
            }
            if ($tasks) $md = rtrim($md) . "\n\n" . implode("\n", $tasks) . "\n";

            $src = trim((string)($note->{'note-attributes'}->{'source-url'} ?? ''));
            if ($src !== '') $md = rtrim($md) . "\n\n원본: " . $src . "\n";

            // 에버노트에서도 "제목 없음"인 노트는 본문 첫 줄을 제목으로
            $origTitle = $title;
            if (Enml::isUntitled($title)) {
                [$title, $md] = Enml::titleFromBody($md, $created);
                $total['titled']++;
            }

            $result = null;
            $store->importInto($idx, [
                'title' => $title, 'notebook' => $nb, 'tags' => $tags,
                'created' => $created, 'updated' => $updated,
                'src' => 'enex:' . sha1($nbName . "\0" . $origTitle . "\0" . $created),
                'files' => $fileList,
                'rewrite' => function (array $names, string $id) use ($md) {
                    return preg_replace_callback("/\x01([0-9a-f]{32})\x01/", fn($m) => Store::fileUrl($id, $names[$m[1]] ?? 'missing'), $md) ?? $md;
                },
            ], $refresh, $result);
            return [$result, count($fileList)];
        } finally {
            foreach ($tmps as $t) @unlink($t);
        }
    }
}
