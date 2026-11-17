<?php
declare(strict_types=1);
require dirname(__DIR__) . '/app/bootstrap.php';

// 첨부파일 내려주기: 로그인한 본인 파일만, 경로 검증 후
$user = current_user();
if (!$user) { http_response_code(403); exit; }
session_write_close();

$id   = (string)($_GET['n'] ?? '');
$name = (string)($_GET['f'] ?? '');
if (!Store::validId($id)) { http_response_code(404); exit; }

$store = new Store($user['uid']);
$path = $store->filePath($id, $name);
if ($path === null) { http_response_code(404); exit; }

$INLINE = [
    'png' => 'image/png', 'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg', 'gif' => 'image/gif',
    'webp' => 'image/webp', 'bmp' => 'image/bmp', 'pdf' => 'application/pdf',
    'txt' => 'text/plain; charset=utf-8', 'mp3' => 'audio/mpeg', 'm4a' => 'audio/mp4', 'mp4' => 'video/mp4',
];
$ext = strtolower(pathinfo($path, PATHINFO_EXTENSION));
$size = (int)filesize($path);
$etag = '"' . dechex((int)filemtime($path)) . '-' . dechex($size) . '"';

header('X-Content-Type-Options: nosniff');
header("Content-Security-Policy: default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox");
header('Cache-Control: private, max-age=604800');
header('ETag: ' . $etag);
if (trim((string)($_SERVER['HTTP_IF_NONE_MATCH'] ?? '')) === $etag) { http_response_code(304); exit; }

$fname = $name;   // basename() 은 로케일에 따라 한글 이름을 깨뜨릴 수 있어 검증된 이름을 그대로 쓴다
$disp = isset($INLINE[$ext]) && empty($_GET['dl']) ? 'inline' : 'attachment';
header('Content-Type: ' . ($INLINE[$ext] ?? 'application/octet-stream'));
header('Content-Length: ' . $size);
header("Content-Disposition: $disp; filename=\"" . preg_replace('/[^A-Za-z0-9._-]/', '_', $fname) . "\"; filename*=UTF-8''" . rawurlencode($fname));
readfile($path);
