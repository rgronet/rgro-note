# 알지로 노트 설치

> ## 만든 곳 · 알지로넷
> **오래 쓰는 웹을 만듭니다.** 2002년부터 서버를 운영하고 프로그램을 개발해온 가람정보가 만들었습니다.
>
> | | |
> |---|---|
> | 사이트 | https://rgro.net |
> | 메일 | carrotdi@gmail.com |
> | 하는 일 | 홈페이지 제작 · 웹 프로그램·업무 시스템 · 오래된 사이트 전환(PHP 4,5,7 → 8.x) · 결제·외부 API 연동 · 서버 구축·운영 |
>
> 고치고 싶은 점, 같이 만들고 싶은 기능이 있으면 편하게 연락 주세요 — [작업 의뢰](https://rgro.net/contact.php)

쓰는 방법은 세 가지입니다.

| 방법 | 언제 | 필요한 것 |
|---|---|---|
| **A. 웹 서버에 설치** | PC·휴대폰 어디서나 같은 노트 | PHP 8.1 이상 웹 호스팅(DB 필요 없음), HTTPS |
| **B. PC 로컬 모드** | 서버 없이 이 PC 에서만 | 윈도우, 크롬 또는 엣지 (PHP 는 배포 폴더에 들어 있음) |
| **C. PC 프로그램 + 서버** | A 를 PC 에서 윈도우 실행 프로그램으로 | A 의 주소, 크롬 또는 엣지 |

---

## A. 웹 서버에 설치

### 1. 파일 올리기

```
알지로노트/      ← 노트 프로그램 폴더
  public/     ← 도메인 문서 루트(웹루트)를 여기로
  app/        ← 웹루트 밖 (설정·프로그램)
  data/       ← 웹루트 밖 (노트 저장, PHP 쓰기 권한 필요. 처음엔 없어도 됨)
  GUIDE.md    ← 처음 로그인한 사용자에게 "사용법" 노트로 들어감
```

1. 폴더 통째로 올리고 도메인 문서 루트를 `public/` 으로 정합니다.
2. `data/` 폴더(또는 그 위 폴더)에 PHP 쓰기 권한을 줍니다(예: 707, 또는 웹서버 사용자 소유).
3. **HTTPS** 로 접속되게 합니다(로그인 쿠키·소셜 로그인에 필요).

#### 문서 루트가 `www` 로 정해져 있는 호스팅 (카페24 등)

문서 루트를 `public/` 으로 바꿀 수 없고 `www`(또는 `public_html`, `html`) 로 고정돼 있어도,
**`www` 의 바깥(한 칸 위)에 폴더를 올릴 수 있으면** 코드를 고치지 않고 그대로 됩니다.
`public` 폴더 이름을 `www` 로 바꿔 올린다고 생각하면 됩니다.

```
(계정 홈)/                  ← FTP 로 접속하면 처음 보이는 곳
  app/        ← 그대로 올림 (www 바깥이라 웹으로 안 열림)
  data/       ← 처음엔 없어도 됨 (PHP 쓰기 권한 필요)
  GUIDE.md
  www/        ← public/ 폴더 "안의 것"을 여기에 올림
    index.php, api.php, file.php, login.php, logout.php, password.php,
    google_callback.php, naver_callback.php, kakao_callback.php,
    manifest.webmanifest, .htaccess, .user.ini, assets/
```

- `www/` 안의 파일들은 "한 칸 위의 `app/`" 을 찾아 쓰므로, `app/` 이 `www/` 와 **같은 깊이**에 있어야 합니다.
- 노트 저장 폴더는 설정의 기본값(`'data_dir' => dirname(__DIR__) . '/data'`)이 `app/` 같은 레벨이라 그대로 두면 됩니다.
  다른 곳에 두려면 `app/config.php` 의 `data_dir` 를 고칩니다.
- `www/` 안에 원래 있던 파일(호스팅 기본 index.html 등)은 지우거나 옮깁니다. 기본 `index.html` 이 있으면 노트 대신 열릴 수 있습니다.
- 숨김 파일 `.htaccess`, `.user.ini` 도 함께 올라갔는지 확인합니다(FTP 프로그램에서 숨김 파일 보기를 켜야 보이는 경우가 있음).
- 소셜 로그인 돌아올 주소는 그대로 `https://내도메인/google_callback.php` 처럼 도메인 바로 아래입니다.
- 올린 뒤 `https://내도메인/` 이 로그인 화면으로 열리면 끝입니다.
  "app/config.php 가 없습니다" 가 나오면 `app/config.sample.php` 를 `app/config.php` 로 복사해 고치지 않은 것이고,
  빈 화면·500 오류면 `app/` 이 `www/` 와 같은 레벨에 있는지 확인합니다.

### 2. PHP 확인

- PHP 8.1 이상 (8.4·8.5 확인)
- 확장: **mbstring, zip**(백업·복원), **dom·xmlreader·simplexml**(에버노트 가져오기), **curl** 또는 `allow_url_fopen`(소셜 로그인), fileinfo
- 첨부 크기: `public/.user.ini` 의 `upload_max_filesize = 20M`, `post_max_size = 24M` (설정의 `upload_max_mb` 와 맞춤)

### 3. 설정 파일 · 로그인 방식

`app/config.sample.php` 를 `app/config.php` 로 복사하고 고칩니다. **config.php 에는 암호·비밀키가 들어가므로 외부에 공개하지 않습니다.**

로그인 방식은 네 가지이고, `'login'` 에서 쓸 것만 `true` 로 켭니다. 켠 방식만 로그인 화면에 나옵니다.

| 방식 | 준비할 것 | 설명 |
|---|---|---|
| **아이디 · 암호** (기본) | 없음 | `config.php` 에 아이디와 처음 암호만 적으면 바로 됩니다 |
| 구글 | 구글 클라우드 콘솔에 앱 등록 | 아래 4번 |
| 카카오 | 카카오 개발자 콘솔에 앱 등록 | 아래 4번 |
| 네이버 | 네이버 개발자센터에 앱 등록 | 아래 4번 |

#### 3-1. 아이디 · 암호 (먼저 이것만으로 시작하기를 권함)

```php
'login' => [
    'password' => true,   // 아이디 · 암호
    'google'   => false,
    'kakao'    => false,
    'naver'    => false,
],
'accounts' => [            // 여기 적은 사람만 로그인
    'u1' => [              // 사용자 폴더 이름 → data/users/u1 (영문 소문자·숫자·_-)
        'name'     => '홍길동',      // 화면에 보일 이름
        'login_id' => 'admin',       // 아이디
        'password' => '처음암호',    // 처음 암호 (처음 로그인하면 반드시 새 암호로 바꾸게 됨)
    ],
],
```

- 처음 암호로 로그인하면 **새 암호로 바꾸는 화면**이 뜨고, 바꾸기 전에는 노트를 쓸 수 없습니다.
- 바꾼 암호는 `data/auth/<사용자>.json` 에 해시로만 저장됩니다(`config.php` 는 고치지 않음).
  **암호를 잊으면** 그 파일을 지우면 `config.php` 의 처음 암호로 다시 들어갈 수 있습니다.
- 새 암호 최소 길이: 서버 8자, PC 로컬 모드 4자. 바꾸려면 `config.php` 에 `'password_min' => 6` 방식으로 변경가능.
- 5번 틀리면 10분 동안 막힙니다.
- 사람을 늘리려면 `'u2' => [...]` 처럼 더합니다. 노트는 사람마다 따로 저장됩니다.

#### 3-2. 소셜 로그인을 같이 쓸 때

`'login'` 에서 그 방식을 `true` 로 켜고, 계정에 그 방식의 값을 적습니다. **값을 적은 방식만 그 사람에게 허용**되고,
같은 사용자 폴더(u1)면 아이디·암호·구글·카카오·네이버 어느 것으로 들어와도 같은 노트입니다.

```php
'u1' => [
    'name'     => '홍길동',
    'login_id' => 'admin',
    'password' => '처음암호',
    'google'   => 'you@gmail.com',     // 구글 메일
    'kakao'    => '1234567890',        // 카카오 회원번호 (또는 메일, 아래 카카오 4 참고)
    'naver'    => 'you@naver.com',     // 네이버 메일 (또는 네이버 회원 id)
],
```

### 4. 소셜 로그인 등록 (쓰는 것만)

각 회사 개발자 사이트에 앱을 등록하고 받은 키를 `config.php` 의 `google` / `kakao` / `naver` 에 넣습니다.
돌아올 주소(리디렉션 URI)는 모두 `https://내도메인/○○_callback.php` 입니다.

**구글** — https://console.cloud.google.com/apis/credentials
1. OAuth 클라이언트 ID 만들기 → 웹 애플리케이션
2. 승인된 리디렉션 URI: `https://내도메인/google_callback.php`
3. 받은 클라이언트 ID·보안 비밀번호를 `google` 의 `client_id` · `client_secret` 에
4. OAuth 동의 화면은 "테스트" 로 두고 테스트 사용자에 본인 계정을 넣으면 혼자·가족 정도는 충분
5. 계정에는 구글 메일을 적습니다(`'google' => 'you@gmail.com'`, 여러 개면 배열)

**카카오** — https://developers.kakao.com
1. 내 애플리케이션 → 앱 추가 → 앱 키의 **REST API 키** 를 `kakao` 의 `client_id` 에
2. 카카오 로그인 활성화, Redirect URI `https://내도메인/kakao_callback.php`, 플랫폼 > Web 에 `https://내도메인` 등록
3. 보안 > Client Secret 을 켰을 때만 `client_secret` 에 넣기(안 켰으면 비워 둠)
4. 계정 구분은 **회원번호**(항상 받음) 또는 **이메일**
   - 회원번호를 모르면 한 번 로그인해 보면 "허용 계정이 아닙니다 (카카오 메일 / 회원번호 …)" 로 알려 줍니다. 그 번호를 계정의 `kakao` 에 적습니다.
   - 이메일로 하려면 앱을 비즈 앱으로 전환(개인 개발자도 본인 인증으로 가능) → 동의항목 "카카오계정(이메일)" 필수 → `kakao` 의 `'email' => true`

**네이버** — https://developers.naver.com/apps
1. 애플리케이션 등록 → 사용 API "네이버 로그인", 제공 정보: 이메일·이름
2. 서비스 URL `https://내도메인`, Callback URL `https://내도메인/naver_callback.php`
3. Client ID · Client Secret 을 `naver` 의 `client_id` · `client_secret` 에
4. 검수 전 "개발 중" 상태에서는 멤버 관리에 등록한 네이버 아이디만 로그인됩니다(혼자·가족이 쓰면 그대로 충분)
5. 계정에는 네이버 메일을 적습니다(`'naver' => 'you@naver.com'`)

### 5. 처음 접속

1. `https://내도메인/` 에 접속해 로그인합니다. 아이디·암호면 처음 암호로 들어간 뒤 새 암호로 바꿉니다.
2. 처음 쓰는 사용자에게는 **"알지로 노트 사용법"** 노트(`GUIDE.md`)가 하나 들어갑니다.
3. 에버노트 노트가 있으면 왼쪽 아래 "백업·복원" → 에버노트(.enex) 가져오기.

### 업데이트할 때

- 바뀐 파일만 올리면 됩니다. `data/` 와 `app/config.php` 는 덮어쓰지 않습니다.
- 화면 파일(css·js)은 `public/index.php` 의 `$v` 숫자로 새로 받게 됩니다.
- 많은 노트를 한 번에 가져올 때는 명령창 도구도 있습니다:
  `php app/tools/import_enex.php u1 D:/evernote_export` (README 참고)

---

## B. PC 로컬 모드 (서버 없이)

PHP 내장 서버를 창 없이 띄우고 앱 창으로 엽니다. 앱 창을 모두 닫으면 PHP 도 꺼집니다.

### 내려받아 쓰기

1. [Releases](https://github.com/rgronet/rgro-note/releases/latest) 에서 **로컬 모드 zip**(`rgro-note-local-….zip`)을 받아 원하는 곳(예: `D:\알지로노트`)에 풉니다.
   PHP·실행 파일·노트 프로그램이 다 들어 있어 따로 설치할 것이 없습니다.
2. `RgroNote.exe` 를 실행합니다. 바탕화면·작업 표시줄에 바로 가기를 만들어 두면 편합니다.
3. 처음 실행하면 먼저 노트 폴더(`data\`)에 쓸 수 있는지 확인하고, **아이디와 암호를 정하는 창**이 뜹니다.
   - 아이디: 영문·숫자·`._-` 2~30자 (윈도우 사용자 이름이 미리 채워짐), 암호: 4자 이상
   - 여기서 정한 아이디·암호로 로그인합니다. 암호는 `data\auth\u1.json` 에 해시로만 저장됩니다(설정 파일에는 안 적힘).
   - **암호를 잊으면** `data\auth\u1.json` 을 지우고 `RgroNote.exe` 를 실행하면 새 암호를 정하는 창이 뜹니다(노트는 그대로).
   - 노트 폴더에 쓸 수 없으면(예: `C:\Program Files` 안에 둠) 알려 주고 멈춥니다. 폴더를 다른 곳으로 옮기거나 `note.ini` 에 `data=` 를 적습니다.
4. 노트는 폴더 안 `data\` 에 저장됩니다. 폴더를 통째로 옮기면 노트도 같이 옮겨집니다.

- "Visual C++ 재배포 패키지가 없습니다" 창이 뜨면 [예]를 눌러 설치한 뒤 다시 실행합니다.
- 포트(기본 8765)는 `note.ini` 의 `port=` 로 바꿉니다. 쓰이고 있으면 다음 번호를 씁니다.
- 오류 기록: `%LOCALAPPDATA%\RgroNote\php-local.log`
- 서버의 노트와는 따로입니다. 주고받을 때는 "백업·복원" 의 zip 을 씁니다.

### note.ini (exe 옆, 모두 생략 가능)

```
mode=local                 # 로컬 모드
php=C:\php\php.exe         # 생략: exe 옆 php\php.exe → PATH 의 php.exe
root=D:\알지로노트         # 노트 프로그램 폴더. 생략: exe 폴더부터 위로 찾음
port=8765
config=...\config.local.php
data=D:\내노트              # 새 설정을 만들 때만 씀
```

메모장 기본 저장. 자세한 것은 [Releases](https://github.com/rgronet/rgro-note/releases/latest) 의 `note.ini.sample`.

---

## C. PC 프로그램 + 서버

- [Releases](https://github.com/rgronet/rgro-note/releases/latest) 에서 `RgroNote.exe` 만 받으면 됩니다(설치 없음).
- 열 주소는 exe 옆 `note.ini` 에 `url=https://내도메인/` 한 줄로 정합니다. 서버 모드(`mode=local` 이 아닐 때)는 꼭 적어야 하며, 없으면 적는 법을 알려 주고 메모장으로 `note.ini` 를 열어 줍니다.
- 이 앱 전용 브라우저 프로필(`%LOCALAPPDATA%\RgroNote`)을 써서 평소 브라우저와 섞이지 않습니다.
- 새로 만든 exe 는 백신이 처음에 막을 수 있습니다. 그럴 때는 백신에서 허용합니다.

## 휴대폰 앱

- 안드로이드 크롬에서 사이트를 열고 ⋮ → **앱 설치**(또는 홈 화면에 추가). 아이폰은 사파리 공유 → 홈 화면에 추가.
- 앱 이름·아이콘을 바꾼 뒤에는 홈 화면 앱을 지우고 다시 설치해야 바로 반영됩니다.

---
만든 곳: 알지로넷 https://rgro.net
