// ============================================================
// 💰 정산 모듈 (settlement.js)
//   📦 아이템 드랍 → 담당자 전달 → 보관함 → 입찰/판매 → 정산(균등 배분)
//   💸 복구·축복 지원비 (주 단위 신청 → 운영진 확정 → 지급)
//
// - app.js 가 먼저 로드되어야 함 (db, users, schedules, isAdmin, getHash, ADMIN_PW_HASH 등을 사용)
// - 모든 로직은 이 파일 안(IIFE)에 격리되어 app.js 와 이름이 겹치지 않음. 바깥에는 window.Settle 만 노출.
//
// Firebase 경로
//   boss_items/{bossId}/items               보스별 아이템 이름 목록 (입력할 때마다 자동 누적)
//   boss_drops/{날짜}_{bossId}/items/{id}    드랍 기록
//   boss_storage/{id}                       보관함 (전달 완료된 아이템 + 판매 정보)
//   boss_settlement/{S타임스탬프}             정산 내역
//   hunter_config/storageManagers           담당자 (userId 배열)
//   boss_reimburse/{주시작일(일)}/{id}        지원비 신청
//   boss_reimburse_img/{id}                 지원비 증빙 이미지 (압축 dataURL, 보기 눌렀을 때만 로드)
//   hunter_config/reimbursePrices           지원비 단가 {recovery, blessing}
// ============================================================
(function () {
'use strict';

const UNIT = '다이아';
const SERVERS = {
    jingir:  { name: '진기르', color: '#3498db' },
    pandora: { name: '판도라', color: '#9b59b6' },
    support: { name: '지원',   color: '#27ae60' }
};

// ── 공통 유틸 ──────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (Number(n) || 0).toLocaleString();
const sid = (v) => String(v == null ? '' : v).replace(/[^0-9A-Za-z_\-]/g, '');   // onclick 인자용으로 정리한 키
const nowIso = () => new Date().toISOString();
const koCmp = (a, b) => String(a).localeCompare(String(b), 'ko');

function serverBadge(sv) {
    if (!sv) return '';
    const s = SERVERS[sv] || { name: sv, color: '#95a5a6' };
    return `<span style="display:inline-block; padding:1px 6px; border-radius:4px; background:${s.color}; color:white; font-size:0.72rem; font-weight:bold; margin-left:4px;">${esc(s.name)}</span>`;
}
function badge(text, color) {
    return `<span style="display:inline-block; padding:2px 8px; border-radius:10px; background:${color}; color:white; font-size:0.74rem; font-weight:bold;">${text}</span>`;
}
function chip(label, active, color, onclick) {
    return `<button onclick="${onclick}" style="padding:4px 12px; border-radius:20px; border:2px solid ${color}; background:${active ? color : 'white'}; color:${active ? 'white' : color}; font-size:0.8rem; font-weight:bold; cursor:pointer;">${label}</button>`;
}
function actBtn(label, onclick, bg) {
    return `<button onclick="${onclick}" style="padding:6px 11px; border:none; border-radius:6px; background:${bg}; color:white; font-size:0.8rem; font-weight:bold; cursor:pointer;">${label}</button>`;
}
// ※ style.css 에 input,select{width:100%; padding:10px; margin-bottom:10px} 전역 규칙이 있어서
//   체크박스·인라인 입력은 아래 스타일로 크기/여백을 명시해 덮어쓴다.
const inputStyle = 'width:100%; margin:0; padding:9px; border:2px solid #ddd; border-radius:7px; font-size:0.92rem; box-sizing:border-box; background:white;';
const cbStyle = 'width:16px; height:16px; margin:0; padding:0; border:none; flex:none; cursor:pointer;';

// ── 상태 ─────────────────────────────────────────────────
const state = {
    inited: false, pane: 'items', storageLoaded: false, dropTarget: 'follow', dropStRefs: {}, dropStorage: {}, variants: [], variantSel: '', variantMem: {}, undeliv: [], undelivLoaded: false, undelivLoading: false, undelivStale: false, admVariants: {}, admEntries: [], admBoss: '', adm: null, admLoading: false,
    managers: [],                 // 담당자 userId[]
    storage: [], stFilter: 'all', stServer: '',
    drops: [], dropKey: '', dropRef: null, bossItems: [],
    settlements: [], recipients: new Set(), calcItemIds: [],
    calcMode: 'equal', calcRatios: { jingir: 0, pandora: 0, support: 0, other: 0 }, calcFixed: {},     // 정산 계산: 분배 방식 / 서버별 비율(%) / 직접 지정 금액
    stQuery: '', stCat: { type: '', job: '' }, stSort: 'recent', stShow: 40, stPanel: false,      // 보관함 검색 / 종류·직업 분류 / 정렬 / 한 번에 보여줄 개수
    catRules: {}, catCache: {}, catDraft: null, itemTags: {},                                          // + 아이템별로 직접 지정한 분류(이름 → {type, job})
                                                         // 분류 규칙(관리자 설정) / 이름별 분류 계산 캐시 / 설정창 임시 편집본
    supportTeam: [], calcSupportPct: 50                                                                  // 지원조 명단(userId[], 관리자만 설정) / 지원조 몫(%)
};

function depsOk() {
    return typeof db !== 'undefined' && typeof users !== 'undefined' && typeof schedules !== 'undefined' && typeof isAdmin !== 'undefined';
}
const getUsers = () => (typeof users !== 'undefined' && Array.isArray(users)) ? users : [];
const getSchedules = () => (typeof schedules !== 'undefined' && Array.isArray(schedules)) ? schedules : [];
const userById = (id) => getUsers().find(u => Number(u.id) === Number(id));
const myNameList = () => (typeof getMyNames === 'function') ? getMyNames() : [];

// ── 권한 ─────────────────────────────────────────────────
async function requireAdmin() {
    if (isAdmin) return true;
    const pw = prompt('관리자 비밀번호를 입력하세요:');
    if (pw === null) return false;
    let ok = false;
    try { ok = (await getHash(pw)) === ADMIN_PW_HASH; } catch (e) { ok = false; }
    if (!ok) alert('❌ 비밀번호가 틀렸습니다.');
    return ok;
}
function isMyManager() {
    const names = myNameList();
    return getUsers().some(u => names.includes(u.name) && state.managers.includes(Number(u.id)));
}
const canManage = () => !!isAdmin || isMyManager();
async function requireManage() { return canManage() ? true : requireAdmin(); }

// ── 모달 ─────────────────────────────────────────────────
function showModal(html) {
    let m = $('settle-modal');
    if (!m) {
        m = document.createElement('div');
        m.id = 'settle-modal';
        m.style.cssText = 'position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); z-index:3000; display:none; justify-content:center; align-items:center;';
        m.addEventListener('click', (e) => { if (e.target === m) closeModal(); });
        document.body.appendChild(m);
    }
    m.innerHTML = `<div style="background:white; border-radius:12px; padding:20px; width:92%; max-width:420px; max-height:88vh; overflow-y:auto;">${html}</div>`;
    m.style.display = 'flex';
}
function closeModal() {
    const m = $('settle-modal');
    if (m) { m.style.display = 'none'; m.innerHTML = ''; }
}

// ── 화면 뼈대 (탭 최초 진입 시 1회 생성) ───────────────────────
function buildRoot() {
    const root = $('settle-root');
    root.innerHTML = `
    <div class="card" style="padding:10px 18px;">
        <div style="display:flex; gap:8px;">
            <button id="settle-seg-items" onclick="Settle.showPane('items')" style="flex:1; padding:10px 6px; border-radius:8px; font-weight:bold; font-size:0.9rem; cursor:pointer;">📦 아이템·정산</button>
            <button id="settle-seg-reimb" onclick="Settle.showPane('reimb')" style="flex:1; padding:10px 6px; border-radius:8px; font-weight:bold; font-size:0.9rem; cursor:pointer;">💸 복구비 관리</button>
        </div>
    </div>

    <div id="settle-pane-items">
        <!-- 보관함 -->
        <div class="card">
            <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom:10px;">
                <h2 style="font-size:1.05rem; margin:0;">🏪 아이템 보관함</h2>
                <div id="settle-storage-actions" style="display:flex; gap:6px; flex-wrap:wrap;"></div>
            </div>
            <div id="settle-storage-filters" style="display:flex; gap:6px; flex-wrap:wrap; margin-bottom:10px;"></div>
            <div id="settle-storage-cats"></div>
            <div id="settle-storage-list"></div>
        </div>

        <!-- 정산 -->
        <div class="card">
            <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom:6px;">
                <h2 style="font-size:1.05rem; margin:0;">📊 정산</h2>
                <div id="settle-calc-actions" style="display:flex; gap:6px; flex-wrap:wrap;"></div>
            </div>
            <p style="font-size:0.8rem; color:#7f8c8d; margin:0 0 8px;">판매가 끝난 아이템의 낙찰액을 합산해 선택한 인원에게 균등 배분합니다. 한 번 정산한 아이템은 다시 합산되지 않습니다.</p>
            <div id="settle-calc-area"></div>
            <div id="settle-history-area"></div>
        </div>
    </div>

    <div id="settle-pane-reimb" style="display:none;"></div>`;
}

function showPane(p) {
    if (p === 'reimb' && !isAdmin) p = 'items';                 // 복구비 관리는 관리자만
    state.pane = p;
    const on = 'background:#2c3e50; color:white; border:2px solid #2c3e50;';
    const off = 'background:white; color:#2c3e50; border:2px solid #d5d8dc;';
    const bi = $('settle-seg-items'), br = $('settle-seg-reimb');
    if (bi) bi.style.cssText = (p === 'items' ? on : off) + ' flex:1; padding:10px 6px; border-radius:8px; font-weight:bold; font-size:0.9rem; cursor:pointer;';
    if (br) { br.style.cssText = (p === 'reimb' ? on : off) + ' flex:1; padding:10px 6px; border-radius:8px; font-weight:bold; font-size:0.9rem; cursor:pointer;'; br.style.display = isAdmin ? '' : 'none'; }
    $('settle-pane-items').style.display = p === 'items' ? 'block' : 'none';
    $('settle-pane-reimb').style.display = p === 'reimb' ? 'block' : 'none';
    if (p === 'reimb') rbAdminInit();
}
function renderSeg() {
    const br = $('settle-seg-reimb');
    if (br) br.style.display = isAdmin ? '' : 'none';
    if (!isAdmin && state.pane === 'reimb') showPane('items');
}

// 하단 [정산] 메뉴는 관리자·담당자에게만 보임 (일반 사용자는 출석 · 복구비 신청 · 내 정보 중심)
function updateNav() {
    const n = $('nav-settle');
    if (n) n.style.display = canManage() ? '' : 'none';
    const tab = $('tab-settle');
    if (tab && tab.classList.contains('active') && !canManage() && typeof switchTab === 'function') switchTab('attendance');
}

// ── 탭 진입/모드 변경 ────────────────────────────────────
function onOpen() {
    const root = $('settle-root');
    if (!root) return;
    if (!depsOk()) {
        root.innerHTML = '<div class="card"><p style="color:#c0392b;">정산 모듈을 시작할 수 없습니다. app.js 가 먼저 로드되었는지 확인하세요.</p></div>';
        return;
    }
    if (!canManage()) { if (typeof switchTab === 'function') switchTab('attendance'); return; }   // 정산 탭은 관리자·담당자 전용
    if (!state.inited) {
        buildRoot();
        state.inited = true;
        showPane('items');
    }
    ensureListeners();
    refreshAll();
    renderSeg();
    if (state.pane === 'reimb') rbAdminInit();
}
function onModeChange() {
    syncDropBox(true);
    updateNav();
    myAttTick();
    if (state.inited) { refreshAll(); renderSeg(); if (state.pane === 'reimb') { rbRenderPriceLine(); rbRender(); } }
    rbRenderUser();
}
function refreshAll() {
    renderStorage();
    renderCalcActions();
    if (state.stFilter === 'undelivered' && (!state.undelivLoaded || state.undelivStale) && !state.undelivLoading) loadUndelivered();
}

// 담당자/보관함 구독은 필요할 때(정산 탭 열기, 드랍 칸 펼치기)만 시작 — 출석 화면을 열 때마다 보관함 전체를 내려받지 않도록
let listenersOn = false;
// 담당자 목록은 아주 작아서 출석 탭 시작 때 구독, 보관함 "전체"는 정산 탭을 열 때만 구독
let managersOn = false, storageOn = false;
function ensureManagers() {
    if (managersOn || !depsOk()) return;
    managersOn = true;
    db.ref('hunter_config/storageManagers').on('value', snap => {
        state.managers = Object.values(snap.val() || {}).map(Number).filter(n => !isNaN(n));
        renderDrops(); renderStorage(); renderCalcActions(); renderVariantSelect(); updateNav();
    });
}
function ensureStorage() {
    if (storageOn || !depsOk()) return;
    storageOn = true;
    db.ref('boss_storage').on('value', snap => {
        const arr = [];
        snap.forEach(ch => { const v = ch.val(); if (v && typeof v === 'object') arr.push(Object.assign({}, v, { id: v.id != null ? v.id : ch.key })); });
        state.storage = arr;
        state.storageLoaded = true;
        renderStorage(); renderDrops(); renderCalcActions();
    });
}
let supportOn = false;
function ensureSupportTeam() {
    if (supportOn || !depsOk()) return;
    supportOn = true;
    db.ref('hunter_config/supportTeam').on('value', snap => {
        state.supportTeam = Object.values(snap.val() || {}).map(Number).filter(n => !isNaN(n));
        renderCalcActions();
        if ($('settle-calc-area') && $('settle-calc-area').innerHTML) renderCalc();        // 정산 계산 화면이 열려 있으면 지원조 표시/계산 갱신
    });
}
function ensureListeners() { ensureManagers(); ensureSupportTeam(); ensureCatRules(); ensureItemTags(); ensureStorage(); }

// ============================================================
// 📦 드랍 기록
// ============================================================
function renderWinnerSelect() {
    const sel = $('settle-drop-winner');
    if (!sel) return;
    const prev = sel.value;
    const list = getUsers().slice().sort((a, b) => koCmp(a.name, b.name));
    sel.innerHTML = '<option value="">획득자 선택</option>' + list.map(u => {
        const sv = SERVERS[u.server] ? ' (' + SERVERS[u.server].name + ')' : '';
        return `<option value="${Number(u.id)}">${esc(u.name + sv)}</option>`;
    }).join('');
    if (prev) sel.value = prev;
}

// ── 기록 대상 보스: 출석 탭의 "현재 진행 중인 보스"를 따라감 (수동으로 다른 보스도 선택 가능) ──
const nowD = () => (typeof getEffectiveNow === 'function') ? getEffectiveNow() : new Date();
function ymdOf(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

// 오늘 이미 시작한 보스 중 가장 최근 것 (진행 중인 보스가 없을 때 기본 대상)
function latestBossToday() {
    const now = nowD();
    const mins = now.getHours() * 60 + now.getMinutes();
    const toMin = (t) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(t)); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
    const list = getSchedules()
        .filter(b => b && b.dayOfWeek === now.getDay() && toMin(b.time) !== null && toMin(b.time) <= mins)
        .sort((a, b) => toMin(a.time) - toMin(b.time));
    return list.length ? list[list.length - 1] : null;
}

// "위에서 선택한 보스" 기준 대상 (출석 탭의 현재 보스 → 없으면 가장 최근 보스)
function followTarget() {
    const manualDate = (typeof currentScheduleDate !== 'undefined' && currentScheduleDate) ? currentScheduleDate : null;
    let bossId = (typeof currentScheduleId !== 'undefined') ? currentScheduleId : null;
    let fallback = false;
    if (!bossId && !manualDate) {
        const lb = latestBossToday();
        if (lb) { bossId = lb.id; fallback = true; }
    }
    const boss = bossId ? (getSchedules().find(s => s.id === bossId) || null) : null;
    return { date: manualDate || ymdOf(nowD()), bossId: bossId, boss: boss, fallback: fallback };
}

function dropTarget() {
    const v = state.dropTarget;
    if (v && v !== 'follow') {                      // "YYYY-MM-DD_보스ID" (날짜는 10자 고정)
        const date = v.slice(0, 10), bossId = v.slice(11);
        return { date: date, bossId: bossId, boss: getSchedules().find(s => s.id === bossId) || null, fallback: false };
    }
    return followTarget();
}

function renderDropTargets() {
    const sel = $('settle-drop-target');
    if (!sel) return;
    const f = followTarget();
    const when = (f.boss ? f.boss.time + ' ' + f.boss.name : '');
    const dateTxt = (f.date !== ymdOf(nowD())) ? f.date.slice(5) + ' ' : '';
    let followLabel;
    if (f.boss && !f.fallback) followLabel = '⭐ 선택된 보스 · ' + dateTxt + when;
    else if (f.boss)           followLabel = '⭐ 최근 보스 · ' + when;
    else                       followLabel = '⭐ 선택된 보스 없음';
    const now = nowD();
    const group = (label, d) => {
        const list = getSchedules().filter(b => b && b.dayOfWeek === d.getDay()).sort((a, b) => String(a.time).localeCompare(String(b.time)));
        if (!list.length) return '';
        const ds = ymdOf(d);
        return `<optgroup label="${label} (${ds.slice(5)})">` + list.map(b => `<option value="${ds}_${esc(b.id)}">${esc(b.time)} ${esc(b.name)}</option>`).join('') + '</optgroup>';
    };
    const yest = new Date(now); yest.setDate(now.getDate() - 1);
    const prev = state.dropTarget;
    sel.innerHTML = '<option value="follow">' + esc(followLabel) + '</option>' + group('오늘', now) + group('어제', yest);
    sel.value = Array.from(sel.options).some(o => o.value === prev) ? prev : 'follow';
    state.dropTarget = sel.value;
}

function onDropTargetChange() {
    const sel = $('settle-drop-target');
    state.dropTarget = sel ? sel.value : 'follow';
    syncDropBox(true);
}

function loadDrops() {
    const t = dropTarget();
    const key = (t.date && t.bossId) ? t.date + '_' + t.bossId : '';
    if (key && key === state.dropKey && state.dropRef) return;      // 같은 대상이면 다시 구독하지 않음
    if (state.dropRef) { state.dropRef.off('value'); state.dropRef = null; }
    state.dropKey = key;
    state.drops = [];
    Object.keys(state.dropStRefs).forEach(k => state.dropStRefs[k].off('value'));
    state.dropStRefs = {}; state.dropStorage = {};
    loadVariants(t.bossId);
    renderDrops();
    if (!key) return;
    const ref = db.ref('boss_drops/' + key + '/items');
    state.dropRef = ref;
    ref.on('value', snap => {
        if (state.dropRef !== ref) return;
        const arr = [];
        snap.forEach(ch => {
            const v = ch.val();
            if (v && typeof v === 'object') arr.push(Object.assign({}, v, { id: v.id != null ? v.id : ch.key, _k: ch.key }));
        });
        arr.sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')));
        state.drops = arr;
        syncDropStorage();
        renderDrops();
    });
}

// 이 보스 드랍 건별로 보관함 항목만 구독 (보관함 전체를 받지 않고도 '보관중/판매완료' 표시)
function syncDropStorage() {
    const want = {};
    state.drops.forEach(d => { want[sid(d.id)] = d.id; });
    Object.keys(state.dropStRefs).forEach(k => {
        if (!want[k]) { state.dropStRefs[k].off('value'); delete state.dropStRefs[k]; delete state.dropStorage[k]; }
    });
    Object.keys(want).forEach(k => {
        if (state.dropStRefs[k]) return;
        const ref = db.ref('boss_storage/' + want[k]);
        state.dropStRefs[k] = ref;
        ref.on('value', snap => {
            if (state.dropStRefs[k] !== ref) return;
            const v = snap.val();
            if (v && typeof v === 'object') state.dropStorage[k] = Object.assign({}, v, { id: v.id != null ? v.id : want[k] });
            else delete state.dropStorage[k];
            renderDrops();
        });
    });
}

// ── 출석 탭 "현재 진행 중인 보스" 아래에 들어가는 드랍 칸 ──
let dropMsgTimer = null;
function showDropMsg(text) {
    const el = $('settle-drop-msg');
    if (!el) return;
    el.textContent = text;
    el.style.display = 'block';
    clearTimeout(dropMsgTimer);
    dropMsgTimer = setTimeout(() => { el.style.display = 'none'; }, 6000);
}

function buildDropBox() {
    const box = $('drop-box');
    if (!box || box.dataset.built) return false;
    box.dataset.built = '1';
    const lab = 'font-size:0.8rem; font-weight:bold; color:#555; display:block; margin:0 0 4px;';
    box.innerHTML = `
    <details id="settle-drop-details" open style="border:1px solid #e0e0e0; border-radius:10px; background:white;">
        <summary style="padding:11px 14px; cursor:pointer; font-weight:bold; color:#2c3e50; font-size:0.92rem;">
            📦 드랍 기록 <span id="settle-drop-count" style="margin-left:6px; padding:1px 8px; border-radius:10px; background:#eef2f5; color:#5D6D7E; font-size:0.75rem;"></span>
        </summary>
        <div style="padding:2px 14px 14px;">
            <p style="font-size:0.78rem; color:#7f8c8d; margin:0 0 10px;">보스에서 나온 아이템과 획득자를 기록하고, 담당자에게 전달되면 ✅ 전달완료를 체크하세요(보관함에 등록됩니다). 보스가 끝난 뒤에도 기록할 수 있고, 지난 보스는 "기록할 보스"에서 오늘·어제 것을 고르세요. 아이템 이름은 처음 입력하면 이 보스 목록에 저장되어 다음부터 선택할 수 있습니다.</p>
            <label style="${lab}">기록할 보스</label>
            <select id="settle-drop-target" onchange="Settle.onDropTargetChange()" style="${inputStyle} margin-bottom:8px;"></select>
            <div id="settle-drop-variant-wrap" style="display:none; margin-bottom:8px;">
                <label style="${lab}">어떤 보스를 잡았나요?</label>
                <select id="settle-drop-variant" onchange="Settle.onVariantChange()" style="${inputStyle}"></select>
            </div>
            <div id="settle-var-edit" style="text-align:right; margin:-2px 0 8px;"></div>
            <select id="settle-drop-item" onchange="Settle.onItemSelect()" style="${inputStyle} margin-bottom:6px;"></select>
            <input type="text" id="settle-drop-item-direct" maxlength="60" placeholder="아이템 이름을 직접 입력" style="${inputStyle} display:none; border-color:#e67e22; margin-bottom:6px;">
            <div style="display:flex; gap:6px;">
                <select id="settle-drop-winner" style="${inputStyle} flex:1;"></select>
                <button class="btn btn-primary" onclick="Settle.addDrop()" style="white-space:nowrap;">➕ 기록</button>
            </div>
            <div id="settle-drop-msg" style="display:none; margin-top:8px; padding:7px 10px; background:#d5f4e6; color:#16a085; border-radius:6px; font-size:0.82rem; font-weight:bold;"></div>
            <div id="settle-drops-list" style="margin-top:12px;"></div>
        </div>
    </details>`;
    return true;
}

// 출석 탭의 현재 보스/날짜/사용자/스케줄/관리자 모드가 바뀌면 드랍 칸을 맞춰서 갱신
let dropSig = '';
function dropSignature() {
    const cs = (typeof currentScheduleId !== 'undefined') ? currentScheduleId : null;
    const cd = (typeof currentScheduleDate !== 'undefined') ? currentScheduleDate : null;
    const f = followTarget();
    return [cs, cd, f.bossId, f.date, getUsers().length, getSchedules().length, !!isAdmin, state.dropTarget, myNameList().join(',')].join('|');
}
function syncDropBox(force) {
    if (!$('settle-drop-target')) return;
    const sig = dropSignature();
    if (!force && sig === dropSig) return;
    dropSig = sig;
    updateNav();
    rbRenderUser();
    renderDropTargets();
    renderWinnerSelect();
    renderVariantSelect();
    loadDrops();
    renderDrops();
}
function initDropBox() {
    if (!depsOk() || !buildDropBox()) return;
    const start = () => { ensureManagers(); syncDropBox(true); setInterval(() => syncDropBox(false), 1000); };
    if (typeof authReadyPromise !== 'undefined' && authReadyPromise && typeof authReadyPromise.then === 'function') authReadyPromise.then(start);
    else start();
}

// 저장소 상태를 최신으로 확인 (구독 전이면 한 건만 직접 조회)
async function stFresh(id) {
    if (state.storageLoaded) return stById(id);
    try {
        const v = (await db.ref('boss_storage/' + id).once('value')).val();
        return (v && typeof v === 'object') ? Object.assign({}, v, { id: v.id != null ? v.id : id }) : null;
    } catch (e) { return stById(id); }
}




/*__DROP_REMOVED_loadDrops__*/

// ── 이 시간대에 나올 수 있는 보스(층) 목록 ─────────────────────
// 일정 이름에 "/" 가 있으면 자동으로 나눔: "오만 1층 / 6층" → ["오만 1층", "오만 6층"], "라바 암살/마령" → ["라바 암살", "마령"]
function deriveVariants(name) {
    const raw = String(name || '');
    const i = raw.indexOf('/');
    if (i <= 0) return [];
    const L = raw.slice(0, i).trim(), R = raw.slice(i + 1).trim();
    if (!L || !R) return [];
    const m = /^(.*?)(\d+)\s*층?$/.exec(L);
    if (m && /^\d+\s*층$/.test(R)) return [(m[1] + m[2] + '층').trim(), (m[1] + R.replace(/\s+/g, '')).trim()];
    return [L, R];
}
const variantKey = (label) => String(label).replace(/[.$#\[\]\/]/g, '_');

let varReq = 0, itemsReq = 0;
function loadVariants(bossId) {
    const boss = bossId ? getSchedules().find(b => b.id === bossId) : null;
    const remember = (list) => (state.variantMem[bossId] && list.some(v => v.label === state.variantMem[bossId])) ? state.variantMem[bossId] : '';
    state.variants = boss ? deriveVariants(boss.name).map(l => ({ label: l, bossName: '' })) : [];
    state.variantSel = remember(state.variants);
    renderVariantSelect();
    loadBossItems();
    if (!bossId) return;
    const req = ++varReq;
    db.ref('boss_variants/' + bossId).once('value').then(snap => {       // 직접 등록한 보스 이름이 있으면 그것을 사용
        if (req !== varReq || dropTarget().bossId !== bossId) return;
        const stored = Object.values(snap.val() || {})
            .filter(v => v && typeof v === 'object' && String(v.label || '').trim())
            .map(v => ({ label: String(v.label).trim(), bossName: String(v.bossName || '').trim() }));
        if (!stored.length) return;
        state.variants = stored;
        state.variantSel = remember(stored);
        renderVariantSelect();
        loadBossItems();
    }).catch(e => console.warn('보스 목록 로드 실패:', e));
}

function renderVariantSelect() {
    const wrap = $('settle-drop-variant-wrap'), sel = $('settle-drop-variant'), edit = $('settle-var-edit');
    if (!wrap || !sel) return;
    const t = dropTarget();
    if (edit) edit.innerHTML = (t.boss && canManage())
        ? '<button onclick="Settle.openVariants()" style="padding:3px 9px; border:1px solid #8e44ad; border-radius:6px; background:white; color:#8e44ad; font-size:0.75rem; font-weight:bold; cursor:pointer;">⚙️ 이 시간대 보스 이름 등록</button>'
        : '';
    const need = state.variants.length >= 2;
    wrap.style.display = need ? 'block' : 'none';
    if (!need) { state.variantSel = ''; return; }
    sel.innerHTML = '<option value="">어떤 보스인지 선택 (필수)</option>'
        + state.variants.map(v => `<option value="${esc(v.label)}">${esc(v.label)}${v.bossName ? ' · ' + esc(v.bossName) : ''}</option>`).join('');
    sel.value = state.variantSel || '';
}

function onVariantChange() {
    const sel = $('settle-drop-variant');
    state.variantSel = sel ? sel.value : '';
    const t = dropTarget();
    if (t.bossId) state.variantMem[t.bossId] = state.variantSel;     // 같은 시간대에서는 방금 고른 보스를 기억
    loadBossItems();
}

// ── 시간대 보스 이름 등록 (관리자/담당자) ──
function varRowHtml(v) {
    return `<div class="settle-var-row" style="display:flex; gap:6px; margin-bottom:6px; align-items:center;">
        <input type="text" class="settle-var-label" maxlength="30" placeholder="구분 (예: 오만 1층)" value="${esc(v.label)}" style="${inputStyle} flex:1;">
        <input type="text" class="settle-var-name" maxlength="40" placeholder="보스 이름 (선택)" value="${esc(v.bossName)}" style="${inputStyle} flex:1.3;">
        <button onclick="Settle.removeVariantRow(this)" style="padding:8px 10px; border:none; border-radius:6px; background:#e74c3c; color:white; cursor:pointer; flex:none;">✕</button>
    </div>`;
}
async function openVariants() {
    const t = dropTarget();
    if (!t.boss) return;
    if (!(await requireManage())) return;
    const rows = state.variants.length ? state.variants : [{ label: '', bossName: '' }];
    showModal(`
        <h3 style="margin:0 0 4px; color:#2c3e50;">⚙️ 보스 이름 등록</h3>
        <p style="font-size:0.8rem; color:#7f8c8d; margin:0 0 10px;"><b>${esc(t.boss.time + ' ' + t.boss.name)}</b> 시간대에 나올 수 있는 보스를 등록하세요. 드랍을 기록할 때 이 중에서 고릅니다. (2개 이상이면 선택창이 나타납니다)</p>
        <div id="settle-var-rows">${rows.map(varRowHtml).join('')}</div>
        <button onclick="Settle.addVariantRow()" style="padding:6px 12px; border:1px dashed #8e44ad; border-radius:6px; background:white; color:#8e44ad; font-weight:bold; font-size:0.82rem; cursor:pointer;">+ 보스 추가</button>
        <div style="display:flex; gap:8px; margin-top:14px;">
            ${actBtn('저장', 'Settle.saveVariants()', '#8e44ad').replace('padding:6px 11px', 'flex:1; padding:11px')}
            ${actBtn('일정 이름대로', 'Settle.resetVariants()', '#7f8c8d').replace('padding:6px 11px', 'flex:1; padding:11px')}
            ${actBtn('취소', 'Settle.closeModal()', '#95a5a6').replace('padding:6px 11px', 'flex:1; padding:11px')}
        </div>`);
}
function addVariantRow() {
    const box = $('settle-var-rows');
    if (box) box.insertAdjacentHTML('beforeend', varRowHtml({ label: '', bossName: '' }));
}
function removeVariantRow(btn) {
    const row = btn && btn.closest ? btn.closest('.settle-var-row') : null;
    if (row) row.remove();
}
async function saveVariants() {
    const t = dropTarget();
    if (!t.bossId) return;
    if (!(await requireManage())) return;
    const list = [], seen = new Set();
    document.querySelectorAll('#settle-var-rows .settle-var-row').forEach(r => {
        const label = (r.querySelector('.settle-var-label').value || '').trim();
        const bossName = (r.querySelector('.settle-var-name').value || '').trim();
        if (label && !seen.has(label)) { seen.add(label); list.push({ label: label, bossName: bossName }); }
    });
    try {
        if (list.length) await db.ref('boss_variants/' + t.bossId).set(list);
        else await db.ref('boss_variants/' + t.bossId).remove();
        closeModal();
        loadVariants(t.bossId);
    } catch (e) { alert('❌ 저장 실패: ' + e.message); }
}
async function resetVariants() {
    const t = dropTarget();
    if (!t.bossId) return;
    if (!(await requireManage())) return;
    if (!confirm('등록한 보스 이름을 지우고, 일정 이름("/" 기준)대로 되돌릴까요?')) return;
    try {
        await db.ref('boss_variants/' + t.bossId).remove();
        closeModal();
        loadVariants(t.bossId);
    } catch (e) { alert('❌ 저장 실패: ' + e.message); }
}

// ============================================================
// 📦 관리 탭 > 보스 아이템 설정 — 보스별 아이템 이름 관리 (출석 탭 [드랍 기록]의 아이템 선택과 같은 데이터)
//   boss_items/@{보스이름}/items   보스별 공통 목록 (같은 보스는 요일·시간대와 상관없이 하나)
//   예전에 일정별/층별로 쌓인 목록은 읽어서 합쳐 보여주고, 편집하면 위 공통 목록으로 정리됨
// ============================================================
const numCmp = (a, b) => String(a).localeCompare(String(b), 'ko', { numeric: true });
const DOW_KO = ['일', '월', '화', '수', '목', '금', '토'];

function slotVariantList(sch) {
    const stored = state.admVariants[sch.id];
    const list = stored ? Object.values(stored).filter(v => v && String(v.label || '').trim()).map(v => ({ label: String(v.label).trim(), bossName: String(v.bossName || '').trim() })) : [];
    if (list.length) return list;
    return deriveVariants(sch.name).map(l => ({ label: l, bossName: '' }));
}

// 일정 전체에서 "보스" 목록을 뽑음 (같은 보스가 요일마다 나와도 하나로 합침)
function adminBossEntries() {
    const map = new Map();
    getSchedules().forEach(sch => {
        if (!sch || !sch.name) return;
        const vars = slotVariantList(sch);
        const multi = vars.length >= 2;
        (multi ? vars : [{ label: sch.name, bossName: '' }]).forEach(v => {
            const key = normName(v.label);
            const e = map.get(key) || { key: key, name: v.label, bossName: '', sched: [] };
            if (v.bossName && !e.bossName) e.bossName = v.bossName;
            e.sched.push({ s: sch, multi: multi, label: v.label });
            map.set(key, e);
        });
    });
    return Array.from(map.values()).sort((a, b) => numCmp(a.name, b.name));
}

function initAdminItems() {
    const card = $('acc-items');
    if (!card || card.dataset.built) return;
    const body = card.querySelector('.accordion-body');
    if (!body) return;
    card.dataset.built = '1';
    body.innerHTML = `
        <p style="color:#7f8c8d; margin:15px 0 12px; font-size:0.88rem; line-height:1.5;">보스별로 드랍되는 아이템 이름을 관리합니다. 같은 보스는 요일·시간대와 상관없이 하나의 목록을 쓰고, 출석 탭의 <b>[드랍 기록]</b>에서 그대로 선택할 수 있습니다.</p>
        <div style="margin-bottom:12px;">
            <label style="color:#2c3e50; font-weight:bold; margin-bottom:6px; display:block;">보스 선택:</label>
            <select id="settle-adm-boss" onchange="Settle.adminOnBossChange()" style="width:100%; padding:10px; font-size:1rem; border:2px solid #5D6D7E; border-radius:6px; margin:0;"><option value="">보스를 선택하세요</option></select>
        </div>
        <div id="settle-adm-body"></div>`;
    const tab = $('tab-users');
    if (tab) {                                             // 관리 탭이 열릴 때마다 보스 목록을 새로 읽음 (app.js 수정 없이 감지)
        let was = tab.classList.contains('active');
        new MutationObserver(() => {
            const now = tab.classList.contains('active');
            if (now && !was) adminOpen();
            was = now;
        }).observe(tab, { attributes: true, attributeFilter: ['class'] });
        if (was) afterAuth(adminOpen);
    }
}
function afterAuth(fn) {
    if (typeof authReadyPromise !== 'undefined' && authReadyPromise && typeof authReadyPromise.then === 'function') authReadyPromise.then(fn);
    else fn();
}

// ============================================================
// 📊 내 출석 (출석 탭 맨 위) — 통계 탭과 같은 calculateStats() 로 계산한 이번 주(수~화) 내 출석
//   boss_attendance 중 이번 주 날짜 범위(키 "날짜_보스ID")만 실시간으로 받음 (전체 출석 기록을 읽지 않음)
// ============================================================
const myAtt = { q: null, cb: null, week: '', data: null, sig: '' };

function myAttDetach() {
    if (myAtt.q) { try { myAtt.q.off('value', myAtt.cb); } catch (e) { /* 이미 해제됨 */ } }
    myAtt.q = null; myAtt.cb = null; myAtt.week = ''; myAtt.data = null;
}
function myAttAttach(startKey, endKey) {
    myAttDetach();
    const q = db.ref('boss_attendance').orderByKey().startAt(startKey).endAt(endKey + '\uf8ff');
    const cb = (snap) => { if (myAtt.q !== q) return; myAtt.data = snap.val() || {}; renderMyAtt(); };
    myAtt.q = q; myAtt.cb = cb; myAtt.week = startKey;
    q.on('value', cb);
}
function myAttUsers() {                                  // 내 이름(최대 5개) 중 명단에 있는 사람
    const seen = new Set(), out = [];
    myNameList().forEach(n => { const u = getUsers().find(x => x.name === n); if (u && !seen.has(u.id)) { seen.add(u.id); out.push(u); } });
    return out;
}

function renderMyAtt() {
    const box = $('my-attendance-box');
    if (!box) return;
    const mine = myAttUsers();
    if (!mine.length || typeof getWeekStart !== 'function' || typeof calculateStats !== 'function') { box.style.display = 'none'; box.innerHTML = ''; return; }
    const ws = getWeekStart(), we = new Date(ws);
    we.setDate(ws.getDate() + 6);
    const head = `<div style="display:flex; justify-content:space-between; align-items:center; gap:8px; margin-bottom:6px;">
            <span style="font-size:0.85rem; font-weight:bold; color:#2c3e50;">📊 내 출석 <span style="font-weight:normal; color:#95a5a6; font-size:0.76rem;">이번 주 (수 ${md(ws)} ~ 화 ${md(we)})</span></span>
            <button onclick="switchTab('stats')" style="padding:2px 8px; border:1px solid #d0d7de; border-radius:6px; background:white; color:#5D6D7E; font-size:0.72rem; cursor:pointer; white-space:nowrap; flex:none;">통계 ›</button>
        </div>`;
    box.style.display = 'block';
    let stats = null;
    if (myAtt.data && typeof calculateStats === 'function') {
        const log = console.log; console.log = function () {};                // calculateStats 의 디버그 로그가 콘솔을 채우지 않게
        try { stats = calculateStats(myAtt.data).userStats; } catch (e) { stats = null; } finally { console.log = log; }
    }
    const rows = mine.map(u => {
        const st = stats ? stats[String(u.id)] : null;
        const nm = `<b style="color:#2c3e50;">${esc(u.name)}</b>${serverBadge(u.server)}`;
        if (!myAtt.data) return `<div style="padding:6px 0; font-size:0.82rem; color:#95a5a6;">${nm} 불러오는 중...</div>`;
        if (!st || !st.serverTotal) return `<div style="padding:6px 0; font-size:0.82rem; color:#7f8c8d;">${nm} 이번 주 출석 기록이 아직 없습니다.</div>`;
        const pct = Math.max(0, Math.min(100, Number(st.rate) || 0));
        return `<div style="padding:6px 0;">
            <div style="display:flex; justify-content:space-between; align-items:baseline; gap:8px; font-size:0.85rem;">
                <span>${nm}</span>
                <span><b style="font-size:1.1rem; color:#2980b9;">${esc(st.rate)}%</b> <span style="color:#7f8c8d; font-size:0.78rem;">${st.present}/${st.serverTotal}회 출석</span></span>
            </div>
            <div style="height:6px; background:#ecf0f1; border-radius:3px; margin-top:4px; overflow:hidden;"><div style="width:${pct}%; height:100%; background:#3498db;"></div></div>
        </div>`;
    }).join('');
    box.innerHTML = `<div style="background:white; border:1px solid #e0e0e0; border-radius:10px; padding:10px 12px;">${head}${rows}</div>`;
}

// 1초마다: 이름/명단/주가 바뀌었는지 확인 (이름이 없으면 구독하지 않음)
function myAttTick() {
    const box = $('my-attendance-box');
    if (!box || !depsOk()) return;
    if (!myAttUsers().length) {
        if (myAtt.q) myAttDetach();
        if (box.style.display !== 'none') renderMyAtt();
        return;
    }
    if (typeof getWeekStart !== 'function' || typeof formatLocalDate !== 'function' || typeof calculateStats !== 'function') {
        if (box.style.display !== 'none') renderMyAtt();                           // 통계 함수를 쓸 수 없으면 칸을 숨김
        return;
    }
    const ws = getWeekStart(), we = new Date(ws);
    we.setDate(ws.getDate() + 6);
    const key = formatLocalDate(ws);
    if (myAtt.week !== key) myAttAttach(key, formatLocalDate(we));              // 최초 / 새 주(수요일)가 시작되면 다시 구독
    const assignN = (typeof weekAssignCache !== 'undefined' && weekAssignCache) ? Object.keys(weekAssignCache).length : 0;
    const sig = myAttUsers().map(u => u.id + ':' + u.server).join(',') + '|' + getUsers().length + '|' + assignN;
    if (sig !== myAtt.sig) { myAtt.sig = sig; renderMyAtt(); }                // 서버 배정/명단이 늦게 도착해도 다시 계산
}
function initMyAtt() { afterAuth(() => { myAttTick(); setInterval(myAttTick, 1000); }); }


async function adminOpen() {
    if (!depsOk() || state.admLoading) return;
    state.admLoading = true;
    ensureCatRules(); ensureItemTags();                      // 아이템별 분류 선택칸에 쓸 분류 목록과 지정 내용
    try { state.admVariants = (await db.ref('boss_variants').once('value')).val() || {}; }
    catch (e) { state.admVariants = {}; }
    state.admLoading = false;
    state.admEntries = adminBossEntries();
    const sel = $('settle-adm-boss');
    if (sel) {
        const prev = state.admBoss;
        sel.innerHTML = '<option value="">보스를 선택하세요</option>' + state.admEntries.map(e => `<option value="${esc(e.key)}">${esc(e.name)}${e.bossName ? ' · ' + esc(e.bossName) : ''}</option>`).join('');
        sel.value = state.admEntries.some(e => e.key === prev) ? prev : '';
        state.admBoss = sel.value;
    }
    await adminLoadBoss();
}
function adminOnBossChange() {
    const sel = $('settle-adm-boss');
    state.admBoss = sel ? sel.value : '';
    adminLoadBoss();
}

let admReq = 0;
async function adminLoadBoss() {
    const e = state.admEntries.find(x => x.key === state.admBoss);
    if (!e) { state.adm = null; adminRender(); return; }
    const gKey = bossListKey(e.name);
    const uKeys = [], aKeys = [];                          // uKeys: 이 보스 것이 확실한 예전 목록 / aKeys: 시간대 공통(어느 층 것인지 알 수 없음)
    e.sched.forEach(x => {
        const k = x.multi ? x.s.id + '~' + variantKey(x.label) : x.s.id;
        if (!uKeys.includes(k)) uKeys.push(k);
        if (x.multi && !aKeys.includes(x.s.id)) aKeys.push(x.s.id);
    });
    const keys = [gKey].concat(uKeys, aKeys);
    const req = ++admReq;
    let snaps;
    try { snaps = await Promise.all(keys.map(k => db.ref('boss_items/' + k + '/items').once('value'))); }
    catch (err) { alert('❌ 아이템 목록을 불러오지 못했습니다: ' + err.message); return; }
    if (req !== admReq) return;
    const rd = (sn) => Object.values(sn.val() || {}).filter(v => typeof v === 'string' && v.trim());
    const items = [];
    const add = (n) => { if (!items.includes(n)) items.push(n); };
    rd(snaps[0]).forEach(add);
    uKeys.forEach(k => rd(snaps[keys.indexOf(k)]).forEach(add));
    const slotLists = {}, slot = new Map();
    aKeys.forEach(k => {
        const list = rd(snaps[keys.indexOf(k)]);
        slotLists[k] = list;
        list.forEach(n => { const ks = slot.get(n) || []; ks.push(k); slot.set(n, ks); });
    });
    state.adm = { e: e, gKey: gKey, uKeys: uKeys, items: items, slotLists: slotLists, slot: Array.from(slot.entries()).map(([name, ks]) => ({ name: name, keys: ks })) };
    adminRender();
}

function adminRender() {
    const box = $('settle-adm-body');
    if (!box) return;
    const a = state.adm;
    if (!a) { box.innerHTML = '<p style="color:#95a5a6; font-size:0.88rem; margin:6px 0;">위에서 보스를 선택하면 그 보스의 아이템 목록을 관리할 수 있습니다.</p>'; return; }
    const days = a.e.sched.map(x => DOW_KO[x.s.dayOfWeek] + ' ' + x.s.time).filter((v, i, arr) => arr.indexOf(v) === i).join(', ');
    const row = (n, btns, stack) => `<div style="display:flex; flex-wrap:wrap; justify-content:space-between; align-items:center; gap:6px 8px; padding:7px 10px; border-bottom:1px solid #f3f3f3;"><span style="color:#2c3e50; word-break:break-all; ${stack ? 'flex:1 1 100%;' : 'flex:1 1 0; min-width:0;'}">${esc(n)}</span><span style="display:flex; gap:6px; flex:none;">${btns}</span></div>`;
    const tagSel = (g, label, n, i) => {
        const ex = explicitTag(n, g), auto = autoCatsOf(n)[g];
        return `<label style="display:flex; align-items:center; gap:4px; font-size:0.74rem; color:#7f8c8d;">${label}
            <select onchange="Settle.adminSetTag(${i}, '${g}', this.value)" style="width:auto; max-width:132px; margin:0; padding:3px 4px; border:1.5px solid ${ex ? '#8e44ad' : '#ddd'}; border-radius:6px; font-size:0.78rem;">
                <option value=""${!ex ? ' selected' : ''}>${esc('자동 (' + (auto.length ? auto.join('·') : '없음') + ')')}</option>
                ${catRules()[g].map(c => `<option value="${esc(c.name)}"${ex === c.name ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}
                <option value="${NONE_CAT}"${ex === NONE_CAT ? ' selected' : ''}>없음(기타)</option>
                <option value="__new">➕ 새 분류 만들기…</option>
            </select></label>`;
    };
    const itemRow = (n, i) => `<div style="padding:7px 10px; border-bottom:1px solid #f3f3f3;">
        <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;"><span style="color:#2c3e50; word-break:break-all; flex:1; min-width:0;">${esc(n)}</span>${actBtn('✕', `Settle.adminDeleteItem(${i})`, '#e74c3c')}</div>
        <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:4px;">${tagSel('type', '종류', n, i)}${tagSel('job', '직업', n, i)}</div>
    </div>`;
    const newSel = (g, label) => `<label style="display:flex; align-items:center; gap:4px; font-size:0.76rem; color:#7f8c8d;">${label}
        <select id="settle-adm-new-${g}" style="width:auto; max-width:132px; margin:0; padding:3px 4px; border:1.5px solid #ddd; border-radius:6px; font-size:0.78rem;">
            <option value="">자동</option>${catRules()[g].map(c => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('')}<option value="${NONE_CAT}">없음(기타)</option></select></label>`;
    box.innerHTML = `
        <div style="background:#f8f9fa; border-radius:8px; padding:9px 12px; margin-bottom:10px; font-size:0.85rem;">
            <b style="color:#2c3e50;">${esc(a.e.name)}</b>${a.e.bossName ? ' · ' + esc(a.e.bossName) : ''}
            <div style="font-size:0.75rem; color:#95a5a6; margin-top:2px;">나오는 시간: ${esc(days)}</div>
        </div>
        <div style="font-size:0.85rem; font-weight:bold; color:#555; margin-bottom:2px;">아이템 ${a.items.length}개</div>
        <div style="font-size:0.74rem; color:#95a5a6; margin-bottom:4px; line-height:1.5;">🏷️ 아이템마다 종류·직업을 정하면 보관함에서 그 분류로 걸러 볼 수 있습니다. 정하지 않으면 이름의 키워드로 자동 분류합니다.</div>
        <div style="border:1px solid #eee; border-radius:8px; margin-bottom:10px; max-height:260px; overflow-y:auto;">
            ${a.items.length ? a.items.map((n, i) => itemRow(n, i)).join('') : '<div style="padding:12px; color:#95a5a6; font-size:0.85rem; text-align:center;">등록된 아이템이 없습니다.</div>'}
        </div>
        <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:center; margin-bottom:6px;"><span style="font-size:0.76rem; color:#7f8c8d; font-weight:bold;">추가할 아이템의 분류</span>${newSel('type', '종류')}${newSel('job', '직업')}</div>
        <textarea id="settle-adm-input" rows="3" placeholder="추가할 아이템 이름 (여러 개는 줄바꿈으로 구분)" style="width:100%; margin:0 0 8px; padding:9px; border:2px solid #ddd; border-radius:7px; font-size:0.92rem; box-sizing:border-box;"></textarea>
        <button class="btn btn-primary" onclick="Settle.adminAddItems()" style="width:100%;">➕ 아이템 추가</button>
        ${a.slot.length ? `
        <div style="margin-top:14px; border:1px dashed #e67e22; border-radius:8px; padding:9px 11px; background:#fffaf2;">
            <div style="font-size:0.82rem; font-weight:bold; color:#d35400;">예전에 "시간대 공통"으로 저장된 아이템 ${a.slot.length}개</div>
            <div style="font-size:0.74rem; color:#7f8c8d; margin:2px 0 6px;">어느 층 보스 것인지 알 수 없어 따로 표시합니다. 이 보스 것이면 [옮기기], 아니면 삭제하세요. (삭제하면 같은 시간대의 다른 층에서도 사라집니다)</div>
            ${a.slot.map((it, i) => row(it.name, actBtn('이 보스로 옮기기', `Settle.adminMoveSlot(${i})`, '#16a085') + actBtn('✕', `Settle.adminDeleteSlot(${i})`, '#e74c3c'), true)).join('')}
        </div>` : ''}`;
}

// 저장: 보스별 공통 목록에 쓰고, 이 보스 것이 확실한 예전 목록은 비워서 한 곳으로 정리
async function adminSave(list, extra) {
    const a = state.adm;
    if (!a) return;
    const updates = {};
    updates['boss_items/' + a.gKey + '/items'] = list.length ? list : null;
    a.uKeys.forEach(k => { updates['boss_items/' + k + '/items'] = null; });
    Object.keys(extra || {}).forEach(k => { updates['boss_items/' + k + '/items'] = extra[k]; });
    try {
        await db.ref().update(updates);
        await adminLoadBoss();
        loadBossItems();                                    // 출석 탭 드랍 칸의 아이템 선택 목록도 바로 갱신
    } catch (e) { alert('❌ 저장 실패: ' + e.message); }
}

async function adminAddItems() {
    const a = state.adm;
    if (!a) { alert('보스를 먼저 선택하세요.'); return; }
    const raw = ($('settle-adm-input').value || '').split('\n').map(x => x.trim().slice(0, 60)).filter(Boolean);
    if (!raw.length) { alert('추가할 아이템 이름을 입력하세요.'); return; }
    if (!(await requireAdmin())) return;
    const list = a.items.slice(), newNames = [];
    raw.forEach(n => { if (!list.includes(n)) { list.push(n); newNames.push(n); } });
    if (!newNames.length) { alert('이미 모두 등록된 아이템입니다.'); return; }
    const pickType = ($('settle-adm-new-type') || {}).value || '', pickJob = ($('settle-adm-new-job') || {}).value || '';
    await adminSave(list);
    if (pickType || pickJob) await tagSet(newNames, { type: pickType || undefined, job: pickJob || undefined });      // 함께 고른 분류를 새 아이템에 지정
    const inp = $('settle-adm-input');
    if (inp) inp.value = '';
}

async function adminDeleteItem(i) {
    const a = state.adm;
    const name = a ? a.items[i] : null;
    if (!name) return;
    if (!(await requireAdmin())) return;
    if (!confirm(`"${name}" 을(를) ${a.e.name} 아이템 목록에서 삭제할까요?\n(이미 기록된 드랍 내역은 그대로 남습니다)`)) return;
    await adminSave(a.items.filter(x => x !== name));
}

// ── 아이템별 분류 직접 지정 (관리자) ──
// patch: { type?: 이름 | NONE_CAT | '' (지정 해제), job?: 같음 }. undefined 는 그대로 둠
async function tagSet(names, patch) {
    const updates = {};
    names.forEach(n => {
        const key = tagKey(n), cur = state.itemTags[key] || {};
        const next = { type: cur.type || '', job: cur.job || '' };
        CAT_SETS.forEach(([g]) => { if (patch[g] !== undefined) next[g] = patch[g] || ''; });
        const entry = {};
        if (next.type) entry.type = next.type;
        if (next.job) entry.job = next.job;
        updates['hunter_config/itemTags/' + key] = (entry.type || entry.job) ? Object.assign({ name: n }, entry) : null;
    });
    try { await db.ref().update(updates); } catch (e) { alert('❌ 저장 실패: ' + e.message); }
}
// 분류가 없으면 만들고, 이미 같은 이름이 있으면 그것을 씀. 반환: 사용할 분류 이름 (실패 시 '')
async function catEnsure(g, name) {
    const rules = catRules();
    const same = rules[g].find(c => c.name.toLowerCase() === name.toLowerCase());
    if (same) return same.name;
    if (rules[g].length >= 40) { alert('분류는 묶음마다 최대 40개까지입니다.'); return ''; }
    const next = { type: rules.type.map(c => ({ name: c.name, keywords: c.keywords.slice() })), job: rules.job.map(c => ({ name: c.name, keywords: c.keywords.slice() })) };
    next[g].push({ name: name, keywords: [] });
    try { await db.ref('hunter_config/itemCategories').set(next); return name; }
    catch (e) { alert('❌ 저장 실패: ' + e.message); return ''; }
}
async function adminSetTag(i, g, v) {
    const a = state.adm, name = a ? a.items[i] : null;
    if (!name) return;
    if (!(await requireAdmin())) { adminRender(); return; }
    let val = v;
    if (v === '__new') {
        const nm = String(prompt('새 ' + (g === 'type' ? '종류' : '직업') + ' 분류 이름을 입력하세요 (10자 이내)') || '').trim();
        if (!nm) { adminRender(); return; }
        if (nm.length > 10) { alert('분류 이름은 10자 이내로 입력하세요.'); adminRender(); return; }
        val = await catEnsure(g, nm);
        if (!val) { adminRender(); return; }
    }
    await tagSet([name], { [g]: val });
}


async function adminMoveSlot(i) {
    const a = state.adm;
    const it = a ? a.slot[i] : null;
    if (!it) return;
    if (!(await requireAdmin())) return;
    const list = a.items.slice();
    if (!list.includes(it.name)) list.push(it.name);
    const extra = {};
    it.keys.forEach(k => { const rest = (a.slotLists[k] || []).filter(x => x !== it.name); extra[k] = rest.length ? rest : null; });
    await adminSave(list, extra);
}

async function adminDeleteSlot(i) {
    const a = state.adm;
    const it = a ? a.slot[i] : null;
    if (!it) return;
    if (!(await requireAdmin())) return;
    if (!confirm(`"${it.name}" 을(를) 시간대 공통 목록에서 삭제할까요?\n(같은 시간대의 다른 층에서도 사라집니다)`)) return;
    const extra = {};
    it.keys.forEach(k => { const rest = (a.slotLists[k] || []).filter(x => x !== it.name); extra[k] = rest.length ? rest : null; });
    await adminSave(a.items.slice(), extra);
}


// ── 아이템 목록: 보스(층)별 + 예전에 쌓인 시간대 공통 목록을 합쳐서 보여줌 ──
const normName = (n) => String(n || '').replace(/\s+/g, '');                 // "오만 1층" 과 "오만1층" 을 같은 보스로 취급
const bossListKey = (name) => '@' + variantKey(normName(name));              // boss_items/@보스이름/items (요일·시간대와 무관한 보스별 공통 목록)
function currentBossName() {
    const t = dropTarget();
    if (!t.boss) return '';
    if (state.variantSel) return state.variantSel;
    return state.variants.length >= 2 ? '' : t.boss.name;
}
function itemKeys() {
    const t = dropTarget();
    if (!t.bossId) return [];
    const name = currentBossName();
    const keys = [];
    if (name) keys.push(bossListKey(name));                                   // 1순위: 보스별 공통 목록 (관리 탭에서 설정, 새 아이템도 여기에 저장)
    if (state.variantSel) keys.push(t.bossId + '~' + variantKey(state.variantSel));   // 예전: 일정+층별 목록
    keys.push(t.bossId);                                                      // 예전: 일정별 목록
    return keys;
}
function loadBossItems() {
    state.bossItems = [];
    renderItemSelect();
    const keys = itemKeys();
    if (!keys.length) return;
    const req = ++itemsReq;
    Promise.all(keys.map(k => db.ref('boss_items/' + k + '/items').once('value'))).then(snaps => {
        if (req !== itemsReq) return;
        const seen = new Set(), list = [];
        snaps.forEach(sn => Object.values(sn.val() || {}).forEach(v => {
            if (typeof v === 'string' && v.trim() && !seen.has(v)) { seen.add(v); list.push(v); }
        }));
        state.bossItems = list;
        renderItemSelect();
    }).catch(e => console.warn('아이템 목록 로드 실패:', e));
}
function renderItemSelect() {
    const sel = $('settle-drop-item');
    if (!sel) return;
    const needVar = state.variants.length >= 2 && !state.variantSel;
    sel.disabled = needVar;
    if (needVar) { sel.innerHTML = '<option value="">먼저 위에서 어떤 보스인지 선택하세요</option>'; return; }
    const prev = sel.value;
    sel.innerHTML = '<option value="">아이템 선택 (이 보스 목록)</option>'
        + state.bossItems.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('')
        + '<option value="__direct__">✏️ 직접 입력...</option>';
    if (prev && state.bossItems.includes(prev)) sel.value = prev;
}
function onItemSelect() {
    const sel = $('settle-drop-item'), direct = $('settle-drop-item-direct');
    if (sel.value === '__direct__') { sel.value = ''; direct.style.display = 'block'; direct.focus(); }
    else if (sel.value) { direct.style.display = 'none'; direct.value = ''; }
}
function getItemName() {
    const direct = $('settle-drop-item-direct'), sel = $('settle-drop-item');
    if (direct && direct.style.display !== 'none' && direct.value.trim()) return direct.value.trim();
    return (sel && sel.value && sel.value !== '__direct__') ? sel.value : '';
}
function learnItem(name) {
    const keys = itemKeys();
    if (!keys.length || state.bossItems.includes(name)) return Promise.resolve();
    return db.ref('boss_items/' + keys[0] + '/items').transaction(cur => {      // 새 아이템은 그 보스의 공통 목록에 저장 (다른 요일에도 그대로 선택 가능)
        const arr = Array.isArray(cur) ? cur.slice() : Object.values(cur || {});
        if (!arr.includes(name)) arr.push(name);
        return arr;
    }).then(() => {
        if (!state.bossItems.includes(name)) state.bossItems.push(name);
        renderItemSelect();
    }).catch(e => console.warn('아이템 목록 저장 실패:', e));
}

function storageFromDrop(d) {
    return {
        id: String(d.id), itemName: d.itemName,
        bossId: d.bossId, bossName: d.bossName, bossServer: d.bossServer || '',
        bossVariant: d.bossVariant || '', bossVariantName: d.bossVariantName || '',
        date: d.date, winner: d.winner, winnerId: d.winnerId, winnerServer: d.winnerServer || '',
        dropPath: 'boss_drops/' + d.date + '_' + d.bossId + '/items/' + (d._k != null ? d._k : d.id),
        addedAt: nowIso(), sold: false, bidPrice: 0, buyer: ''
    };
}

async function addDrop() {
    const t = dropTarget();
    const itemName = getItemName();
    const winner = userById(parseInt($('settle-drop-winner').value));
    if (!t.boss)   { alert('기록할 보스가 없습니다.\n위의 "보스 선택"에서 보스를 고르거나, "기록할 보스"를 직접 선택하세요.'); return; }
    if (!itemName) { alert('아이템을 선택하거나 직접 입력하세요.'); return; }
    if (!winner)   { alert('획득자를 선택하세요.'); return; }
    if (state.variants.length >= 2 && !state.variantSel) { alert('어떤 보스를 잡았는지(예: 1층 / 6층) 먼저 선택하세요.'); return; }
    const vObj = state.variants.find(v => v.label === state.variantSel) || null;
    const date = t.date, bossId = t.bossId, boss = t.boss;

    const id = Date.now() + '_' + Number(winner.id);
    const isMgr = state.managers.includes(Number(winner.id));      // 담당자가 먹었으면 전달·보관함 자동 처리
    const drop = {
        id: id, itemName: itemName, winner: winner.name, winnerId: Number(winner.id), winnerServer: winner.server || '',
        bossId: bossId, bossName: boss.name, bossServer: winner.server || '', date: date,
        bossVariant: vObj ? vObj.label : '', bossVariantName: vObj ? vObj.bossName : '',
        delivered: isMgr, inStorage: isMgr, timestamp: nowIso()
    };
    const updates = {};
    updates['boss_drops/' + date + '_' + bossId + '/items/' + id] = drop;
    if (isMgr) updates['boss_storage/' + id] = storageFromDrop(Object.assign({ _k: id }, drop));   // 보관함에도 실제로 등록
    try {
        await db.ref().update(updates);
        state.undelivStale = true;
        await learnItem(itemName);
        $('settle-drop-item').value = '';
        $('settle-drop-item-direct').value = '';
        $('settle-drop-item-direct').style.display = 'none';
        $('settle-drop-winner').value = '';
        showDropMsg('✅ ' + itemName + ' → ' + boss.time + ' ' + boss.name + (vObj ? ' · ' + vObj.label : '') + (date !== ymdOf(nowD()) ? ' (' + date.slice(5) + ')' : '') + ' 기록 완료');
    } catch (e) {
        alert('❌ 드랍 기록 실패: ' + e.message);
    }
}

const stById = (id) => state.storage.find(s => sid(s.id) === sid(id));
const findDrop = (k) => state.drops.find(d => sid(d.id) === k);

function renderDrops() {
    const box = $('settle-drops-list');
    if (!box) return;
    const cnt = $('settle-drop-count');
    if (cnt) cnt.textContent = state.dropKey ? state.drops.length + '개' : '';
    const msg = (t) => `<p style="color:#95a5a6; text-align:center; padding:12px; font-size:0.88rem; margin:0;">${t}</p>`;
    if (!state.dropKey) { box.innerHTML = msg('지금 기록할 보스가 없습니다.<br>위 "보스 선택"에서 보스를 고르거나, 위의 "기록할 보스"에서 선택하세요.'); return; }
    if (!state.drops.length) { box.innerHTML = msg('이 보스의 드랍 기록이 없습니다.'); return; }
    const t = dropTarget();
    const mg = canManage();
    const hint = mg ? '' : '<div style="font-size:0.76rem; color:#7f8c8d; margin-top:4px; line-height:1.5;">ℹ️ ✅ 전달완료 체크는 <b>관리자·담당자</b>만 보입니다. 담당자라면 <b>[내 이름 설정]</b>에 담당자로 지정된 본인 이름이 등록되어 있어야 합니다.</div>';
    box.innerHTML = `<div style="font-size:0.82rem; font-weight:bold; color:#555; margin-bottom:6px;">${esc(t.date.slice(5))} ${t.boss ? esc(t.boss.time + ' ' + t.boss.name) : ''} · 드랍 ${state.drops.length}개</div>` + state.drops.map(d => {
        const k = sid(d.id);
        const st = state.storageLoaded ? stById(d.id) : (state.dropStorage[k] || null);
        const mgrWinner = state.managers.includes(Number(d.winnerId));
        let status;
        if (st && st.sold) status = badge(st.settledId ? '정산완료' : '판매완료', '#27ae60');
        else if (st || d.inStorage) status = badge('보관중', '#e67e22');
        else if (d.delivered) status = badge('전달완료', '#16a085');
        else status = badge('미전달', '#d35400');
        const controls = mg ? `
            <div style="display:flex; gap:6px; flex-wrap:wrap; margin-top:8px;">
                <label style="display:flex; align-items:center; gap:4px; padding:5px 9px; background:${d.delivered ? '#d5f4e6' : '#fef9e7'}; border-radius:6px; cursor:pointer; font-size:0.82rem; font-weight:bold; white-space:nowrap;">
                    <input type="checkbox" style="${cbStyle}" ${d.delivered ? 'checked' : ''} onchange="Settle.toggleDelivered('${k}', this.checked)"> ✅ 전달완료 (보관함 등록)
                </label>
                ${actBtn('🗑️', `Settle.deleteDrop('${k}')`, '#e74c3c')}
            </div>` : '';
        return `
        <div style="border:2px solid ${d.delivered ? '#a9dfbf' : '#f0e6cc'}; border-radius:8px; padding:10px 12px; margin-bottom:8px; background:white;">
            <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap;">
                <b style="color:#2c3e50;">${esc(d.itemName)}</b>${status}
            </div>
            ${d.bossVariant ? `<div style="font-size:0.8rem; color:#6c3483; margin-top:3px;">🗡️ ${esc(d.bossVariant)}${d.bossVariantName ? ' · ' + esc(d.bossVariantName) : ''}</div>` : ''}
            <div style="font-size:0.82rem; color:#666; margin-top:3px;">
                획득: <b>${esc(d.winner)}</b>${serverBadge(d.winnerServer)}${mgrWinner ? ' ' + badge('담당자', '#8e44ad') : ''}
                ${mgrWinner && d.inStorage ? '<span style="color:#8e44ad; font-size:0.76rem;"> · 자동 보관함 등록</span>' : ''}
            </div>
            <div style="font-size:0.74rem; color:#aaa; margin-top:2px;">${esc(new Date(d.timestamp).toLocaleString('ko-KR'))}</div>
            ${controls}
        </div>`;
    }).join('') + hint;
}

// 전달완료 체크 = 담당자에게 전달되어 보관함에 들어간 것 (체크하면 보관함에 등록, 해제하면 보관함에서 제거)
async function toggleDelivered(k, checked) {
    const d = findDrop(k);
    if (!d) return;
    if (!(await requireManage())) { renderDrops(); return; }
    const st = await stFresh(d.id);
    if (!checked && st && st.sold) { alert('이미 판매된 아이템입니다. 정산 탭 보관함에서 판매 취소를 먼저 해주세요.'); renderDrops(); return; }
    const base = 'boss_drops/' + state.dropKey + '/items/' + d._k;
    const updates = {};
    updates[base + '/delivered'] = !!checked;
    updates[base + '/inStorage'] = !!checked;
    if (checked) { if (!st) updates['boss_storage/' + d.id] = storageFromDrop(d); }
    else updates['boss_storage/' + d.id] = null;
    try { await db.ref().update(updates); state.undelivStale = true; } catch (e) { alert('❌ 저장 실패: ' + e.message); renderDrops(); }
}
async function deleteDrop(k) {
    const d = findDrop(k);
    if (!d) return;
    if (!(await requireManage())) return;
    const st = await stFresh(d.id);
    if (st && st.sold) { alert('판매된 아이템은 삭제할 수 없습니다. 보관함에서 판매 취소를 먼저 해주세요.'); return; }
    if (!confirm(`"${d.itemName}" 드랍 기록을 삭제할까요?`)) return;
    const updates = {};
    updates['boss_drops/' + state.dropKey + '/items/' + d._k] = null;
    updates['boss_storage/' + d.id] = null;
    try { await db.ref().update(updates); state.undelivStale = true; } catch (e) { alert('❌ 삭제 실패: ' + e.message); }
}

// ============================================================
// 🏪 보관함
// ============================================================
function setStorageFilter(f) {
    state.stFilter = f;
    state.stShow = STORAGE_PAGE;
    if (f === 'undelivered' && (!state.undelivLoaded || state.undelivStale)) loadUndelivered();   // 미전달 목록은 눌렀을 때 읽음
    else renderStorage();
}
function setStorageServer(sv) { state.stServer = sv; state.stShow = STORAGE_PAGE; renderStorage(); }

// ============================================================
// 🔎 보관함 검색 · 분류 — 아이템이 많아져도 찾기 쉽게
//   · 분류는 아이템 이름에 들어 있는 키워드로 자동 판단 (종류: 주문서·반지…, 직업: 법사·기사…). 키워드는 관리자가 고칠 수 있음
//   · 종류 × 직업 은 동시에 고를 수 있고(예: 법사 + 반지), 검색어·상태·서버 필터와도 함께 적용
//   · 한 번에 40개씩만 보여주고 [더 보기]로 늘림
// ============================================================
const STORAGE_PAGE = 40;
const NONE_CAT = '__none';
const CAT_SETS = [['type', '종류'], ['job', '직업']];
const DEFAULT_CATS = {
    type: [
        { name: '반지', keywords: ['반지'] },
        { name: '목걸이', keywords: ['목걸이'] },
        { name: '귀걸이', keywords: ['귀걸이'] },
        { name: '방어구', keywords: ['투구', '갑옷', '망토', '장갑', '각반', '부츠', '장화', '방패', '티셔츠', '허리띠', '벨트','가더'] },
        { name: '무기', keywords: ['단검','한손검','양손검','지팡이','활','창','도끼','이도류','크로우','건틀렛','라이플','핸드캐넌','체인소드','사이드','룬소드'] },
        { name: '마법인형', keywords: ['마법인형', '카드'] },
        { name: '영웅제작비법서', keywords: ['영비'] },
        { name: '전설제작비법서', keywords: ['전비'] },
        { name: '스킬북', keywords: ['스킬북'] }
    ],
    job: [
        { name: '군주', keywords: ['군주'] },
        { name: '기사', keywords: ['기사'] },
        { name: '요정', keywords: ['요정'] },
        { name: '법사', keywords: ['법사', '마법사'] },
        { name: '다크엘프', keywords: ['다크엘프', '다엘'] },
        { name: '총사', keywords: ['총사'] },
        { name: '투사', keywords: ['투사'] },
        { name: '암흑기사', keywords: ['암흑기사','암기'] },
        { name: '신성검사', keywords: ['신성검사','신검'] },
        { name: '광전사', keywords: ['광전사','광전'] },
        { name: '사신', keywords: ['사신'] },
        { name: '뇌신', keywords: ['뇌신'] },
        { name: '마검사', keywords: ['마검사','마검'] }
    ]
};
const normKey = (t) => String(t || '').replace(/\s+/g, '').toLowerCase();
const qarg = (t) => encodeURIComponent(String(t)).replace(/'/g, '%27');           // onclick="...('값')" 안에 안전하게 넣기 위한 인코딩

function catRules() {
    const v = state.catRules || {};
    return { type: (v.type && v.type.length) ? v.type : DEFAULT_CATS.type, job: (v.job && v.job.length) ? v.job : DEFAULT_CATS.job };
}
function normRules(v) {                                                          // DB 값 → 규칙 (깨진 값은 무시, 없는 묶음은 기본값 사용)
    const out = {};
    CAT_SETS.forEach(([g]) => {
        const arr = Object.values((v && v[g]) || {}).filter(c => c && typeof c === 'object' && String(c.name || '').trim());
        if (arr.length) out[g] = arr.map(c => ({ name: String(c.name).trim(), keywords: Object.values(c.keywords || {}).map(k => String(k).trim()).filter(Boolean) }));
    });
    return out;
}
// 아이템 이름 → { type: [분류이름…], job: [분류이름…] }. 더 긴 키워드 안에 들어 있는 짧은 키워드는 제외 ("용기사" 안의 "기사")
// 키워드로 자동 판단한 분류. 더 긴 키워드 안에 들어 있는 짧은 키워드는 제외 ("용기사" 안의 "기사")
function autoCatsOf(name) {
    const flat = normKey(name), rules = catRules(), out = { type: [], job: [] };
    CAT_SETS.forEach(([g]) => {
        const hits = [];
        rules[g].forEach(c => {
            const kws = (c.keywords || []).map(normKey).filter(k => k && flat.indexOf(k) >= 0).sort((a, b) => b.length - a.length);
            if (kws.length) hits.push({ name: c.name, kw: kws[0] });
        });
        out[g] = hits.filter(h => !hits.some(o => o !== h && o.kw.length > h.kw.length && o.kw.indexOf(h.kw) >= 0)).map(h => h.name);
    });
    return out;
}
// 관리 탭 [보스 아이템 설정]에서 아이템별로 직접 지정한 분류: 분류 이름 / NONE_CAT(없음) / ''(지정 안 함 = 자동)
const tagKey = (name) => normKey(name).replace(/[.$#\[\]\/]/g, '_').slice(0, 120);
function explicitTag(name, g) {
    const t = state.itemTags[tagKey(name)];
    const v = t ? t[g] : '';
    if (v === NONE_CAT) return NONE_CAT;
    return v && catRules()[g].some(c => c.name === v) ? v : '';
}
// 최종 분류 = 직접 지정한 것이 있으면 그것, 없으면 키워드 자동 판단
function itemCats(name) {
    const key = String(name || '');
    if (state.catCache[key]) return state.catCache[key];
    const out = autoCatsOf(key);
    CAT_SETS.forEach(([g]) => { const ex = explicitTag(key, g); if (ex === NONE_CAT) out[g] = []; else if (ex) out[g] = [ex]; });
    state.catCache[key] = out;
    return out;
}
function catTagLine(name) {                                                      // 보관함 카드에 붙이는 작은 분류 표시
    const c = itemCats(name), parts = c.type.concat(c.job);
    return parts.length ? `<div style="font-size:0.74rem; color:#8e44ad; margin-top:1px;">🏷️ ${parts.map(esc).join(' · ')}</div>` : '';
}
// 검색어(띄어쓰기로 여러 단어, 모두 포함) + 종류/직업 선택에 맞는지. skip: 칩 개수를 셀 때 그 묶음의 선택은 빼고 계산
function stPass(o, skip) {
    if (state.stQuery) {
        const hay = normKey([o.itemName, o.bossName, o.bossVariant, o.bossVariantName, o.winner, o.buyer].filter(Boolean).join(' '));
        if (!state.stQuery.split(/\s+/).map(normKey).filter(Boolean).every(t => hay.indexOf(t) >= 0)) return false;
    }
    const c = itemCats(o.itemName);
    for (const [g] of CAT_SETS) {
        if (g === skip) continue;
        const sel = state.stCat[g];
        if (!sel) continue;
        if (sel === NONE_CAT ? c[g].length > 0 : c[g].indexOf(sel) < 0) return false;
    }
    return true;
}
const stActiveCount = () => (state.stCat.type ? 1 : 0) + (state.stCat.job ? 1 : 0);
function stValidateSel() {                                                       // 분류 규칙이 바뀌어 없어진 분류를 선택 중이면 해제
    const rules = catRules();
    CAT_SETS.forEach(([g]) => { const sel = state.stCat[g]; if (sel && sel !== NONE_CAT && !rules[g].some(c => c.name === sel)) state.stCat[g] = ''; });
}

function ensureCatBar() {
    const bar = $('settle-storage-cats');
    if (!bar || $('settle-st-q')) return;
    bar.innerHTML = `
        <div style="display:flex; gap:6px; margin-bottom:6px;">
            <input type="search" id="settle-st-q" value="${esc(state.stQuery)}" placeholder="🔎 아이템·보스·획득자 검색 (띄어쓰기로 여러 단어)" oninput="Settle.setStQuery(this.value)" style="flex:1; min-width:0; margin:0; padding:9px 10px; border:2px solid #ddd; border-radius:8px; font-size:0.9rem; box-sizing:border-box;">
            <button id="settle-st-toggle" onclick="Settle.toggleCatPanel()" style="flex:none; padding:0 12px; border-radius:8px; font-weight:bold; font-size:0.85rem; cursor:pointer; white-space:nowrap;"></button>
        </div>
        <div id="settle-st-panel" style="display:none; background:#f8f9fa; border-radius:8px; padding:8px 10px; margin-bottom:6px;"></div>
        <div id="settle-st-summary" style="font-size:0.78rem; color:#7f8c8d; margin-bottom:8px; line-height:1.5;"></div>`;
}
// base: 상태/서버 필터까지만 적용한 목록 (칩의 개수 계산용), shown: 조건에 맞는 개수
function renderCatBar(base, shown) {
    ensureCatBar();
    const panel = $('settle-st-panel'), sum = $('settle-st-summary'), tog = $('settle-st-toggle');
    if (!panel || !sum || !tog) return;
    stValidateSel();
    const rules = catRules();
    let html = '';
    CAT_SETS.forEach(([g, label]) => {
        const cnt = {}; let none = 0;
        base.filter(o => stPass(o, g)).forEach(o => {
            const cs = itemCats(o.itemName)[g];
            if (!cs.length) none++; else cs.forEach(n => { cnt[n] = (cnt[n] || 0) + 1; });
        });
        const sel = state.stCat[g];
        const chips = rules[g].filter(c => cnt[c.name] || sel === c.name)
            .map(c => chip(esc(c.name) + ' ' + (cnt[c.name] || 0), sel === c.name, '#34495e', `Settle.setStCat('${g}', '${qarg(c.name)}')`));
        if (none || sel === NONE_CAT) chips.push(chip('기타 ' + none, sel === NONE_CAT, '#95a5a6', `Settle.setStCat('${g}', '${NONE_CAT}')`));
        html += `<div style="margin-bottom:8px;"><div style="font-size:0.76rem; font-weight:bold; color:#555; margin-bottom:4px;">${label}</div>
            <div style="display:flex; gap:5px; flex-wrap:wrap;">${chip('전체', !sel, '#5D6D7E', `Settle.setStCat('${g}', '')`)}${chips.join('')}</div></div>`;
    });
    const so = (v, t) => `<option value="${v}"${state.stSort === v ? ' selected' : ''}>${t}</option>`;
    html += `<div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
        <span style="font-size:0.78rem; color:#555; font-weight:bold;">정렬</span>
        <select id="settle-st-sort" onchange="Settle.setStSort(this.value)" style="width:auto; margin:0; padding:5px 8px; border:2px solid #ddd; border-radius:6px; font-size:0.82rem;">${so('recent', '최신순')}${so('old', '오래된순')}${so('name', '이름순')}${so('price', '낙찰가 높은순')}</select>
        ${actBtn('필터 초기화', 'Settle.clearStFilters()', '#95a5a6')}
    </div>`;
    panel.innerHTML = html;
    panel.style.display = state.stPanel ? 'block' : 'none';
    const n = stActiveCount();
    tog.textContent = '분류 ' + (state.stPanel ? '▴' : '▾') + (n ? ' ' + n : '');
    tog.style.cssText = 'flex:none; padding:0 12px; border-radius:8px; font-weight:bold; font-size:0.85rem; cursor:pointer; white-space:nowrap; ' + (n ? 'background:#34495e; color:white; border:2px solid #34495e;' : 'background:white; color:#34495e; border:2px solid #d5d8dc;');
    const act = [];
    CAT_SETS.forEach(([g, label]) => { const sel = state.stCat[g]; if (sel) act.push(label + ': <b>' + (sel === NONE_CAT ? '기타' : esc(sel)) + '</b>'); });
    sum.innerHTML = `조건에 맞는 아이템 <b>${shown}</b>개${shown !== base.length ? ' / 전체 ' + base.length + '개' : ''}${act.length ? ' · ' + act.join(' · ') : ''}${state.stQuery ? ' · 검색 "<b>' + esc(state.stQuery) + '</b>"' : ''}`;
}
const stMoreBtn = (total, shown) => total > shown ? `<div style="text-align:center; margin:8px 0 2px;">${actBtn('⬇️ 더 보기 (남은 ' + (total - shown) + '개)', 'Settle.moreStorage()', '#5D6D7E')}</div>` : '';

function setStQuery(v) { state.stQuery = String(v || '').trim(); state.stShow = STORAGE_PAGE; renderStorage(); }
function setStCat(g, v) {
    const val = v === '' ? '' : decodeURIComponent(v);
    state.stCat[g] = (val && state.stCat[g] === val) ? '' : val;                 // 이미 선택한 분류를 다시 누르면 해제
    state.stShow = STORAGE_PAGE;
    renderStorage();
}
function setStSort(v) { state.stSort = v; state.stShow = STORAGE_PAGE; renderStorage(); }
function toggleCatPanel() { state.stPanel = !state.stPanel; renderStorage(); }
function moreStorage() { state.stShow += STORAGE_PAGE; renderStorage(); }
function clearStFilters() {
    state.stQuery = ''; state.stCat = { type: '', job: '' }; state.stSort = 'recent'; state.stShow = STORAGE_PAGE;
    const q = $('settle-st-q'); if (q) q.value = '';
    renderStorage();
}

let tagsOn = false;
function ensureItemTags() {
    if (tagsOn || !depsOk()) return;
    tagsOn = true;
    db.ref('hunter_config/itemTags').on('value', snap => {
        const v = snap.val() || {};
        state.itemTags = {};
        Object.keys(v).forEach(k => { const t = v[k]; if (t && typeof t === 'object') state.itemTags[k] = { name: String(t.name || ''), type: t.type || '', job: t.job || '' }; });
        state.catCache = {}; stValidateSel(); renderStorage();
        if (state.adm) adminRender();                                              // 관리 탭 편집기의 선택칸도 최신 상태로
    });
}
let catRulesOn = false;
function ensureCatRules() {
    if (catRulesOn || !depsOk()) return;
    catRulesOn = true;
    db.ref('hunter_config/itemCategories').on('value', snap => { state.catRules = normRules(snap.val()); state.catCache = {}; stValidateSel(); renderStorage(); if (state.adm) adminRender(); });
}

// ── 분류 설정 (관리자 전용) ──
const catCountFor = (keywords) => {
    const ks = (keywords || []).map(normKey).filter(Boolean);
    if (!ks.length) return 0;
    return state.storage.filter(i => { const f = normKey(i.itemName); return ks.some(k => f.indexOf(k) >= 0); }).length;
};
function catUnclassified(g) {                                                    // 저장된 규칙으로 분류되지 않는 아이템 이름 (규칙을 보완할 때 참고)
    const seen = new Set(), names = [];
    state.storage.forEach(i => { const n = i.itemName; if (n && !seen.has(n)) { seen.add(n); if (!itemCats(n)[g].length) names.push(n); } });
    return names;
}
async function openCatSettings() {
    if (!(await requireAdmin())) return;
    state.catDraft = JSON.parse(JSON.stringify(catRules()));
    CAT_SETS.forEach(([g]) => state.catDraft[g].forEach(c => { c.orig = c.name; }));          // 이름을 바꾸는지 알아보기 위해 원래 이름을 기억
    renderCatEditor();
}
function catDraftSync() {                                                        // 입력칸에 적은 내용을 임시 편집본에 반영
    if (!state.catDraft) return;
    CAT_SETS.forEach(([g]) => {
        const rows = Array.from(document.querySelectorAll('#settle-cat-editor .cat-row[data-set="' + g + '"]'));
        if (!rows.length) return;
        state.catDraft[g] = rows.map(r => ({ name: r.querySelector('.cat-name').value.trim(), keywords: r.querySelector('.cat-kw').value.split(/[,\n]/).map(k => k.trim()).filter(Boolean), orig: r.dataset.orig || '' }));
    });
}
function renderCatEditor() {
    const d = state.catDraft;
    if (!d) return;
    const row = (g, c, i) => `<div class="cat-row" data-set="${g}" data-orig="${esc(c.orig || '')}" style="display:flex; gap:6px; align-items:center; margin-bottom:6px;">
        <input class="cat-name" value="${esc(c.name)}" maxlength="10" placeholder="이름" oninput="Settle.catRowCount(this)" style="width:78px; flex:none; margin:0; padding:7px 8px; border:2px solid #ddd; border-radius:6px; font-size:0.85rem; box-sizing:border-box;">
        <input class="cat-kw" value="${esc((c.keywords || []).join(', '))}" placeholder="키워드 (쉼표로 구분)" oninput="Settle.catRowCount(this)" style="flex:1; min-width:0; margin:0; padding:7px 8px; border:2px solid #ddd; border-radius:6px; font-size:0.85rem; box-sizing:border-box;">
        <span class="cat-cnt" style="font-size:0.72rem; color:#7f8c8d; width:34px; text-align:right; flex:none;">${catCountFor(c.keywords)}개</span>
        <button onclick="Settle.catDelRow('${g}', ${i})" style="width:26px; height:26px; border-radius:50%; border:none; background:#e74c3c; color:white; cursor:pointer; font-size:12px; flex:none;">✕</button></div>`;
    const sec = ([g, label]) => {
        const un = catUnclassified(g);
        return `<div style="margin-bottom:14px;">
            <div style="font-size:0.9rem; font-weight:bold; color:#2c3e50; margin-bottom:4px;">${label} 분류</div>
            ${d[g].map((c, i) => row(g, c, i)).join('')}
            <div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap;">${actBtn('➕ 분류 추가', `Settle.catAddRow('${g}')`, '#5D6D7E')}
                <span style="font-size:0.74rem; color:#95a5a6;">아이템 이름에 키워드가 들어 있으면 그 분류로 묶입니다.</span></div>
            ${un.length ? `<div style="font-size:0.74rem; color:#d35400; margin-top:4px; line-height:1.5;">분류 안 된 아이템 ${un.length}종: ${un.slice(0, 8).map(esc).join(', ')}${un.length > 8 ? ' 외 ' + (un.length - 8) + '종' : ''}</div>` : ''}
        </div>`;
    };
    showModal(`
        <h3 style="margin:0 0 4px; color:#2c3e50;">🏷️ 아이템 분류 설정</h3>
        <p style="font-size:0.8rem; color:#7f8c8d; margin:0 0 10px; line-height:1.5;">보관함에서 아이템을 분류별로 걸러 볼 수 있게 이름과 키워드를 정합니다. 오른쪽 숫자는 지금 보관함에서 그 키워드에 해당하는 아이템 수입니다. (관리자만 변경)</p>
        <div id="settle-cat-editor" style="max-height:52vh; overflow-y:auto; padding-right:2px;">${CAT_SETS.map(sec).join('')}</div>
        <div style="display:flex; gap:8px; margin-top:12px;">
            ${actBtn('저장', 'Settle.saveCatSettings()', '#8e44ad').replace('padding:6px 11px', 'flex:1; padding:11px')}
            ${actBtn('기본값으로', 'Settle.resetCatSettings()', '#7f8c8d').replace('padding:6px 11px', 'padding:11px')}
            ${actBtn('취소', 'Settle.closeModal()', '#95a5a6').replace('padding:6px 11px', 'padding:11px')}
        </div>`);
}
function catRowCount(el) {
    const r = el.closest('.cat-row');
    if (!r) return;
    const kws = r.querySelector('.cat-kw').value.split(/[,\n]/).map(k => k.trim()).filter(Boolean);
    r.querySelector('.cat-cnt').textContent = catCountFor(kws) + '개';
}
function catAddRow(g) { catDraftSync(); if (state.catDraft) { state.catDraft[g].push({ name: '', keywords: [] }); renderCatEditor(); } }
function catDelRow(g, i) { catDraftSync(); if (state.catDraft) { state.catDraft[g].splice(i, 1); renderCatEditor(); } }
async function saveCatSettings() {
    catDraftSync();
    const d = state.catDraft;
    if (!d) return;
    const out = {};
    for (const [g, label] of CAT_SETS) {
        const list = d[g] || [];
        if (!list.length) { alert(label + ' 분류가 비어 있습니다. 최소 1개는 있어야 합니다. (쓰지 않으려면 키워드를 비워 두세요)'); return; }
        if (list.length > 40) { alert(label + ' 분류는 최대 40개까지입니다.'); return; }
        const seen = new Set();
        for (const c of list) {
            if (!c.name) { alert(label + ' 분류의 이름을 입력하세요.'); return; }
            const key = c.name.toLowerCase();
            if (seen.has(key)) { alert(label + ' 분류 이름이 겹칩니다: ' + c.name); return; }
            seen.add(key);
            if (c.keywords.some(k => k.length > 20)) { alert('키워드는 20자 이내로 입력하세요. (' + c.name + ')'); return; }
        }
        out[g] = list.map(c => ({ name: c.name, keywords: c.keywords }));
    }
    // 이름만 바꾼 분류는 "이름 변경"으로 보고, 그 분류로 직접 지정한 아이템도 함께 옮김. 삭제된 분류는 영향을 안내
    const renames = [], removed = [], oldRules = catRules();
    CAT_SETS.forEach(([g]) => {
        const newNames = out[g].map(c => c.name);
        d[g].forEach(c => { if (c.orig && c.orig !== c.name && !newNames.includes(c.orig)) renames.push({ g: g, from: c.orig, to: c.name }); });
        oldRules[g].forEach(c => { if (!newNames.includes(c.name) && !renames.some(r => r.g === g && r.from === c.name)) removed.push({ g: g, name: c.name }); });
    });
    const carried = (g, nm) => Object.keys(state.itemTags).filter(k => state.itemTags[k][g] === nm);
    let msg = '';
    renames.forEach(r => { const n = carried(r.g, r.from).length; if (n) msg += `\n· 이름 변경 "${r.from}" → "${r.to}": 직접 지정한 아이템 ${n}개도 함께 바뀝니다.`; });
    removed.forEach(r => { const n = carried(r.g, r.name).length; if (n) msg += `\n· "${r.name}" 삭제: 직접 지정한 아이템 ${n}개는 자동 분류(키워드)로 돌아갑니다.`; });
    if (msg && !confirm('분류를 바꾸면 아이템 분류에 영향이 있습니다.' + msg + '\n\n계속할까요?')) return;
    if (!(await requireAdmin())) return;                                         // 저장 시점에도 관리자 확인
    try {
        const updates = { 'hunter_config/itemCategories': JSON.stringify(out) === JSON.stringify(DEFAULT_CATS) ? null : out };
        renames.forEach(r => carried(r.g, r.from).forEach(k => { updates['hunter_config/itemTags/' + k + '/' + r.g] = r.to; }));
        await db.ref().update(updates);
        state.catDraft = null;
        closeModal();
    } catch (e) { alert('❌ 저장 실패: ' + e.message); }
}
async function resetCatSettings() {
    if (!confirm('분류를 기본값으로 되돌릴까요?\n(직접 추가·수정한 분류와 키워드가 모두 사라집니다)')) return;
    if (!(await requireAdmin())) return;
    try { await db.ref('hunter_config/itemCategories').remove(); state.catDraft = null; closeModal(); } catch (e) { alert('❌ 저장 실패: ' + e.message); }
}


function renderStorage() {
    const acts = $('settle-storage-actions'), fil = $('settle-storage-filters'), box = $('settle-storage-list');
    if (!box) return;
    const mg = canManage();
    stValidateSel();                                                                   // 분류 규칙이 바뀌어 사라진 분류를 선택 중이면, 목록을 계산하기 전에 먼저 해제
    acts.innerHTML = (isAdmin ? actBtn('👤 담당자 설정', 'Settle.openManagers()', '#8e44ad') + actBtn('🏷️ 분류 설정', 'Settle.openCatSettings()', '#8e44ad') : '')
                   + (mg ? actBtn('💰 입찰/판매', 'Settle.openAuction()', '#e67e22') : '');
    fil.innerHTML =
        chip('전체', state.stFilter === 'all', '#5D6D7E', "Settle.setStorageFilter('all')")
        + chip('보관중', state.stFilter === 'pending', '#e67e22', "Settle.setStorageFilter('pending')")
        + chip('판매완료', state.stFilter === 'sold', '#27ae60', "Settle.setStorageFilter('sold')")
        + chip('미전달' + (state.undelivLoaded ? ' ' + notInStorage().length : ''), state.stFilter === 'undelivered', '#d35400', "Settle.setStorageFilter('undelivered')")
        + '<span style="color:#ddd;">|</span>'
        + chip('전서버', !state.stServer, '#95a5a6', "Settle.setStorageServer('')")
        + Object.keys(SERVERS).map(k => chip(SERVERS[k].name, state.stServer === k, SERVERS[k].color, `Settle.setStorageServer('${k}')`)).join('');

    if (state.stFilter === 'undelivered') { renderUndelivered(box); return; }

    const base = state.storage.filter(i => {
        if (state.stFilter === 'pending' && i.sold) return false;
        if (state.stFilter === 'sold' && !i.sold) return false;
        if (state.stServer && i.bossServer !== state.stServer) return false;
        return true;
    });
    const byRecent = (a, b) => String(b.addedAt || '').localeCompare(String(a.addedAt || ''));
    const sorter = state.stSort === 'old' ? (a, b) => -byRecent(a, b)
        : state.stSort === 'name' ? (a, b) => koCmp(a.itemName, b.itemName) || byRecent(a, b)
        : state.stSort === 'price' ? (a, b) => (Number(b.bidPrice) || 0) - (Number(a.bidPrice) || 0) || byRecent(a, b)
        : byRecent;
    const list = base.filter(i => stPass(i)).sort(sorter);
    renderCatBar(base, list.length);

    const pendingN = state.storage.filter(i => !i.sold).length;
    const soldTotal = state.storage.filter(i => i.sold).reduce((t, i) => t + (Number(i.bidPrice) || 0), 0);
    const waiting = unsettledItems().reduce((t, i) => t + (Number(i.bidPrice) || 0), 0);
    const tile = (label, val, bg, color, sub) => `<div style="flex:1; background:${bg}; border-radius:8px; padding:8px; text-align:center;"><div style="font-size:0.74rem; color:#7f8c8d;">${label}</div><div style="font-size:1.05rem; font-weight:bold; color:${color};">${val}</div>${sub ? `<div style="font-size:0.7rem; color:#7f8c8d; margin-top:2px;">${sub}</div>` : ''}</div>`;
    const head = `<div style="display:flex; gap:8px; margin-bottom:10px;">${tile('보관중', pendingN + '개', '#e8f4fd', '#2980b9')}${tile('아이템 판매 금액', fmt(soldTotal) + ' ' + UNIT, '#d5f4e6', '#27ae60', soldTotal ? (waiting ? '정산 대기 ' + fmt(waiting) : '모두 정산됨') : '')}</div>`;

    if (!list.length) { box.innerHTML = head + '<p style="color:#95a5a6; text-align:center; padding:14px; margin:0; font-size:0.88rem;">조건에 맞는 아이템이 없습니다.</p>'; return; }
    box.innerHTML = head + list.slice(0, state.stShow).map(it => {
        const k = sid(it.id);
        const sold = !!it.sold;
        const btns = [];
        if (mg && !sold) btns.push(actBtn('💰 입찰', `Settle.openAuction('${k}')`, '#e67e22'));
        if (mg && !sold) btns.push(actBtn('🗑️', `Settle.deleteStorage('${k}')`, '#e74c3c'));
        if (mg && sold && !it.settledId) btns.push(actBtn('↩️ 판매 취소', `Settle.unsell('${k}')`, '#7f8c8d'));
        return `
        <div style="border:2px solid ${sold ? '#a9dfbf' : '#e0e0e0'}; border-radius:8px; padding:10px 12px; margin-bottom:8px; background:${sold ? '#f0fff4' : 'white'};">
            <div style="display:flex; justify-content:space-between; gap:8px; flex-wrap:wrap;">
                <div style="flex:1; min-width:150px;">
                    <div style="font-weight:bold; color:#2c3e50;">${esc(it.itemName)} ${sold ? badge(it.settledId ? '정산완료' : '판매완료', it.settledId ? '#16a085' : '#27ae60') : ''}</div>
                    ${catTagLine(it.itemName)}
                    <div style="font-size:0.8rem; color:#666;">📅 ${esc(it.date)} ⚔️ ${esc(it.bossName)}${it.bossVariant ? ` <span style="display:inline-block; padding:1px 6px; border-radius:4px; background:#f4ecf7; color:#6c3483; font-size:0.72rem; font-weight:bold;">${esc(it.bossVariant)}${it.bossVariantName ? ' · ' + esc(it.bossVariantName) : ''}</span>` : ''}${serverBadge(it.bossServer)}</div>
                    <div style="font-size:0.8rem; color:#666;">획득: <b>${esc(it.winner)}</b>${sold ? ` → 낙찰: <b>${esc(it.buyer)}</b> <span style="color:#2980b9; font-weight:bold;">${fmt(it.bidPrice)} ${UNIT}</span>` : ''}</div>
                </div>
                <div style="display:flex; gap:6px; align-items:center;">${btns.join('')}</div>
            </div>
        </div>`;
    }).join('') + stMoreBtn(list.length, state.stShow);
}

async function deleteStorage(k) {
    const it = stById(k);
    if (!it) return;
    if (!(await requireManage())) return;
    if (it.sold) { alert('판매된 아이템은 삭제할 수 없습니다.'); return; }
    if (!confirm(`"${it.itemName}" 을(를) 보관함에서 삭제할까요?\n(드랍 기록은 "미전달" 상태로 돌아갑니다)`)) return;
    const updates = {};
    updates['boss_storage/' + it.id] = null;
    if (it.dropPath) { updates[it.dropPath + '/inStorage'] = false; updates[it.dropPath + '/delivered'] = false; }
    try { await db.ref().update(updates); state.undelivStale = true; } catch (e) { alert('❌ 삭제 실패: ' + e.message); }
}

// ============================================================
// 📭 미전달 아이템 — 담당자에게 아직 전달되지 않아 보관함에 없는 드랍
//   boss_drops 의 키가 "날짜_일정ID" 이므로 최근 UNDELIV_DAYS 일만 키 범위로 읽음 (전체를 읽지 않음)
// ============================================================
const UNDELIV_DAYS = 45;

async function loadUndelivered() {
    if (state.undelivLoading) return;
    state.undelivLoading = true;
    renderStorage();
    const from = ymdOf(new Date(Date.now() - UNDELIV_DAYS * 86400000));
    try {
        const snap = await db.ref('boss_drops').orderByKey().startAt(from).once('value');
        const list = [];
        snap.forEach(ch => {
            const pk = String(ch.key);
            if (pk.slice(0, 10) < from) return;
            const items = (ch.val() || {}).items || {};
            Object.keys(items).forEach(k => {
                const v = items[k];
                if (!v || typeof v !== 'object') return;
                const bossId = v.bossId || pk.slice(11);                      // 예전 기록은 날짜/보스ID 가 키에만 있음
                const sch = getSchedules().find(b => b.id === bossId);
                list.push(Object.assign({}, v, {
                    id: v.id != null ? v.id : k, _k: k, _pk: pk,
                    date: v.date || pk.slice(0, 10), bossId: bossId, bossName: v.bossName || (sch ? sch.name : '')
                }));
            });
        });
        state.undeliv = list;
        state.undelivLoaded = true;
        state.undelivStale = false;
    } catch (e) {
        alert('❌ 미전달 목록을 불러오지 못했습니다: ' + e.message);
    }
    state.undelivLoading = false;
    renderStorage();
}
function reloadUndelivered() { loadUndelivered(); }

// 보관함에 없는 드랍 (= 아직 담당자에게 전달되지 않았거나, 예전 방식으로 전달완료만 체크된 것)
function notInStorage() {
    return state.undeliv.filter(d => !(state.storageLoaded ? !!stById(d.id) : d.delivered === true));
}
function undeliveredList() {
    return notInStorage()
        .filter(d => !state.stServer || (d.bossServer || d.winnerServer) === state.stServer)
        .sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')));      // 오래 못 전달한 것부터
}

function renderUndelivered(box) {
    if (state.undelivLoading && !state.undelivLoaded) {
        box.innerHTML = '<p style="color:#95a5a6; text-align:center; padding:14px; margin:0; font-size:0.88rem;">미전달 목록을 불러오는 중...</p>';
        return;
    }
    const mg = canManage();
    const allU = undeliveredList();
    const list = allU.filter(d => stPass(d));
    renderCatBar(allU, list.length);
    const today = ymdOf(nowD());
    const ago = (ds) => {
        const n = Math.round((new Date(today + 'T00:00:00') - new Date(ds + 'T00:00:00')) / 86400000);
        return n <= 0 ? '오늘' : n + '일 전';
    };
    const head = `<div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:8px;">
        <div style="font-size:0.85rem; font-weight:bold; color:#d35400;">📭 아직 전달되지 않은 아이템 ${list.length}건${list.length !== allU.length ? ' / 전체 ' + allU.length + '건' : ''} <span style="font-weight:normal; color:#95a5a6; font-size:0.76rem;">(최근 ${UNDELIV_DAYS}일)</span></div>
        ${actBtn('🔄 새로고침', 'Settle.reloadUndelivered()', '#5D6D7E')}
    </div>`;
    if (!list.length) { box.innerHTML = head + '<p style="color:#95a5a6; text-align:center; padding:14px; margin:0; font-size:0.88rem;">' + (allU.length ? '조건에 맞는 미전달 아이템이 없습니다.' : '미전달 아이템이 없습니다. 👍') + '</p>'; return; }
    box.innerHTML = head + list.slice(0, state.stShow).map(d => {
        const pk = sid(d._pk), kk = sid(d._k);
        const marked = d.delivered === true;                 // 전달완료로 표시됐지만 보관함에는 없는 경우
        return `
        <div style="border:2px solid ${marked ? '#f5cba7' : '#f0e6cc'}; border-radius:8px; padding:10px 12px; margin-bottom:8px; background:white;">
            <div style="display:flex; justify-content:space-between; gap:8px; flex-wrap:wrap;">
                <div style="flex:1; min-width:150px;">
                    <div style="font-weight:bold; color:#2c3e50;">${esc(d.itemName)} ${marked ? badge('보관함 미등록', '#e67e22') : badge('미전달', '#d35400')}</div>
                    ${catTagLine(d.itemName)}
                    <div style="font-size:0.8rem; color:#666;">📅 ${esc(d.date)} (${ago(d.date)}) ⚔️ ${esc(d.bossName)}${d.bossVariant ? ` <span style="display:inline-block; padding:1px 6px; border-radius:4px; background:#f4ecf7; color:#6c3483; font-size:0.72rem; font-weight:bold;">${esc(d.bossVariant)}${d.bossVariantName ? ' · ' + esc(d.bossVariantName) : ''}</span>` : ''}</div>
                    <div style="font-size:0.8rem; color:#666;">획득: <b>${esc(d.winner)}</b>${serverBadge(d.bossServer || d.winnerServer)}</div>
                    ${marked ? '<div style="font-size:0.75rem; color:#e67e22; margin-top:2px;">전달완료로 표시되어 있지만 보관함에는 없습니다.' + (mg ? ' [전달 확인]을 누르면 보관함에 등록됩니다.' : '') + '</div>' : ''}
                </div>
                <div style="display:flex; gap:6px; align-items:center;">${mg ? actBtn('✅ 전달 확인', `Settle.confirmDelivery('${pk}', '${kk}')`, '#16a085') + actBtn('🗑️', `Settle.deleteUndelivered('${pk}', '${kk}')`, '#e74c3c') : ''}</div>
            </div>
        </div>`;
    }).join('') + stMoreBtn(list.length, state.stShow) + (mg ? '' : '<p style="font-size:0.78rem; color:#7f8c8d; margin:6px 0 0;">ℹ️ 전달 확인은 관리자·담당자만 할 수 있습니다.</p>');
}

const findUndeliv = (pk, k) => state.undeliv.find(d => sid(d._pk) === pk && sid(d._k) === k);

// 전달 확인 = 담당자가 받아서 보관함에 등록 (드랍 카드의 ✅ 전달완료 체크와 같은 처리)
async function confirmDelivery(pk, k) {
    const d = findUndeliv(pk, k);
    if (!d) return;
    if (!(await requireManage())) return;
    const st = await stFresh(d.id);
    const base = 'boss_drops/' + d._pk + '/items/' + d._k;
    const updates = {};
    updates[base + '/delivered'] = true;
    updates[base + '/inStorage'] = true;
    if (!st) updates['boss_storage/' + d.id] = storageFromDrop(d);
    try {
        await db.ref().update(updates);
        d.delivered = true; d.inStorage = true;
        renderStorage();
    } catch (e) { alert('❌ 저장 실패: ' + e.message); }
}

async function deleteUndelivered(pk, k) {
    const d = findUndeliv(pk, k);
    if (!d) return;
    if (!(await requireManage())) return;
    const st = await stFresh(d.id);
    if (st && st.sold) { alert('판매된 아이템은 삭제할 수 없습니다.'); return; }
    if (!confirm(`"${d.itemName}" 드랍 기록을 삭제할까요?`)) return;
    const updates = {};
    updates['boss_drops/' + d._pk + '/items/' + d._k] = null;
    updates['boss_storage/' + d.id] = null;
    try {
        await db.ref().update(updates);
        state.undeliv = state.undeliv.filter(x => x !== d);
        renderStorage();
    } catch (e) { alert('❌ 삭제 실패: ' + e.message); }
}


// ── 입찰/판매 ─────────────────────────────────────────────
function openAuction(preId) {
    if (!canManage()) return;
    const pending = state.storage.filter(i => !i.sold);
    if (!pending.length) { alert('판매할 수 있는 보관 중인 아이템이 없습니다.'); return; }
    const buyers = getUsers().slice().sort((a, b) => koCmp(a.name, b.name));
    const lab = 'font-size:0.85rem; font-weight:bold; color:#555; display:block; margin:10px 0 4px;';
    showModal(`
        <h3 style="margin:0 0 6px; color:#2c3e50;">💰 입찰/판매 등록</h3>
        <label style="${lab}">아이템</label>
        <select id="settle-au-item" style="${inputStyle}">
            ${pending.map(i => `<option value="${esc(sid(i.id))}"${sid(i.id) === sid(preId) ? ' selected' : ''}>${esc(i.itemName)} (${esc(i.date)} ${esc(i.bossName)})</option>`).join('')}
        </select>
        <label style="${lab}">낙찰가 (${UNIT})</label>
        <input type="number" id="settle-au-price" min="1" step="1" placeholder="예: 800" style="${inputStyle}">
        <label style="${lab}">낙찰자</label>
        <select id="settle-au-buyer" style="${inputStyle}">
            <option value="">낙찰자 선택</option>
            ${buyers.map(u => `<option value="${Number(u.id)}">${esc(u.name)}</option>`).join('')}
        </select>
        <div style="display:flex; gap:8px; margin-top:16px;">
            ${actBtn('✅ 판매 확정', 'Settle.confirmAuction()', '#e67e22').replace('padding:6px 11px', 'flex:1; padding:11px')}
            ${actBtn('취소', 'Settle.closeModal()', '#95a5a6').replace('padding:6px 11px', 'flex:1; padding:11px')}
        </div>`);
}

async function confirmAuction() {
    const k = $('settle-au-item').value;
    const price = parseInt($('settle-au-price').value);
    const buyer = userById(parseInt($('settle-au-buyer').value));
    const it = stById(k);
    if (!it)            { alert('아이템을 선택하세요.'); return; }
    if (!(price > 0))   { alert('낙찰가를 입력하세요.'); return; }
    if (!buyer)         { alert('낙찰자를 선택하세요.'); return; }
    if (!(await requireManage())) return;
    if (it.sold)        { alert('이미 판매된 아이템입니다.'); return; }
    try {
        await db.ref('boss_storage/' + it.id).update({ sold: true, bidPrice: price, buyer: buyer.name, buyerId: Number(buyer.id), soldAt: nowIso() });
        closeModal();
    } catch (e) { alert('❌ 저장 실패: ' + e.message); }
}

async function unsell(k) {
    const it = stById(k);
    if (!it || !it.sold) return;
    if (!(await requireManage())) return;
    if (it.settledId) { alert('이미 정산된 아이템입니다. 정산 내역에서 정산을 취소한 뒤에 가능합니다.'); return; }
    if (!confirm(`"${it.itemName}" 판매를 취소할까요? (낙찰 정보가 지워집니다)`)) return;
    try {
        await db.ref('boss_storage/' + it.id).update({ sold: false, bidPrice: 0, buyer: '', buyerId: null, soldAt: null });
    } catch (e) { alert('❌ 저장 실패: ' + e.message); }
}

// ── 담당자 설정 ───────────────────────────────────────────
async function openManagers() {
    if (!(await requireAdmin())) return;
    const list = getUsers().slice().sort((a, b) => koCmp(a.name, b.name));
    showModal(`
        <h3 style="margin:0 0 4px; color:#2c3e50;">👤 보관함 담당자 설정</h3>
        <p style="font-size:0.8rem; color:#7f8c8d; margin:0 0 10px;">담당자가 아이템을 획득하면 전달완료(보관함 등록)가 자동 처리되고, 담당자는 전달 확인·입찰·정산을 직접 처리할 수 있습니다.</p>
        <input type="text" id="settle-mgr-search" placeholder="이름 검색" oninput="Settle.filterManagerRows()" style="${inputStyle} margin-bottom:8px;">
        <div id="settle-mgr-list" style="max-height:46vh; overflow-y:auto; border:1px solid #eee; border-radius:8px;">
            ${list.map(u => `<label class="settle-mgr-row" data-name="${esc(u.name)}" style="display:flex; align-items:center; gap:8px; padding:8px 10px; border-bottom:1px solid #f3f3f3; cursor:pointer;">
                <input type="checkbox" style="${cbStyle}" value="${Number(u.id)}" ${state.managers.includes(Number(u.id)) ? 'checked' : ''}> ${esc(u.name)}${serverBadge(u.server)}</label>`).join('')}
        </div>
        <div style="display:flex; gap:8px; margin-top:14px;">
            ${actBtn('저장', 'Settle.saveManagers()', '#8e44ad').replace('padding:6px 11px', 'flex:1; padding:11px')}
            ${actBtn('취소', 'Settle.closeModal()', '#95a5a6').replace('padding:6px 11px', 'flex:1; padding:11px')}
        </div>`);
}
function filterManagerRows() {
    const q = ($('settle-mgr-search').value || '').trim();
    document.querySelectorAll('#settle-mgr-list .settle-mgr-row').forEach(r => {
        r.style.display = (!q || (r.dataset.name || '').includes(q)) ? 'flex' : 'none';
    });
}
async function saveManagers() {
    const ids = Array.from(document.querySelectorAll('#settle-mgr-list input[type=checkbox]')).filter(c => c.checked).map(c => Number(c.value));
    try {
        await db.ref('hunter_config/storageManagers').set(ids);
        closeModal();
    } catch (e) { alert('❌ 저장 실패: ' + e.message); }
}

// ── 지원조 설정 (관리자 전용) ───────────────────────────────
async function openSupportTeam() {
    if (!(await requireAdmin())) return;
    const list = getUsers().slice().sort((a, b) => koCmp(a.name, b.name));
    showModal(`
        <h3 style="margin:0 0 4px; color:#2c3e50;">🤝 지원조 설정</h3>
        <p style="font-size:0.8rem; color:#7f8c8d; margin:0 0 10px; line-height:1.5;">정산 계산에서 [지원조 비율]을 고르면, 여기서 지정한 사람들이 정해진 비율(%)만큼을 받고 나머지 인원은 그 비율을 뺀 나머지를 나눠 받습니다. 지원조 명단은 관리자만 바꿀 수 있습니다.</p>
        <input type="text" id="settle-sup-search" placeholder="이름 검색" oninput="Settle.filterSupportRows()" style="${inputStyle} margin-bottom:8px;">
        <div id="settle-sup-list" style="max-height:46vh; overflow-y:auto; border:1px solid #eee; border-radius:8px;">
            ${list.map(u => `<label class="settle-sup-row" data-name="${esc(u.name)}" style="display:flex; align-items:center; gap:8px; padding:8px 10px; border-bottom:1px solid #f3f3f3; cursor:pointer;">
                <input type="checkbox" style="${cbStyle}" value="${Number(u.id)}" ${state.supportTeam.includes(Number(u.id)) ? 'checked' : ''}> ${esc(u.name)}${serverBadge(u.server)}</label>`).join('')}
        </div>
        <div style="display:flex; gap:8px; margin-top:14px;">
            ${actBtn('저장', 'Settle.saveSupportTeam()', '#8e44ad').replace('padding:6px 11px', 'flex:1; padding:11px')}
            ${actBtn('취소', 'Settle.closeModal()', '#95a5a6').replace('padding:6px 11px', 'flex:1; padding:11px')}
        </div>`);
}
function filterSupportRows() {
    const q = ($('settle-sup-search').value || '').trim();
    document.querySelectorAll('#settle-sup-list .settle-sup-row').forEach(r => { r.style.display = !q || r.dataset.name.indexOf(q) >= 0 ? 'flex' : 'none'; });
}
async function saveSupportTeam() {
    if (!(await requireAdmin())) return;                       // 저장 시점에도 관리자 확인
    const ids = Array.from(document.querySelectorAll('#settle-sup-list input[type=checkbox]')).filter(c => c.checked).map(c => Number(c.value));
    try {
        await db.ref('hunter_config/supportTeam').set(ids.length ? ids : null);
        closeModal();
    } catch (e) { alert('❌ 저장 실패: ' + e.message); }
}


// ============================================================
// 📊 정산 (균등 배분 / 대상자 선택 / 중복 정산 방지)
// ============================================================
function unsettledItems() {
    return state.storage.filter(i => i.sold && !i.settledId && Number(i.bidPrice) > 0);
}
function calcItems() {
    const ids = state.calcItemIds.map(sid);
    const items = state.storage.filter(i => ids.includes(sid(i.id)) && i.sold && !i.settledId);
    return { items: items, total: items.reduce((s, i) => s + (Number(i.bidPrice) || 0), 0) };
}
// 총액을 n명에게 나누고 남는 금액은 이름순 앞 사람부터 1씩 (인원 간 차이는 최대 1)
// ── 정산 분배 계산 ──────────────────────────────────────────
// 1) 직접 지정한 금액(특정인에게 주는 금액)을 총액에서 먼저 뺌
// 2) 남은 금액을 방식대로 분배: 균등 / 서버별 비율(조건 = 서버, 비율 = %, 각 서버 몫 안에서는 균등)
// 3) 받을 사람이 없는 서버의 몫은 "미배분"(혈 귀속)으로 따로 표시. 정수(다이아) 단위, 남는 1은 이름순 앞사람부터
const RATIO_GROUPS = [['jingir', '진기르'], ['pandora', '판도라'], ['support', '지원'], ['other', '서버 없음']];
const groupOf = (u) => (SERVERS[u.server] ? u.server : 'other');
const sumOf = (arr) => arr.reduce((a, b) => a + b, 0);

function computeSplit(total, recips, mode, ratios, fixed, opts) {
    const warnings = [], errors = [];
    const rows = recips.slice().sort((a, b) => koCmp(a.name, b.name))
        .map(u => ({ userId: Number(u.id), name: u.name, server: u.server || '', group: groupOf(u), team: !!(opts && opts.supportIds && opts.supportIds.has(Number(u.id))), amount: 0, fixed: false }));
    let fixedSum = 0;
    rows.forEach(r => {
        const f = fixed ? fixed[r.userId] : undefined;
        if (f !== undefined && f !== null && f !== '' && !isNaN(Number(f))) { r.fixed = true; r.amount = Math.max(0, Math.floor(Number(f))); fixedSum += r.amount; }
    });
    const ratioSum = sumOf(RATIO_GROUPS.map(([g]) => Number(ratios && ratios[g]) || 0));
    let pool = total - fixedSum, unallocated = 0;
    if (!rows.length) errors.push('정산 대상자를 1명 이상 선택하세요.');
    if (pool < 0) { errors.push(`직접 지정한 금액 합계(${fmt(fixedSum)})가 총액(${fmt(total)})보다 큽니다.`); pool = 0; }
    const auto = rows.filter(r => !r.fixed);
    if (rows.length && !auto.length) {
        unallocated = pool;
        if (pool > 0) warnings.push(`전원 금액을 직접 지정해서 남은 ${fmt(pool)} ${UNIT}은 배분되지 않습니다. (미배분)`);
    } else if (auto.length && mode !== 'ratio' && mode !== 'support') {
        const base = Math.floor(pool / auto.length);
        let rem = pool - base * auto.length;
        auto.forEach(r => { r.amount = base + (rem-- > 0 ? 1 : 0); });
    } else if (auto.length && mode === 'ratio') {
        if (Math.abs(ratioSum - 100) > 0.01) errors.push(`서버별 비율의 합계가 ${Math.round(ratioSum * 100) / 100}%입니다. 100%로 맞춰주세요.`);
        const gs = RATIO_GROUPS.map(([g]) => g);
        const exact = gs.map(g => pool * (Number(ratios[g]) || 0) / 100);
        const pools = exact.map(Math.floor);
        let left = pool - sumOf(pools);                                      // 소수점 정리: 소수 부분이 큰 서버부터 1씩
        const order = gs.map((g, i) => ({ i: i, frac: exact[i] - pools[i] })).filter(o => exact[o.i] > 0).sort((a, b) => b.frac - a.frac || a.i - b.i);
        for (let k = 0; left > 0 && order.length && Math.abs(ratioSum - 100) <= 0.01; k++, left--) pools[order[k % order.length].i]++;
        gs.forEach((g, gi) => {
            const members = auto.filter(r => r.group === g);
            const share = pools[gi];
            if (!members.length) {
                if (share > 0) {
                    unallocated += share;
                    warnings.push(`${RATIO_GROUPS[gi][1]} 몫 ${fmt(share)} ${UNIT}은 받을 사람이 없어 미배분입니다.`);
                }
                return;
            }
            const base = Math.floor(share / members.length);
            let rem = share - base * members.length;
            members.forEach(r => { r.amount = base + (rem-- > 0 ? 1 : 0); });
            if (share === 0 && pool > 0 && members.length) warnings.push(`${RATIO_GROUPS[gi][1]} ${members.length}명은 비율이 0%라 받는 금액이 없습니다.`);
        });
    }
    if (auto.length && mode === 'support') {                        // 지원조 몫(%) / 나머지 인원은 나머지(100−%)에서 균등 — 직접 지정 금액을 뺀 뒤의 금액 기준
        const raw = Number(opts && opts.supportPct);
        if (isNaN(raw) || raw < 0 || raw > 100) errors.push('지원조 비율은 0~100% 사이로 입력하세요.');
        const tp = Math.min(100, Math.max(0, isNaN(raw) ? 0 : raw));
        const exact = [pool * tp / 100, pool * (100 - tp) / 100];
        const pools = exact.map(Math.floor);
        let left = pool - pools[0] - pools[1];                              // 소수점 정리: 소수 부분이 큰 쪽부터 1씩
        const ord = [0, 1].filter(i => exact[i] > 0).sort((a, b) => (exact[b] - pools[b]) - (exact[a] - pools[a]) || a - b);
        for (let k = 0; left > 0 && ord.length; k++, left--) pools[ord[k % ord.length]]++;
        [[0, '지원조', auto.filter(r => r.team)], [1, '나머지 인원', auto.filter(r => !r.team)]].forEach(([i, nm, members]) => {
            const share = pools[i];
            if (!members.length) {
                if (share > 0) { unallocated += share; warnings.push(`${nm} 몫 ${fmt(share)} ${UNIT}은 받을 사람이 없어 미배분입니다.`); }
                return;
            }
            const base = Math.floor(share / members.length);
            let rem = share - base * members.length;
            members.forEach(r => { r.amount = base + (rem-- > 0 ? 1 : 0); });
            if (share === 0 && pool > 0) warnings.push(`${nm} ${members.length}명은 비율이 0%라 받는 금액이 없습니다.`);
        });
    }
    const paid = sumOf(rows.map(r => r.amount));
    return { rows: rows, unallocated: unallocated, fixedSum: fixedSum, pool: pool, ratioSum: ratioSum, warnings: warnings, errors: errors, valid: errors.length === 0, paid: paid, balanced: paid + unallocated === total };
}

function calcCurrent() {
    const { items, total } = calcItems();
    const recips = getUsers().filter(u => state.recipients.has(Number(u.id)));
    const opts = { supportIds: new Set(state.supportTeam.map(Number)), supportPct: state.calcSupportPct };
    return Object.assign({ items: items, total: total, recips: recips }, computeSplit(total, recips, state.calcMode, state.calcRatios, state.calcFixed, opts));
}
const calcModeText = (mode, ratios, supportPct) => mode === 'support'
    ? '지원조 비율 (지원조 ' + (Math.round(Number(supportPct) * 100) / 100) + '% · 나머지 ' + (Math.round((100 - Number(supportPct)) * 100) / 100) + '%)'
    : mode === 'ratio'
    ? '서버별 비율 (' + RATIO_GROUPS.filter(([g]) => Number((ratios || {})[g]) > 0).map(([g, n]) => n + ' ' + (Math.round(Number(ratios[g]) * 100) / 100) + '%').join(' · ') + ')'
    : '균등 배분';

function renderCalcActions() {
    const box = $('settle-calc-actions');
    if (!box) return;
    const n = unsettledItems().length;
    box.innerHTML = (canManage() ? actBtn('📊 정산 계산' + (n ? ' (' + n + ')' : ''), 'Settle.openCalc()', '#27ae60') : '')
                  + actBtn('📋 정산 내역', 'Settle.showHistory()', '#3498db')
                  + (isAdmin ? actBtn('🤝 지원조 설정' + (state.supportTeam.length ? ' (' + state.supportTeam.length + '명)' : ''), 'Settle.openSupportTeam()', '#8e44ad') : '');
}

function openCalc() {
    if (!canManage()) return;
    const items = unsettledItems();
    if (!items.length) { alert('정산할 아이템이 없습니다.\n(판매 완료 상태이고 아직 정산되지 않은 아이템만 대상입니다)'); return; }
    state.calcItemIds = items.map(i => String(i.id));
    state.recipients = new Set(getUsers().map(u => Number(u.id)));     // 기본: 전원
    state.calcMode = 'equal'; state.calcRatios = { jingir: 0, pandora: 0, support: 0, other: 0 }; state.calcFixed = {}; state.calcSupportPct = 50;
    renderCalc();
}
function closeCalc() { const b = $('settle-calc-area'); if (b) b.innerHTML = ''; }

function renderCalc() {
    const box = $('settle-calc-area');
    if (!box) return;
    const { items, total } = calcItems();
    const us = getUsers().slice().sort((a, b) => koCmp(a.name, b.name));
    const showOther = us.some(u => !SERVERS[u.server]);
    const inp = 'width:70px; margin:0; padding:5px 7px; border:2px solid #ddd; border-radius:6px; font-size:0.85rem; text-align:right; box-sizing:border-box;';
    box.innerHTML = `
    <div style="border:2px solid #27ae60; border-radius:10px; overflow:hidden; margin-bottom:12px;">
        <div style="background:#2c3e50; color:white; padding:10px 14px; display:flex; justify-content:space-between; align-items:center;">
            <span style="font-size:0.88rem;">정산 대상 ${items.length}개 · 총 낙찰액</span>
            <b style="font-size:1.1rem;">${fmt(total)} ${UNIT}</b>
        </div>
        <div style="padding:8px 14px; font-size:0.82rem;">
            ${items.map(i => `<div style="display:flex; justify-content:space-between; gap:8px; padding:3px 0; border-bottom:1px dashed #eee;"><span>${esc(i.itemName)}${i.bossVariant ? ' (' + esc(i.bossVariant) + ')' : ''} → ${esc(i.buyer)}</span><b style="color:#2980b9;">${fmt(i.bidPrice)}</b></div>`).join('')}
        </div>
        <div style="padding:0 14px 10px;">
            <div style="font-size:0.85rem; font-weight:bold; margin:6px 0;">⚖️ 분배 방식</div>
            <div style="display:flex; gap:6px; margin-bottom:6px;">
                <button id="settle-mode-equal" onclick="Settle.setCalcMode('equal')" style="flex:1; padding:8px 4px; border-radius:8px; cursor:pointer; font-weight:bold; font-size:0.85rem;">균등 배분</button>
                <button id="settle-mode-support" onclick="Settle.setCalcMode('support')" style="flex:1; padding:8px 4px; border-radius:8px; cursor:pointer; font-weight:bold; font-size:0.85rem;">지원조 비율</button>
                <button id="settle-mode-ratio" onclick="Settle.setCalcMode('ratio')" style="flex:1; padding:8px 4px; border-radius:8px; cursor:pointer; font-weight:bold; font-size:0.85rem;">서버별 비율</button>
            </div>
            <div id="settle-support-box" style="display:none; background:#f8f9fa; border-radius:8px; padding:8px 10px; margin-bottom:6px;">
                <div style="font-size:0.78rem; color:#7f8c8d; margin-bottom:6px; line-height:1.5;">지원조는 정산 금액의 아래 비율만큼 받고, 나머지 인원은 그 비율을 뺀 나머지를 나눠 받습니다. (각 몫 안에서는 균등)</div>
                <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; font-size:0.85rem;"><span>🤝 지원조 몫</span><span><input type="number" id="settle-support-pct" min="0" max="100" step="0.5" value="${Number(state.calcSupportPct) || 0}" oninput="Settle.setSupportPct(this.value)" style="${inp}"> %</span></div>
                <div id="settle-support-info" style="font-size:0.8rem; color:#555; margin-top:6px; line-height:1.6;"></div>
                <div style="font-size:0.74rem; color:#95a5a6; margin-top:4px;">지원조 명단은 관리자만 설정할 수 있습니다.${isAdmin ? ' ' + actBtn('🤝 지원조 설정', 'Settle.openSupportTeam()', '#8e44ad') : ''}</div>
            </div>
            <div id="settle-ratio-box" style="display:none; background:#f8f9fa; border-radius:8px; padding:8px 10px; margin-bottom:6px;">
                <div style="font-size:0.78rem; color:#7f8c8d; margin-bottom:6px; line-height:1.5;">서버마다 몫(%)을 정하면, 각 서버 몫을 그 서버 대상자끼리 균등하게 나눕니다.</div>
                ${RATIO_GROUPS.filter(([g]) => g !== 'other' || showOther).map(([g, n]) => `<div style="display:flex; align-items:center; justify-content:space-between; gap:8px; padding:3px 0; font-size:0.85rem;"><span>${n}</span><span><input type="number" id="settle-ratio-${g}" min="0" max="100" step="0.5" value="${Number(state.calcRatios[g]) || 0}" oninput="Settle.setRatio('${g}', this.value)" style="${inp}"> %</span></div>`).join('')}
                <div style="display:flex; justify-content:space-between; align-items:center; margin-top:6px; font-size:0.82rem;"><span id="settle-ratio-sum"></span>${actBtn('대상 인원 비례로 채우기', 'Settle.fillRatioByHeadcount()', '#5D6D7E')}</div>
            </div>
            <div style="font-size:0.85rem; font-weight:bold; margin:8px 0 6px;">👥 정산 대상자 <span id="settle-rcpt-count" style="color:#27ae60;"></span></div>
            <div style="font-size:0.76rem; color:#7f8c8d; margin-bottom:6px; line-height:1.5;">오른쪽 칸에 금액을 입력하면 그 사람에게는 <b>그 금액</b>을 줍니다. (직접 지정한 금액을 먼저 빼고 남은 금액을 위 방식으로 나눕니다. 비워두면 자동)</div>
            <div style="display:flex; gap:6px; flex-wrap:wrap; margin-bottom:6px;">
                ${actBtn('전체 선택', 'Settle.setRecipientsAll(true)', '#5D6D7E')}
                ${actBtn('전체 해제', 'Settle.setRecipientsAll(false)', '#95a5a6')}
                ${Object.keys(SERVERS).map(k => actBtn(SERVERS[k].name + '만', `Settle.setRecipientsServer('${k}')`, SERVERS[k].color)).join('')}
            </div>
            <div id="settle-rcpt-list" style="max-height:240px; overflow-y:auto; border:1px solid #eee; border-radius:8px;">
                ${us.map(u => `<div style="display:flex; align-items:center; justify-content:space-between; gap:8px; padding:5px 10px; border-bottom:1px solid #f5f5f5;">
                    <label style="display:flex; align-items:center; gap:8px; cursor:pointer; flex:1; min-width:0;">
                        <input type="checkbox" style="${cbStyle}" data-uid="${Number(u.id)}" ${state.recipients.has(Number(u.id)) ? 'checked' : ''} onchange="Settle.toggleRecipient(${Number(u.id)}, this.checked)"> <span>${esc(u.name)}${serverBadge(u.server)}${state.supportTeam.includes(Number(u.id)) ? ' <span class="settle-team-badge" style="display:none; padding:1px 6px; background:#d5f5e3; color:#1e8449; border-radius:4px; font-size:0.7rem; font-weight:bold;">지원조</span>' : ''}</span></label>
                    <input type="number" data-fix="${Number(u.id)}" min="0" step="1" oninput="Settle.setFixed(${Number(u.id)}, this.value)" style="${inp} width:96px;" title="이 사람에게 줄 금액을 직접 지정">
                </div>`).join('')}
            </div>
            <div id="settle-calc-preview" style="margin-top:10px;"></div>
        </div>
        <div style="padding:10px 14px; border-top:1px solid #eee; display:flex; gap:8px;">
            ${actBtn('💾 정산 확정 저장', 'Settle.saveSettlement()', '#27ae60').replace('<button', '<button id="settle-save-btn"')}
            ${actBtn('닫기', 'Settle.closeCalc()', '#95a5a6')}
        </div>
    </div>`;
    renderCalcModeUi();
    renderCalcPreview();
}

function renderCalcModeUi() {
    const on = 'background:#2c3e50; color:white; border:2px solid #2c3e50;', off = 'background:white; color:#2c3e50; border:2px solid #d5d8dc;';
    const css = ' flex:1; padding:8px 4px; border-radius:8px; cursor:pointer; font-weight:bold; font-size:0.85rem;';
    ['equal', 'support', 'ratio'].forEach(m => { const b = $('settle-mode-' + m); if (b) b.style.cssText = (state.calcMode === m ? on : off) + css; });
    const rb2 = $('settle-ratio-box'), sb = $('settle-support-box');
    if (rb2) rb2.style.display = state.calcMode === 'ratio' ? 'block' : 'none';
    if (sb) sb.style.display = state.calcMode === 'support' ? 'block' : 'none';
    document.querySelectorAll('.settle-team-badge').forEach(b => { b.style.display = state.calcMode === 'support' ? 'inline' : 'none'; });
    RATIO_GROUPS.forEach(([g]) => { const el = $('settle-ratio-' + g); if (el && document.activeElement !== el) el.value = Number(state.calcRatios[g]) || 0; });
    const sp = $('settle-support-pct'); if (sp && document.activeElement !== sp) sp.value = Number(state.calcSupportPct) || 0;
}
function setCalcMode(m) {
    state.calcMode = (m === 'ratio' || m === 'support') ? m : 'equal';
    if (state.calcMode === 'ratio' && RATIO_GROUPS.every(([g]) => !Number(state.calcRatios[g]))) fillRatioByHeadcount();
    renderCalcModeUi();
    renderCalcPreview();
}
function setSupportPct(v) {
    state.calcSupportPct = (v === '' || v === null) ? 0 : Math.max(0, Number(v) || 0);
    renderCalcPreview();
}
function fillRatioByHeadcount() {                              // 선택된 대상자 수에 비례 (결과는 균등 배분과 같아짐) → 여기서 숫자만 고쳐 쓰면 됨
    const recips = getUsers().filter(u => state.recipients.has(Number(u.id)));
    const n = recips.length;
    if (!n) return;
    const cnt = {}; RATIO_GROUPS.forEach(([g]) => { cnt[g] = recips.filter(u => groupOf(u) === g).length; });
    const pct = {}; let used = 0, big = 'jingir';
    RATIO_GROUPS.forEach(([g]) => { pct[g] = Math.floor(cnt[g] / n * 1000) / 10; used += pct[g]; if (cnt[g] > cnt[big]) big = g; });
    pct[big] = Math.round((pct[big] + (100 - used)) * 10) / 10;       // 합계가 정확히 100이 되도록 가장 큰 서버에 맞춤
    state.calcRatios = pct;
    renderCalcModeUi();
    renderCalcPreview();
}
function setRatio(g, v) {
    state.calcRatios[g] = (v === '' || v === null) ? 0 : Math.max(0, Number(v) || 0);
    renderCalcPreview();
}
function setFixed(uid, v) {
    if (v === '' || v === null || v === undefined) delete state.calcFixed[Number(uid)];
    else state.calcFixed[Number(uid)] = Math.max(0, Math.floor(Number(v) || 0));
    renderCalcPreview();
}

function renderCalcPreview() {
    const el = $('settle-calc-preview'), cnt = $('settle-rcpt-count');
    if (!el) return;
    const c = calcCurrent();
    if (cnt) cnt.textContent = '(' + c.recips.length + '명 선택)';
    // 대상자가 아닌 사람의 직접 지정은 버리고, 행마다 "자동 금액"을 입력칸 안내문구로 표시
    const byId = {}; c.rows.forEach(r => { byId[r.userId] = r; });
    document.querySelectorAll('#settle-rcpt-list input[data-fix]').forEach(i => {
        const uid = Number(i.dataset.fix), r = byId[uid];
        if (!r) { delete state.calcFixed[uid]; i.value = ''; i.disabled = true; i.placeholder = '-'; i.style.borderColor = '#ddd'; return; }
        i.disabled = false;
        i.placeholder = r.fixed ? '' : '자동 ' + fmt(r.amount);
        i.style.borderColor = r.fixed ? '#e67e22' : '#ddd';
        if (document.activeElement !== i) i.value = r.fixed ? String(r.amount) : '';     // 입력 중이 아닐 때는 칸 표시를 실제 계산과 항상 일치시킴
    });
    RATIO_GROUPS.forEach(([g]) => { const el = $('settle-ratio-' + g); if (el && document.activeElement !== el) el.value = Number(state.calcRatios[g]) || 0; });
    const inf = $('settle-support-info');
    if (inf) {
        const tn = c.rows.filter(r => r.team).length, rn = c.rows.length - tn, p = Math.min(100, Math.max(0, Number(state.calcSupportPct) || 0));
        inf.innerHTML = `지원조 <b>${p}%</b> · 나머지 인원 <b>${Math.round((100 - p) * 100) / 100}%</b><br>선택한 대상자 중 지원조 <b>${tn}명</b> · 나머지 <b>${rn}명</b>${state.supportTeam.length === 0 ? '<br><span style="color:#c0392b;">⚠️ 지원조 명단이 비어 있습니다. 관리자가 먼저 설정해야 합니다.</span>' : ''}`;
    }
    const sumEl = $('settle-ratio-sum');
    if (sumEl) {
        const okSum = Math.abs(c.ratioSum - 100) <= 0.01;
        sumEl.innerHTML = `합계 <b style="color:${okSum ? '#27ae60' : '#c0392b'};">${Math.round(c.ratioSum * 100) / 100}%</b> ${okSum ? '✓' : '(100%로 맞춰주세요)'}`;
    }
    const sb = $('settle-save-btn');
    if (sb) { sb.disabled = !c.valid; sb.style.opacity = c.valid ? '' : '0.45'; }
    if (!c.recips.length) { el.innerHTML = '<div style="color:#c0392b; font-size:0.85rem;">대상자를 1명 이상 선택하세요.</div>'; return; }
    const auto = c.rows.filter(r => !r.fixed);
    let line;
    if (!auto.length) line = '직접 지정한 금액만 지급합니다.';
    else if (state.calcMode === 'equal') {
        const base = Math.floor(c.pool / auto.length), rem = c.pool - base * auto.length;
        line = `1인당 <b style="color:#27ae60;">${fmt(base)} ${UNIT}</b>${rem ? `<span style="color:#7f8c8d; font-size:0.8rem;"> (남는 ${rem} ${UNIT}은 이름순 앞 ${rem}명에게 1씩)</span>` : ''}${c.fixedSum ? ` <span style="color:#7f8c8d; font-size:0.8rem;">· 자동 분배 ${auto.length}명</span>` : ''}`;
    } else if (state.calcMode === 'support') {
        const range = (arr) => arr.length ? fmt(Math.min.apply(null, arr)) + (Math.min.apply(null, arr) !== Math.max.apply(null, arr) ? ' ~ ' + fmt(Math.max.apply(null, arr)) : '') : '-';
        const tm = auto.filter(r => r.team), rs = auto.filter(r => !r.team);
        line = `🤝 지원조 ${tm.length}명: 1인당 <b style="color:#27ae60;">${range(tm.map(r => r.amount))}</b> · 나머지 ${rs.length}명: 1인당 <b style="color:#27ae60;">${range(rs.map(r => r.amount))}</b> ${UNIT}`;
    } else {
        const amts = auto.map(r => r.amount);
        line = `자동 분배 ${auto.length}명: 1인당 <b style="color:#27ae60;">${fmt(Math.min.apply(null, amts))}${Math.min.apply(null, amts) !== Math.max.apply(null, amts) ? ' ~ ' + fmt(Math.max.apply(null, amts)) : ''} ${UNIT}</b>`;
    }
    el.innerHTML = `<div style="background:#f0fff4; border:1px solid #a9dfbf; border-radius:8px; padding:10px 12px; font-size:0.88rem; line-height:1.6;">
        <div>${line}</div>
        <div style="font-size:0.8rem; color:#555; margin-top:2px;">총액 <b>${fmt(c.total)}</b> = 직접 지정 <b style="color:#e67e22;">${fmt(c.fixedSum)}</b> + 자동 분배 <b>${fmt(c.paid - c.fixedSum)}</b> + 미배분 <b style="color:${c.unallocated ? '#c0392b' : '#555'};">${fmt(c.unallocated)}</b></div>
        ${c.errors.map(m => `<div style="color:#c0392b; font-size:0.8rem; margin-top:3px;">⛔ ${esc(m)}</div>`).join('')}
        ${c.warnings.map(m => `<div style="color:#d35400; font-size:0.8rem; margin-top:3px;">⚠️ ${esc(m)}</div>`).join('')}
    </div>`;
}

function syncRecipientChecks() {
    document.querySelectorAll('#settle-rcpt-list input[data-uid]').forEach(c => { c.checked = state.recipients.has(Number(c.dataset.uid)); });
    renderCalcPreview();
}
function toggleRecipient(uid, checked) {
    if (checked) state.recipients.add(Number(uid)); else state.recipients.delete(Number(uid));
    renderCalcPreview();
}
function setRecipientsAll(on) {
    state.recipients = on ? new Set(getUsers().map(u => Number(u.id))) : new Set();
    syncRecipientChecks();
}
function setRecipientsServer(sv) {
    state.recipients = new Set(getUsers().filter(u => u.server === sv).map(u => Number(u.id)));
    syncRecipientChecks();
}

async function saveSettlement() {
    if (!(await requireManage())) return;
    const c = calcCurrent();
    const items = c.items, total = c.total;
    if (!items.length) { alert('정산할 아이템이 없습니다. (이미 정산되었을 수 있습니다)'); return; }
    if (!c.recips.length) { alert('정산 대상자를 1명 이상 선택하세요.'); return; }
    if (c.errors.length) { alert(c.errors[0]); return; }
    if (!c.balanced) { alert('금액 계산이 맞지 않습니다. (배분 합계 ' + fmt(c.paid) + ' + 미배분 ' + fmt(c.unallocated) + ' ≠ 총액 ' + fmt(total) + ')\n분배 설정을 확인하세요.'); return; }
    const dist = c.rows;
    const fixedN = dist.filter(d => d.fixed).length;
    if (c.unallocated > 0 && !confirm(`미배분 금액이 ${fmt(c.unallocated)} ${UNIT} 있습니다. (받을 사람이 없는 몫)\n이 금액은 누구에게도 지급되지 않습니다. 그대로 저장할까요?`)) return;
    if (!confirm(`아이템 ${items.length}개, 총 ${fmt(total)} ${UNIT}을(를) ${dist.length}명에게 배분하고 정산을 확정할까요?\n방식: ${calcModeText(state.calcMode, state.calcRatios, state.calcSupportPct)}${fixedN ? ' · 직접 지정 ' + fixedN + '명' : ''}\n(확정 후에는 같은 아이템이 다시 정산되지 않습니다)`)) return;

    try {
        // 다른 사람이 먼저 정산했는지 서버 값으로 재확인
        const fresh = await Promise.all(items.map(i => db.ref('boss_storage/' + i.id + '/settledId').once('value')));
        if (fresh.some(s => s.val())) { alert('다른 사람이 이미 정산한 아이템이 포함되어 있습니다. 화면을 새로 연 뒤 다시 시도하세요.'); return; }

        const sidv = 'S' + Date.now();
        const recMap = {};
        dist.forEach(d => {
            recMap['u' + d.userId] = { userId: d.userId, name: d.name, server: d.server, amount: d.amount, received: false };
            if (d.fixed) recMap['u' + d.userId].fixed = true;                       // 운영진이 금액을 직접 지정한 사람
            if (state.calcMode === 'support' && d.team) recMap['u' + d.userId].team = true;   // 정산 당시 지원조였던 사람 (이후 명단이 바뀌어도 기록 유지)
        });
        const record = {
            id: sidv, createdAt: nowIso(), totalAmount: total, count: dist.length,
            mode: state.calcMode === 'ratio' ? 'ratio' : (state.calcMode === 'support' ? 'support' : 'equal'),
            items: items.map(i => ({ id: String(i.id), itemName: i.itemName, bossName: i.bossName, bossServer: i.bossServer || '', bossVariant: i.bossVariant || '', date: i.date, buyer: i.buyer, bidPrice: i.bidPrice })),
            recipients: recMap
        };
        if (state.calcMode === 'ratio') { record.ratios = {}; RATIO_GROUPS.forEach(([g]) => { record.ratios[g] = Number(state.calcRatios[g]) || 0; }); }
        if (state.calcMode === 'support') record.supportPct = Number(state.calcSupportPct) || 0;
        if (c.fixedSum) record.fixedTotal = c.fixedSum;
        if (c.unallocated) record.unallocated = c.unallocated;
        const updates = {};
        updates['boss_settlement/' + sidv] = record;
        items.forEach(i => { updates['boss_storage/' + i.id + '/settledId'] = sidv; });
        await db.ref().update(updates);
        closeCalc();
        alert('✅ 정산이 저장되었습니다.');
        showHistory();
    } catch (e) {
        alert('❌ 정산 저장 실패: ' + e.message);
    }
}

// ── 정산 내역 ─────────────────────────────────────────────
async function showHistory() {
    const area = $('settle-history-area');
    if (!area) return;
    area.innerHTML = '<p style="color:#95a5a6; text-align:center; padding:10px; margin:0;">불러오는 중...</p>';
    try {
        const snap = await db.ref('boss_settlement').limitToLast(30).once('value');
        const list = [];
        snap.forEach(ch => { const v = ch.val(); if (v && typeof v === 'object') list.push(v); });
        state.settlements = list.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
        renderHistory();
    } catch (e) {
        area.innerHTML = '<p style="color:#c0392b;">정산 내역을 불러오지 못했습니다: ' + esc(e.message) + '</p>';
    }
}
function hideHistory() { const a = $('settle-history-area'); if (a) a.innerHTML = ''; }

const recipientsOf = (r) => Object.entries(r.recipients || {})
    .filter(([k, v]) => v && typeof v === 'object')
    .map(([k, v]) => Object.assign({ _key: k }, v))
    .sort((a, b) => koCmp(a.name, b.name));

function renderHistory() {
    const area = $('settle-history-area');
    if (!area) return;
    const mg = canManage();
    const head = `<div style="display:flex; justify-content:space-between; align-items:center; margin:10px 0 8px;"><b style="font-size:0.9rem;">📋 정산 내역 (최근 ${state.settlements.length}건)</b>${actBtn('닫기', 'Settle.hideHistory()', '#95a5a6')}</div>`;
    if (!state.settlements.length) { area.innerHTML = head + '<p style="color:#95a5a6; text-align:center; padding:12px; margin:0; font-size:0.88rem;">저장된 정산 내역이 없습니다.</p>'; return; }
    area.innerHTML = head + state.settlements.map(r => {
        const rid = sid(r.id);
        const rc = recipientsOf(r);
        const done = rc.filter(x => x.received).length;
        const its = Object.values(r.items || {});
        return `
        <div style="border:1px solid #dee2e6; border-radius:8px; padding:10px 12px; margin-bottom:8px; background:white;">
            <div style="display:flex; justify-content:space-between; flex-wrap:wrap; gap:6px;">
                <div><b>${esc(new Date(r.createdAt).toLocaleDateString('ko-KR'))}</b>
                    <span style="font-size:0.8rem; color:#7f8c8d;"> 아이템 ${its.length}개 · ${rc.length}명</span></div>
                <b style="color:#2980b9;">${fmt(r.totalAmount)} ${UNIT}</b>
            </div>
            <div style="font-size:0.78rem; color:#7f8c8d; margin-top:3px;">분배: ${esc(calcModeText(r.mode, r.ratios, r.supportPct))}${rc.filter(x => x.fixed).length ? ' · 직접 지정 ' + rc.filter(x => x.fixed).length + '명' : ''}${Number(r.unallocated) ? ' · <span style="color:#c0392b;">미배분 ' + fmt(r.unallocated) + '</span>' : ''}</div>
            <div id="settle-hist-prog-${rid}" style="font-size:0.78rem; color:#7f8c8d; margin-top:3px;">수령 확인 ${done}/${rc.length}</div>
            <details style="margin-top:6px;">
                <summary style="cursor:pointer; font-size:0.85rem; color:#2c3e50;">낙찰 아이템 / 대상자 보기</summary>
                <div style="font-size:0.8rem; margin:6px 0; padding:6px 8px; background:#f8f9fa; border-radius:6px;">
                    ${its.map(i => `<div style="display:flex; justify-content:space-between; gap:8px;"><span>${esc(i.itemName)}${i.bossVariant ? ' (' + esc(i.bossVariant) + ')' : ''} → ${esc(i.buyer)}</span><b>${fmt(i.bidPrice)}</b></div>`).join('')}
                </div>
                <div style="max-height:220px; overflow-y:auto; border:1px solid #eee; border-radius:6px;">
                    ${rc.map(x => `<div style="display:flex; justify-content:space-between; align-items:center; gap:8px; padding:6px 10px; border-bottom:1px solid #f3f3f3; font-size:0.85rem;">
                        <span>${esc(x.name)}${serverBadge(x.server)}${x.team ? ' <span style="padding:1px 6px; background:#d5f5e3; color:#1e8449; border-radius:4px; font-size:0.7rem;">지원조</span>' : ''}${x.fixed ? ' <span style="padding:1px 6px; background:#fdebd0; color:#d35400; border-radius:4px; font-size:0.7rem;">직접 지정</span>' : ''}</span>
                        <span style="display:flex; align-items:center; gap:8px;"><b style="color:#27ae60;">${fmt(x.amount)}</b>
                        ${mg ? `<input type="checkbox" style="${cbStyle}" ${x.received ? 'checked' : ''} onchange="Settle.toggleReceived('${rid}', '${sid(x._key)}', this.checked)" title="수령 확인">`
                             : (x.received ? '<span style="color:#27ae60; font-size:0.75rem;">수령</span>' : '')}</span>
                    </div>`).join('')}
                </div>
            </details>
            ${isAdmin ? `<div style="margin-top:8px;">${actBtn('↩️ 정산 취소', `Settle.cancelSettlement('${rid}')`, '#c0392b')}</div>` : ''}
        </div>`;
    }).join('');
}

async function toggleReceived(rid, key, checked) {
    if (!(await requireManage())) { renderHistory(); return; }
    const r = state.settlements.find(x => sid(x.id) === rid);
    if (!r || !r.recipients) return;
    const realKey = Object.keys(r.recipients).find(k => sid(k) === key);
    if (!realKey) return;
    try {
        await db.ref('boss_settlement/' + r.id + '/recipients/' + realKey + '/received').set(!!checked);
        r.recipients[realKey].received = !!checked;
        const rc = recipientsOf(r);
        const el = $('settle-hist-prog-' + rid);
        if (el) el.textContent = '수령 확인 ' + rc.filter(x => x.received).length + '/' + rc.length;
    } catch (e) { alert('❌ 저장 실패: ' + e.message); renderHistory(); }
}

async function cancelSettlement(rid) {
    const r = state.settlements.find(x => sid(x.id) === rid);
    if (!r) return;
    if (!(await requireAdmin())) return;
    if (!confirm(`이 정산(${fmt(r.totalAmount)} ${UNIT})을 취소할까요?\n포함된 아이템은 다시 '정산 대기' 상태가 됩니다.`)) return;
    const updates = {};
    updates['boss_settlement/' + r.id] = null;
    Object.values(r.items || {}).forEach(i => { updates['boss_storage/' + i.id + '/settledId'] = null; });
    try {
        await db.ref().update(updates);
        showHistory();
    } catch (e) { alert('❌ 취소 실패: ' + e.message); }
}

// ============================================================
// 💸 복구·축복 지원비 (주 단위 신청 → 운영진 확정 → 지급)
// ============================================================
const RB_MAX_IMAGES = 3;
const rb = {
    inited: false, week: '', requests: [], prices: { recovery: 0, blessing: 0, transfer: 0 },
    shots: [], shotSeq: 0, ocrQ: Promise.resolve(), workerP: null,
    uInited: false, userData: {}, userRefs: {}, weekCb: null,          // 사용자 탭: 최근 3주 데이터
    weekRef: null, priceBound: false, imgCache: {}, open: new Set()
};
const RB_MAX_PER_KIND = 2;                                   // 복구 사진 2장 · 축복 사진 2장까지
const RB_KIND = { recovery: '복구', blessing: '축복' };

// 날짜 도우미 (app.js 에 의존하지 않도록 자체 구현)
// 게임의 주간 호칭 랭킹은 매주 수요일 05시에 초기화됨 → 한 주 = 수요일 05:00 ~ 다음 수요일 05:00 (키는 시작하는 수요일 날짜)
function weekStartWed(d) {
    const x = new Date(d);
    x.setHours(x.getHours() - 5);
    x.setDate(x.getDate() - ((x.getDay() - 3 + 7) % 7));
    x.setHours(0, 0, 0, 0);
    return x;
}
function ymd(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function md(d) { return (d.getMonth() + 1) + '/' + d.getDate(); }

const rbSafeSrc = (d) => (typeof d === 'string' && /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+\/=]+$/.test(d)) ? d : '';
// 이 기기를 구분하는 값 (다른 사람 사진을 대신 올린 신청도 올린 사람이 수정/삭제할 수 있게)
function deviceId() {
    try {
        let v = localStorage.getItem('settleDeviceId');
        if (!v) { v = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); localStorage.setItem('settleDeviceId', v); }
        return v;
    } catch (e) { return 'd-nolocal'; }
}
const rbIsMine = (r) => myNameList().includes(r.name) || (!!r.by && r.by === deviceId());
const rbWeekOf = (r) => r._week || rb.week;
function rbWeekRange(key) {
    const st = new Date(key + 'T00:00:00'), en = new Date(st);
    en.setDate(st.getDate() + 7);
    return '수 ' + md(st) + ' 05시 ~ 수 ' + md(en) + ' 05시';
}
function rbWeekName(key) {
    const cur = ymd(weekStartWed(nowD()));
    const diff = Math.round((new Date(cur + 'T00:00:00') - new Date(key + 'T00:00:00')) / (7 * 86400000));
    const p = diff === 0 ? '이번 주' : (diff === 1 ? '지난 주' : (diff > 1 ? diff + '주 전' : ''));
    return (p ? p + ' ' : '') + '(' + rbWeekRange(key) + ')';
}
function rbRecentWeeks(n) {                              // 이번 주부터 n주 (시작 수요일 날짜 키)
    const cur = weekStartWed(nowD()), out = [];
    for (let i = 0; i < n; i++) { const st = new Date(cur); st.setDate(cur.getDate() - i * 7); out.push(ymd(st)); }
    return out;
}
function rbUserAll() {
    const out = [];
    Object.keys(rb.userData).forEach(k => rb.userData[k].forEach(r => out.push(r)));
    return out;
}
const rbMine = () => rbUserAll().filter(rbIsMine).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
const rbFind = (k) => rb.requests.find(r => sid(r.id) === k) || rbUserAll().find(r => sid(r.id) === k) || null;
// 신청 금액 = 복구 횟수×단가 + 축복 횟수×단가 + 이전 횟수×단가 + (운영진이 직접 기입한) 추가비용. 확정된 신청은 확정 당시 단가(priceSnap) 기준
function rbParts(r) {
    const p = r.priceSnap || rb.prices;
    const base = (Number(r.recoveryCnt) || 0) * (Number(p.recovery) || 0) + (Number(r.blessingCnt) || 0) * (Number(p.blessing) || 0);
    const tr = (Number(r.transferCnt) || 0) * (Number(p.transfer) || 0);
    const ex = Number(r.extraAmount) || 0;
    return { base: base, transfer: tr, extra: ex, total: base + tr + ex };
}
function rbAmount(r) { return rbParts(r).total; }
const rbCntText = (o) => '복구 ' + fmt(o.recoveryCnt) + '회 · 축복 ' + fmt(o.blessingCnt) + '회' + (Number(o.transferCnt) > 0 ? ' · 이전 ' + fmt(o.transferCnt) + '회' : '');

// 관리자 화면 (정산 탭 > 복구비 관리): 전체 신청 목록 · 확정/반려/지급 · 단가 · 주간 지급 요약
function rbBuildAdmin() {
    $('settle-pane-reimb').innerHTML = `
    <div class="card">
        <h2 style="font-size:1.05rem; margin:0 0 4px;">💸 복구비 관리</h2>
        <p style="font-size:0.8rem; color:#7f8c8d; margin:0 0 10px; line-height:1.5;">전체 신청을 확인하고 확정·지급 처리합니다. 확정하면 횟수 수정이 잠기고 증빙 사진은 삭제됩니다.</p>
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:6px;">
            <label style="font-weight:bold; color:#2c3e50;">주차:</label>
            <select id="rb-week" onchange="Settle.rbLoadWeek()" style="width:auto; margin:0; padding:9px 12px; border:2px solid #5D6D7E; border-radius:8px; font-size:0.88rem; font-weight:bold;"></select>
        </div>
        <div id="rb-price-line" style="font-size:0.82rem; color:#7f8c8d;"></div>
    </div>
    <div class="card">
        <h3 style="margin:0 0 12px; color:#2c3e50; font-size:1rem;">📋 이 주차 신청 내역 (전체)</h3>
        <div id="rb-list"></div>
    </div>
    <div class="card">
        <h3 style="margin:0 0 12px; color:#2c3e50; font-size:1rem;">🧾 주간 지급 요약</h3>
        <div id="rb-summary"></div>
    </div>`;
}

// 사용자 화면 (복구비 탭): 내가 받을 돈 · 신청하기 · 내 신청 내역
function rbBuildUser() {
    const lab = 'font-size:0.85rem; font-weight:bold; color:#555; display:block; margin-bottom:4px;';
    $('reimb-root').innerHTML = `
    <div class="card" style="background:#f4faff;">
        <h2 style="font-size:1.05rem; margin:0 0 6px;">💰 내가 받을 돈</h2>
        <div id="rbu-money"></div>
    </div>

    <div class="card">
        <h2 style="font-size:1.05rem; margin:0 0 4px;">💸 복구비 신청</h2>
        <p style="font-size:0.8rem; color:#7f8c8d; margin:0 0 12px; line-height:1.5;">게임의 <b>[호칭 → 호칭 리스트]</b> 화면 사진을 올리면 종류(복구·축복)와 점수(= 사용 횟수)를 자동으로 읽습니다. 운영진이 확정하면 혈에서 비용을 지급합니다.<br>⏰ 주간 호칭 랭킹은 <b>매주 수요일 05시</b>에 초기화되니, 초기화 전에 올려주세요.</p>
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:6px;">
            <label style="font-weight:bold; color:#2c3e50;">주차:</label>
            <select id="rbu-week" onchange="Settle.rbSubmitState()" style="width:auto; margin:0; padding:9px 12px; border:2px solid #5D6D7E; border-radius:8px; font-size:0.86rem; font-weight:bold;"></select>
        </div>
        <div id="rbu-price-line" style="font-size:0.82rem; color:#7f8c8d; margin-bottom:12px;"></div>
        <div style="margin-bottom:12px;"><label style="${lab}">신청자</label><select id="rb-user" onchange="Settle.rbSubmitState()" style="${inputStyle}"></select></div>
        <div id="rbu-state" style="display:none; margin:-4px 0 12px; padding:9px 12px; border-radius:8px; font-size:0.84rem; line-height:1.5;"></div>
        <div style="margin-bottom:10px;">
            <label style="${lab}">호칭 화면 사진 <span style="font-weight:normal; color:#7f8c8d;">(복구 2장 · 축복 2장까지)</span></label>
            <p style="font-size:0.76rem; color:#7f8c8d; margin:0 0 8px; line-height:1.5;">"두려움없이"는 복구, "축복의기사"는 축복 화면입니다. 읽은 값이 틀리면 직접 고치세요. 다른 사람 사진이면 내 횟수로 바꿔 입력하세요.</p>
            <label for="rb-files" style="display:inline-block; padding:9px 16px; border:2px solid #3498db; border-radius:8px; color:#3498db; font-weight:bold; cursor:pointer; font-size:0.9rem;">🖼️ 사진 선택</label>
            <input type="file" id="rb-files" accept="image/*" multiple style="display:none;" onchange="Settle.rbHandleFiles(this)">
            <div id="rb-shots" style="margin-top:10px;"></div>
            <div id="rb-totals" style="font-size:0.9rem; color:#2c3e50; margin-top:2px;"></div>
        </div>
        <div style="margin-bottom:12px;">
            <label style="${lab}">🚚 이전 횟수 <span id="rbu-transfer-price" style="font-weight:normal; color:#7f8c8d;"></span></label>
            <input type="number" id="rb-transfer" min="0" step="1" placeholder="0" oninput="Settle.rbTransferInput()" style="${inputStyle} margin-bottom:4px;">
            <div style="font-size:0.76rem; color:#7f8c8d; line-height:1.5;">이전한 횟수를 직접 입력하세요. (사진은 필요 없습니다) 금액 = 횟수 × 이전 단가</div>
            <div id="rb-transfer-amt" style="font-size:0.82rem; color:#2980b9; font-weight:bold; margin-top:2px;"></div>
        </div>
        <div style="margin-bottom:12px;"><label style="${lab}">메모 (선택)</label><input type="text" id="rb-memo" maxlength="100" placeholder="예: 본캐·부캐 합산" style="${inputStyle}"></div>
        <button class="btn btn-primary" id="rb-submit-btn" onclick="Settle.rbSubmit()" style="width:100%; padding:12px; font-size:1rem;">📤 제출</button>
    </div>

    <div class="card">
        <h3 style="margin:0 0 12px; color:#2c3e50; font-size:1rem;">📋 내 신청 내역 <span style="font-weight:normal; color:#95a5a6; font-size:0.78rem;">(최근 3주)</span></h3>
        <div id="rbu-list"></div>
    </div>`;
}

// 단가는 사용자·관리자 화면이 함께 사용
function rbEnsurePrices() {
    if (rb.priceBound) return;
    rb.priceBound = true;
    db.ref('hunter_config/reimbursePrices').on('value', snap => {
        const v = snap.val() || {};
        rb.prices = { recovery: Number(v.recovery) || 0, blessing: Number(v.blessing) || 0, transfer: Number(v.transfer) || 0 };
        rbRenderPriceLine(); rbRender(); rbRenderUser();
    });
}

function rbAdminInit() {
    if (!rb.inited) { rbBuildAdmin(); rbPopulateWeeks(); rb.inited = true; }
    rbEnsurePrices();
    if (!rb.weekRef) rbLoadWeek();
    rbRenderPriceLine();
    rbRender();
}

// 사용자 탭을 열 때: 화면 만들기 + 최근 3주 신청 구독
function rbUserOpen() {
    if (!depsOk()) return;
    if (!rb.uInited) { rbBuildUser(); rb.uInited = true; }
    rbPopulateUserWeeks();
    rbPopulateUsers();
    rbEnsurePrices();
    rbUserAttach();
    rbRenderUser();
}
function rbUserAttach() {
    const keys = rbRecentWeeks(3);
    Object.keys(rb.userRefs).forEach(k => {                  // 새 주가 시작되어 범위를 벗어난 주차는 구독 해제
        if (keys.includes(k)) return;
        try { rb.userRefs[k].ref.off('value', rb.userRefs[k].cb); } catch (e) { /* 이미 해제됨 */ }
        delete rb.userRefs[k]; delete rb.userData[k];
    });
    keys.forEach(key => {
        if (rb.userRefs[key]) return;
        const ref = db.ref('boss_reimburse/' + key);
        const cb = snap => {
            const data = snap.val() || {};
            rb.userData[key] = Object.values(data).filter(r => r && r.id).map(r => Object.assign({}, r, { _week: key }));
            rbRenderUser();
        };
        rb.userRefs[key] = { ref: ref, cb: cb };
        ref.on('value', cb);
    });
}
function initUserReimb() {                               // 복구비 탭이 열릴 때마다 (app.js 수정 없이 감지)
    const tab = $('tab-reimb');
    if (!tab) return;
    let was = tab.classList.contains('active');
    new MutationObserver(() => {
        const now = tab.classList.contains('active');
        if (now && !was) afterAuth(rbUserOpen);
        was = now;
    }).observe(tab, { attributes: true, attributeFilter: ['class'] });
    if (was) afterAuth(rbUserOpen);
}

function rbPopulateWeeks() {                              // 관리자: 최근 8주
    const sel = $('rb-week');
    if (sel) sel.innerHTML = rbRecentWeeks(8).map(k => `<option value="${k}">${esc(rbWeekName(k))}</option>`).join('');
}
function rbPopulateUserWeeks() {                          // 사용자: 이번 주 / 지난 주
    const sel = $('rbu-week');
    if (!sel) return;
    const prev = sel.value;
    const keys = rbRecentWeeks(2);
    sel.innerHTML = keys.map(k => `<option value="${k}">${esc(rbWeekName(k))}</option>`).join('');
    sel.value = keys.includes(prev) ? prev : keys[0];
}

function rbPopulateUsers() {
    const sel = $('rb-user');
    if (!sel) return;
    const prev = sel.value;
    const sorted = getUsers().slice().sort((a, b) => koCmp(a.name, b.name));
    const names = myNameList();
    const mine = sorted.find(u => names.includes(u.name));
    sel.innerHTML = '<option value="">신청자 선택</option>' + sorted.map(u => `<option value="${Number(u.id)}">${esc(u.name)}</option>`).join('');
    if (prev && sorted.some(u => String(u.id) === prev)) sel.value = prev;
    else if (mine) sel.value = String(mine.id);
}

// ── 호칭 화면 사진에서 종류/점수 읽기 ─────────────────────────────
// 종류: "두려움없이 / 사망 패널티 복구 횟수" → 복구, "축복의기사 / 신녀의 축복 사용 횟수" → 축복 (옵션 문구의 "축복 소모량"과 헷갈리지 않게 고유 문구만 사용)
// 점수: "점수/도달률" 바로 뒤, 또는 "내순위 N위" 바로 뒤의 "숫자+점" ("점"은 %로 읽히기도 함, +15% 같은 옵션 수치는 제외)
// 못 읽으면 틀린 값을 내지 않고 비워 둠 → 직접 입력
function rbParseShot(raw) {
    const flat = String(raw || '').replace(/\s+/g, '');
    let kind = '';
    if (/두려움|사망패널티|복구횟수/.test(flat)) kind = 'recovery';
    else if (/축복의기사|신녀의축복|축복사용횟수/.test(flat)) kind = 'blessing';
    const after = (re, span) => {
        const m = re.exec(flat);
        if (!m) return null;
        const seg = flat.slice(m.index + m[0].length, m.index + m[0].length + span);
        const g = /([+\-]?)(\d{1,4})[점%]/g;
        let c;
        while ((c = g.exec(seg))) { if (!c[1]) return Number(c[2]); }
        return null;
    };
    const score = after(/점수\/?도달률/, 10);
    const header = after(/내순위\d{1,3}위/, 6);
    let value = null, conf = '';
    if (score !== null && header !== null) { value = score; conf = score === header ? 'high' : 'low'; }
    else if (score !== null || header !== null) { value = score !== null ? score : header; conf = 'mid'; }
    return { kind: kind, value: value, conf: conf };
}
function rbMergeReads(a, b) {                       // a: 1차(대비 보정), b: 2차(원본)
    const kind = a.kind || b.kind;
    if (a.value !== null && b.value !== null) return { kind: kind, value: a.value, conf: a.value === b.value ? 'high' : 'low' };
    if (a.value !== null) return { kind: kind, value: a.value, conf: a.conf };
    if (b.value !== null) return { kind: kind, value: b.value, conf: b.conf === 'high' ? 'mid' : b.conf };
    return { kind: kind, value: null, conf: '' };
}

// 글자가 잘 읽히도록 확대 + 흑백 + 대비 보정 (밝기 분포 기준이라 화면마다 밝기가 달라도 동작)
function rbEnhance(src) {
    const scale = Math.max(1, Math.min(2, 2800 / src.width));
    const c = document.createElement('canvas');
    c.width = Math.round(src.width * scale); c.height = Math.round(src.height * scale);
    const g = c.getContext('2d');
    g.drawImage(src, 0, 0, c.width, c.height);
    const d = g.getImageData(0, 0, c.width, c.height), px = d.data, n = px.length / 4;
    const lum = new Uint8Array(n), hist = new Array(256).fill(0);
    for (let i = 0; i < n; i++) { const y = (0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]) | 0; lum[i] = y; hist[y]++; }
    const pick = (p) => { let acc = 0; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * p) return v; } return 255; };
    const lo = pick(0.05), hi = Math.max(lo + 30, pick(0.995));
    for (let i = 0; i < n; i++) { const v = Math.max(0, Math.min(255, (lum[i] - lo) * 255 / (hi - lo))); px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = v; }
    g.putImageData(d, 0, 0);
    return c;
}

function rbGetWorker() {
    if (typeof Tesseract === 'undefined' || !Tesseract || typeof Tesseract.createWorker !== 'function') return Promise.reject(new Error('ocr-unavailable'));
    if (!rb.workerP) rb.workerP = Promise.resolve(Tesseract.createWorker('kor+eng')).catch(e => { rb.workerP = null; throw e; });
    return rb.workerP;
}
function rbWithTimeout(p, ms) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout')), ms);
        p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
    });
}
async function rbReadCanvas(src) {
    const worker = await rbGetWorker();
    const first = rbParseShot((await rbWithTimeout(worker.recognize(rbEnhance(src)), 90000)).data.text);
    if (first.conf === 'high') return first;                               // 두 곳에서 같은 값 → 확실
    let second = { kind: '', value: null, conf: '' };
    try { second = rbParseShot((await rbWithTimeout(worker.recognize(src), 90000)).data.text); } catch (e) { /* 1차 결과만 사용 */ }
    return rbMergeReads(first, second);
}

// ── 사진 올리기: 사진마다 [종류 · 횟수] 행이 생기고, 자동으로 읽은 값이 미리 채워짐 (모두 수정 가능) ──
const rbCountKind = (kind, except) => rb.shots.filter(x => x.kind === kind && x !== except).length;
function rbTotals() {
    const t = { recovery: 0, blessing: 0 };
    rb.shots.forEach(x => { if (t[x.kind] !== undefined) t[x.kind] += Number(x.cnt) || 0; });
    return t;
}
function rbDefaultKind() {
    if (rbCountKind('recovery') < RB_MAX_PER_KIND) return 'recovery';
    if (rbCountKind('blessing') < RB_MAX_PER_KIND) return 'blessing';
    return '';
}

// 파일 → {원본 캔버스(글자 읽기용), 압축한 사진(저장용)}. 저장용은 증빙 확인만 되면 되므로 작게 (사진 한 장 약 50~100KB)
function rbPrepare(file) {
    return new Promise(resolve => {
        if (!file || !file.type || file.type.indexOf('image/') !== 0) { resolve(null); return; }
        const reader = new FileReader();
        reader.onerror = () => resolve(null);
        reader.onload = e => {
            const img = new Image();
            img.onerror = () => resolve(null);
            img.onload = () => {
                const full = document.createElement('canvas');
                full.width = img.width; full.height = img.height;
                full.getContext('2d').drawImage(img, 0, 0);
                const draw = (maxSide, q) => {
                    const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
                    const c = document.createElement('canvas');
                    c.width = Math.max(1, Math.round(img.width * scale));
                    c.height = Math.max(1, Math.round(img.height * scale));
                    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
                    return c.toDataURL('image/jpeg', q);
                };
                let out = draw(1280, 0.55);
                if (out.length > 250000) out = draw(1000, 0.5);
                resolve({ data: out, canvas: full });
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    });
}

async function rbHandleFiles(input) {
    const files = Array.from(input.files || []);
    input.value = '';
    if (!files.length) return;
    const room = RB_MAX_PER_KIND * 2 - rb.shots.length;
    if (room <= 0) { alert('사진은 복구 2장 · 축복 2장, 최대 4장까지 올릴 수 있습니다.'); return; }
    if (files.length > room) alert('최대 4장까지라서 앞의 ' + room + '장만 사용합니다.');
    for (const f of files.slice(0, room)) {
        const prep = await rbPrepare(f);
        if (!prep) { alert('이미지를 읽을 수 없습니다: ' + (f.name || '')); continue; }
        const shot = { id: ++rb.shotSeq, data: prep.data, kind: rbDefaultKind(), detKind: '', cnt: '', auto: null, conf: '', status: 'reading', manual: false, kindManual: false, _canvas: prep.canvas };
        rb.shots.push(shot);
        rbRenderShots();
        rb.ocrQ = rb.ocrQ.then(() => rbOcrShot(shot)).catch(() => {});
    }
}

async function rbOcrShot(shot) {
    if (!rb.shots.includes(shot)) { shot._canvas = null; return; }          // 읽기 전에 지운 사진
    try {
        const res = await rbReadCanvas(shot._canvas);
        if (!rb.shots.includes(shot)) return;
        shot.status = 'done';
        shot.detKind = res.kind || '';
        shot.auto = res.value;
        shot.conf = res.conf;
        if (res.kind && !shot.kindManual && res.kind !== shot.kind && rbCountKind(res.kind, shot) < RB_MAX_PER_KIND) shot.kind = res.kind;
        if (res.value !== null && !shot.manual) shot.cnt = res.value;        // 사용자가 직접 입력했다면 덮어쓰지 않음
    } catch (e) {
        shot.status = 'fail';
    } finally {
        shot._canvas = null;
        rbRenderShots();
    }
}

function rbShotNote(x) {
    if (x.status === 'reading') return '🔍 사진을 읽는 중... (직접 입력해도 됩니다)';
    const parts = [];
    const edited = x.auto !== null && Number(x.cnt) !== x.auto;
    if (x.status === 'fail') parts.push('⚠️ 자동 인식을 사용할 수 없습니다 — 횟수를 직접 입력하세요');
    else if (x.auto === null) parts.push('❌ 점수를 읽지 못했습니다 — 횟수를 직접 입력하세요');
    else if (edited) parts.push('✏️ 직접 수정함 (자동 인식: ' + x.auto + ')');
    else if (x.conf === 'high') parts.push('✅ 자동 인식 (' + x.auto + '점)');
    else parts.push('⚠️ ' + x.auto + '점으로 읽었습니다 — 사진과 맞는지 확인하세요');
    if (x.detKind && x.detKind !== x.kind) parts.push('⚠️ 사진은 ' + RB_KIND[x.detKind] + ' 화면으로 보입니다');
    if (!x.kind) parts.push('⚠️ 종류를 선택하세요 (복구·축복 각 2장까지)');
    return parts.join(' · ');
}

function rbRenderShots() {
    const box = $('rb-shots');
    if (!box) return;
    box.innerHTML = rb.shots.map(x => `
        <div style="display:flex; gap:10px; align-items:flex-start; padding:8px; border:1px solid #e5e8ea; border-radius:8px; margin-bottom:8px; background:#fafbfc;">
            <img src="${rbSafeSrc(x.data)}" style="width:64px; height:64px; object-fit:cover; border-radius:6px; border:1px solid #ddd; flex:none;">
            <div style="flex:1; min-width:0;">
                <div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap;">
                    <select onchange="Settle.rbShotKind(${x.id}, this.value)" style="width:auto; margin:0; padding:6px 8px; border:2px solid #ddd; border-radius:6px; font-size:0.88rem; font-weight:bold;">
                        <option value=""${x.kind === '' ? ' selected' : ''}>종류</option>
                        <option value="recovery"${x.kind === 'recovery' ? ' selected' : ''}>복구</option>
                        <option value="blessing"${x.kind === 'blessing' ? ' selected' : ''}>축복</option>
                    </select>
                    <input type="number" id="rb-shot-cnt-${x.id}" min="0" step="1" value="${esc(x.cnt)}" oninput="Settle.rbShotCount(${x.id}, this.value)" placeholder="횟수" style="width:84px; margin:0; padding:6px 8px; border:2px solid #ddd; border-radius:6px; font-size:0.95rem;">
                    <span style="font-size:0.85rem; color:#555;">회</span>
                </div>
                <div id="rb-shot-note-${x.id}" style="font-size:0.74rem; color:#7f8c8d; margin-top:4px; line-height:1.4;">${esc(rbShotNote(x))}</div>
            </div>
            <button onclick="Settle.rbRemoveShot(${x.id})" style="width:26px; height:26px; border-radius:50%; border:none; background:#e74c3c; color:white; cursor:pointer; font-size:12px; line-height:1; flex:none;">✕</button>
        </div>`).join('');
    rbRenderTotals();
}
function rbRenderTotals() {
    const el = $('rb-totals');
    if (!el) return;
    const t = rbTotals();
    el.innerHTML = rb.shots.length ? `복구 횟수 <b style="color:#2980b9;">${fmt(t.recovery)}</b>회 · 축복 횟수 <b style="color:#2980b9;">${fmt(t.blessing)}</b>회 <span style="color:#95a5a6; font-size:0.76rem;">(사진별 횟수의 합계)</span>` : '';
}
function rbShotFind(id) { return rb.shots.find(x => x.id === Number(id)); }
function rbShotCount(id, v) {
    const x = rbShotFind(id);
    if (!x) return;
    x.cnt = (v === '' || v === null) ? '' : Math.max(0, parseInt(v) || 0);
    x.manual = true;
    const note = $('rb-shot-note-' + x.id);
    if (note) note.textContent = rbShotNote(x);
    rbRenderTotals();
}
function rbShotKind(id, v) {
    const x = rbShotFind(id);
    if (!x) return;
    if (v && rbCountKind(v, x) >= RB_MAX_PER_KIND) { alert(RB_KIND[v] + ' 사진은 ' + RB_MAX_PER_KIND + '장까지 올릴 수 있습니다.'); rbRenderShots(); return; }
    x.kind = v;
    x.kindManual = true;
    rbRenderShots();
}
function rbRemoveShot(id) {
    const x = rbShotFind(id);
    if (!x) return;
    rb.shots = rb.shots.filter(y => y !== x);
    x._canvas = null;
    rbRenderShots();
}


function rbLoadWeek() {
    rb.week = $('rb-week').value;
    rb.open.clear();
    if (rb.weekRef && rb.weekCb) rb.weekRef.off('value', rb.weekCb);      // 내 구독만 해제 (같은 주차를 보는 사용자 탭 구독은 유지)
    const key = rb.week;
    const ref = db.ref('boss_reimburse/' + key);
    const cb = snap => {
        if (rb.weekRef !== ref) return;
        const data = snap.val() || {};
        rb.requests = Object.values(data).filter(r => r && r.id).map(r => Object.assign({}, r, { _week: key }))
            .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
        rbRender();
    };
    rb.weekRef = ref; rb.weekCb = cb;
    ref.on('value', cb);
}

function rbRenderPriceLine() {
    const p = rb.prices;
    const has = p.recovery || p.blessing || p.transfer;
    const txt = has
        ? `지급 단가(회당): 복구 ${fmt(p.recovery)} · 축복 ${fmt(p.blessing)} · 이전 ${fmt(p.transfer)} ${UNIT}`
        : '지급 단가가 아직 설정되지 않았습니다. (운영진이 복구·축복·이전 단가를 각각 설정하면 금액이 계산됩니다)';
    const adm = $('rb-price-line');
    if (adm) adm.innerHTML = esc(txt) + (isAdmin ? ' <button onclick="Settle.rbSetPrices()" style="margin-left:6px; padding:4px 10px; border:none; border-radius:6px; background:#8e44ad; color:white; font-size:0.78rem; font-weight:bold; cursor:pointer;">⚙️ 단가 설정</button>' : '');
    const usr = $('rbu-price-line');
    if (usr) usr.textContent = txt;
    const tp = $('rbu-transfer-price');
    if (tp) tp.textContent = p.transfer ? '(1회당 ' + fmt(p.transfer) + ' ' + UNIT + ')' : '(단가 미설정)';
    rbRenderTransferPreview();
}
function rbRenderTransferPreview() {
    const el = $('rb-transfer-amt'), inp = $('rb-transfer');
    if (!el || !inp) return;
    const n = Number(inp.value) || 0;
    el.textContent = n > 0 ? '예상 이전비: ' + fmt(n) + ' × ' + fmt(rb.prices.transfer) + ' = ' + fmt(n * (Number(rb.prices.transfer) || 0)) + ' ' + UNIT : '';
}

// ── 이미지 선택/압축 ──
// ── 제출 ──
async function rbSubmit() {
    const user = userById(parseInt($('rb-user').value));
    const memo = $('rb-memo').value.trim();
    const week = $('rbu-week') ? $('rbu-week').value : rb.week;
    if (!week) { alert('주차를 선택하세요.'); return; }
    if (!user)    { alert('신청자를 선택하세요.'); return; }
    const localMine = (rb.userData[week] || []).filter(r => Number(r.userId) === Number(user.id));
    if (localMine.some(r => r.status === 'approved')) { alert(rbLockMsg(user.name)); return; }          // 확정된 주차는 제출 불가
    const trRaw = ($('rb-transfer') ? $('rb-transfer').value : '').trim();
    const transfer = trRaw === '' ? 0 : Number(trRaw);
    if (!Number.isInteger(transfer) || transfer < 0) { alert('이전 횟수는 0 이상의 정수로 입력하세요.'); return; }
    if (rb.shots.length === 0 && transfer <= 0) { alert('호칭 화면 사진을 1장 이상 올려주세요. (이전 횟수만 신청하는 경우에는 이전 횟수를 입력하세요)'); return; }
    if (rb.shots.some(x => x.status === 'reading' && !x.manual)) { alert('사진을 읽는 중입니다. 잠시 뒤에 다시 눌러주세요. (횟수를 직접 입력해도 됩니다)'); return; }
    for (let i = 0; i < rb.shots.length; i++) {
        const x = rb.shots[i];
        if (!x.kind) { alert((i + 1) + '번째 사진의 종류(복구/축복)를 선택하세요.'); return; }
        if (x.cnt === '' || isNaN(Number(x.cnt)) || Number(x.cnt) < 0) { alert((i + 1) + '번째 사진의 횟수를 입력하세요.'); return; }
    }
    if (rbCountKind('recovery') > RB_MAX_PER_KIND || rbCountKind('blessing') > RB_MAX_PER_KIND) { alert('복구·축복 사진은 각각 ' + RB_MAX_PER_KIND + '장까지입니다.'); return; }
    const t = rbTotals();
    if (t.recovery + t.blessing + transfer <= 0) { alert('복구·축복·이전 횟수가 모두 0입니다. 횟수를 확인하세요.'); return; }
    // 같은 사진을 두 번 올렸는지
    for (const kind of ['recovery', 'blessing']) {
        const same = rb.shots.filter(x => x.kind === kind);
        if (same.length === 2 && same[0].data === same[1].data) { alert(RB_KIND[kind] + ' 사진이 같은 사진으로 두 번 올라갔습니다. 하나를 지워주세요.'); return; }
        if (same.length === 2 && Number(same[0].cnt) === Number(same[1].cnt) && !confirm(RB_KIND[kind] + ' 사진 두 장의 횟수가 같습니다(' + same[0].cnt + '회).\n서로 다른 캐릭터 사진이 맞나요? 합산해서 신청합니다.')) return;
    }
    // 점수는 한 주 누적값이라 한 사람당 한 건만 유지: 확정 전 신청은 새 내용으로 교체(재신청), 확정되면 불가 — 서버 값으로 확인
    let existing = localMine;
    try { existing = Object.values((await db.ref('boss_reimburse/' + week).once('value')).val() || {}).filter(r => r && Number(r.userId) === Number(user.id)); } catch (e) { /* 화면에 있는 값으로 확인 */ }
    if (existing.some(r => r.status === 'approved')) { alert(rbLockMsg(user.name)); return; }
    const old = existing;
    if (old.length && !confirm(`${user.name}님의 이 주차 신청이 이미 있습니다.\n(${old[0].status === 'rejected' ? '반려' : '확인 대기'}: ${rbCntText(old[0])})\n\n새 내용으로 재신청하면 기존 신청과 증빙 사진은 삭제됩니다. 계속할까요?`)) return;
    try {
        for (const o of old) {                                                    // 교체 직전, 그 사이 운영진이 확정하지 않았는지 한 번 더 확인
            const res = await db.ref('boss_reimburse/' + week + '/' + o.id).transaction(cur => (cur && cur.status === 'approved') ? undefined : cur);
            if (res && res.committed === false) { alert('방금 운영진이 확정했습니다. ' + rbLockMsg(user.name)); return; }
        }
    } catch (e) { alert('❌ 확인 실패: ' + e.message); return; }

    const btn = $('rb-submit-btn');
    btn.disabled = true; btn.textContent = '제출 중...';
    const id = Date.now() + '_' + Number(user.id);
    const req = {
        id: id, userId: Number(user.id), name: user.name,
        recoveryCnt: t.recovery, blessingCnt: t.blessing, transferCnt: transfer,
        shots: rb.shots.map(x => ({ kind: x.kind, cnt: Number(x.cnt) || 0, auto: x.auto === null ? null : x.auto })),   // 사진별 횟수 + 자동 인식값(수정 여부 확인용)
        memo: memo, imgCount: rb.shots.length, status: 'pending', paid: false, by: deviceId(), createdAt: nowIso()
    };
    const keep = old.find(o => Number(o.extraAmount) > 0);                  // 운영진이 넣어 둔 추가비용은 재신청해도 유지
    if (keep) { req.extraAmount = Number(keep.extraAmount); if (keep.extraNote) req.extraNote = keep.extraNote; }
    const updates = {};
    old.forEach(o => { updates['boss_reimburse/' + week + '/' + o.id] = null; updates['boss_reimburse_img/' + o.id] = null; });
    updates['boss_reimburse/' + week + '/' + id] = req;
    if (rb.shots.length) updates['boss_reimburse_img/' + id] = rb.shots.map(x => x.data);          // 사진이 없는 신청(이전만)은 사진 경로를 만들지 않음
    try {
        await db.ref().update(updates);
        old.forEach(o => { delete rb.imgCache[o.id]; rb.open.delete(sid(o.id)); });
        rb.shots = [];
        rbRenderShots();
        $('rb-memo').value = '';
        if ($('rb-transfer')) { $('rb-transfer').value = ''; rbRenderTransferPreview(); }
        alert(old.length ? '✅ 재신청이 완료되었습니다. 기존 신청이 새 내용으로 바뀌었습니다.' : '✅ 제출되었습니다. 운영진 확인 후 확정되면 지급됩니다.');
    } catch (e) {
        alert('❌ 제출 실패: ' + e.message);
    } finally {
        btn.disabled = false;
        rbRenderSubmitState();
    }
}

// ── 목록 ──
function rbStatusBadge(r) {
    if (r.status === 'approved') return r.paid ? badge('💵 지급완료', '#27ae60') : badge('✅ 확정', '#2980b9');
    if (r.status === 'rejected') return badge('❌ 반려', '#c0392b');
    return badge('⏳ 확인 대기', '#e67e22');
}

function rbCardHtml(r, mode) {
    const adminView = mode === 'admin';
    const k = sid(r.id);
    const amount = rbAmount(r);
    const pr = r.priceSnap || rb.prices;
    const isMine = rbIsMine(r);
    const locked = r.status === 'approved';                          // 확정되면 수정 불가
    const canEdit = !locked && ((adminView && isAdmin) || isMine);
    const canDelete = (adminView && isAdmin) || (isMine && (r.status === 'pending' || r.status === 'rejected'));
    const border = r.status === 'approved' ? (r.paid ? '#a9dfbf' : '#aed6f1') : (r.status === 'rejected' ? '#f5b7b1' : '#f0e6cc');
    const btns = [];
    if (r.imgCount > 0) btns.push(actBtn('🖼️ 증빙 ' + r.imgCount + '장', `Settle.rbShowImages('${k}')`, '#5D6D7E'));
    if (canEdit) btns.push(actBtn('✏️ 횟수 수정', `Settle.rbEdit('${k}')`, '#8e44ad'));
    if (adminView && isAdmin) {
        if (!locked) btns.push(actBtn('✅ 확정', `Settle.rbApprove('${k}')`, '#2980b9'));
        if (r.status === 'pending') btns.push(actBtn('❌ 반려', `Settle.rbReject('${k}')`, '#c0392b'));
        if (!r.paid && (r.status === 'pending' || locked)) btns.push(actBtn(Number(r.extraAmount) > 0 ? '➕ 추가비용 수정' : '➕ 추가비용', `Settle.rbExtra('${k}')`, '#d35400'));
        if (locked) btns.push(actBtn(r.paid ? '↩️ 지급 취소' : '💵 지급완료', `Settle.rbTogglePaid('${k}')`, '#27ae60'));
        if (locked && !r.paid) btns.push(actBtn('↩️ 확정 취소', `Settle.rbUnconfirm('${k}')`, '#7f8c8d'));
        if (r.paid && r.imgCount > 0) btns.push(actBtn('🧹 증빙 삭제', `Settle.rbDeleteImages('${k}')`, '#95a5a6'));
    }
    if (canDelete) btns.push(actBtn('🗑️', `Settle.rbDelete('${k}')`, '#e74c3c'));
    const shotsLine = adminView ? rbShotsLine(r) : '';
    const weekTag = adminView ? '' : `<div style="font-size:0.74rem; color:#7f8c8d; margin-bottom:4px;">📅 ${esc(rbWeekName(r._week || ''))}</div>`;
    return `
    <div style="background:white; border:2px solid ${border}; border-radius:10px; padding:12px; margin-bottom:10px;">
        ${weekTag}
        <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap;">
            <div style="font-weight:bold; color:#2c3e50;">${esc(r.name)}${isMine && adminView ? ' <span style="padding:1px 6px; background:#ffc107; color:#333; border-radius:4px; font-size:0.72rem;">⭐ 나</span>' : ''}</div>
            ${rbStatusBadge(r)}
        </div>
        <div style="margin-top:6px; font-size:0.92rem; color:#555;">
            복구 <b>${fmt(r.recoveryCnt)}</b>회 · 축복 <b>${fmt(r.blessingCnt)}</b>회${Number(r.transferCnt) > 0 ? ` · 이전 <b>${fmt(r.transferCnt)}</b>회` : ''}
            <span style="color:#2980b9; font-weight:bold;"> = ${fmt(amount)} ${UNIT}</span>${r.edited ? ' <span style="color:#8e44ad; font-size:0.76rem;">✏️수정됨</span>' : ''}
        </div>
        <div style="margin-top:2px; font-size:0.76rem; color:#95a5a6;">복구 ${fmt(r.recoveryCnt)}×${fmt(pr.recovery)} + 축복 ${fmt(r.blessingCnt)}×${fmt(pr.blessing)}${Number(r.transferCnt) > 0 ? ` + 이전 ${fmt(r.transferCnt)}×${fmt(pr.transfer)}` : ''}${Number(r.extraAmount) > 0 ? ` + 추가 ${fmt(r.extraAmount)}` : ''}${r.status === 'pending' && (pr.recovery || pr.blessing) ? ' (예상 · 확정 때 단가로 정해짐)' : ''}</div>
        ${Number(r.extraAmount) > 0 ? `<div style="margin-top:4px; font-size:0.85rem; color:#d35400; font-weight:bold;">➕ 추가비용 +${fmt(r.extraAmount)} ${UNIT}${r.extraNote ? ' <span style="font-weight:normal;">(' + esc(r.extraNote) + ')</span>' : ''}</div>` : ''}
        ${shotsLine ? `<div style="margin-top:2px; font-size:0.76rem; color:#7f8c8d;">${esc(shotsLine)}</div>` : ''}
        ${r.memo ? `<div style="margin-top:4px; font-size:0.85rem; color:#7f8c8d;">📝 ${esc(r.memo)}</div>` : ''}
        ${r.status === 'rejected' && r.rejectReason ? `<div style="margin-top:4px; font-size:0.85rem; color:#c0392b;">반려 사유: ${esc(r.rejectReason)}</div>` : ''}
        ${locked ? '<div style="margin-top:4px; font-size:0.76rem; color:#2980b9;">🔒 확정됨 — 횟수 수정 불가 · 증빙 사진 삭제됨</div>' : ''}
        <div style="margin-top:3px; font-size:0.76rem; color:#aaa;">${esc(new Date(r.createdAt).toLocaleString('ko-KR'))}</div>
        <div class="rb-imgs" data-k="${k}" style="display:flex; gap:6px; flex-wrap:wrap; margin-top:8px;"></div>
        ${btns.length ? `<div style="display:flex; gap:6px; flex-wrap:wrap; margin-top:10px;">${btns.join('')}</div>` : ''}
    </div>`;
}

function rbRender() {                                      // 관리자: 이 주차 전체 신청
    const box = $('rb-list');
    if (!box) return;
    if (rb.requests.length === 0) {
        box.innerHTML = '<p style="color:#95a5a6; text-align:center; padding:20px; margin:0;">이 주차에 접수된 신청이 없습니다.</p>';
        rbRenderSummary();
        return;
    }
    box.innerHTML = rb.requests.map(r => rbCardHtml(r, 'admin')).join('');
    rb.open.forEach(k => rbPaintImages(k));
    rbRenderSummary();
}

// ── 사용자 화면: 내가 받을 돈 / 내 신청 내역 ──
function rbRenderUser() {
    rbRenderPriceLine();
    rbRenderMoney();
    rbRenderMine();
    rbRenderSubmitState();
}
// 신청자·주차에 따라 제출 버튼 상태: 신청 없음 → [제출] / 확정 전 신청 있음 → [재신청] / 확정됨 → 제출 불가
const rbLockMsg = (name) => name + '님의 이 주차 신청은 이미 확정되어 이번 주는 더 이상 제출할 수 없습니다.';
function rbRenderSubmitState() {
    const btn = $('rb-submit-btn'), note = $('rbu-state');
    if (!btn || !note) return;
    const lock = (on) => {
        btn.disabled = on; btn.style.opacity = on ? '0.5' : '';
        const f = $('rb-files'); if (f) f.disabled = on;
        const lbl = document.querySelector('label[for="rb-files"]');
        if (lbl) { lbl.style.opacity = on ? '0.4' : ''; lbl.style.pointerEvents = on ? 'none' : ''; }
    };
    const user = userById(parseInt($('rb-user').value));
    const week = $('rbu-week') ? $('rbu-week').value : '';
    const mine = (user && week) ? (rb.userData[week] || []).filter(r => Number(r.userId) === Number(user.id)) : [];
    const done = mine.find(r => r.status === 'approved');
    if (done) {
        note.style.cssText = 'display:block; margin:-4px 0 12px; padding:9px 12px; border-radius:8px; font-size:0.84rem; line-height:1.5; background:#eaf2f8; color:#1f618d; border:1px solid #aed6f1;';
        note.innerHTML = '🔒 ' + esc(rbLockMsg(user.name)) + '<br><span style="font-size:0.78rem;">확정 내용: ' + rbCntText(done) + '</span>';
        btn.textContent = '🔒 확정됨 — 제출 불가'; lock(true);
    } else if (mine.length) {
        const o = mine[0];
        note.style.cssText = 'display:block; margin:-4px 0 12px; padding:9px 12px; border-radius:8px; font-size:0.84rem; line-height:1.5; background:#fef5e7; color:#a04000; border:1px solid #f5cba7;';
        note.innerHTML = '🔄 이 주차에 이미 신청이 있습니다 (' + (o.status === 'rejected' ? '반려' : '확인 대기') + ': ' + rbCntText(o) + ').<br><span style="font-size:0.78rem;">다시 제출하면 기존 신청이 새 내용으로 바뀝니다. 확정되기 전까지 몇 번이든 재신청할 수 있습니다.</span>';
        btn.textContent = '🔄 재신청'; lock(false);
    } else {
        note.style.display = 'none'; note.innerHTML = '';
        btn.textContent = '📤 제출'; lock(false);
    }
}

function rbRenderMoney() {
    const el = $('rbu-money');
    if (!el) return;
    const mine = rbMine();
    const sum = (f) => mine.filter(f).reduce((t, r) => t + rbAmount(r), 0);
    const waiting = sum(r => r.status === 'approved' && !r.paid);
    const paid = sum(r => r.status === 'approved' && r.paid);
    const est = sum(r => r.status === 'pending');
    const wp = mine.filter(r => r.status === 'approved' && !r.paid).reduce((a, r) => { const q = rbParts(r); a.base += q.base; a.tr += q.transfer; a.ex += q.extra; return a; }, { base: 0, tr: 0, ex: 0 });
    const detail = (wp.tr || wp.ex) ? `<div style="font-size:0.78rem; color:#555; margin-top:4px;">복구·축복 ${fmt(wp.base)} + 이전 ${fmt(wp.tr)}${wp.ex ? ' + 추가비용 ' + fmt(wp.ex) : ''}</div>` : '';
    const tile = (label, val, bg, color) => `<div style="flex:1; background:${bg}; border-radius:8px; padding:8px; text-align:center;"><div style="font-size:0.72rem; color:#7f8c8d;">${label}</div><div style="font-size:0.98rem; font-weight:bold; color:${color};">${fmt(val)} ${UNIT}</div></div>`;
    el.innerHTML = `
        <div style="text-align:center; padding:4px 0 10px;">
            <div style="font-size:0.8rem; color:#7f8c8d;">지급 대기 (확정됨)</div>
            <div style="font-size:1.8rem; font-weight:bold; color:#2980b9;">${fmt(waiting)} <span style="font-size:1rem;">${UNIT}</span></div>
            ${detail}
            <div style="font-size:0.76rem; color:#7f8c8d;">${waiting ? '운영진이 확정한 금액입니다. 곧 지급됩니다.' : (est ? '운영진이 확정하면 이곳에 표시됩니다.' : '확정된 금액이 없습니다.')}</div>
        </div>
        <div style="display:flex; gap:8px;">${tile('확인 대기 (예상)', est, '#fef9e7', '#d35400')}${tile('지급 완료', paid, '#d5f4e6', '#27ae60')}</div>
        <div style="font-size:0.74rem; color:#95a5a6; margin-top:8px; line-height:1.5;">최근 3주 신청 기준${myNameList().length === 0 ? '<br>💡 출석 체크 탭에서 <b>[내 이름 설정]</b>을 하면 내 신청이 자동으로 모입니다.' : ''}</div>`;
}
function rbRenderMine() {
    const box = $('rbu-list');
    if (!box) return;
    const mine = rbMine();
    if (!mine.length) { box.innerHTML = '<p style="color:#95a5a6; text-align:center; padding:16px; margin:0; font-size:0.9rem;">최근 3주 동안 신청한 내역이 없습니다.</p>'; return; }
    box.innerHTML = mine.map(r => rbCardHtml(r, 'user')).join('');
    rb.open.forEach(k => rbPaintImages(k));
}

function rbShotsLine(r) {
    if (!Array.isArray(r.shots) || !r.shots.length) return '';
    const parts = r.shots.map(x => {
        const k = RB_KIND[x.kind] || '?';
        const auto = (x.auto === undefined || x.auto === null) ? ' (직접 입력)' : (Number(x.auto) !== Number(x.cnt) ? ' ✏️수정(자동 인식 ' + x.auto + ')' : '');
        return k + ' ' + fmt(x.cnt) + '회' + auto;
    });
    return '사진 ' + r.shots.length + '장: ' + parts.join(' · ');
}
// ── 증빙 이미지 보기 ──
const rbImgBoxes = (k) => Array.from(document.querySelectorAll('.rb-imgs[data-k="' + k + '"]'));
function rbShowImages(k) {
    if (rb.open.has(k)) {
        rb.open.delete(k);
        rbImgBoxes(k).forEach(b => { b.innerHTML = ''; });
        return;
    }
    rb.open.add(k);
    rbPaintImages(k);
}

async function rbPaintImages(k) {
    const r = rbFind(k);
    if (!r || !rbImgBoxes(k).length) return;
    try {
        if (!rb.imgCache[r.id]) {
            rbImgBoxes(k).forEach(b => { b.innerHTML = '<span style="color:#aaa; font-size:0.85rem;">불러오는 중...</span>'; });
            const snap = await db.ref('boss_reimburse_img/' + r.id).once('value');
            rb.imgCache[r.id] = Object.values(snap.val() || {});
        }
        const imgs = rb.imgCache[r.id];
        if (!rb.open.has(k)) return;
        const html = imgs.length
            ? imgs.map((d, i) => `<img src="${rbSafeSrc(d)}" onclick="Settle.rbOpenImage('${k}', ${i})" style="width:96px; height:96px; object-fit:cover; border-radius:8px; border:1px solid #ddd; cursor:pointer;">`).join('')
            : '<span style="color:#aaa; font-size:0.85rem;">증빙 이미지가 없습니다 (삭제됨)</span>';
        rbImgBoxes(k).forEach(b => { b.innerHTML = html; });
    } catch (e) {
        rbImgBoxes(k).forEach(b => { b.innerHTML = '<span style="color:#c0392b; font-size:0.85rem;">이미지를 불러오지 못했습니다.</span>'; });
    }
}

function rbOpenImage(k, idx) {
    const r = rbFind(k);
    const imgs = r ? rb.imgCache[r.id] : null;
    if (!imgs || !imgs[idx]) return;
    let ov = $('rb-overlay');
    if (!ov) {
        ov = document.createElement('div');
        ov.id = 'rb-overlay';
        ov.style.cssText = 'position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.85); z-index:6000; display:none; justify-content:center; align-items:center; cursor:pointer;';
        ov.onclick = () => { ov.style.display = 'none'; ov.innerHTML = ''; };
        document.body.appendChild(ov);
    }
    ov.innerHTML = `<img src="${rbSafeSrc(imgs[idx])}" style="max-width:96vw; max-height:92vh; border-radius:8px;">`;
    ov.style.display = 'flex';
}

// ── 운영진 처리 ──
function rbUpdate(r, patch) {
    const updates = {};
    Object.keys(patch).forEach(key => { updates['boss_reimburse/' + rbWeekOf(r) + '/' + r.id + '/' + key] = patch[key]; });
    return db.ref().update(updates).catch(e => alert('❌ 저장 실패: ' + e.message));
}

// 확정: 횟수를 더 이상 수정할 수 없게 잠그고, 증빙 사진은 삭제 (횟수와 단가 기록만 남김)
async function rbApprove(k) {
    const r = rbFind(k);
    if (!r || !(await requireAdmin())) return;
    const missing = [];
    if ((Number(r.recoveryCnt) || 0) > 0 && !rb.prices.recovery) missing.push('복구');
    if ((Number(r.blessingCnt) || 0) > 0 && !rb.prices.blessing) missing.push('축복');
    if ((Number(r.transferCnt) || 0) > 0 && !rb.prices.transfer) missing.push('이전');
    if (missing.length && !confirm(missing.join('·') + ' 단가가 설정되지 않아 해당 금액이 0으로 계산됩니다. 계속 확정할까요?')) return;
    const imgN = Number(r.imgCount) || 0;
    if (!confirm(`${r.name}님 신청을 확정할까요?\n${rbCntText(r)}${Number(r.extraAmount) > 0 ? ' · 추가비용 ' + fmt(r.extraAmount) : ''}\n\n확정하면 횟수를 수정할 수 없고${imgN ? ', 증빙 사진 ' + imgN + '장은 삭제됩니다.' : '.'}`)) return;
    const base = 'boss_reimburse/' + rbWeekOf(r) + '/' + r.id;
    const updates = {};
    updates[base + '/status'] = 'approved';
    updates[base + '/priceSnap'] = { recovery: rb.prices.recovery, blessing: rb.prices.blessing, transfer: rb.prices.transfer };
    updates[base + '/reviewedAt'] = nowIso();
    updates[base + '/rejectReason'] = null;
    updates[base + '/imgCount'] = 0;
    updates['boss_reimburse_img/' + r.id] = null;
    try {
        await db.ref().update(updates);
        delete rb.imgCache[r.id];
        rb.open.delete(k);
    } catch (e) { alert('❌ 확정 실패: ' + e.message); }
}

async function rbUnconfirm(k) {
    const r = rbFind(k);
    if (!r || r.status !== 'approved' || r.paid || !(await requireAdmin())) return;
    if (!confirm('확정을 취소할까요?\n다시 횟수를 수정할 수 있게 되지만, 이미 삭제된 증빙 사진은 되돌릴 수 없습니다.')) return;
    await rbUpdate(r, { status: 'pending', priceSnap: null, reviewedAt: null });
}

// 횟수 수정: 확정 전에는 본인(또는 운영진)이 수정 가능, 확정되면 불가
async function rbEdit(k) {
    const r = rbFind(k);
    if (!r) return;
    const mine = rbIsMine(r);
    if (r.status === 'approved') { alert('확정된 신청은 수정할 수 없습니다.'); return; }
    if (!isAdmin && !mine) { if (!(await requireAdmin())) return; }
    const lab = 'font-size:0.85rem; font-weight:bold; color:#555; display:block; margin:12px 0 4px;';
    showModal(`
        <h3 style="margin:0 0 4px; color:#2c3e50;">✏️ 횟수 수정</h3>
        <p style="font-size:0.8rem; color:#7f8c8d; margin:0;"><b>${esc(r.name)}</b>님의 이번 주 사용 횟수</p>
        <label style="${lab}">복구 횟수</label>
        <input type="number" id="rb-edit-rec" min="0" step="1" value="${Number(r.recoveryCnt) || 0}" style="${inputStyle}">
        <label style="${lab}">축복 횟수</label>
        <input type="number" id="rb-edit-bls" min="0" step="1" value="${Number(r.blessingCnt) || 0}" style="${inputStyle}">
        <label style="${lab}">이전 횟수</label>
        <input type="number" id="rb-edit-trf" min="0" step="1" value="${Number(r.transferCnt) || 0}" style="${inputStyle}">
        <p style="font-size:0.76rem; color:#95a5a6; margin:10px 0 0;">운영진이 확정하면 더 이상 수정할 수 없습니다.${r.status === 'rejected' ? ' 수정하면 다시 "확인 대기"로 돌아갑니다.' : ''}</p>
        <div style="display:flex; gap:8px; margin-top:14px;">
            ${actBtn('저장', `Settle.rbSaveEdit('${sid(r.id)}')`, '#8e44ad').replace('padding:6px 11px', 'flex:1; padding:11px')}
            ${actBtn('취소', 'Settle.closeModal()', '#95a5a6').replace('padding:6px 11px', 'flex:1; padding:11px')}
        </div>`);
}
async function rbSaveEdit(k) {
    const r = rbFind(k);
    if (!r) return;
    const rn = parseInt($('rb-edit-rec').value), bn = parseInt($('rb-edit-bls').value), tn = $('rb-edit-trf').value === '' ? 0 : parseInt($('rb-edit-trf').value);
    if (isNaN(rn) || isNaN(bn) || isNaN(tn) || rn < 0 || bn < 0 || tn < 0) { alert('횟수는 0 이상의 숫자여야 합니다. (복구/축복/이전)'); return; }
    if (!isAdmin && !rbIsMine(r)) { if (!(await requireAdmin())) return; }
    try {
        // 그 사이 운영진이 확정했다면 저장하지 않도록 서버 값으로 한 번 더 확인
        const res = await db.ref('boss_reimburse/' + rbWeekOf(r) + '/' + r.id).transaction(cur => {
            if (cur === null) return cur;
            if (cur.status === 'approved') return;                         // 중단
            cur.recoveryCnt = rn; cur.blessingCnt = bn; cur.transferCnt = tn;
            cur.status = 'pending'; delete cur.rejectReason;
            cur.edited = true; cur.editedAt = nowIso();
            return cur;
        });
        closeModal();
        if (res && res.committed === false) alert('이미 확정되어 수정할 수 없습니다.');
    } catch (e) { alert('❌ 저장 실패: ' + e.message); }
}

// 운영진이 직접 기입하는 추가비용 (지급 전까지 수정 가능, 0으로 두면 삭제). 단가와 무관한 금액이라 확정 후에도 지급 전에는 바꿀 수 있음
async function rbExtra(k) {
    const r = rbFind(k);
    if (!r) return;
    if (!(await requireAdmin())) return;
    if (r.paid) { alert('이미 지급 완료된 신청은 추가비용을 바꿀 수 없습니다. (지급 취소 후 수정하세요)'); return; }
    const lab = 'font-size:0.85rem; font-weight:bold; color:#555; display:block; margin:12px 0 4px;';
    showModal(`
        <h3 style="margin:0 0 4px; color:#2c3e50;">➕ 추가비용</h3>
        <p style="font-size:0.8rem; color:#7f8c8d; margin:0;"><b>${esc(r.name)}</b>님의 이번 신청에 더해 줄 금액을 직접 기입합니다.</p>
        <label style="${lab}">추가비용 (${UNIT})</label>
        <input type="number" id="rb-extra-amt" min="0" step="1" value="${Number(r.extraAmount) || ''}" placeholder="0" style="${inputStyle}">
        <label style="${lab}">사유 (선택)</label>
        <input type="text" id="rb-extra-note" maxlength="40" value="${esc(r.extraNote || '')}" placeholder="예: 이벤트 보상" style="${inputStyle}">
        <p style="font-size:0.76rem; color:#95a5a6; margin:10px 0 0;">내 신청 금액과 [내가 받을 돈]에 그대로 더해집니다. 0으로 저장하면 삭제됩니다.</p>
        <div style="display:flex; gap:8px; margin-top:14px;">
            ${actBtn('저장', `Settle.rbSaveExtra('${sid(r.id)}')`, '#d35400').replace('padding:6px 11px', 'flex:1; padding:11px')}
            ${actBtn('취소', 'Settle.closeModal()', '#95a5a6').replace('padding:6px 11px', 'flex:1; padding:11px')}
        </div>`);
}
async function rbSaveExtra(k) {
    const r = rbFind(k);
    if (!r) return;
    if (!(await requireAdmin())) return;                       // 저장 시점에도 관리자 확인
    const raw = $('rb-extra-amt').value.trim();
    const amt = raw === '' ? 0 : Number(raw);
    if (!Number.isInteger(amt) || amt < 0) { alert('추가비용은 0 이상의 정수로 입력하세요.'); return; }
    try {
        const res = await db.ref('boss_reimburse/' + rbWeekOf(r) + '/' + r.id).transaction(cur => {
            if (cur === null) return cur;
            if (cur.paid) return;                              // 그 사이 지급 완료되었다면 중단
            if (amt > 0) { cur.extraAmount = amt; const nt = $('rb-extra-note').value.trim(); if (nt) cur.extraNote = nt; else delete cur.extraNote; }
            else { delete cur.extraAmount; delete cur.extraNote; }
            return cur;
        });
        closeModal();
        if (res && res.committed === false) alert('이미 지급 완료되어 추가비용을 바꿀 수 없습니다.');
    } catch (e) { alert('❌ 저장 실패: ' + e.message); }
}

async function rbReject(k) {
    const r = rbFind(k);
    if (!r || !(await requireAdmin())) return;
    const reason = prompt('반려 사유 (선택)', '');
    if (reason === null) return;
    await rbUpdate(r, { status: 'rejected', rejectReason: reason.trim() || null, paid: false, paidAt: null, priceSnap: null, reviewedAt: nowIso() });
}
async function rbTogglePaid(k) {
    const r = rbFind(k);
    if (!r || r.status !== 'approved' || !(await requireAdmin())) return;
    const next = !r.paid;
    await rbUpdate(r, { paid: next, paidAt: next ? nowIso() : null });
}
async function rbPayUser(userId) {
    if (!(await requireAdmin())) return;
    const targets = rb.requests.filter(r => Number(r.userId) === Number(userId) && r.status === 'approved' && !r.paid);
    if (targets.length === 0) return;
    const total = targets.reduce((s, r) => s + rbAmount(r), 0);
    if (!confirm(`${targets[0].name}님에게 ${fmt(total)} ${UNIT} 지급 완료 처리할까요?`)) return;
    const now = nowIso();
    const updates = {};
    targets.forEach(r => {
        updates['boss_reimburse/' + rbWeekOf(r) + '/' + r.id + '/paid'] = true;
        updates['boss_reimburse/' + rbWeekOf(r) + '/' + r.id + '/paidAt'] = now;
    });
    await db.ref().update(updates).catch(e => alert('❌ 저장 실패: ' + e.message));
}
async function rbDelete(k) {
    const r = rbFind(k);
    if (!r) return;
    const mine = rbIsMine(r) && (r.status === 'pending' || r.status === 'rejected');
    if (!(isAdmin || mine)) { alert('삭제 권한이 없습니다.'); return; }
    if (!confirm('이 신청을 삭제할까요? (증빙 이미지도 함께 삭제됩니다)')) return;
    const updates = {};
    updates['boss_reimburse/' + rbWeekOf(r) + '/' + r.id] = null;
    updates['boss_reimburse_img/' + r.id] = null;
    await db.ref().update(updates).catch(e => alert('❌ 삭제 실패: ' + e.message));
    delete rb.imgCache[r.id];
    rb.open.delete(k);
}
async function rbDeleteImages(k) {
    const r = rbFind(k);
    if (!r || !(await requireAdmin())) return;
    if (!confirm('지급이 끝난 신청의 증빙 이미지를 삭제할까요? (DB 용량 절약, 되돌릴 수 없음)')) return;
    const updates = {};
    updates['boss_reimburse_img/' + r.id] = null;
    updates['boss_reimburse/' + rbWeekOf(r) + '/' + r.id + '/imgCount'] = 0;
    await db.ref().update(updates).catch(e => alert('❌ 삭제 실패: ' + e.message));
    delete rb.imgCache[r.id];
    rb.open.delete(k);
}
async function rbSetPrices() {
    if (!(await requireAdmin())) return;
    const lab = 'font-size:0.85rem; font-weight:bold; color:#555; display:block; margin:12px 0 4px;';
    showModal(`
        <h3 style="margin:0 0 4px; color:#2c3e50;">⚙️ 지원비 단가 설정</h3>
        <p style="font-size:0.8rem; color:#7f8c8d; margin:0 0 4px;">복구비·축복비·이전비는 단가가 달라서 각각 설정합니다. 신청 금액 = 횟수 × 단가.</p>
        <label style="${lab}">🩹 복구 1회당 지급액 (${UNIT})</label>
        <input type="number" id="rb-price-recovery" min="0" step="1" value="${Number(rb.prices.recovery) || 0}" style="${inputStyle}">
        <label style="${lab}">✨ 축복 1회당 지급액 (${UNIT})</label>
        <input type="number" id="rb-price-blessing" min="0" step="1" value="${Number(rb.prices.blessing) || 0}" style="${inputStyle}">
        <label style="${lab}">🚚 이전 1회당 지급액 (${UNIT})</label>
        <input type="number" id="rb-price-transfer" min="0" step="1" value="${Number(rb.prices.transfer) || 0}" style="${inputStyle}">
        <p style="font-size:0.76rem; color:#95a5a6; margin:10px 0 0;">이미 확정된 신청은 확정 당시 단가가 유지됩니다.</p>
        <div style="display:flex; gap:8px; margin-top:14px;">
            ${actBtn('저장', 'Settle.rbSavePrices()', '#8e44ad').replace('padding:6px 11px', 'flex:1; padding:11px')}
            ${actBtn('취소', 'Settle.closeModal()', '#95a5a6').replace('padding:6px 11px', 'flex:1; padding:11px')}
        </div>`);
}
async function rbSavePrices() {
    if (!(await requireAdmin())) return;                       // 저장 시점에도 관리자 확인
    const ra = parseInt($('rb-price-recovery').value), rbv = parseInt($('rb-price-blessing').value), rt = parseInt($('rb-price-transfer').value);
    if (isNaN(ra) || isNaN(rbv) || isNaN(rt) || ra < 0 || rbv < 0 || rt < 0) { alert('단가는 0 이상의 숫자로 입력하세요. (복구/축복/이전 모두)'); return; }
    try {
        await db.ref('hunter_config/reimbursePrices').set({ recovery: ra, blessing: rbv, transfer: rt });
        closeModal();
        alert('✅ 단가가 저장되었습니다.\n복구 ' + fmt(ra) + ' · 축복 ' + fmt(rbv) + ' · 이전 ' + fmt(rt) + ' ' + UNIT);
    } catch (e) { alert('❌ 저장 실패: ' + e.message); }
}

// ── 주간 지급 요약 ──
function rbRenderSummary() {
    const box = $('rb-summary');
    if (!box) return;
    const approved = rb.requests.filter(r => r.status === 'approved');
    const pendingCnt = rb.requests.filter(r => r.status === 'pending').length;
    const byUser = {};
    approved.forEach(r => {
        const u = byUser[r.userId] || (byUser[r.userId] = { userId: r.userId, name: r.name, rec: 0, bless: 0, trf: 0, extra: 0, amount: 0, unpaid: 0 });
        const a = rbAmount(r);
        u.rec += Number(r.recoveryCnt) || 0;
        u.bless += Number(r.blessingCnt) || 0;
        u.trf += Number(r.transferCnt) || 0;
        u.extra += Number(r.extraAmount) || 0;
        u.amount += a;
        if (!r.paid) u.unpaid += a;
    });
    const rows = Object.values(byUser).sort((a, b) => b.amount - a.amount);
    const total = rows.reduce((s, u) => s + u.amount, 0);
    const unpaid = rows.reduce((s, u) => s + u.unpaid, 0);
    const tile = (label, val, bg, color) => `<div style="flex:1; min-width:90px; background:${bg}; border-radius:8px; padding:10px; text-align:center;"><div style="font-size:0.74rem; color:#7f8c8d;">${label}</div><div style="font-size:1rem; font-weight:bold; color:${color};">${val}</div></div>`;
    let html = `<div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px;">
        ${tile('확정 총액', fmt(total) + ' ' + UNIT, '#e8f4fd', '#2980b9')}
        ${tile('지급 완료', fmt(total - unpaid), '#d5f4e6', '#27ae60')}
        ${tile('미지급', fmt(unpaid), '#fef9e7', '#d35400')}
    </div>`;
    if (pendingCnt > 0) html += `<div style="margin-bottom:10px; padding:8px 12px; background:#fef9e7; border-radius:8px; font-size:0.85rem; color:#d35400;">⏳ 확인 대기 ${pendingCnt}건은 확정 후 요약에 반영됩니다.</div>`;
    if (rows.length === 0) {
        html += '<p style="color:#95a5a6; text-align:center; padding:12px; margin:0;">확정된 신청이 없습니다.</p>';
    } else {
        html += rows.map(u => `
        <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; padding:10px 12px; border:1px solid #e5e8ea; border-radius:8px; margin-bottom:6px; background:white;">
            <div><div style="font-weight:bold; color:#2c3e50;">${esc(u.name)}</div>
                 <div style="font-size:0.8rem; color:#7f8c8d;">복구 ${fmt(u.rec)} · 축복 ${fmt(u.bless)}${u.trf ? ' · 이전 ' + fmt(u.trf) : ''}${u.extra ? ' · 추가 ' + fmt(u.extra) : ''}</div></div>
            <div style="text-align:right;">
                <div style="font-weight:bold; color:#2980b9;">${fmt(u.amount)} ${UNIT}</div>
                ${u.unpaid === 0
                    ? '<span style="font-size:0.78rem; color:#27ae60; font-weight:bold;">💵 지급완료</span>'
                    : (isAdmin
                        ? `<button onclick="Settle.rbPayUser(${Number(u.userId)})" style="margin-top:4px; padding:5px 12px; border:none; border-radius:6px; background:#27ae60; color:white; font-size:0.8rem; font-weight:bold; cursor:pointer;">💵 ${fmt(u.unpaid)} 지급완료 처리</button>`
                        : `<span style="font-size:0.78rem; color:#d35400; font-weight:bold;">미지급 ${fmt(u.unpaid)}</span>`)}
            </div>
        </div>`).join('');
    }
    box.innerHTML = html;
}

// ============================================================
// 바깥(inline onclick 등)에 노출하는 함수 — 이 목록 밖의 것은 모두 내부 전용
// ============================================================
window.Settle = {
    onOpen, onModeChange, showPane, closeModal,
    onDropTargetChange, refreshDropBox: () => syncDropBox(true), onVariantChange, openVariants, addVariantRow, removeVariantRow, saveVariants, resetVariants, onItemSelect, addDrop, toggleDelivered, deleteDrop, confirmDelivery, deleteUndelivered, reloadUndelivered, adminOnBossChange, adminAddItems, adminDeleteItem, adminMoveSlot, adminDeleteSlot,
    setStorageFilter, setStorageServer, openAuction, confirmAuction, unsell, deleteStorage,
    openManagers, filterManagerRows, saveManagers,
    openCalc, closeCalc, adminSetTag, setStQuery, setStCat, setStSort, toggleCatPanel, moreStorage, clearStFilters, openCatSettings, catRowCount, catAddRow, catDelRow, saveCatSettings, resetCatSettings, toggleRecipient, setCalcMode, setSupportPct, openSupportTeam, saveSupportTeam, filterSupportRows, setRatio, setFixed, fillRatioByHeadcount, setRecipientsAll, setRecipientsServer, saveSettlement,
    showHistory, hideHistory, toggleReceived, cancelSettlement,
    rbLoadWeek, rbUserOpen, rbSubmitState: rbRenderSubmitState, rbTransferInput: rbRenderTransferPreview, rbExtra, rbSaveExtra, rbHandleFiles, rbShotKind, rbShotCount, rbRemoveShot, rbSubmit, rbShowImages, rbOpenImage, rbSaveEdit, rbUnconfirm,
    rbApprove, rbReject, rbEdit, rbTogglePaid, rbPayUser, rbDelete, rbDeleteImages, rbSetPrices, rbSavePrices
};

initDropBox();   // 출석 탭의 드랍 칸 시작
initAdminItems(); // 관리 탭의 [보스 아이템 설정] 편집기
initUserReimb();  // 사용자용 [복구비] 탭
initMyAtt();      // 출석 탭의 [내 출석]
updateNav();      // 정산 메뉴는 관리자·담당자에게만
})();
