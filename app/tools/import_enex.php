<?php
declare(strict_types=1);
/**
 * 에버노트 ENEX 가져오기 (한 번만 쓰는 도구)
 *
 *   php app/tools/import_enex.php <사용자폴더> <파일.enex 또는 폴더> [...]
 *   예) php app/tools/import_enex.php u1 D:/evernote_export
 *
 * - 노트북 이름 = enex 파일 이름(에버노트가 노트북 이름으로 내보냄). 없으면 만든다.
 * - 같은 노트(제목+만든 시각+노트북)는 다시 돌려도 건너뛴다.
 * - --refresh : 이미 가져온 노트를 지금 변환 규칙으로 다시 쓴다(ID·첨부 유지).
 *               가져온 뒤 웹에서 고친 노트는 건드리지 않는다.
 * - 본문은 Markdown 으로, 첨부는 data/users/<사용자>/files/<노트ID>/ 로 저장한다.
 */
if (PHP_SAPI !== 'cli') exit("CLI 전용\n");
require dirname(__DIR__) . '/bootstrap.php';
require dirname(__DIR__) . '/lib/EnexImport.php';
ini_set('memory_limit', '1024M');

$args = array_slice($argv, 1);
$refresh = in_array('--refresh', $args, true);
$args = array_values(array_filter($args, fn($a) => $a !== '--refresh'));
$uid = $args[0] ?? null;
$paths = array_slice($args, 1);
if (!$uid || !$paths) {
    fwrite(STDERR, "사용법: php app/tools/import_enex.php [--refresh] <사용자폴더(u1)> <파일.enex 또는 폴더> ...\n");
    exit(1);
}

$files = [];
foreach ($paths as $p) {
    if (is_dir($p)) {
        foreach (scandir($p) ?: [] as $f) if (preg_match('/\.enex$/i', $f)) $files[] = rtrim($p, '/\\') . DIRECTORY_SEPARATOR . $f;
    } elseif (is_file($p)) {
        $files[] = $p;
    } else {
        fwrite(STDERR, "없음: $p\n");
    }
}
if (!$files) exit("가져올 .enex 파일이 없습니다\n");

$store = new Store($uid);
$total = EnexImport::TOTAL;
foreach ($files as $file) {
    $nbName = EnexImport::notebookName($file);
    echo "▶ $nbName ($file)\n";
    try {
        $t = EnexImport::run($store, $file, $nbName, $refresh, fn(string $m) => print($m . "\n"));
    } catch (Throwable $e) {
        echo "  " . $e->getMessage() . "\n";
        continue;
    }
    echo "  노트 {$t['notes']} 개 처리\n";
    foreach ($t as $k => $n) $total[$k] += $n;
}
printf("완료: 추가 %d, 이미 있음 %d, 첨부 %d, 실패 %d, 제목 없음→본문 첫 줄 %d\n",
    $total['added'], $total['skipped'], $total['files'], $total['errors'], $total['titled']);
if ($refresh) {
    printf("다시 변환: 바뀜 %d, 그대로 %d, 웹에서 고친 노트라 건너뜀 %d\n", $total['refreshed'], $total['same'], $total['edited']);
}
