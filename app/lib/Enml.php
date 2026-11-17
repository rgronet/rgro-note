<?php
declare(strict_types=1);

/**
 * 에버노트 ENML(HTML 비슷한 XML) → Markdown.
 * 에버노트는 한 줄을 <div> 하나로 쓰므로 div 하나 = 한 줄로 옮긴다(보기 화면은 줄바꿈을 그대로 표시).
 * 첨부 주소는 \x01<hash>\x01 자리표시로 남기고, 저장된 파일 이름이 정해진 뒤 file.php 주소로 바꾼다.
 */
final class Enml
{
    private array $lines = [];
    private string $buf = '';
    private bool $started = false;
    /** @var array<int, array{0:string,1:string,2:bool}> [첫 줄 접두어, 다음 줄 접두어, 썼는지] */
    private array $prefix = [];
    private array $media = [];   // hash => [name, mime]
    private array $olCount = [];

    public static function toMarkdown(string $enml, array $media): string
    {
        $c = new self();
        $c->media = $media;
        return $c->run($enml);
    }

    /** 에버노트가 제목 없을 때 넣는 이름 */
    public static function isUntitled(string $title): bool
    {
        return in_array(trim($title), ['', '제목 없음', '제목 없는 노트', 'Untitled', 'Untitled Note', '無題'], true);
    }

    /**
     * 제목 없는 노트: 본문 첫 줄을 제목으로 쓴다(에버노트 목록에 보이는 것과 같음).
     * 첫 줄이 짧은 글이면 제목으로 옮기고 본문에서 뺀다(txt 첫 줄 = 제목이므로 두 번 안 나오게).
     * 길거나 목록·표 같은 줄이면 앞부분만 제목으로 쓰고 본문은 그대로 둔다.
     * 글이 없으면 "메모 YYYY-MM-DD".
     * @return array{0:string,1:string} [제목, 본문]
     */
    public static function titleFromBody(string $md, int $created): array
    {
        $lines = explode("\n", $md);
        $inFence = false;
        foreach ($lines as $i => $l) {
            if (preg_match('/^`{3,}/', $l)) { $inFence = !$inFence; continue; }
            $t = trim($l);
            if ($t === '' || $t === '---') continue;
            // 이미지만 있는 줄, 첨부 링크만 있는 줄은 건너뜀
            if (preg_match('/^(!\[[^\]]*\]\([^)]*\)\s*)+$/u', $t)) continue;
            if (preg_match('/^\[📎[^\]]*\]\([^)]*\)$/u', $t)) continue;

            $plain = !$inFence && !preg_match('/^([-*+] |\d+[.)] |\||>|#)/', $t);
            $text = preg_replace('/!\[[^\]]*\]\([^)]*\)/u', '', $t) ?? $t;
            $text = preg_replace('/\[([^\]]*)\]\([^)]*\)/u', '$1', $text) ?? $text;
            $text = preg_replace('/^(#{1,6}\s+|[-*+]\s+\[[ xX]\]\s+|[-*+>]\s+|\d+[.)]\s+|\|\s*)/u', '', $text) ?? $text;
            $text = str_replace(['**', '~~', '`', "\u{00A0}", '|'], ['', '', '', ' ', ' '], $text);
            $text = trim(preg_replace('/\s+/u', ' ', $text) ?? $text);
            if ($text === '') continue;

            if ($plain && mb_strlen($text) <= 60) {
                array_splice($lines, $i, 1);
                if (isset($lines[$i]) && trim($lines[$i]) === '' && $i === 0) array_splice($lines, $i, 1);
                return [$text, ltrim(implode("\n", $lines), "\n")];
            }
            return [mb_strlen($text) > 50 ? mb_substr($text, 0, 50) . '…' : $text, $md];
        }
        return ['메모 ' . date('Y-m-d', $created), $md];
    }

    public static function mediaPlaceholder(string $hash): string
    {
        return "\x01" . $hash . "\x01";
    }

