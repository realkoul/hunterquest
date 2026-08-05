// ============================================================
// 에카 작위 퀘스트 - 애플리케이션 로직
// ============================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-app.js";
import { getDatabase, ref, set, onValue, runTransaction, query, orderByKey, limitToLast } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-database.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-auth.js";
import { CONSTANTS, firebaseConfig } from "./config.js";

    // 🔒 비밀번호 암호화 함수 (SHA-256, 브라우저 표준 crypto API 사용)
    const getHash = async (str) => {
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
        return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    };

    // 🚨 XSS 방지: HTML 특수문자 이스케이프
    const escapeHtml = (str) => {
        if (!str) return '';
        return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    };

    // 🚨 비밀번호가 해시값으로 변경되어 소스코드 노출 방지

    // 멀티서버: 현재 선택된 서버
    let currentServer = localStorage.getItem('currentServer') || "1";


    const getValidUsers = (users) => {
        if (!users) return [];
        return Array.isArray(users) ? users.filter(u => u && u.id) : Object.values(users).filter(u => u && u.id);
    };

    const generateUniqueId = (existingUsers) => {
        if (existingUsers.length === 0) return 1;
        return Math.max(...existingUsers.map(u => u.id || 0)) + 1;
    };

    /**
     * 멀티서버: 사용자의 특정 서버 데이터 가져오기
     */
    const getUserServerData = (user, serverNum) => {
        if (!user.servers) user.servers = {};
        if (!user.servers[serverNum]) {
            user.servers[serverNum] = {
                status: "idle",
                role: "",
                startTime: null,
                waitingTime: null,
                isYielded: false,
                yieldOrder: 0
            };
        }
        return user.servers[serverNum];
    };

    /**
     * 멀티서버: 서버별 가상 사용자 목록 생성
     */
    const getServerUsers = (users, serverNum) => {
        return users.map(user => {
            const serverData = getUserServerData(user, serverNum);
            return {
                id: user.id,
                name: user.name,
                completedCount: user.completedCount || 0,
                status: serverData.status,
                role: serverData.role,
                startTime: serverData.startTime,
                waitingTime: serverData.waitingTime,
                isYielded: serverData.isYielded,
                yieldOrder: serverData.yieldOrder,
                // 원본 참조 유지 (저장 시 필요)
                _originalUser: user,
                _serverNum: serverNum
            };
        });
    };

    const sortWaitingUsers = (users) => {
        const roles = ['테이너', '퍼포', '하이드'];
        let finalResult = [];

        roles.forEach(role => {
            const roleUsers = users.filter(u => u.role === role);
            
            const baseSorted = [...roleUsers].sort((a, b) => {
                if (a.completedCount !== b.completedCount) return a.completedCount - b.completedCount;
                return (a.waitingTime || 0) - (b.waitingTime || 0);
            });

            const activeFront = baseSorted.find(u => !u.isYielded);

            const sortedRoleUsers = baseSorted.sort((a, b) => {
                const getGroup = (u) => {
                    if (activeFront && u.id === activeFront.id) return 0; // 0그룹 = 활성 1순위
                    if (u.isYielded) return 1; // 1그룹 = 양보 대기열
                    return 2; // 2그룹 = 일반 대기열
                };

                const groupA = getGroup(a);
                const groupB = getGroup(b);

                if (groupA !== groupB) return groupA - groupB;

                if (a.completedCount !== b.completedCount) return a.completedCount - b.completedCount;
                return (a.waitingTime || 0) - (b.waitingTime || 0);
            });

            finalResult = finalResult.concat(sortedRoleUsers);
        });

        const noRoleUsers = users.filter(u => !roles.includes(u.role));
        return finalResult.concat(noRoleUsers);
    };

    const getRoleBadge = (role) => {
        if (!role) return '';
        let className = 'role-all';
        if (role === '테이너') className = 'role-tainer';
        else if (role === '하이드') className = 'role-hide';
        else if (role === '퍼포') className = 'role-perfo';
        return `<span class="role-badge ${className}">${role}</span>`;
    };

    const isTimestamp = (val) => {
        if (typeof val === 'number') return true;
        if (typeof val === 'string' && /^\d{10,}$/.test(val)) return true;
        return false;
    };

    const formatStartTime = (startTime) => {
        if (!startTime) return '-';
        if (isTimestamp(startTime)) {
            const d = new Date(Number(startTime));
            return d.toLocaleTimeString('ko-KR', { hour12: false, timeZone: 'Asia/Seoul' });
        }
        return startTime; 
    };

    const getElapsedTime = (startTime) => {
        if (!startTime) return '';
        try {
            let diffMs;
            if (isTimestamp(startTime)) {
                diffMs = Date.now() - Number(startTime);
            } else {
                const match = startTime.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
                if (!match) return '';
                const now = new Date();
                const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
                let startDateTime = new Date(`${today}T${startTime}`);
                if (isNaN(startDateTime.getTime())) return '';
                if (startDateTime > now) startDateTime.setDate(startDateTime.getDate() - 1);
                diffMs = now - startDateTime;
            }
            const diffMinutes = Math.floor(diffMs / 60000);
            if (diffMinutes < 1) return '방금 시작';
            else if (diffMinutes < 60) return `${diffMinutes}분 경과`;
            else return `${Math.floor(diffMinutes / 60)}시간 ${diffMinutes % 60}분 경과`;
        } catch (error) {
            return '';
        }
    };

    // 🔒 로그인 입력값을 SHA-256 해시로 변환하여 비교
    window.checkPassword = async () => {
        const input = document.getElementById('password-input').value;
        const errorMsg = document.getElementById('password-error');
        if (await getHash(input) === CONSTANTS.SITE_PASSWORD_HASH) {
            // 비밀번호 성공 → 서버 선택 화면으로
            document.getElementById('lock-screen').style.display = 'none';
            document.getElementById('server-selection-screen').style.display = 'flex';
            document.getElementById('loading-cover').style.display = 'flex';
            
            // Firebase 시작 (데이터만 로드, 화면은 안 보임)
            startFirebase(); 
        } else {
            errorMsg.style.display = 'block';
            document.getElementById('password-input').value = '';
            document.getElementById('password-input').focus();
        }
    };

    // 서버 선택
    window.selectServer = (serverNum) => {
        currentServer = serverNum;
        localStorage.setItem('currentServer', serverNum);
        
        // 서버 선택 화면 숨기고 메인 화면 표시
        document.getElementById('server-selection-screen').style.display = 'none';
        document.getElementById('main-container').style.display = 'block';
        
        // 현재 서버 정보 업데이트
        updateCurrentServerDisplay();
        
        // 화면 렌더링
        render();
    };

    // 서버 변경 버튼 클릭
    window.showServerSelection = () => {
        document.getElementById('main-container').style.display = 'none';
        document.getElementById('server-selection-screen').style.display = 'flex';
        updateServerSelectionInfo();
    };

    // 현재 서버 표시 업데이트
    function updateCurrentServerDisplay() {
        const serverInfo = {
            '1': { 
                name: '진기르',
                color: 'linear-gradient(135deg, #3498db 0%, #2980b9 100%)' // 파란색
            },
            '2': { 
                name: '판도라',
                color: 'linear-gradient(135deg, #9b59b6 0%, #8e44ad 100%)' // 보라색
            }
        };
        
        const info = serverInfo[currentServer] || { 
            name: currentServer + '번 서버',
            color: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)'
        };
        
        document.getElementById('current-server-name').textContent = info.name;
        
        // 서버별 배경 색상 변경
        const serverBox = document.getElementById('current-server-box');
        if (serverBox) {
            serverBox.style.background = info.color;
        }
        
        // 제목에도 서버 이름 표시
        document.getElementById('server-title').textContent = info.name;
        document.getElementById('server-queue-title').textContent = info.name;
        
        // 참여 인원 업데이트
        updateCurrentServerCount();
    }

    // 현재 서버 인원 수 업데이트
    function updateCurrentServerCount() {
        const users = getValidUsers(window.users);
        let count = 0;
        
        users.forEach(user => {
            const serverData = getUserServerData(user, currentServer);
            if (serverData.status === 'waiting' || serverData.status === 'active') {
                count++;
            }
        });
        
        document.getElementById('current-server-count').textContent = `${count}명`;
    }

    // 서버 선택 화면 정보 업데이트
    function updateServerSelectionInfo() {
        const users = getValidUsers(window.users);
        
        for (let i = 1; i <= 2; i++) {
            const serverNum = String(i);
            let count = 0;
            
            users.forEach(user => {
                const serverData = getUserServerData(user, serverNum);
                if (serverData.status === 'waiting' || serverData.status === 'active') {
                    count++;
                }
            });
            
            const elem = document.getElementById(`server-${i}-info`);
            if (elem) {
                elem.textContent = `${count}명 참여 중`;
            }
        }
    }

    async function startFirebase() {
        const app = initializeApp(firebaseConfig);
        const db = getDatabase(app);
        const auth = getAuth(app);

        // 🔒 익명 인증: DB 보안 규칙의 auth != null 조건을 만족시키기 위함.
        // 앱 화면/사용자 경험에는 아무 변화 없음.
        try {
            await signInAnonymously(auth);
        } catch (err) {
            console.error('Firebase 인증 실패:', err);
            alert('서버 연결에 실패했습니다. 새로고침 후 다시 시도해주세요.');
            return;
        }
        
        const dbRef = ref(db, 'eka_quest_users_2');
        window.changeLogRef = ref(db, 'eka_change_logs_2');

        window.users = [];
        window.MAX_ACTIVE = CONSTANTS.MAX_ACTIVE_SLOTS;
        window.targetUserId = null;
        let logCounter = 0;
        
        window.logChange = (userId, userName, field, oldValue, newValue, changedBy = '시스템') => {
            const timestamp = new Date().toLocaleString('ko-KR', { hour12: false, timeZone: 'Asia/Seoul' });
            const logEntry = { timestamp, userId, userName, field, oldValue: String(oldValue), newValue: String(newValue), changedBy };
            const uniqueKey = Date.now() + '_' + (logCounter++);
            set(ref(db, 'eka_change_logs_2/' + uniqueKey), logEntry).catch(e => console.error('로그 저장 실패:', e));
        };

        onValue(dbRef, (snapshot) => {
            const data = snapshot.val();
            window.users = data ? getValidUsers(data) : [];
            
            // 서버 선택 화면 정보 업데이트 (데이터만)
            updateServerSelectionInfo();
            
            // 이미 서버를 선택한 경우에만 render
            if (document.getElementById('main-container').style.display === 'block') {
                render();
            }
            
            document.getElementById('loading-cover').style.display = 'none';
        }, (error) => {
            alert('서버 연결 실패:\n' + error.message);
            document.getElementById('loading-cover').style.display = 'none';
        });

        window.saveData = (updateFunction) => {
            return runTransaction(dbRef, (currentData) => {
                let data = currentData ? getValidUsers(currentData) : [];
                if (updateFunction) data = updateFunction(data);
                // ✅ NaN 방어: Firebase 저장 전 completedCount 항상 검증
                data = data.map(user => ({
                    ...user,
                    completedCount: (isNaN(user.completedCount) || user.completedCount == null)
                        ? 0
                        : parseInt(user.completedCount, 10)
                }));
                return data; 
            }).catch((err) => {
                alert('저장 오류: ' + err.message);
                throw err;
            });
        };
        
        setInterval(() => {
            const elapsedElements = document.querySelectorAll('.elapsed-time-display');
            elapsedElements.forEach(el => {
                const startTime = el.getAttribute('data-start-time');
                if (startTime) {
                    const elapsedText = getElapsedTime(startTime);
                    el.innerHTML = elapsedText ? `⏱️ ${elapsedText}` : '';
                }
            });
        }, 1000);
    }

    /**
     * 멀티서버: 서버 전환
     */
    window.switchServer = (serverNum) => {
        currentServer = serverNum;
        localStorage.setItem('currentServer', serverNum);
        
        // 버튼 활성화 상태 업데이트
        document.querySelectorAll('.server-btn').forEach(btn => {
            if (btn.dataset.server === serverNum) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });
        
        // 제목 업데이트
        document.getElementById('server-title').textContent = `${serverNum}번 서버`;
        document.getElementById('server-queue-title').textContent = `${serverNum}번 서버`;
        document.getElementById('current-server-label').textContent = `${serverNum}번 서버`;
        
        // 화면 다시 렌더링
        render();
    };

    /**
     * 멀티서버: 서버별 인원 수 업데이트
     */
    function updateServerCounts() {
        const users = getValidUsers(window.users);
        
        for (let i = 1; i <= 4; i++) {
            const serverNum = String(i);
            let count = 0;
            
            users.forEach(user => {
                const serverData = getUserServerData(user, serverNum);
                if (serverData.status === 'waiting' || serverData.status === 'active') {
                    count++;
                }
            });
            
            const elem = document.getElementById(`server-${i}-count`);
            if (elem) {
                elem.textContent = `${count}명`;
            }
        }
    }

    function render() {
        const users = getValidUsers(window.users);
        
        // 멀티서버: 현재 서버의 가상 사용자 목록 생성
        const serverUsers = getServerUsers(users, currentServer);
        
        const waitingUsers = sortWaitingUsers(serverUsers.filter(u => u.status === 'waiting'));
        
        // 진행 중인 사용자를 역할 순서대로 정렬: 테이너 → 퍼포 → 하이드
        const activeUsers = serverUsers.filter(u => u.status === 'active').sort((a, b) => {
            const roleOrder = { '테이너': 1, '퍼포': 2, '하이드': 3 };
            return (roleOrder[a.role] || 999) - (roleOrder[b.role] || 999);
        });
        
        const currentRoles = activeUsers.map(u => u.role);

        document.getElementById('total-cnt').innerText = users.length;
        document.getElementById('waiting-cnt').innerText = waitingUsers.length;
        document.getElementById('active-cnt').innerText = activeUsers.length;

        renderActiveSlots(activeUsers);
        renderQueueColumns(waitingUsers, currentRoles, activeUsers.length);
        renderParticipantTable(serverUsers);
        
        // 멀티서버: 서버 정보 업데이트
        updateCurrentServerDisplay();
        updateServerSelectionInfo();
    }
    
    function renderActiveSlots(activeUsers) {
        const slotsDiv = document.getElementById('slots-container');
        slotsDiv.innerHTML = '';
        
        for (let i = 0; i < CONSTANTS.MAX_ACTIVE_SLOTS; i++) {
            const user = activeUsers[i];
            const div = document.createElement('div');
            
            if (user) {
                const elapsedTime = getElapsedTime(user.startTime);
                const displayTime = formatStartTime(user.startTime);
                const elapsedHTML = `<br><span class="elapsed-time-display" data-start-time="${user.startTime}" style="color:#e67e22; font-weight:bold; font-size:0.9rem;">${elapsedTime ? '⏱️ ' + elapsedTime : ''}</span>`;
                
                div.className = 'slot active';
                div.innerHTML = `
                    <div>
                        <span class="info-badge bg-green">${user.completedCount}회 완료</span>
                        <h3 style="margin:10px 0;">${getRoleBadge(user.role)} ${escapeHtml(user.name)}</h3>
                        <small style="color:#888">${displayTime} 시작${elapsedHTML}</small>
                    </div>
                    <button class="btn-action btn-end" onclick="finishWork(${user.id})">종료 (횟수 +1)</button>
                `;
            } else {
                div.className = 'slot empty';
                div.innerHTML = `<h3>빈 슬롯 ${i + 1}</h3><div style="font-size:0.9rem;">입장 대기 중...</div>`;
            }
            slotsDiv.appendChild(div);
        }
    }

    function renderQueueColumns(waitingUsers, currentRoles, activeCount) {
        const listTainer = document.getElementById('queue-list-tainer');
        const listHide = document.getElementById('queue-list-hide');
        const listPerfo = document.getElementById('queue-list-perfo');
        
        listTainer.innerHTML = ''; listHide.innerHTML = ''; listPerfo.innerHTML = '';
        
        const hasEmptySlot = activeCount < CONSTANTS.MAX_ACTIVE_SLOTS;
        const queuedRoles = new Set(); 
        const roleRanks = { '테이너': 0, '하이드': 0, '퍼포': 0 };

        waitingUsers.forEach((u) => {
            if (!u.role) return;
            
            roleRanks[u.role]++;
            const localRank = roleRanks[u.role];
            
            const card = document.createElement('div');
            card.className = 'queue-card';
            
            const isBlockedByActive = currentRoles.includes(u.role);
            const isBlockedByQueue = queuedRoles.has(u.role);
            queuedRoles.add(u.role);

            const canEnter = hasEmptySlot && !isBlockedByActive && !isBlockedByQueue;

            let mainBtn = '';
            if (!hasEmptySlot) {
                mainBtn = `<button disabled class="btn-common-style btn-disabled-card">슬롯 꽉참</button>`;
            } else if (isBlockedByActive) {
                mainBtn = `<button disabled class="btn-common-style btn-disabled-card" style="color:#e74c3c;">⛔ 진행 중</button>`;
            } else if (isBlockedByQueue) {
                mainBtn = `<button disabled class="btn-common-style btn-blocked-queue">✋ 대기 중</button>`;
            } else {
                mainBtn = `<button class="btn-common-style btn-enter" onclick="startWork(${u.id})">입장 하기</button>`;
            }

            let swapBtn = '';
            const sameRoleWaiting = waitingUsers.filter(user => user.role === u.role);
            const isFirstInRole = sameRoleWaiting.length > 0 && sameRoleWaiting[0].id === u.id;
            
            // Bug 4 fix: canEnter 조건 제거 → 1순위이면 역할 진행 중에도 미리 양보 가능 (단, 혼자면 비활성화)
            if (isFirstInRole && sameRoleWaiting.length > 1) {
                swapBtn = `<button class="btn-common-style btn-swap" onclick="window.yieldTurn(${u.id})">▼ 양보</button>`;
            } else {
                swapBtn = `<button class="btn-common-style btn-swap" disabled style="opacity:0.5; cursor:not-allowed;">▼ 양보</button>`;
            }

            let buttonHtml = `<div class="btn-group">${mainBtn}${swapBtn}</div>`;
            
            let nameHtml = `<h4 style="margin:0;">${escapeHtml(u.name)}</h4>`;
            if (u.isYielded) {
                nameHtml = `
                    <div style="display:flex; align-items:center;">
                        <h4 style="margin:0; color:#8e44ad;">${escapeHtml(u.name)}</h4>
                        <span style="background:#8e44ad; color:white; padding:2px 5px; border-radius:4px; font-size:0.7rem; margin-left:5px;">양보 중</span>
                    </div>`;
            }
            
            card.innerHTML = `
                <div class="queue-header">
                    <div style="display:flex; align-items:center; gap:8px;">
                        <div class="queue-rank">${localRank}</div>
                        <div>
                            ${nameHtml}
                            <small style="color:#888;">완료 ${u.completedCount}회</small>
                        </div>
                    </div>
                </div>
                <div style="margin-top:5px;">
                    ${buttonHtml}
                    <button class="btn-cancel-queue" onclick="window.cancelWaitingWithConfirm(${u.id})">대기 취소</button>
                </div>
            `;
            
            if (u.role === '테이너') listTainer.appendChild(card);
            else if (u.role === '하이드') listHide.appendChild(card);
            else if (u.role === '퍼포') listPerfo.appendChild(card);
        });
        
        if (roleRanks['테이너'] === 0) listTainer.innerHTML = '<div style="color:#aaa; text-align:center; padding:20px 0;">대기자 없음</div>';
        if (roleRanks['하이드'] === 0) listHide.innerHTML = '<div style="color:#aaa; text-align:center; padding:20px 0;">대기자 없음</div>';
        if (roleRanks['퍼포'] === 0) listPerfo.innerHTML = '<div style="color:#aaa; text-align:center; padding:20px 0;">대기자 없음</div>';
    }

    function renderParticipantTable(users) {
        const tbody = document.getElementById('participant-table');
        tbody.innerHTML = '';

        // ⭐ 내 이름 목록 가져오기
        const myNames = getMyNamesQuest();
        const myNamesSet = new Set(myNames);

        // 내 이름 → 맨 위, 그 다음 완료횟수 있는 사람, 나머지 순
        const allUsers = [...users].sort((a, b) => {
            const aIsMine = myNamesSet.has(a.name);
            const bIsMine = myNamesSet.has(b.name);
            if (aIsMine && !bIsMine) return -1;
            if (!aIsMine && bIsMine) return 1;
            // 둘 다 내 이름이면 등록 순서 유지
            if (aIsMine && bIsMine) return myNames.indexOf(a.name) - myNames.indexOf(b.name);
            // 나머지: 완료횟수 있는 사람 우선, 그 다음 id 순
            const aHasCompleted = a.completedCount > 0 ? 0 : 1;
            const bHasCompleted = b.completedCount > 0 ? 0 : 1;
            if (aHasCompleted !== bHasCompleted) return aHasCompleted - bHasCompleted;
            return a.id - b.id;
        });

        allUsers.forEach(u => {
            const tr = document.createElement('tr');
            const isMyName = myNamesSet.has(u.name);
            if (isMyName) tr.classList.add('my-name-row');

            let statusHtml = '', actionBtn = '';

            if (u.status === 'idle') {
                statusHtml = '<span class="st-badge st-idle">미등록</span>';
                actionBtn = `<button class="btn-apply" onclick="openRoleModal(${u.id})">대기 신청</button>`;
            } else if (u.status === 'waiting') {
                statusHtml = `${getRoleBadge(u.role)} <span class="st-badge st-waiting">대기 중</span>`;
                actionBtn = `<button class="btn-cancel" onclick="cancelWaiting(${u.id})">신청 취소</button>`;
            } else if (u.status === 'active') {
                statusHtml = `${getRoleBadge(u.role)} <span class="st-badge st-active">진행 중</span>`;
                actionBtn = '-';
            }

            const rowOpacity = (!isMyName && u.completedCount === 0) ? 'opacity: 0.6;' : '';
            const myBadge = isMyName ? ' <span style="background:#ffc107;color:#333;padding:1px 6px;border-radius:4px;font-size:0.75rem;font-weight:bold;">⭐ 나</span>' : '';

            tr.innerHTML = `
                <td style="${rowOpacity}">${u.id}</td>
                <td style="${rowOpacity}"><input type="text" class="edit-name" value="${escapeHtml(u.name)}" onchange="window.updateName(${u.id}, this.value)">${myBadge}</td>
                <td style="${rowOpacity}">
                    <input type="number" class="edit-count" value="${u.completedCount}" onchange="window.updateCompletedCount(${u.id}, this.value, this)">
                </td>
                <td style="${rowOpacity}">${statusHtml}</td>
                <td style="font-size:0.85rem; color:#666; ${rowOpacity}">${formatStartTime(u.startTime)}</td>
                <td>
                    ${actionBtn}
                    <button class="btn-delete" onclick="window.deleteUser(${u.id})">삭제</button>
                </td>
            `;
            tbody.appendChild(tr);
        });
    }

    // 🔒 관리자 비밀번호 검사부 SHA-256 해시값 비교 적용 1
    window.updateCompletedCount = async (id, newVal, inputEl) => {
        const validUsers = getValidUsers(window.users);
        const user = validUsers.find(u => u.id === id);
        if (!user || user.completedCount == newVal) return;

        const originalVal = user.completedCount;
        const parsedVal = parseInt(newVal);

        if (isNaN(parsedVal) || parsedVal < 0) {
            alert("올바른 숫자를 입력하세요.");
            inputEl.value = originalVal; return;
        }

        if (await getHash(prompt("관리자 비밀번호를 입력하세요:") || "") === CONSTANTS.EDIT_PASSWORD_HASH) {
            window.saveData((currentData) => {
                const validData = getValidUsers(currentData);
                const currentUser = validData.find(u => u.id === id);
                if (currentUser) {
                    window.logChange(id, user.name, 'completedCount', currentUser.completedCount, parsedVal, '관리자 직접 수정');
                    currentUser.completedCount = parsedVal;
                }
                return validData;
            }).then(() => alert("수정되었습니다."));
        } else {
            alert("비밀번호가 틀렸습니다.");
            inputEl.value = originalVal;
        }
    };

    window.openRoleModal = (id) => { 
        const validUsers = getValidUsers(window.users);
        const user = validUsers.find(u => u.id === id);
        if (user && user.status === 'waiting') {
            alert('이미 대기 중입니다!\n\n현재 대기 역할: ' + user.role);
            return;
        }
        window.targetUserId = id; 
        document.getElementById('roleModal').style.display = 'flex'; 
    };
    
    window.confirmRole = (role) => {
        if (!role) return alert('퀘스트를 선택해주세요!');
        
        // 멀티서버: 현재 서버의 데이터 체크
        const localUser = getValidUsers(window.users).find(u => u.id === window.targetUserId);
        if (localUser) {
            const serverData = getUserServerData(localUser, currentServer);
            if (serverData.status === 'waiting') {
                alert('이미 대기 중입니다!\n\n현재 대기 역할: ' + serverData.role);
                window.closeModal();
                return;
            }
        }
        
        window.saveData((currentData) => {
            const validData = getValidUsers(currentData);
            const user = validData.find(u => u.id === window.targetUserId);
            if (user) {
                // 멀티서버: 서버 데이터 가져오기
                const serverData = getUserServerData(user, currentServer);
                
                if (serverData.status === 'waiting') return validData;
                
                window.logChange(user.id, user.name, 'action', '', `[${currentServer}서버] ${role} 대기열 등록`, '대기 등록');
                
                serverData.status = 'waiting';
                serverData.role = role;
                serverData.waitingTime = Date.now();
                serverData.isYielded = false;

                // 신규 등록자가 새로운 1순위가 되면 양보 내역 초기화
                const sameRoleWaiting = validData.filter(u => {
                    const sd = getUserServerData(u, currentServer);
                    return sd.status === 'waiting' && sd.role === role;
                });
                
                const hadYielded = sameRoleWaiting.some(u => getUserServerData(u, currentServer).isYielded);
                if (hadYielded) {
                    const baseSorted = [...sameRoleWaiting].sort((a, b) => {
                        const asd = getUserServerData(a, currentServer);
                        const bsd = getUserServerData(b, currentServer);
                        if (a.completedCount !== b.completedCount) return a.completedCount - b.completedCount;
                        return (asd.waitingTime || 0) - (bsd.waitingTime || 0);
                    });
                    const newFront = baseSorted[0];
                    if (newFront && newFront.id === user.id) {
                        sameRoleWaiting.forEach(u => {
                            getUserServerData(u, currentServer).isYielded = false;
                        });
                        window.logChange(user.id, user.name, 'action', '', `[${currentServer}서버] 신규 1순위 등록으로 양보 초기화`, '대기 등록');
                    }
                }
            }
            return validData;
        });
        window.closeModal();
    };
    
    window.closeModal = () => { window.targetUserId = null; document.getElementById('roleModal').style.display = 'none'; };
    
    window.cancelWaiting = (id) => {
        window.saveData((currentData) => {
            const validData = getValidUsers(currentData);
            const user = validData.find(u => u.id === id);
            if (user) {
                // 멀티서버: 현재 서버 데이터
                const serverData = getUserServerData(user, currentServer);
                const targetRole = serverData.role;
                
                window.logChange(user.id, user.name, 'action', '', `[${currentServer}서버] ${serverData.role || '대기'} 취소`, '대기 취소');
                
                const sameRole = validData.filter(u => {
                    const sd = getUserServerData(u, currentServer);
                    return sd.status === 'waiting' && sd.role === targetRole;
                });
                
                const baseSorted = [...sameRole].sort((a, b) => {
                    const asd = getUserServerData(a, currentServer);
                    const bsd = getUserServerData(b, currentServer);
                    if (a.completedCount !== b.completedCount) return a.completedCount - b.completedCount;
                    return (asd.waitingTime || 0) - (bsd.waitingTime || 0);
                });
                
                const activeFront = baseSorted.find(u => !getUserServerData(u, currentServer).isYielded);
                const isActiveFront = activeFront && activeFront.id === id;
                
                serverData.status = 'idle';
                serverData.waitingTime = null;
                serverData.role = '';
                serverData.isYielded = false;
                
                if (isActiveFront) {
                    validData.forEach(u => {
                        const sd = getUserServerData(u, currentServer);
                        if (sd.status === 'waiting' && sd.role === targetRole) {
                            sd.isYielded = false;
                        }
                    });
                }
            }
            return validData;
        });
    };
    
    window.cancelWaitingWithConfirm = (id) => { if (confirm('대기를 취소하시겠습니까?')) window.cancelWaiting(id); };
    
    window.startWork = (id) => {
        // 멀티서버: 현재 서버의 데이터로 체크
        const localUsers = getValidUsers(window.users);
        const serverUsers = getServerUsers(localUsers, currentServer);
        const localActive = serverUsers.filter(u => u.status === 'active');
        
        if (localActive.length >= CONSTANTS.MAX_ACTIVE_SLOTS) { 
            alert('슬롯이 꽉 찼습니다.'); 
            return; 
        }
        
        const localUser = serverUsers.find(u => u.id === id);
        if (!localUser || !localUser.role) return;
        if (localActive.some(au => au.role === localUser.role)) { 
            alert(`🚫 [${localUser.role}] 퀘스트는 이미 진행 중입니다.`); 
            return; 
        }
        
        window.saveData((currentData) => {
            const validData = getValidUsers(currentData);
            
            // 멀티서버: 현재 서버의 활성 사용자 체크
            const activeUsers = validData.filter(u => {
                const sd = getUserServerData(u, currentServer);
                return sd.status === 'active';
            });
            
            if (activeUsers.length >= CONSTANTS.MAX_ACTIVE_SLOTS) return validData;
            
            const user = validData.find(u => u.id === id);
            if (!user) return validData;
            
            const serverData = getUserServerData(user, currentServer);
            if (!serverData.role) return validData;
            
            // 같은 역할 체크
            if (activeUsers.some(au => getUserServerData(au, currentServer).role === serverData.role)) {
                return validData;
            }

            // 1순위가 아닌 사람은 입장 불가
            const sameRoleQueue = validData.filter(u => {
                const sd = getUserServerData(u, currentServer);
                return sd.status === 'waiting' && sd.role === serverData.role;
            });
            
            const serverQueueUsers = getServerUsers(sameRoleQueue, currentServer);
            const queueSorted = sortWaitingUsers(serverQueueUsers);
            if (queueSorted.length > 0 && queueSorted[0].id !== user.id) return validData;
            
            const targetRole = serverData.role;
            window.logChange(user.id, user.name, 'action', '', `[${currentServer}서버] ${serverData.role} 입장`, '입장');
            
            serverData.status = 'active';
            serverData.startTime = Date.now();
            serverData.isYielded = false;
            
            // 같은 역할 양보 초기화
            validData.forEach(u => {
                const sd = getUserServerData(u, currentServer);
                if (sd.status === 'waiting' && sd.role === targetRole) {
                    sd.isYielded = false;
                }
            });
            
            return validData;
        });
    };
    
    window.finishWork = (id) => {
        if (!confirm("완료 횟수가 +1 증가합니다. 퀘스트를 종료하시겠습니까?")) return;
        window.saveData((currentData) => {
            const validData = getValidUsers(currentData);
            const user = validData.find(u => u.id === id);
            if (user) {
                // 멀티서버: 현재 서버 데이터
                const serverData = getUserServerData(user, currentServer);
                const targetRole = serverData.role;
                
                // 완료 횟수는 전역 (모든 서버 공유)
                user.completedCount = (isNaN(user.completedCount) || user.completedCount == null) ? 1 : parseInt(user.completedCount, 10) + 1;
                
                window.logChange(user.id, user.name, 'action', '', `[${currentServer}서버] ${serverData.role} 완료 (${user.completedCount}회)`, '완료');
                
                serverData.status = 'idle';
                serverData.startTime = null;
                serverData.role = '';
                serverData.isYielded = false;
                
                // 종료 시 같은 역할 대기열의 양보 상태 초기화
                validData.forEach(u => {
                    const sd = getUserServerData(u, currentServer);
                    if (sd.status === 'waiting' && sd.role === targetRole) {
                        sd.isYielded = false;
                    }
                });
            }
            return validData;
        });
    };
    
    window.yieldTurn = (currentId) => {
        window.saveData((currentData) => {
            const validData = getValidUsers(currentData);
            const user = validData.find(u => u && u.id === currentId);
            if (!user) return validData;
            
            // 멀티서버: 현재 서버 데이터
            const serverData = getUserServerData(user, currentServer);
            if (!serverData.role) return validData;
            if (serverData.status !== 'waiting') return validData;
            
            const sameRoleWaiting = validData.filter(u => {
                const sd = getUserServerData(u, currentServer);
                return u && sd.status === 'waiting' && sd.role === serverData.role;
            });
            
            // 혼자 대기 중일 때 양보 불가
            if (sameRoleWaiting.length <= 1) return validData;

            // 1순위가 아닌 사람은 양보 불가
            const baseSortedForYield = [...sameRoleWaiting].sort((a, b) => {
                const asd = getUserServerData(a, currentServer);
                const bsd = getUserServerData(b, currentServer);
                if (a.completedCount !== b.completedCount) return a.completedCount - b.completedCount;
                return (asd.waitingTime || 0) - (bsd.waitingTime || 0);
            });
            
            const currentFront = baseSortedForYield.find(u => !getUserServerData(u, currentServer).isYielded);
            if (!currentFront || currentFront.id !== user.id) return validData;
            
            serverData.isYielded = true;
            
            const allYielded = sameRoleWaiting.every(x => getUserServerData(x, currentServer).isYielded);
            if (allYielded) {
                sameRoleWaiting.forEach(x => { 
                    getUserServerData(x, currentServer).isYielded = false; 
                });
                window.logChange(user.id, user.name, 'action', '', `[${currentServer}서버] 전원 양보하여 초기화`, '양보 초기화');
            } else {
                const serverQueueUsers = getServerUsers(validData, currentServer).filter(u => u.status === 'waiting');
                const sorted = sortWaitingUsers(serverQueueUsers).filter(u => u.role === serverData.role);
                const nextUser = sorted.find(x => !x.isYielded);
                window.logChange(user.id, user.name, 'action', '', `[${currentServer}서버] 양보 (다음: ${nextUser ? nextUser.name : '없음'})`, '양보');
            }
            
            return validData;
        });
    };

    window.addNewUser = () => {
        const name = document.getElementById('new-name').value.trim();
        if (!name) return alert('이름을 입력해주세요.');
        if (/[<>"'`&]/.test(name)) return alert('이름에 특수문자(<, >, ", \', `, &)는 사용할 수 없습니다.');
        if (getValidUsers(window.users).some(u => u.name === name)) return alert(`"${name}"은(는) 이미 등록된 이름입니다.`);
        
        window.saveData((currentData) => {
            const validData = getValidUsers(currentData);
            if (validData.some(u => u.name === name)) return validData;
            validData.push({ id: generateUniqueId(validData), name: name, completedCount: 0, role: '', status: 'idle', waitingTime: null, startTime: null, isYielded: false });
            return validData;
        }).then(() => document.getElementById('new-name').value = '');
    };
    
    window.deleteUser = (id) => { 
        if (confirm('정말 삭제하시겠습니까?')) {
            window.saveData((currentData) => {
                const validData = getValidUsers(currentData);
                const user = validData.find(u => u.id === id);
                if (user && user.status === 'waiting') {
                    const sameRole = validData.filter(u => u.status === 'waiting' && u.role === user.role);
                    const baseSorted = [...sameRole].sort((a, b) => {
                        if (a.completedCount !== b.completedCount) return a.completedCount - b.completedCount;
                        return (a.waitingTime || 0) - (b.waitingTime || 0);
                    });
                    const activeFront = baseSorted.find(u => !u.isYielded);
                    if (activeFront && activeFront.id === id) {
                        sameRole.forEach(u => { u.isYielded = false; });
                    }
                }
                return validData.filter(u => u.id !== id);
            });
        }
    };
    
    window.updateName = (id, val) => {
        const trimmed = val.trim();
        if (!trimmed || /[<>"'`&]/.test(trimmed)) {
            alert('이름은 비워둘 수 없으며, 특수문자(<, >, ", \', `, &)는 사용할 수 없습니다.');
            const original = getValidUsers(window.users).find(u => u.id === id);
            if (original) document.querySelector(`input.edit-name[onchange*="(${id},"]`).value = original.name;
            return;
        }
        window.saveData((currentData) => { const validData = getValidUsers(currentData); const u = validData.find(u => u.id === id); if (u) u.name = trimmed; return validData; });
    };
    
    // 🔒 관리자 비밀번호 검사부 SHA-256 해시값 비교 적용 2
    window.resetCompletedCounts = async () => {
        if (!confirm('모든 참여자의 완료 횟수를 0으로 초기화하시겠습니까?\n(참여자 목록과 상태는 유지됩니다)')) return;
        const pw = prompt("관리자 비밀번호를 입력하세요:");
        if (await getHash(pw || "") === CONSTANTS.EDIT_PASSWORD_HASH) {
            window.saveData((currentData) => {
                const validData = getValidUsers(currentData);
                // Bug A fix: completedCount와 무관하게 waiting 중인 사람의 isYielded도 초기화
                // (completedCount=0이어서 조건에 안 걸리던 양보자가 고착되는 문제 수정)
                validData.forEach(u => {
                    if (u.completedCount > 0) {
                        window.logChange(u.id, u.name, 'completedCount', u.completedCount, 0, '일괄 초기화');
                        u.completedCount = 0;
                    }
                    if (u.status === 'waiting' && u.isYielded) {
                        u.isYielded = false;
                    }
                });
                return validData;
            }).then(() => alert("모든 완료 횟수가 초기화되었습니다."));
        } else if (pw !== null) {
            alert("비밀번호가 틀렸습니다.");
        }
    };

    // 🔒 관리자 비밀번호 검사부 SHA-256 해시값 비교 적용 3
    window.clearAllData = async () => { 
        if (confirm('모든 데이터를 삭제하시겠습니까?')) { 
            const pw = prompt("초기화 비밀번호:");
            if (await getHash(pw || "") === CONSTANTS.RESET_PASSWORD_HASH) {
                window.saveData(() => []).then(() => alert("초기화되었습니다."));
            } else if (pw !== null) {
                alert("비밀번호가 틀렸습니다.");
            }
        } 
    };

    // 🔒 관리자 비밀번호 검사부 SHA-256 해시값 비교 적용 4
    window.openLogModal = async () => {
        const pw = prompt('관리자 비밀번호:');
        if (await getHash(pw || "") === CONSTANTS.EDIT_PASSWORD_HASH) {
            document.getElementById('logModal').style.display = 'flex'; window.refreshLogsInModal();
        } else if (pw !== null) {
            alert('비밀번호 불일치');
        }
    };
    window.closeLogModal = () => { document.getElementById('logModal').style.display = 'none'; };
    
    window.refreshLogsInModal = () => {
        const logsQuery = query(window.changeLogRef, orderByKey(), limitToLast(CONSTANTS.LOG_DISPLAY_COUNT));
        onValue(logsQuery, (snapshot) => {
            const logs = snapshot.val();
            const logTable = document.getElementById('log-table-modal');
            logTable.innerHTML = '';
            if (!logs) return logTable.innerHTML = '<tr><td colspan="6" style="text-align:center; padding: 50px;">로그가 없습니다.</td></tr>';
            
            Object.entries(logs).map(([key, value]) => ({key, ...value})).sort((a, b) => parseInt(b.key) - parseInt(a.key)).forEach(log => {
                const tr = document.createElement('tr');
                tr.innerHTML = `<td>${escapeHtml(log.timestamp)}</td><td><strong>${escapeHtml(log.userName)}</strong></td><td><span style="background:#3498db; color:white; padding:2px 6px; border-radius:4px;">${escapeHtml(log.field)}</span></td><td style="color:#e74c3c;">${escapeHtml(log.oldValue) || '-'}</td><td style="color:#27ae60;"><strong>${escapeHtml(log.newValue) || '-'}</strong></td><td>${escapeHtml(log.changedBy)}</td>`;
                logTable.appendChild(tr);
            });
        }, { onlyOnce: true });
    };

    document.getElementById('btn-add-user').onclick = window.addNewUser;
    document.getElementById('btn-reset-count').onclick = window.resetCompletedCounts;
    document.getElementById('btn-reset-all').onclick = window.clearAllData;
    document.getElementById('new-name').addEventListener('keypress', (e) => { if(e.key==='Enter') window.addNewUser(); });

    // ======================================================
    // ⭐ 내 이름 기능 (참여자 목록 상단 고정 + 강조)
    // ======================================================
    const MAX_MY_NAMES_QUEST = 5;
    const MY_NAMES_QUEST_KEY = 'myQuestNames';

    window.getMyNamesQuest = function getMyNamesQuest() {
        try {
            const raw = localStorage.getItem(MY_NAMES_QUEST_KEY);
            if (raw) {
                const arr = JSON.parse(raw);
                if (Array.isArray(arr)) return arr.filter(n => typeof n === 'string' && n.trim()).slice(0, MAX_MY_NAMES_QUEST);
            }
        } catch (e) {}
        return [];
    }

    window.setMyNamesQuest = function setMyNamesQuest(names) {
        const filtered = (names || []).filter(n => typeof n === 'string' && n.trim()).slice(0, MAX_MY_NAMES_QUEST);
        localStorage.setItem(MY_NAMES_QUEST_KEY, JSON.stringify(filtered));
    }

    window.showMyNameModalQuest = function showMyNameModalQuest() {
        const modal = document.getElementById('my-name-modal-quest');
        const container = document.getElementById('my-name-slots-quest');
        const current = getMyNamesQuest();
        let html = '';
        for (let i = 0; i < MAX_MY_NAMES_QUEST; i++) {
            const value = (current[i] || '').replace(/"/g, '&quot;');
            html += `
                <div style="display:flex; gap:8px; align-items:center;">
                    <label style="flex:0 0 45px; font-weight:bold; color:#2c3e50;">${i + 1}번</label>
                    <input type="text" class="my-name-slot-quest" data-slot="${i}"
                        value="${value}"
                        placeholder="${i === 0 ? '예: 헌터야해' : '비워두면 미사용'}"
                        style="flex:1; padding:10px; border:1px solid #ddd; border-radius:6px; font-size:1rem;">
                </div>`;
        }
        container.innerHTML = html;
        modal.classList.add('active');
        setTimeout(() => {
            const first = container.querySelector('input.my-name-slot-quest');
            if (first) first.focus();
        }, 100);
    }

    window.saveMyNamesQuest = function saveMyNamesQuest() {
        const inputs = document.querySelectorAll('.my-name-slot-quest');
        const names = [];
        inputs.forEach(inp => { const v = inp.value.trim(); if (v) names.push(v); });
        const seen = new Set();
        const unique = [];
        names.forEach(n => { if (!seen.has(n)) { seen.add(n); unique.push(n); } });
        setMyNamesQuest(unique);
        closeMyNameModalQuest();
        render();  // 테이블 즉시 갱신
        if (unique.length > 0) alert(`⭐ ${unique.length}명 등록:
${unique.join(', ')}`);
        else alert('내 이름이 해제되었습니다.');
    }

    window.closeMyNameModalQuest = function closeMyNameModalQuest() {
        document.getElementById('my-name-modal-quest').classList.remove('active');
    }
