// ============================================================
// ⚙️ 환경설정 — 배포 환경/팀마다 달라질 수 있는 값만 모아둠
// ============================================================

const firebaseConfig = {
    apiKey: "AIzaSyBJ9CRer5FEjA1_yZ5g1jBypaX_3Cpqqyo",
    authDomain: "hunterquest-fbdee.firebaseapp.com",
    databaseURL: "https://hunterquest-fbdee-default-rtdb.firebaseio.com",
    projectId: "hunterquest-fbdee",
    storageBucket: "hunterquest-fbdee.firebasestorage.app",
    messagingSenderId: "999017602063",
    appId: "1:999017602063:web:711b798bb7405ddbfe577a",
    measurementId: "G-13WEG56NZR"
};

// 비밀번호는 평문 대신 SHA-256 해시로 저장 (소스 열람 시 즉시 노출 방지)
// 비밀번호 변경 시: 브라우저 콘솔에서 `await getHash('새비밀번호')` 실행 후 결과값으로 교체
const ADMIN_PW_HASH = '158a323a7ba44870f23d96f1516dd70aa48e9a72db4ebb026b0a89e212a208ab';
const DEFAULT_SITE_PW_HASH = '158a323a7ba44870f23d96f1516dd70aa48e9a72db4ebb026b0a89e212a208ab'; // 관리 페이지에서 변경 가능
