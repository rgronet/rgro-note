<?php
declare(strict_types=1);
require dirname(__DIR__) . '/app/bootstrap.php';
require APP_DIR . '/lib/EnexImport.php';

security_headers(false);
$user = current_user();
if (!$user) json_error('로그인이 필요합니다', 401);
if (!empty($user['must_change'])) json_error('먼저 암호를 바꾸세요 (화면을 새로고침)', 403);
session_write_close();   // 세션 잠금을 풀어 동시 요청이 막히지 않게 (이후 세션 변경 없음)

$action = (string)($_GET['a'] ?? '');
$isPost = ($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST';
if ($isPost && !check_csrf($_SERVER['HTTP_X_CSRF_TOKEN'] ?? null)) {
    json_error('보안 토큰이 맞지 않습니다. 페이지를 새로고침하세요.', 403);
}

$in = [];
if ($isPost) {
    $ct = (string)($_SERVER['CONTENT_TYPE'] ?? '');
    if (str_contains($ct, 'application/json')) {
        $in = json_decode((string)file_get_contents('php://input'), true);
        if (!is_array($in)) json_error('요청 형식 오류');
    } else {
        $in = $_POST;
    }
}

$POST_ONLY = ['save', 'trash', 'restore', 'purge', 'empty_trash', 'nb_create', 'nb_rename', 'nb_delete', 'upload',
              'restore_chunk', 'restore_finish', 'enex_finish', 'file_delete', 'note_view', 'macros'];
if (in_array($action, $POST_ONLY, true) && !$isPost) json_error('POST 로 요청하세요', 405);

$id = (string)($in['id'] ?? $_GET['id'] ?? '');
if ($id !== '' && !Store::validId($id)) json_error('잘못된 노트 ID');

try {
    $store = new Store($user['uid']);

    switch ($action) {
        case 'state':
            $store->welcomeIfNew();         // 처음 쓰는 사용자면 README 를 안내 노트로 하나 넣음
            $store->reconcileSometimes();   // 파일 수정 시각 확인은 5분에 한 번만(빠르게)
            $idx = $store->index();
            $notes = [];
            $att = $store->fileCounts();   // 첨부 있는 노트 표시용 [이미지 수, 다른 파일 수]
            foreach ($idx['notes'] as $nid => $m) {
                if (!empty($m['missing'])) continue;   // 파일이 아직 안 올라왔거나 지워진 노트
                unset($m['hash'], $m['mtime'], $m['src']);   // 화면에 필요 없는 값은 빼서 전송량 줄임
                if (isset($att[(string)$nid])) $m['att'] = $att[(string)$nid];
                $notes[] = ['id' => (string)$nid] + $m;
            }
            json_out([
                'ok'        => true,
                'user'      => ['email' => $user['email'], 'name' => $user['name'], 'picture' => $user['picture'],
                                'method' => Auth::METHODS[$user['method'] ?? 'google'] ?? '', 'uid' => $user['uid']],
                'notebooks' => $idx['notebooks'],
                'notes'     => $notes,
                'uploadMax' => (int)config('upload_max_mb', 20) * 1024 * 1024,
                'macros'    => $store->macros(),
            ]);

        case 'note':
            $idx = $store->index();
            if (!isset($idx['notes'][$id])) json_error('노트가 없습니다', 404);
            $n = $store->readNote($id);
            json_out(['ok' => true, 'note' => ['id' => $id] + $n + $idx['notes'][$id], 'files' => $store->listFiles($id)]);

        case 'save':
            $data = array_intersect_key($in, array_flip(['id', 'title', 'body', 'notebook', 'tags', 'pinned', 'fixed', 'rev']));
            if (($data['id'] ?? '') === '') unset($data['id'], $data['rev']);
            $r = $store->saveNote($data);
            if ($r['conflict']) json_out(['ok' => false, 'conflict' => true, 'note' => ['id' => $r['id']] + $r['note']], 409);
            json_out(['ok' => true, 'note' => ['id' => $r['id']] + $r['note']]);

        case 'trash':
        case 'restore':
            $m = $store->setTrashed($id, $action === 'trash');
            json_out(['ok' => true, 'note' => ['id' => $id] + $m]);

        case 'purge':
            $ids = array_values(array_filter((array)($in['ids'] ?? [$id]), fn($x) => is_string($x) && Store::validId($x)));
            json_out(['ok' => true, 'count' => $store->purge($ids)]);

        case 'empty_trash':
            json_out(['ok' => true, 'count' => $store->emptyTrash()]);

        case 'nb_create':
            json_out(['ok' => true, 'notebook' => $store->createNotebook((string)($in['name'] ?? ''))]);

        case 'nb_rename':
            $store->renameNotebook((string)($in['nb'] ?? ''), (string)($in['name'] ?? ''));
            json_out(['ok' => true]);

        case 'nb_delete':
            $store->deleteNotebook((string)($in['nb'] ?? ''));
            json_out(['ok' => true]);

        case 'search':
            $q = (string)($_GET['q'] ?? '');
            json_out(['ok' => true, 'hits' => $store->search($q, !empty($_GET['trash']))]);

        case 'note_view':   // 노트를 마지막으로 본 방식 기억 (소스·마크다운·위지윅)
            $store->setView($id, (string)($in['view'] ?? ''));
            json_out(['ok' => true]);

        case 'macros':   // 빠른 입력 목록 저장
            json_out(['ok' => true, 'macros' => $store->saveMacros($in['macros'] ?? [])]);

        case 'usage':
            json_out(['ok' => true, 'usage' => $store->usage()]);

        case 'file_delete':   // 첨부 하나 지우기 (본문의 링크·그림은 화면에서 같이 지움)
            if (!isset($store->index()['notes'][$id])) json_error('노트가 없습니다', 404);
            if (!$store->deleteFile($id, (string)($in['name'] ?? ''))) json_error('첨부가 없습니다', 404);
            json_out(['ok' => true, 'files' => $store->listFiles($id)]);

        case 'upload':
            if (!isset($store->index()['notes'][$id])) json_error('노트가 없습니다', 404);
            $f = $_FILES['file'] ?? null;
            if (!is_array($f) || !isset($f['error'])) json_error('파일이 너무 크거나 전송되지 않았습니다(서버 post_max_size 확인)');
            if ($f['error'] === UPLOAD_ERR_INI_SIZE || $f['error'] === UPLOAD_ERR_FORM_SIZE) json_error('파일이 서버 제한보다 큽니다');
            if ($f['error'] !== UPLOAD_ERR_OK) json_error('업로드 실패 (코드 ' . (int)$f['error'] . ')');
            if ($f['size'] > (int)config('upload_max_mb', 20) * 1024 * 1024) json_error('파일이 너무 큽니다');
            $name = $store->addFile($id, (string)$f['tmp_name'], (string)$f['name'], true);
            json_out(['ok' => true, 'name' => $name, 'image' => (bool)preg_match('/\.(png|jpe?g|gif|webp|bmp)$/i', $name)]);

        // ---------- 백업 / 복원 ----------
        case 'backup':   // 노트 전체를 zip 으로 내려받기
            @set_time_limit(300);
            $zipPath = Backup::make($user['uid']);
            header('Content-Type: application/zip');
            header('Content-Length: ' . filesize($zipPath));
            header('Content-Disposition: attachment; filename="note-backup-' . $user['uid'] . '-' . date('Ymd-Hi') . '.zip"');
            header('Cache-Control: no-store');
            readfile($zipPath);
            @unlink($zipPath);
            exit;

        case 'restore_chunk':   // 복원 zip 을 나눠서 받기 (호스팅 업로드 크기 제한 회피)
            $up = (string)($_POST['upload'] ?? '');
            if (!preg_match('/^[a-f0-9]{16,32}$/', $up)) json_error('잘못된 업로드 ID');
            $kind = ($_POST['kind'] ?? '') === 'enex' ? 'enex' : 'restore';   // 에버노트 가져오기도 같은 방식으로 받음
            $part = Backup::tmpDir() . '/' . $kind . '-' . $user['uid'] . '-' . $up . '.part';
            $offset = (int)($_POST['offset'] ?? -1);
            $have = is_file($part) ? (int)filesize($part) : 0;
            if ($offset === 0 && $have > 0) { @unlink($part); $have = 0; }
            if ($offset !== $have) json_error('업로드 순서가 맞지 않습니다. 처음부터 다시 하세요.', 409, ['have' => $have]);
            $f = $_FILES['chunk'] ?? null;
            if (!is_array($f) || ($f['error'] ?? 1) !== UPLOAD_ERR_OK) json_error('조각 업로드 실패 (서버 post_max_size 확인)');
            if ($have + (int)$f['size'] > 4 * 1024 * 1024 * 1024) json_error('파일이 너무 큽니다');
            $src = fopen((string)$f['tmp_name'], 'rb');
            $dst = fopen($part, 'ab');
            if (!$src || !$dst) json_error('임시 파일을 쓸 수 없습니다(data/tmp 쓰기 권한 확인)', 500);
            stream_copy_to_stream($src, $dst);
            fclose($src); fclose($dst);
            clearstatcache(true, $part);
            json_out(['ok' => true, 'have' => (int)filesize($part)]);

        case 'restore_finish':   // 다 받은 zip 으로 복원
            @set_time_limit(600);
            $up = (string)($in['upload'] ?? '');
            if (!preg_match('/^[a-f0-9]{16,32}$/', $up)) json_error('잘못된 업로드 ID');
            $part = Backup::tmpDir() . '/restore-' . $user['uid'] . '-' . $up . '.part';
            clearstatcache(true, $part);
            if (!is_file($part) || (int)filesize($part) !== (int)($in['size'] ?? -1)) {
                @unlink($part);
                json_error('업로드가 끝까지 되지 않았습니다. 다시 하세요.');
            }
            try {
                $r = Backup::restore($user['uid'], $part);
            } finally {
                @unlink($part);
            }
            (new Store($user['uid']))->reconcile();   // 파일과 index 맞추기
            json_out(['ok' => true] + $r);

        case 'enex_finish':   // 다 받은 .enex 를 노트북 하나로 가져오기 (지금 노트는 그대로, 더하기만)
            @set_time_limit(0);
            @ini_set('memory_limit', '1024M');
            $up = (string)($in['upload'] ?? '');
            if (!preg_match('/^[a-f0-9]{16,32}$/', $up)) json_error('잘못된 업로드 ID');
            $part = Backup::tmpDir() . '/enex-' . $user['uid'] . '-' . $up . '.part';
            clearstatcache(true, $part);
            if (!is_file($part) || (int)filesize($part) !== (int)($in['size'] ?? -1)) {
                @unlink($part);
                json_error('업로드가 끝까지 되지 않았습니다. 다시 하세요.');
            }
            if (!EnexImport::looksLikeEnex($part)) { @unlink($part); json_error('에버노트 내보내기(.enex) 파일이 아닙니다'); }
            try {
                $nbName = trim((string)($in['notebook'] ?? ''));
                $nbName = $nbName !== '' ? mb_substr(preg_replace('/[\x00-\x1f\x7f]+/u', ' ', $nbName) ?? '', 0, 100)
                                         : EnexImport::notebookName((string)($in['name'] ?? ''));
                $t = EnexImport::run($store, $part, $nbName, !empty($in['refresh']), null, $errs);
            } finally {
                @unlink($part);
            }
            json_out(['ok' => true, 'notebook' => $nbName, 'errorList' => $errs] + $t);

        default:
            json_error('알 수 없는 요청', 404);
    }
} catch (RuntimeException $e) {
    json_error($e->getMessage());
} catch (Throwable $e) {
    error_log('[note api] ' . $e);
    json_error('서버 오류가 났습니다', 500);
}