    private function run(string $enml): string
    {
        $html = preg_replace('/<\?xml[^>]*\?>|<!DOCTYPE[^>]*>/i', '', $enml) ?? $enml;
        // 알 수 없는 빈 태그는 HTML 파서가 뒤 내용을 삼킬 수 있어 빈 요소(img/input)로 바꿔 둔다
        $html = preg_replace('#<en-media\b([^>]*?)/?>(\s*</en-media>)?#i', '<img data-en-media="1"$1>', $html) ?? $html;
        $html = preg_replace('#<en-todo\b([^>]*?)/?>(\s*</en-todo>)?#i', '<input type="checkbox" data-en-todo="1"$1>', $html) ?? $html;
        $html = preg_replace('#<en-crypt\b[^>]*>.*?</en-crypt>#is', '<span>[암호화된 내용 — 에버노트에서만 열 수 있음]</span>', $html) ?? $html;
        $html = preg_replace('#<(/?)en-note\b#i', '<$1div', $html) ?? $html;

        $doc = new DOMDocument();
        $prev = libxml_use_internal_errors(true);
        $doc->loadHTML('<?xml encoding="UTF-8"><html><body>' . $html . '</body></html>', LIBXML_NONET | LIBXML_COMPACT | LIBXML_PARSEHUGE);
        libxml_clear_errors();
        libxml_use_internal_errors($prev);

        $body = $doc->getElementsByTagName('body')->item(0);
        if ($body) $this->children($body);
        $this->nl();

        $out = implode("\n", self::paragraphs($this->lines));
        $out = preg_replace("/\n{3,}/", "\n\n", $out) ?? $out;
        return trim($out, "\n") . "\n";
    }

    /**
     * 글 줄은 한 줄씩 그대로 둔다(Toast UI 는 줄 하나 = 문단 하나로 보여 줌. 에버노트와 같음).
     * 줄의 종류가 바뀌는 곳(글↔목록, 글↔인용, 표, 제목, 코드 블록)에만 빈 줄을 넣는다.
     * 빈 줄이 없으면 목록 다음 글 줄이 목록 안으로 빨려 들어가는 등 구조가 깨진다.
     */
    private static function paragraphs(array $lines): array
    {
        $out = [];
        $fence = null;
        $prevKind = null;   // 바로 윗줄 종류 (빈 줄이면 null)
        foreach ($lines as $l) {
            if ($fence !== null) {
                $out[] = $l;
                if (rtrim($l) === $fence) { $fence = null; $prevKind = 'code'; }
                continue;
            }
            if (trim($l) === '') { $out[] = $l; $prevKind = null; continue; }

            if (preg_match('/^(`{3,})/', $l, $m)) { $kind = 'code'; $fence = $m[1]; }
            elseif (preg_match('/^\s*([-*+] |\d+[.)] )/', $l)) $kind = 'list';
            elseif ($prevKind === 'list' && preg_match('/^\s+\S/', $l)) $kind = 'list';   // 목록 항목의 이어지는 줄
            elseif ($l[0] === '>') $kind = 'quote';
            elseif ($l[0] === '|') $kind = 'table';
            elseif (preg_match('/^#{1,6}(\s|$)/', $l)) $kind = 'heading';   // "#!/bin/bash" 같은 건 제목이 아님
            else $kind = 'text';

            if ($prevKind !== null && ($kind !== $prevKind || $kind === 'code')) $out[] = '';
            $out[] = $l;
            $prevKind = $kind;
        }
        return $out;
    }

    // ---------- 줄 만들기 ----------

    private function w(string $s, bool $raw = false): void
    {
        if ($s === '') return;
        if ($raw) {
            if (!$this->started) { $this->w("\x02"); $this->buf = substr($this->buf, 0, -1); }
            $this->buf .= $s;
            return;
        }
        if (!$this->started) {
            $p = '';
            foreach ($this->prefix as $i => $e) {
                $p .= $e[2] ? $e[1] : $e[0];
                $this->prefix[$i][2] = true;
            }
            $this->buf = $p;
            $this->started = true;
            $s = ltrim($s, ' ');   // 줄 첫머리 공백(HTML 들여쓰기 흔적) 제거
            if ($s === '') return;
        }
        $this->buf .= $s;
    }

    /** 줄 끝. $blank=true 면 빈 줄이라도 하나 남긴다(<br>) */
    private function nl(bool $blank = false): void
    {
        if ($this->started) {
            $line = rtrim($this->buf);
            // "&nbsp; " 만 있는 줄 = 빈 줄
            if (preg_match('/^[\s\x{00A0}\x{200A}\x{200B}]*$/u', $line)) $line = '';
            $this->lines[] = $line;
        } elseif ($blank) {
            $p = '';
            foreach ($this->prefix as $e) $p .= $e[2] ? $e[1] : $e[0];
            $this->lines[] = rtrim($p);
        }
        $this->buf = '';
        $this->started = false;
    }

