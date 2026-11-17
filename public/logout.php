<?php
declare(strict_types=1);
require dirname(__DIR__) . '/app/bootstrap.php';

if ($_SERVER['REQUEST_METHOD'] === 'POST' && check_csrf($_POST['csrf'] ?? null)) {
    $_SESSION = [];
    $p = session_get_cookie_params();
    setcookie(session_name(), '', ['expires' => time() - 3600, 'path' => $p['path'], 'secure' => $p['secure'],
                                   'httponly' => true, 'samesite' => 'Lax']);
    session_destroy();
}
redirect('./');
