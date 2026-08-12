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

// 우리 팀 이름 (오만타워 담당자 색상 인식 결과와 비교해서 "우리팀/타팀" 표시에 사용)
const OUR_TEAM_NAME = '정훈';

// 비밀번호는 평문 대신 SHA-256 해시로 저장 (소스 열람 시 즉시 노출 방지)
// 비밀번호 변경 시: 브라우저 콘솔에서 `await getHash('새비밀번호')` 실행 후 결과값으로 교체
const ADMIN_PW_HASH = '8cc60874ca4956002e8dd407ac7ea3349600cc8f694c30d8109e1c237e0e5ad0';
const DEFAULT_SITE_PW_HASH = 'b280279a0ef279d0b9f0bdc4162591dbbc6312abac67120527b20d65c7de5dbf'; // 관리 페이지에서 변경 가능