    private function push(string $first, string $rest): void { $this->prefix[] = [$first, $rest, false]; }
    private function pop(): void { array_pop($this->prefix); }

    // ---------- 노드 ----------

    private function children(DOMNode $n): void
    {
        foreach ($n->childNodes as $c) $this->node($c);
    }

    private function node(DOMNode $n): void
    {
        if ($n instanceof DOMText) {
            $t = str_replace("\r", '', $n->nodeValue ?? '');
            // 태그 사이 줄맞춤 공백(예전 ENML) → 무시
            if (trim($t, " \t\n") === '') { if (!str_contains($t, "\n")) $this->w(' '); return; }
            // 글 안의 줄바꿈(붙여넣은 글)은 에버노트가 줄바꿈으로 보여 주므로 그대로 줄을 나눈다.
            // 단, 글 앞뒤의 줄바꿈은 태그 줄맞춤일 수 있어 뺀다.
            $t = preg_replace('/^[ \t]*\n/', '', $t) ?? $t;
            $t = preg_replace('/\n[ \t]*$/', '', $t) ?? $t;
            foreach (explode("\n", $t) as $i => $part) {
                if ($i > 0) $this->nl(true);
                $this->w(preg_replace('/[ \t]+/', ' ', $part) ?? $part);
            }
            return;
        }
        if (!$n instanceof DOMElement) return;
        $tag = strtolower($n->tagName);
        $style = strtolower($n->getAttribute('style'));

        if (str_contains($style, '-en-codeblock') || $tag === 'pre') { $this->code($n); return; }
        if (str_contains($style, '--en-task-group')) { return; }   // 작업 목록 자리표시(작업은 따로 붙임)
        if (preg_match('/display\s*:\s*none/', $style)) { return; }  // 에버노트 숨김 설정 블록(--en-chs 등)

        switch ($tag) {
            case 'script': case 'style': case 'head': case 'title': case 'object': return;

            case 'br': $this->nl(true); return;

            case 'div': case 'section': case 'article': case 'center': case 'footer': case 'header':
                $this->nl(); $this->children($n); $this->nl(); return;

            case 'p':
                $this->nl(); $this->children($n); $this->nl(); $this->nl(true); return;

            case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
                $this->nl();
                $this->push(str_repeat('#', (int)$tag[1]) . ' ', '');
                $this->children($n);
                $this->nl(); $this->pop();
                return;

            case 'blockquote':
                $this->nl(); $this->push('> ', '> '); $this->children($n); $this->nl(); $this->pop(); return;

            case 'ul': case 'ol':
                $this->nl(); $this->olCount[] = $tag === 'ol' ? 1 : 0; $this->children($n); array_pop($this->olCount); $this->nl(); return;

            case 'li':
                $this->nl();
                $k = count($this->olCount) - 1;
                if ($k >= 0 && $this->olCount[$k] > 0) { $m = $this->olCount[$k]++ . '. '; }
                else { $m = '- '; }
                // 에버노트 체크리스트: <li style="--en-checked:true">
                if (preg_match('/--en-checked\s*:\s*(true|false)/', $style, $mm)) $m = '- [' . ($mm[1] === 'true' ? 'x' : ' ') . '] ';
                $this->push($m, str_repeat(' ', strlen($m)));
                $this->children($n);
                $this->nl(); $this->pop();
                return;

            case 'hr':
                // 바로 윗줄이 글자면 "---" 가 제목 표시로 해석되므로 앞뒤를 빈 줄로 띄운다
                $this->nl(); array_push($this->lines, '', '---', ''); return;

            case 'table': $this->table($n); return;

            case 'input':
                if ($n->hasAttribute('data-en-todo')) {
                    $box = strtolower($n->getAttribute('checked')) === 'true' ? '[x] ' : '[ ] ';
                    $this->w($this->started ? $box : '- ' . $box);
                }
                return;

            case 'img':
                if ($n->hasAttribute('data-en-media')) { $this->media($n); return; }
                $src = $n->getAttribute('src');
                if (preg_match('#^https?://#i', $src)) $this->w('![](' . self::url($src) . ')');
                return;

            case 'a':
                $href = trim($n->getAttribute('href'));
                $text = trim(preg_replace('/\s+/u', ' ', $n->textContent) ?? '');
                $hasImg = $n->getElementsByTagName('img')->length > 0;
                if ($href === '' || $hasImg || str_starts_with(strtolower($href), 'javascript:')) { $this->children($n); return; }
                if ($text === '' ) { $this->w('<' . $href . '>'); return; }
                $this->w($text === $href ? $href : '[' . str_replace(['[', ']'], ['\[', '\]'], $text) . '](' . self::url($href) . ')');
                return;

            case 'b': case 'strong': $this->wrap($n, '**'); return;
            case 'i': case 'em': $this->wrap($n, '*'); return;
            case 's': case 'strike': case 'del': $this->wrap($n, '~~'); return;
            case 'code': $this->wrap($n, '`'); return;

            case 'span': case 'font':
                // 글자색·배경색(형광펜)은 <span style="color: …; background-color: …"> 로 남김(편집기·보기에서 그대로 보임)
                $color = self::colorStyle($n, $style);
                $simple = $color !== '' && self::isSimpleInline($n);
                if ($simple) $this->w('<span style="' . $color . '">');
                if (preg_match('/font-weight\s*:\s*(bold|[6-9]00)/', $style)) $this->wrap($n, '**');
                elseif (str_contains($style, 'line-through')) $this->wrap($n, '~~');
                else $this->children($n);
                if ($simple) $this->w('</span>');
                return;

            default:
                $this->children($n);
        }
    }

