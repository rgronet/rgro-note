<?php
declare(strict_types=1);

/**
 * 사용자 한 명의 노트 저장소.
 *
 * data/users/<uid>/
 *   index.json          노트북 목록 + 노트 메타(제목·노트북·태그·날짜·rev·휴지통)
 *   index.json.bak      직전 index
 *   notes/<id>.txt      첫 줄 = 제목, 둘째 줄부터 = 내용(Markdown)
 *   files/<id>/<이름>   첨부파일
 *
 * txt 파일이 원본이다. index 가 없어지거나, FTP 로 txt 를 직접 넣거나 고쳐도
 * reconcile() 이 파일을 다시 읽어 index 를 맞춘다.
 */
final class Store
{
    public const ID_RE = '/^[A-Za-z0-9_-]{6,64}$/';
    private const MAX_BODY = 2 * 1024 * 1024;

    private string $dir;
    private ?array $srcSet = null;   // 가져오기 중복 확인용

    public function __construct(string $uid)
    {
        if (!preg_match('/^[a-z0-9_-]{1,40}$/', $uid)) throw new RuntimeException('잘못된 사용자');
        $this->dir = DATA_DIR . '/users/' . $uid;
        foreach (['', '/notes', '/files'] as $sub) {
            if (!is_dir($this->dir . $sub) && !mkdir($this->dir . $sub, 0700, true) && !is_dir($this->dir . $sub)) {
                throw new RuntimeException('데이터 폴더를 만들 수 없습니다. data 폴더 쓰기 권한을 확인하세요.');
            }
        }
    }

    // ---------- 기본 도구 ----------

    public static function newId(): string
    {
        return date('Ymd') . '-' . bin2hex(random_bytes(4));
    }

    public static function validId(string $id): bool
    {
        return (bool)preg_match(self::ID_RE, $id);
    }

    public function notePath(string $id): string
    {
        if (!self::validId($id)) throw new RuntimeException('잘못된 노트 ID');
        return $this->dir . '/notes/' . $id . '.txt';
    }

    public function filesDir(string $id): string
    {
        if (!self::validId($id)) throw new RuntimeException('잘못된 노트 ID');
        return $this->dir . '/files/' . $id;
    }

    /** 잠금을 잡고 index 를 읽어 $fn(&$index) 를 실행한 뒤 저장한다 */
    public function mutate(callable $fn): mixed
    {
        $fp = fopen($this->dir . '/.lock', 'c');
        if (!$fp) throw new RuntimeException('잠금 파일을 열 수 없습니다');
        try {
            flock($fp, LOCK_EX);
            $idx = $this->loadIndex();
            $before = json_encode($idx);
            $result = $fn($idx);
            if (json_encode($idx) !== $before) { $this->saveIndex($idx); $this->dropUsage(); }
            return $result;
        } finally {
            flock($fp, LOCK_UN);
            fclose($fp);
        }
    }

    public function index(): array
    {
        return $this->loadIndex();
    }

    /**
     * 처음 쓰는 사용자(index.json 도 노트도 없음)면 사용법(GUIDE.md, 없으면 README.md)을 안내 노트로 하나 넣는다.
     * 한 번 index 가 생기면 다시는 안 넣는다(안내 노트를 지워도 다시 안 생김). README 가 없으면 그냥 넘어감.
     */
    public function welcomeIfNew(): void
    {
        if (is_file($this->dir . '/index.json') || is_file($this->dir . '/index.json.bak')) return;
        if (glob($this->dir . '/notes/*.txt')) return;
        $md = '';
        foreach (['GUIDE.md', 'README.md'] as $f) {
            if (is_file(ROOT_DIR . '/' . $f)) { $md = (string)file_get_contents(ROOT_DIR . '/' . $f); break; }
        }
        $this->mutate(function (array &$idx) use ($md) {
            if ($idx['notes'] || trim($md) === '') return;   // 다른 요청이 먼저 만들었거나 README 없음
            $md = str_replace("\r\n", "\n", preg_replace('/^\xEF\xBB\xBF/', '', $md));
            $lines = explode("\n", $md);
            $title = trim(preg_replace('/^#+\s*/', '', (string)array_shift($lines)));
            $body = ltrim(implode("\n", $lines), "\n");
            $now = time();
            $id = $this->importInto($idx, [
                'title' => $title !== '' ? $title : '알지로 노트 사용법',
                'body' => $body, 'notebook' => $idx['notebooks'][0]['id'] ?? 'nb-default', 'tags' => ['안내'],
                'created' => $now, 'updated' => $now, 'src' => 'welcome:guide',
            ]);
            if ($id !== null) $idx['notes'][$id]['view'] = 'wysiwyg';   // 사용법은 꾸며진 모양으로 열리게
        });
    }

