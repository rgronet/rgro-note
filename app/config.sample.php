<?php
// 알지로 노트 설정 예시. 이 파일을 config.php 로 복사해서 값을 채운다.
// config.php 는 웹루트(public) 밖에 있으므로 브라우저로 열리지 않는다.

return [
    'app_name' => '알지로 노트',

    // 노트 데이터 폴더 (웹루트 밖). 기본값: 노트 프로그램 폴더/data (app 폴더 옆)
    'data_dir' => dirname(__DIR__) . '/data',

    'timezone'     => 'Asia/Seoul',
    'session_days' => 30,     // 로그인 유지 기간(일)
    'upload_max_mb' => 20,    // 첨부 1개 최대 크기

    // ---------- 로그인 방식: 쓸 것만 true (체크) ----------
    // 꺼진 방식은 로그인 화면에 버튼이 안 나오고, 그 방식으로 이미 들어온 사람도 바로 막힌다.
    //   처음에는 아이디·암호만으로 시작하고, 소셜 로그인은 아래 키를 넣은 뒤 켜는 것을 권한다.
    'login' => [
        'password' => true,    // 아이디 · 암호 (따로 등록할 것 없음)
        'google'   => false,   // 구글
        'kakao'    => false,   // 카카오
        'naver'    => false,   // 네이버
    ],

    // ---------- 허용 계정 (미리 적은 사람만 로그인) ----------
    // '사용자 폴더 이름'(영문 소문자·숫자·_-) => 이 사람이 쓸 수 있는 방식의 값. 비워 두거나 빼면 그 방식은 이 사람에게 안 됨.
    // 폴더는 data/users/<이름> 으로 따로 만들어진다. 같은 폴더면 어느 방식으로 들어와도 같은 노트.
    'accounts' => [
        'u1' => [
            'name'     => '홍길동',            // 화면에 보일 이름
            // 아이디·암호: password 는 "처음 암호". 이 암호로 들어오면 무조건 새 암호로 바꾸는 화면이 뜬다.
            //   바꾼 암호는 data/auth/u1.json 에 해시로만 저장된다. 잊으면 그 파일을 지우면 다시 처음 암호로 들어감.
            'login_id' => 'admin',
            'password' => '처음암호1234',
            // 소셜 로그인: 쓰는 방식만 적는다(비우면 그 방식은 이 사람에게 안 됨)
            'google'   => 'you@gmail.com',     // 구글 메일 (여러 개면 ['a@gmail.com', 'b@gmail.com'])
            'kakao'    => '1234567890',        // 카카오 회원번호 또는 메일(아래 kakao email 을 켠 경우)
            'naver'    => 'you@naver.com',     // 네이버 메일 또는 네이버 회원 id
        ],
    ],
    // 예전 형식(구글 메일 => 폴더)도 그대로 된다:  'users' => ['you@gmail.com' => 'u1'],

    // 구글 OAuth: https://console.cloud.google.com/apis/credentials
    //   "OAuth 클라이언트 ID" > 웹 애플리케이션. 승인된 리디렉션 URI 에 redirect_uri 를 똑같이 등록.
    'google' => [
        'client_id'     => '',
        'client_secret' => '',
        'redirect_uri'  => 'https://note.example.com/google_callback.php',   // note.example.com 을 내 도메인으로
    ],

    // 카카오 로그인: https://developers.kakao.com  > 내 애플리케이션 > 앱 키의 "REST API 키" = client_id
    //   카카오 로그인 활성화, Redirect URI = 아래 redirect_uri, 플랫폼 > Web 사이트 도메인 등록
    //   보안 > Client Secret 을 켰으면 client_secret 에 넣는다(안 켰으면 비워 둠).
    //   계정 구분: 회원번호(항상 받음) 또는 이메일.
    //   이메일로 구분하려면 앱을 "비즈 앱"으로 바꾸고(개인 개발자도 본인 인증으로 가능),
    //   카카오 로그인 > 동의항목 > "카카오계정(이메일)" 을 필수 동의로 켠 뒤 아래 email 을 true 로.
    //   (인증된 이메일만 인정. 모를 때는 한 번 로그인해 보면 "허용 계정이 아닙니다 (카카오 메일 / 회원번호 …)" 로 알려 줌)
    'kakao' => [
        'client_id'     => '',
        'client_secret' => '',
        'redirect_uri'  => 'https://note.example.com/kakao_callback.php',
        'email'         => false,   // true: 로그인 때 이메일 동의를 요청 (위 동의항목을 켠 경우만. 안 켰는데 true 면 카카오가 오류를 냄)
    ],

    // 네이버 로그인: https://developers.naver.com/apps  > 애플리케이션 등록 > 사용 API "네이버 로그인"
    //   제공 정보: 이메일(필수)·이름. 서비스 URL = https://note.example.com(내 도메인), Callback URL = 아래 redirect_uri
    //   (검수 전 "개발 중" 상태에서는 멤버 관리에 등록한 네이버 아이디만 로그인됨 → 혼자 쓰면 그대로 충분)
    'naver' => [
        'client_id'     => '',
        'client_secret' => '',
        'redirect_uri'  => 'https://note.example.com/naver_callback.php',
    ],

    // 개발용: true 이고 접속 주소가 127.0.0.1/::1 일 때만 로그인 화면에 "개발용 로그인"(첫 번째 계정)이 나온다.
    // 실제 서버에서는 반드시 false.
    // 새 암호 최소 길이 (생략: 서버 8, 로컬 모드 4)
    // 'password_min' => 8,

    'dev_login' => false,
];
