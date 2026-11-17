<?php
declare(strict_types=1);

define('APP_DIR', __DIR__);
define('ROOT_DIR', dirname(__DIR__));

// 테스트용: 환경변수 NOTE_CONFIG 로 다른 설정 파일을 쓸 수 있다(실제 config.php 를 건드리지 않고 PC 에서 시험)
$__cfg = getenv('NOTE_CONFIG') ?: APP_DIR . '/config.php';
if (!is_file($__cfg)) {
    http_response_code(500);
    exit('app/config.php 가 없습니다. config.sample.php 를 복사해서 설정하세요.');
}
$GLOBALS['APP_CONFIG'] = require $__cfg;
unset($__cfg);

define('DATA_DIR', rtrim((string)($GLOBALS['APP_CONFIG']['data_dir'] ?? ROOT_DIR . '/data'), '/\\'));

require APP_DIR . '/lib/helpers.php';
require APP_DIR . '/lib/Store.php';
require APP_DIR . '/lib/GoogleAuth.php';
require APP_DIR . '/lib/Auth.php';
require APP_DIR . '/lib/Backup.php';

date_default_timezone_set((string)config('timezone', 'Asia/Seoul'));
mb_internal_encoding('UTF-8');
if (PHP_SAPI !== 'cli') start_session();
