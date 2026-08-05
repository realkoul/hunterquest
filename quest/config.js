// ============================================================
// ⚙️ 환경설정 — 배포 환경/팀마다 달라질 수 있는 값만 모아둠
// (나중에 동맹팀별로 이 파일만 교체하는 구조로 확장 가능)
// ============================================================

// ⚠️ 중요: 아래 3개 값은 아직 예전 방식(약한 자체 해시)의 결과값입니다.
// app.js가 이제 SHA-256(64자리 16진수)을 기대하도록 바뀌어서, 교체 전까지는
// 기존 비밀번호로 로그인/관리자 기능이 전부 실패합니다.
//
// 교체 방법 (배포 전 반드시 진행):
// 1. 아무 웹페이지에서나 개발자도구(F12) → Console 탭 열기
// 2. 아래 코드를 실행 (따옴표 안을 실제 비밀번호로 교체):
//      crypto.subtle.digest('SHA-256', new TextEncoder().encode('실제비밀번호'))
//        .then(b => console.log(Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2,'0')).join('')))
// 3. 출력된 64자리 값을 아래 SITE_PASSWORD_HASH 자리에 붙여넣기
// 4. EDIT_PASSWORD_HASH(관리자), RESET_PASSWORD_HASH(초기화)도 각각 동일하게 반복
//
// (기존 비밀번호 자체는 이 파일 어디에도 평문으로 남아있지 않았기 때문에,
//  실제 비밀번호를 알고 계신 분이 직접 새 해시를 계산해서 넣어야 합니다.)
    export const CONSTANTS = {
        VERSION: "4.5.1",
        MAX_ACTIVE_SLOTS: 3,
        LOG_DISPLAY_COUNT: 100,
        SITE_PASSWORD_HASH: "REPLACE_ME_SHA256",
        RESET_PASSWORD_HASH: "REPLACE_ME_SHA256",
        EDIT_PASSWORD_HASH: "REPLACE_ME_SHA256"
    };

    export const firebaseConfig = {
        apiKey: "AIzaSyBJ9CRer5FEjA1_yZ5g1jBypaX_3Cpqqyo",
        authDomain: "hunterquest-fbdee.firebaseapp.com",
        databaseURL: "https://hunterquest-fbdee-default-rtdb.firebaseio.com",
        projectId: "hunterquest-fbdee",
        storageBucket: "hunterquest-fbdee.firebasestorage.app",
        messagingSenderId: "999017602063",
        appId: "1:999017602063:web:711b798bb7405ddbfe577a",
        measurementId: "G-13WEG56NZR"
    };