    /** 안쪽이 블록(문단·목록·표·그림) 없는 한 줄 글자인지 */
    private static function isSimpleInline(DOMElement $n): bool
    {
        $t = $n->textContent;
        if (trim($t) === '' || preg_match('/[\r\n]/', $t)) return false;
        foreach (['div', 'p', 'br', 'li', 'table', 'img', 'en-media'] as $b) {
            if ($n->getElementsByTagName($b)->length) return false;
        }
        return true;
    }

    /** 에버노트 색 → "color: #rrggbb; background-color: #rrggbb" (검정 글자·흰 배경 같은 기본색은 뺌) */
    private static function colorStyle(DOMElement $n, string $style): string
    {
        $out = [];
        $fg = '';
        if (preg_match('/(?<![-\w])color\s*:\s*([^;]+)/', $style, $m)) $fg = $m[1];
        elseif ($n->hasAttribute('color')) $fg = $n->getAttribute('color');
        $fg = self::hexColor($fg);
        if ($fg !== '' && !self::isNear($fg, [0, 0, 0], 70) && !self::isNear($fg, [255, 255, 255], 20)) $out[] = 'color: ' . $fg;
        $bg = '';
        if (preg_match('/background(?:-color)?\s*:\s*([^;]+)/', $style, $m)) $bg = $m[1];
        elseif (preg_match('/--en-highlight\s*:\s*([a-z]+)/', $style, $m)) {
            $bg = ['yellow' => '#ffef9e', 'green' => '#b7f7d1', 'blue' => '#adf4ff', 'purple' => '#cbcaff', 'pink' => '#ffd1f7', 'orange' => '#ffd9b3', 'red' => '#fec1d0'][$m[1]] ?? '';
        }
        $bg = self::hexColor($bg);
        if ($bg !== '' && !self::isNear($bg, [255, 255, 255], 12)) $out[] = 'background-color: ' . $bg;
        return implode('; ', $out);
    }

    private static function hexColor(string $c): string
    {
        $c = strtolower(trim(str_replace('!important', '', $c)));
        if (preg_match('/^#([0-9a-f]{3})$/', $c, $m)) return '#' . $m[1][0] . $m[1][0] . $m[1][1] . $m[1][1] . $m[1][2] . $m[1][2];
        if (preg_match('/^#[0-9a-f]{6}$/', $c)) return $c;
        if (preg_match('/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/', $c, $m)) {
            if (isset($m[4]) && $m[4] !== '' && (float)$m[4] < 0.1) return '';   // 투명
            return sprintf('#%02x%02x%02x', min(255, (int)$m[1]), min(255, (int)$m[2]), min(255, (int)$m[3]));
        }
        $names = ['red' => '#ff0000', 'blue' => '#0000ff', 'green' => '#008000', 'yellow' => '#ffff00', 'orange' => '#ffa500',
                  'purple' => '#800080', 'gray' => '#808080', 'grey' => '#808080', 'black' => '#000000', 'white' => '#ffffff'];
        return $names[$c] ?? '';
    }

    private static function isNear(string $hex, array $rgb, int $tol): bool
    {
        $v = [hexdec(substr($hex, 1, 2)), hexdec(substr($hex, 3, 2)), hexdec(substr($hex, 5, 2))];
        return abs($v[0] - $rgb[0]) <= $tol && abs($v[1] - $rgb[1]) <= $tol && abs($v[2] - $rgb[2]) <= $tol;
    }

