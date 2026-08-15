// ============================================================
// ⚙️ 환경설정 — 배포 환경/팀마다 달라질 수 있는 값만 모아둠
// (나중에 동맹팀별로 이 파일만 교체하는 구조로 확장 가능)
// ============================================================

    export const CONSTANTS = {
        VERSION: "4.5.1",
        MAX_ACTIVE_SLOTS: 3,
        LOG_DISPLAY_COUNT: 100,
        AUTO_FINISH_HOURS: 24,          // 퀘스트 시작 후 이 시간이 지나면 자동 종료(완료 처리)
        SITE_PASSWORD_HASH: "170448",   
        RESET_PASSWORD_HASH: "18653f",  
        EDIT_PASSWORD_HASH: "1ac23e"    
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