    private function loadIndex(): array
    {
        $path = $this->dir . '/index.json';
        $idx = null;
        foreach ([$path, $path . '.bak'] as $p) {
            if (is_file($p)) {
                $idx = json_decode((string)file_get_contents($p), true);
                if (is_array($idx)) break;
            }
        }
        if (!is_array($idx)) $idx = [];
        $idx += ['version' => 1, 'notebooks' => [], 'notes' => []];
        if (!$idx['notebooks']) {
            $idx['notebooks'][] = ['id' => 'nb-default', 'name' => '기본 노트북', 'created' => time()];
        }
        return $idx;
    }

    private function saveIndex(array $idx): void
    {
        $path = $this->dir . '/index.json';
        if (is_file($path)) @copy($path, $path . '.bak');
        $json = json_encode($idx, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
        if ($json === false) throw new RuntimeException('index 저장 실패');
        atomic_write($path, $json);
    }

    // ---------- 노트 파일 ----------

    public static function cleanTitle(string $t): string
    {
        $t = trim(str_replace(["\r\n", "\r", "\n", "\t"], ' ', $t));
        return mb_substr($t, 0, 200);
    }

    public static function cleanBody(string $b): string
    {
        return str_replace(["\r\n", "\r"], "\n", $b);
    }

    public static function snippet(string $body, int $len = 140): string
    {
        $s = preg_replace('/!\[[^\]]*\]\([^)]*\)/u', ' ', $body) ?? $body;          // 이미지
        $s = preg_replace('/\[([^\]]*)\]\([^)]*\)/u', '$1', $s) ?? $s;              // 링크 → 글자
        $s = preg_replace('/^\s*(#{1,6}|[-*+]\s+\[[ xX]\]|[-*+>]|\d+[.)])\s*/mu', '', $s) ?? $s;
        $s = preg_replace('#</?(span|font|u|mark|sub|sup)\b[^>]*>|<br\s*/?>#iu', '', $s) ?? $s;   // 글자색 등 HTML 태그
        $s = str_replace(['**', '__', '`', '~~'], '', $s);
        $s = trim(preg_replace('/\s+/u', ' ', $s) ?? $s);
        return mb_substr($s, 0, $len);
    }

    /** @return array{title:string, body:string} */
    public function readNote(string $id): array
    {
        $path = $this->notePath($id);
        if (!is_file($path)) throw new RuntimeException('노트 파일이 없습니다');
        return self::parse((string)file_get_contents($path));
    }

    public static function parse(string $raw): array
    {
        if (str_starts_with($raw, "\xEF\xBB\xBF")) $raw = substr($raw, 3);
        if (!mb_check_encoding($raw, 'UTF-8')) {
            // FTP 로 넣은 EUC-KR 파일 대비
            $conv = @mb_convert_encoding($raw, 'UTF-8', 'CP949');
            if (is_string($conv)) $raw = $conv;
        }
        $raw = self::cleanBody($raw);
        $pos = strpos($raw, "\n");
        if ($pos === false) return ['title' => self::cleanTitle($raw), 'body' => ''];
        return ['title' => self::cleanTitle(substr($raw, 0, $pos)), 'body' => substr($raw, $pos + 1)];
    }

    private function writeNoteFile(string $id, string $title, string $body): int
    {
        $path = $this->notePath($id);
        atomic_write($path, $title . "\n" . $body);
        clearstatcache(true, $path);
        return (int)filemtime($path);
    }

    // ---------- 노트 조작 (모두 잠금 안에서) ----------

    public function notebookExists(array $idx, string $nb): bool
    {
        foreach ($idx['notebooks'] as $n) if ($n['id'] === $nb) return true;
        return false;
    }

    /**
     * 새 노트 또는 기존 노트 저장. 넘긴 필드만 바꾼다.
     * $in: id?, title?, body?, notebook?, tags?, pinned?(즐겨찾기), fixed?(맨 위 고정), rev?(기존 노트를 고칠 때 기준 rev)
     * 기준 rev 가 다르면 ['conflict' => true, 'note' => 현재 메타] 를 돌려준다.
     */
    public function saveNote(array $in): array
    {
        if (isset($in['body']) && strlen((string)$in['body']) > self::MAX_BODY) {
            throw new RuntimeException('노트가 너무 큽니다(2MB 제한)');
        }
        return $this->mutate(function (array &$idx) use ($in) {
            $id = (string)($in['id'] ?? '');
            $isNew = $id === '';
            if ($isNew) {
                do { $id = self::newId(); } while (isset($idx['notes'][$id]));
                $nb = (string)($in['notebook'] ?? '');
                if (!$this->notebookExists($idx, $nb)) $nb = $idx['notebooks'][0]['id'];
                $now = time();
                $meta = ['title' => '', 'snippet' => '', 'notebook' => $nb, 'tags' => [], 'created' => $now,
                         'updated' => $now, 'rev' => 0, 'trashed' => null, 'pinned' => false, 'mtime' => 0];
                $title = ''; $body = '';
            } else {
                if (!isset($idx['notes'][$id])) throw new RuntimeException('노트가 없습니다');
                $meta = $idx['notes'][$id];
                if (isset($in['rev']) && (int)$in['rev'] !== (int)$meta['rev']) {
                    return ['conflict' => true, 'id' => $id, 'note' => $meta];
                }
                ['title' => $title, 'body' => $body] = $this->readNote($id);
            }

            $contentChanged = $isNew;
            if (array_key_exists('title', $in)) { $t = self::cleanTitle((string)$in['title']); $contentChanged = $contentChanged || $t !== $title; $title = $t; }
            if (array_key_exists('body', $in))  { $b = self::cleanBody((string)$in['body']);   $contentChanged = $contentChanged || $b !== $body;  $body = $b; }
            if (array_key_exists('notebook', $in) && $this->notebookExists($idx, (string)$in['notebook'])) $meta['notebook'] = (string)$in['notebook'];
            if (array_key_exists('tags', $in))   $meta['tags'] = self::cleanTags($in['tags']);
            if (array_key_exists('pinned', $in)) $meta['pinned'] = (bool)$in['pinned'];
            if (array_key_exists('fixed', $in))  $meta['fixed'] = (bool)$in['fixed'];   // 목록 맨 위 고정

            if ($contentChanged) {
                $meta['mtime']   = $this->writeNoteFile($id, $title, $body);
                $meta['hash']    = md5($title . "\n" . $body);
                $meta['title']   = $title;
                $meta['snippet'] = self::snippet($body);
                if (!$isNew) $meta['updated'] = time();
            }
            $meta['rev'] = (int)$meta['rev'] + 1;
            $idx['notes'][$id] = $meta;
            return ['conflict' => false, 'id' => $id, 'note' => $meta];
        });
    }

    public const VIEWS = ['source', 'markdown', 'wysiwyg'];

    /** 노트를 마지막으로 본 방식(소스·마크다운·위지윅). 내용이 아니라서 rev·수정 날짜는 그대로 */
    public function setView(string $id, string $view): void
    {
        if (!in_array($view, self::VIEWS, true)) throw new RuntimeException('잘못된 보기 방식');
        $this->mutate(function (array &$idx) use ($id, $view) {
            if (!isset($idx['notes'][$id])) throw new RuntimeException('노트가 없습니다');
            $idx['notes'][$id]['view'] = $view;
        });
    }

    /**
     * 사용 용량: 노트 txt · 첨부 파일 바이트 수와 개수.
     * 파일 수천 개를 매번 재면 느려서 결과를 .usage.json 에 남겨 두고,
     * 노트·첨부가 바뀌면(index 저장·첨부 추가) 지운다 → 다음에 한 번만 다시 잰다.
     */
    public function usage(): array
    {
        $cache = $this->dir . '/.usage.json';
        if (is_file($cache)) {
            $c = json_decode((string)file_get_contents($cache), true);
            $im = is_file($this->dir . '/index.json') ? (int)filemtime($this->dir . '/index.json') : 0;
            if (is_array($c) && isset($c['total'], $c['at']) && $im <= (int)$c['at']) return $c + ['cached' => true];
        }
        $sum = function (string $dir) use (&$sum): array {
            $bytes = 0; $count = 0;
            foreach (@scandir($dir) ?: [] as $f) {
                if ($f === '.' || $f === '..') continue;
                $p = $dir . '/' . $f;
                if (is_dir($p)) { [$b, $n] = $sum($p); $bytes += $b; $count += $n; }
                else { $bytes += (int)@filesize($p); $count++; }
            }
            return [$bytes, $count];
        };
        [$nb, $nc] = $sum($this->dir . '/notes');
        [$fb, $fc] = $sum($this->dir . '/files');
        $idxBytes = is_file($this->dir . '/index.json') ? (int)filesize($this->dir . '/index.json') : 0;
        $r = ['notesBytes' => $nb, 'noteFiles' => $nc, 'filesBytes' => $fb, 'files' => $fc,
              'otherBytes' => $idxBytes, 'total' => $nb + $fb + $idxBytes, 'at' => time()];
        @file_put_contents($cache, json_encode($r));
        return $r;
    }

    private function dropUsage(): void
    {
        @unlink($this->dir . '/.usage.json');
    }

    // ---------- 빠른 입력(매크로): macros.json ----------

    /** @return list<array{name:string, text:string, bar:bool}>|null  (null = 아직 한 번도 저장 안 함) */
    public function macros(): ?array
    {
        $p = $this->dir . '/macros.json';
        if (!is_file($p)) return null;
        $m = json_decode((string)file_get_contents($p), true);
        return is_array($m) ? self::cleanMacros($m) : null;
    }

    public function saveMacros(mixed $list): array
    {
        $list = self::cleanMacros(is_array($list) ? $list : []);
        atomic_write($this->dir . '/macros.json', (string)json_encode($list, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
        return $list;
    }

    private static function cleanMacros(array $in): array
    {
        $out = [];
        foreach ($in as $m) {
            if (!is_array($m)) continue;
            $name = mb_substr(trim(str_replace(["\r", "\n", "\t"], ' ', (string)($m['name'] ?? ''))), 0, 30);
            $text = mb_substr(str_replace(["\r\n", "\r"], "\n", (string)($m['text'] ?? '')), 0, 2000);
            if ($text === '') continue;
            $out[] = ['name' => $name !== '' ? $name : mb_substr($text, 0, 10), 'text' => $text, 'bar' => !empty($m['bar'])];
            if (count($out) >= 50) break;
        }
        return $out;
    }

    public static function cleanTags(mixed $tags): array
    {
        if (is_string($tags)) $tags = preg_split('/[,#]/u', $tags) ?: [];
        $out = [];
        foreach ((array)$tags as $t) {
            $t = mb_substr(trim(str_replace(["\r", "\n", ','], ' ', (string)$t)), 0, 50);
            if ($t !== '' && !in_array($t, $out, true)) $out[] = $t;
        }
        return array_slice($out, 0, 30);
    }

    public function setTrashed(string $id, bool $trashed): array
    {
        return $this->mutate(function (array &$idx) use ($id, $trashed) {
            if (!isset($idx['notes'][$id])) throw new RuntimeException('노트가 없습니다');
            $idx['notes'][$id]['trashed'] = $trashed ? time() : null;
            $idx['notes'][$id]['rev']++;
            return $idx['notes'][$id];
        });
    }

    /** 휴지통에 있는 노트만 영구 삭제 */
    public function purge(array $ids): int
    {
        return $this->mutate(function (array &$idx) use ($ids) {
            $n = 0;
            foreach ($ids as $id) {
                $id = (string)$id;
                if (!isset($idx['notes'][$id]) || empty($idx['notes'][$id]['trashed'])) continue;
                @unlink($this->notePath($id));
                $this->removeDir($this->filesDir($id));
                unset($idx['notes'][$id]);
                $n++;
            }
            return $n;
        });
    }

    public function emptyTrash(): int
    {
        $ids = [];
        foreach ($this->index()['notes'] as $id => $m) if (!empty($m['trashed'])) $ids[] = (string)$id;
        return $this->purge($ids);
    }

    private function removeDir(string $dir): void
    {
        if (!is_dir($dir)) return;
        foreach (scandir($dir) ?: [] as $f) {
            if ($f === '.' || $f === '..') continue;
            is_dir("$dir/$f") ? $this->removeDir("$dir/$f") : @unlink("$dir/$f");
        }
        @rmdir($dir);
    }

    // ---------- 노트북 ----------

    public function createNotebook(string $name): array
    {
        $name = self::cleanTitle($name);
        if ($name === '') throw new RuntimeException('노트북 이름을 입력하세요');
        return $this->mutate(function (array &$idx) use ($name) {
            foreach ($idx['notebooks'] as $nb) if ($nb['name'] === $name) return $nb;
            $nb = ['id' => 'nb-' . bin2hex(random_bytes(4)), 'name' => $name, 'created' => time()];
            $idx['notebooks'][] = $nb;
            return $nb;
        });
    }

    public function renameNotebook(string $id, string $name): void
    {
        $name = self::cleanTitle($name);
        if ($name === '') throw new RuntimeException('노트북 이름을 입력하세요');
        $this->mutate(function (array &$idx) use ($id, $name) {
            foreach ($idx['notebooks'] as &$nb) if ($nb['id'] === $id) $nb['name'] = $name;
        });
    }

    /** 노트가 남아 있으면 지우지 않는다(휴지통 노트는 첫 노트북으로 옮김) */
    public function deleteNotebook(string $id): void
    {
        $this->mutate(function (array &$idx) use ($id) {
            if (count($idx['notebooks']) <= 1) throw new RuntimeException('노트북은 하나 이상 있어야 합니다');
            foreach ($idx['notes'] as $m) {
                if ($m['notebook'] === $id && empty($m['trashed'])) throw new RuntimeException('노트북에 노트가 남아 있습니다. 먼저 옮기거나 삭제하세요.');
            }
            $idx['notebooks'] = array_values(array_filter($idx['notebooks'], fn($nb) => $nb['id'] !== $id));
            $first = $idx['notebooks'][0]['id'];
            foreach ($idx['notes'] as &$m) if ($m['notebook'] === $id) $m['notebook'] = $first;
        });
    }

    // ---------- 첨부 ----------

    public static function cleanFileName(string $name): string
    {
        if (!mb_check_encoding($name, 'UTF-8')) {   // 윈도우 프로그램이 CP949 로 보낸 이름
            $conv = @mb_convert_encoding($name, 'UTF-8', 'CP949');
            $name = is_string($conv) && mb_check_encoding($conv, 'UTF-8') ? $conv : '';
        }
        $name = str_replace(["\0", '/', '\\'], '', $name);
        $name = preg_replace('/[^\p{L}\p{N}._ ()\-]/u', '_', $name) ?? '';
        $name = ltrim(trim($name), '.');
        if ($name === '') $name = 'file';
        if (mb_strlen($name) > 100) {
            $ext = pathinfo($name, PATHINFO_EXTENSION);
            $name = mb_substr($name, 0, 90) . ($ext !== '' ? '.' . mb_substr($ext, 0, 8) : '');
        }
        return $name;
    }

    /** 본문에 넣는 첨부 주소 (편집 화면·보기 화면·txt 어디서나 그대로 쓰는 상대 주소) */
    public static function fileUrl(string $noteId, string $name): string
    {
        return 'file.php?n=' . rawurlencode($noteId) . '&f=' . rawurlencode($name);
    }

    /** 첨부 저장. 같은 이름이 있으면 이름-1, 이름-2 ... 저장된 이름을 돌려준다 */
    public function addFile(string $noteId, string $srcPath, string $name, bool $isUpload): string
    {
        $dir = $this->filesDir($noteId);
        if (!is_dir($dir)) mkdir($dir, 0700, true);
        $name = self::cleanFileName($name);
        $base = pathinfo($name, PATHINFO_FILENAME);
        $ext  = pathinfo($name, PATHINFO_EXTENSION);
        $final = $name;
        for ($i = 1; file_exists("$dir/$final"); $i++) $final = $base . '-' . $i . ($ext !== '' ? ".$ext" : '');
        $ok = $isUpload ? move_uploaded_file($srcPath, "$dir/$final") : copy($srcPath, "$dir/$final");
        if (!$ok) throw new RuntimeException('첨부 저장 실패');
        $this->dropUsage();
        return $final;
    }

    /** 첨부 경로(검증 후). 없으면 null */
    public function filePath(string $noteId, string $name): ?string
    {
        if ($name === '' || $name[0] === '.' || preg_match('#[/\\\\\0]#', $name)) return null;
        $dir = realpath($this->filesDir($noteId));
        if ($dir === false) return null;
        $p = realpath($dir . DIRECTORY_SEPARATOR . $name);
        if ($p === false || !is_file($p) || !str_starts_with($p, $dir . DIRECTORY_SEPARATOR)) return null;
        return $p;
    }

    /** 첨부 하나 지우기. 지웠으면 true */
    public function deleteFile(string $noteId, string $name): bool
    {
        $p = $this->filePath($noteId, $name);
        if ($p === null) return false;
        if (!@unlink($p)) throw new RuntimeException('첨부를 지울 수 없습니다(쓰기 권한 확인)');
        $dir = $this->filesDir($noteId);
        if (is_dir($dir) && count(scandir($dir) ?: []) <= 2) @rmdir($dir);   // 빈 폴더 정리
        $this->dropUsage();
        return true;
    }

    public const IMG_RE = '/\.(png|jpe?g|gif|webp|bmp|svg|heic|avif)$/i';

    /**
     * 노트별 첨부 개수: [노트ID => [이미지 수, 다른 파일 수]]. 목록에 🖼·📎 표시용.
     * files/ 의 노트 폴더 수정 시각이 그대로면 저장해 둔 값(.files.json)을 써서 빠르다
     * (첨부를 더하거나 지우면, FTP 로 바꿔도 폴더 수정 시각이 바뀜).
     */
    public function fileCounts(): array
    {
        $root = $this->dir . '/files';
        $cacheFile = $this->dir . '/.files.json';
        $old = is_file($cacheFile) ? (json_decode((string)file_get_contents($cacheFile), true) ?: []) : [];
        $new = []; $changed = false;
        foreach (is_dir($root) ? (scandir($root) ?: []) : [] as $id) {
            if ($id[0] === '.' || !is_dir("$root/$id")) continue;
            $mt = (int)filemtime("$root/$id");
            if (isset($old[$id]) && $old[$id][0] === $mt) { $new[$id] = $old[$id]; continue; }
            $img = 0; $other = 0;
            foreach (scandir("$root/$id") ?: [] as $f) {
                if ($f[0] === '.' || !is_file("$root/$id/$f")) continue;
                preg_match(self::IMG_RE, $f) ? $img++ : $other++;
            }
            $new[$id] = [$mt, $img, $other];
            $changed = true;
        }
        if ($changed || count($new) !== count($old)) @file_put_contents($cacheFile, json_encode($new), LOCK_EX);
        $out = [];
        foreach ($new as $id => [, $img, $other]) if ($img || $other) $out[(string)$id] = [$img, $other];
        return $out;
    }

    public function listFiles(string $noteId): array
    {
        $dir = $this->filesDir($noteId);
        if (!is_dir($dir)) return [];
        $out = [];
        foreach (scandir($dir) ?: [] as $f) {
            if ($f[0] === '.' || !is_file("$dir/$f")) continue;
            $out[] = ['name' => $f, 'size' => filesize("$dir/$f")];
        }
        return $out;
    }

    // ---------- 검색 ----------

    /**
     * 검색. 노트 파일 수천 개를 매번 여는 대신 본문을 모아 둔 검색용 파일(search.cache) 하나만 읽는다.
     * 검색용 파일의 각 줄에는 노트 내용 해시가 같이 있어서, 바뀐 노트만 그때 다시 읽어 채운다(저장 경로마다 따로 고칠 필요 없음).
     * 대소문자 구분 없이(영문), 띄어 쓴 낱말이 모두 들어 있는 노트(AND).
     */
    public function search(string $q, bool $trash = false, int $limit = 300): array
    {
        $words = array_values(array_filter(preg_split('/\s+/u', mb_strtolower(trim($q))) ?: [], 'strlen'));
        if (!$words) return [];
        $idx = $this->index();
        $cache = $this->searchCache($idx);
        $hits = [];
        foreach ($idx['notes'] as $id => $m) {
            $id = (string)$id;
            if ((bool)$m['trashed'] !== $trash || !empty($m['missing']) || !isset($cache[$id])) continue;
            $b = $cache[$id];
            $hay = $m['title'] . "\n" . $b . "\n" . implode(' ', $m['tags']);
            foreach ($words as $w) if (stripos($hay, $w) === false) continue 2;
            $pos = stripos($b, $words[0]);
            $snip = $pos === false ? $m['snippet'] : self::snippet(mb_strcut($b, max(0, $pos - 90), 600));
            $hits[] = ['id' => $id, 'snippet' => $snip];
            if (count($hits) >= $limit) break;
        }
        return $hits;
    }

    /**
     * 검색용 파일 읽기(+ 바뀐 노트만 다시 읽어 고쳐 쓰기). 돌려주는 값: [노트ID => 본문]
     * 파일 형식: 한 줄에 "ID \t 해시 \t 본문" (본문 속 줄바꿈·탭은 \x01·\x02 로 바꿔 둠)
     */
    private function searchCache(array $idx): array
    {
        $path = $this->dir . '/search.cache';
        $old = [];
        $raw = @file_get_contents($path);
        if (is_string($raw) && $raw !== '') {
            foreach (explode("\n", $raw) as $line) {
                $p = explode("\t", $line, 3);
                if (count($p) === 3) $old[$p[0]] = [$p[1], $p[2]];
            }
        }
        unset($raw);
        $out = []; $lines = []; $dirty = false;
        foreach ($idx['notes'] as $id => $m) {
            $id = (string)$id;
            if (!empty($m['missing'])) continue;
            $key = ($m['hash'] ?? '') !== '' ? $m['hash'] : 't' . ($m['mtime'] ?? 0);
            if (isset($old[$id]) && $old[$id][0] === $key) {
                $enc = $old[$id][1];
            } else {
                try { $body = $this->readNote($id)['body']; } catch (Throwable) { continue; }
                $enc = str_replace(["\r", "\n", "\t"], ['', "\x01", "\x02"], $body);
                $dirty = true;
            }
            $lines[] = $id . "\t" . $key . "\t" . $enc;
            $out[$id] = str_replace(["\x01", "\x02"], ["\n", "\t"], $enc);
        }
        if ($dirty || count($old) !== count($lines)) {
            try { atomic_write($path, implode("\n", $lines)); } catch (Throwable) { /* 못 써도 이번 검색은 됨 */ }
        }
        return $out;
    }

    // ---------- 가져오기 (mutate 안에서 부른다) ----------

    /**
     * 노트 한 개를 index 에 넣는다. 같은 src 가 이미 있으면 건너뛰고 null.
     * $n: title, body, notebook, tags[], created, updated, src, files[ [path, name] ], rewrite(callable(name map) → body)?
     */
    public function importInto(array &$idx, array $n, bool $refresh = false, ?string &$result = null): ?string
    {
        if ($this->srcSet === null) {
            $this->srcSet = [];
            foreach ($idx['notes'] as $sid => $m) if (!empty($m['src'])) $this->srcSet[$m['src']] = (string)$sid;
        }
        $existing = $this->srcSet[$n['src']] ?? null;
        if ($existing !== null) {
            $result = 'skip';
            if (!$refresh || !isset($idx['notes'][$existing])) return null;
            $m = $idx['notes'][$existing];
            // 가져온 뒤 한 번도 안 고친 노트만 다시 변환한다(고친 노트는 그대로 둠)
            if ((int)$m['rev'] !== 1 || (int)$m['updated'] !== (int)$n['updated']) { $result = 'edited'; return null; }
            return $this->refreshInto($idx, $existing, $n, $result);
        }
        $result = 'added';

        do { $id = self::newId(); } while (isset($idx['notes'][$id]));
        $this->srcSet[$n['src']] = $id;
        $names = [];
        foreach ($n['files'] ?? [] as $key => [$path, $name]) $names[$key] = $this->addFile($id, $path, $name, false);
        $body = isset($n['rewrite']) ? ($n['rewrite'])($names, $id) : (string)$n['body'];
        $title = self::cleanTitle((string)$n['title']);
        $body = self::cleanBody($body);
        $path = $this->notePath($id);
        atomic_write($path, $title . "\n" . $body);
        @touch($path, (int)$n['updated']);
        clearstatcache(true, $path);
        $idx['notes'][$id] = [
            'title' => $title, 'snippet' => self::snippet($body), 'notebook' => $n['notebook'],
            'tags' => self::cleanTags($n['tags'] ?? []), 'created' => (int)$n['created'], 'updated' => (int)$n['updated'],
            'rev' => 1, 'trashed' => null, 'pinned' => false, 'mtime' => (int)filemtime($path), 'src' => $n['src'],
            'hash' => md5($title . "\n" . $body),
        ];
        return $id;
    }

    /** 이미 가져온 노트를 새 변환 결과로 다시 쓴다. ID·첨부 파일은 그대로(같은 내용의 첨부는 다시 저장 안 함) */
    private function refreshInto(array &$idx, string $id, array $n, ?string &$result): ?string
    {
        $have = [];   // md5 => 이미 저장된 파일 이름
        foreach ($this->listFiles($id) as $f) $have[md5_file($this->filesDir($id) . '/' . $f['name'])] = $f['name'];
        $names = [];
        foreach ($n['files'] ?? [] as $key => [$path, $name]) {
            $names[$key] = $have[md5_file($path)] ?? $this->addFile($id, $path, $name, false);
        }
        $body = self::cleanBody(isset($n['rewrite']) ? ($n['rewrite'])($names, $id) : (string)$n['body']);
        $title = self::cleanTitle((string)$n['title']);
        $hash = md5($title . "\n" . $body);
        $m = $idx['notes'][$id];
        if (($m['hash'] ?? '') === $hash) { $result = 'same'; return null; }
        $path = $this->notePath($id);
        if (is_file($path) && md5_file($path) === $hash) { $result = 'same'; $m['hash'] = $hash; $idx['notes'][$id] = $m; return null; }
        atomic_write($path, $title . "\n" . $body);
        @touch($path, (int)$n['updated']);
        clearstatcache(true, $path);
        $m['title'] = $title;
        $m['snippet'] = self::snippet($body);
        $m['mtime'] = (int)filemtime($path);
        $m['hash'] = $hash;
        $idx['notes'][$id] = $m;   // rev 는 1 그대로 → 다음 refresh 때도 "안 고친 노트"로 인식
        $result = 'refreshed';
        return $id;
    }

    /** mutate 안에서 노트북 찾기/만들기 */
    public function notebookIdInto(array &$idx, string $name): string
    {
        $name = self::cleanTitle($name) ?: '가져온 노트';
        foreach ($idx['notebooks'] as $nb) if ($nb['name'] === $name) return $nb['id'];
        $nb = ['id' => 'nb-' . bin2hex(random_bytes(4)), 'name' => $name, 'created' => time()];
        $idx['notebooks'][] = $nb;
        return $nb['id'];
    }

    // ---------- 파일과 index 맞추기 ----------

    /**
     * notes/ 폴더의 txt 와 index 를 맞춘다.
     *  - index 에 없는 txt(직접 넣은 파일) → 첫 노트북에 추가 (ID 형식이 아니면 새 ID 로 이름 변경)
     *  - 수정 시각이 다른 txt → **내용이 실제로 바뀐 경우에만** 제목·요약·수정일 갱신.
     *    FTP 로 올리면 수정 시각이 올린 시각으로 바뀌므로 시각만 보고 판단하면 날짜가 전부 틀어진다.
     *  - 파일이 없어진 노트 → 바로 지우지 않고 missing 표시 후 목록에서 숨김.
     *    올리는 도중(index 는 먼저 올라가고 txt 는 아직)에 접속해도 날짜·노트북·태그를 잃지 않는다.
     *    7일 지나도 파일이 없으면 그때 index 에서 뺀다.
     */
    /**
     * reconcile 을 $ttl 초에 한 번만. 노트 파일 수천 개의 수정 시각을 매번 다 보면 목록 불러오기가 느려서.
     * (FTP 로 바꾼 파일은 늦어도 $ttl 초 뒤에 반영. 복원 등은 reconcile() 을 바로 부른다)
     */
    public function reconcileSometimes(int $ttl = 300): void
    {
        $stamp = $this->dir . '/.reconciled';
        $last = @filemtime($stamp);
        if ($last !== false && time() - $last < $ttl && time() >= $last) return;
        $this->reconcile();
        @touch($stamp);
    }

    public function reconcile(): void
    {
        $dir = $this->dir . '/notes';
        $files = [];
        foreach (scandir($dir) ?: [] as $f) {
            if (!str_ends_with($f, '.txt') || $f[0] === '.') continue;
            $files[substr($f, 0, -4)] = (int)filemtime("$dir/$f");
        }
        $idx = $this->index();
        $need = false;
        foreach ($files as $id => $mt) {
            $m = $idx['notes'][(string)$id] ?? null;
            if (!$m || (int)$m['mtime'] !== $mt || !empty($m['missing'])) { $need = true; break; }
        }
        if (!$need) {
            foreach ($idx['notes'] as $id => $m) {
                if (!isset($files[$id]) && empty($m['missing'])) { $need = true; break; }
            }
        }
        if (!$need) return;

        $this->mutate(function (array &$idx) use ($files, $dir) {
            foreach ($files as $id => $mt) {
                $id = (string)$id;
                $m = $idx['notes'][$id] ?? null;
                if ($m && (int)$m['mtime'] === $mt && empty($m['missing'])) continue;
                if (!self::validId($id)) {
                    $new = self::newId();
                    if (!rename("$dir/$id.txt", "$dir/$new.txt")) continue;
                    $id = $new;
                    $m = null;
                    clearstatcache();
                    $mt = (int)filemtime("$dir/$id.txt");
                }
                $raw = (string)file_get_contents("$dir/$id.txt");
                $hash = md5($raw);
                $p = self::parse($raw);
                $snip = self::snippet($p['body']);

                if ($m) {
                    unset($m['missing']);
                    // 내용이 같으면 시각만 맞춘다. 예전 index(hash 없음)는 제목·요약이 같으면 같은 내용으로 본다.
                    $same = isset($m['hash']) ? $m['hash'] === $hash : ($m['title'] === $p['title'] && $m['snippet'] === $snip);
                    $m['mtime'] = $mt;
                    $m['hash'] = $hash;
                    if (!$same) {
                        $m['title'] = $p['title'];
                        $m['snippet'] = $snip;
                        $m['updated'] = $mt;
                        $m['rev'] = (int)$m['rev'] + 1;
                    }
                } else {
                    $m = ['title' => $p['title'], 'snippet' => $snip, 'notebook' => $idx['notebooks'][0]['id'], 'tags' => [],
                          'created' => $mt, 'updated' => $mt, 'rev' => 1, 'trashed' => null, 'pinned' => false,
                          'mtime' => $mt, 'hash' => $hash];
                }
                $idx['notes'][$id] = $m;
            }
            $now = time();
            foreach ($idx['notes'] as $id => &$m) {
                if (is_file($dir . '/' . $id . '.txt')) continue;
                if (empty($m['missing'])) $m['missing'] = $now;
                elseif ($now - (int)$m['missing'] > 7 * 86400) unset($idx['notes'][$id]);
            }
            unset($m);
        });
    }
}