    /** 안쪽이 한 줄 글자일 때만 **굵게** 같은 표시를 붙인다 */
    private function wrap(DOMElement $n, string $mark): void
    {
        $t = $n->textContent;
        $simple = trim($t) !== '' && trim($t) === $t && !preg_match('/[\r\n]/', $t);
        foreach (['div', 'p', 'br', 'li', 'table', 'img'] as $b) {
            if ($n->getElementsByTagName($b)->length) { $simple = false; break; }
        }
        if ($simple) $this->w($mark);
        $this->children($n);
        if ($simple) $this->w($mark);
    }

    private function media(DOMElement $n): void
    {
        $hash = strtolower($n->getAttribute('hash'));
        $mime = strtolower($n->getAttribute('type'));
        if (!isset($this->media[$hash])) { $this->w('[첨부 없음]'); return; }
        [$name, $m] = $this->media[$hash];
        $mime = $m ?: $mime;
        $url = self::mediaPlaceholder($hash);   // 가져오기에서 file.php?n=..&f=.. 로 바뀜
        if (str_starts_with($mime, 'image/')) {
            $this->nl(); $this->w('![](' . $url . ')'); $this->nl();
        } else {
            $this->w('[📎 ' . str_replace(['[', ']'], '', $name) . '](' . $url . ')');
        }
    }

    private function code(DOMElement $n): void
    {
        // 코드 블록: div 줄마다 한 줄, br 도 줄바꿈
        $text = '';
        $walk = function (DOMNode $x) use (&$walk, &$text) {
            foreach ($x->childNodes as $c) {
                if ($c instanceof DOMText) { $text .= $c->nodeValue; continue; }
                if (!$c instanceof DOMElement) continue;
                $t = strtolower($c->tagName);
                if ($t === 'br') { $text .= "\n"; continue; }
                $walk($c);
                if (in_array($t, ['div', 'p', 'li'], true) && !str_ends_with($text, "\n")) $text .= "\n";
            }
        };
        $walk($n);
        $text = rtrim(str_replace("\u{00A0}", ' ', $text), "\n");
        $this->nl();
        $fence = str_contains($text, '```') ? '````' : '```';
        foreach (array_merge([$fence], explode("\n", $text), [$fence]) as $l) {
            $this->w($l, true);   // 코드 들여쓰기는 그대로
            $this->nl(true);
        }
    }

    private function table(DOMElement $t): void
    {
        $rows = [];
        foreach ($t->getElementsByTagName('tr') as $tr) {
            $cells = [];
            foreach ($tr->childNodes as $td) {
                if (!$td instanceof DOMElement || !in_array(strtolower($td->tagName), ['td', 'th'], true)) continue;
                $sub = new self();
                $sub->media = $this->media;
                $sub->children($td);
                $sub->nl();
                $cells[] = array_values(array_filter($sub->lines, fn($l) => trim($l) !== ''));
            }
            if ($cells) $rows[] = $cells;
        }
        if (!$rows) return;
        $w = max(array_map('count', $rows));

        // 칸이 하나뿐인 표 = 에버노트의 "상자". 표로 두면 줄바꿈을 <br> 로밖에 못 쓰니 그냥 줄로 풀어 쓴다
        if ($w === 1) {
            $this->nl(); $this->nl(true);
            foreach ($rows as $r) {
                if (!$r[0]) continue;
                array_push($this->lines, ...$r[0]);
                $this->lines[] = '';
            }
            return;
        }

        // 칸이 여럿인 표: 마크다운 표 칸 안에서는 줄바꿈을 <br> 로 쓴다
        $rows = array_map(fn($r) => array_map(fn($ls) => str_replace('|', '\|', implode('<br>', $ls)), $r), $rows);
        $this->nl(); $this->nl(true);
        foreach ($rows as $i => $r) {
            $r = array_pad($r, $w, '');
            $this->lines[] = '| ' . implode(' | ', $r) . ' |';
            if ($i === 0) $this->lines[] = '|' . str_repeat(' --- |', $w);
        }
        $this->lines[] = '';
    }

    private static function url(string $u): string
    {
        return preg_match('/[\s()<>]/', $u) ? '<' . str_replace(['<', '>'], ['%3C', '%3E'], $u) . '>' : $u;
    }
}
