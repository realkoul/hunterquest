// ============================================================
// 💰 정산 모듈 (settlement.js)
//   📦 아이템 드랍 → 담당자 전달 → 보관함 → 입찰/판매 → 정산(균등 배분)
//   💸 복구·축복 지원비 (주 단위 신청 → 운영진 승인 → 지급)
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
    settlements: [], recipients: new Set(), calcItemIds: []
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
            <button id="settle-seg-reimb" onclick="Settle.showPane('reimb')" style="flex:1; padding:10px 6px; border-radius:8px; font-weight:bold; font-size:0.9rem; cursor:pointer;">💸 복구·축복 지원비</button>
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
    state.pane = p;
    const on = 'background:#2c3e50; color:white; border:2px solid #2c3e50;';
    const off = 'background:white; color:#2c3e50; border:2px solid #d5d8dc;';
    const bi = $('settle-seg-items'), br = $('settle-seg-reimb');
    if (bi) bi.style.cssText = (p === 'items' ? on : off) + ' flex:1; padding:10px 6px; border-radius:8px; font-weight:bold; font-size:0.9rem; cursor:pointer;';
    if (br) br.style.cssText = (p === 'reimb' ? on : off) + ' flex:1; padding:10px 6px; border-radius:8px; font-weight:bold; font-size:0.9rem; cursor:pointer;';
    $('settle-pane-items').style.display = p === 'items' ? 'block' : 'none';
    $('settle-pane-reimb').style.display = p === 'reimb' ? 'block' : 'none';
    if (p === 'reimb') rbInit();
}

// ── 탭 진입/모드 변경 ────────────────────────────────────
function onOpen() {
    const root = $('settle-root');
    if (!root) return;
    if (!depsOk()) {
        root.innerHTML = '<div class="card"><p style="color:#c0392b;">정산 모듈을 시작할 수 없습니다. app.js 가 먼저 로드되었는지 확인하세요.</p></div>';
        return;
    }
    if (!state.inited) {
        buildRoot();
        state.inited = true;
        showPane('items');
    }
    ensureListeners();
    refreshAll();
    if (state.pane === 'reimb') rbInit();
}
function onModeChange() {
    syncDropBox(true);
    if (state.inited) { refreshAll(); if (state.pane === 'reimb') { rbRenderPriceLine(); rbRender(); } }
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
        renderDrops(); renderStorage(); renderCalcActions(); renderVariantSelect();
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
function ensureListeners() { ensureManagers(); ensureStorage(); }

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

async function adminOpen() {
    if (!depsOk() || state.admLoading) return;
    state.admLoading = true;
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
    box.innerHTML = `
        <div style="background:#f8f9fa; border-radius:8px; padding:9px 12px; margin-bottom:10px; font-size:0.85rem;">
            <b style="color:#2c3e50;">${esc(a.e.name)}</b>${a.e.bossName ? ' · ' + esc(a.e.bossName) : ''}
            <div style="font-size:0.75rem; color:#95a5a6; margin-top:2px;">나오는 시간: ${esc(days)}</div>
        </div>
        <div style="font-size:0.85rem; font-weight:bold; color:#555; margin-bottom:4px;">아이템 ${a.items.length}개</div>
        <div style="border:1px solid #eee; border-radius:8px; margin-bottom:10px; max-height:260px; overflow-y:auto;">
            ${a.items.length ? a.items.map((n, i) => row(n, actBtn('✕', `Settle.adminDeleteItem(${i})`, '#e74c3c'))).join('') : '<div style="padding:12px; color:#95a5a6; font-size:0.85rem; text-align:center;">등록된 아이템이 없습니다.</div>'}
        </div>
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
    const list = a.items.slice();
    let added = 0;
    raw.forEach(n => { if (!list.includes(n)) { list.push(n); added++; } });
    if (!added) { alert('이미 모두 등록된 아이템입니다.'); return; }
    await adminSave(list);
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
    if (f === 'undelivered' && (!state.undelivLoaded || state.undelivStale)) loadUndelivered();   // 미전달 목록은 눌렀을 때 읽음
    else renderStorage();
}
function setStorageServer(sv) { state.stServer = sv; renderStorage(); }

function renderStorage() {
    const acts = $('settle-storage-actions'), fil = $('settle-storage-filters'), box = $('settle-storage-list');
    if (!box) return;
    const mg = canManage();
    acts.innerHTML = (isAdmin ? actBtn('👤 담당자 설정', 'Settle.openManagers()', '#8e44ad') : '')
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

    const list = state.storage.filter(i => {
        if (state.stFilter === 'pending' && i.sold) return false;
        if (state.stFilter === 'sold' && !i.sold) return false;
        if (state.stServer && i.bossServer !== state.stServer) return false;
        return true;
    }).sort((a, b) => String(b.addedAt || '').localeCompare(String(a.addedAt || '')));

    const pendingN = state.storage.filter(i => !i.sold).length;
    const soldTotal = state.storage.filter(i => i.sold).reduce((t, i) => t + (Number(i.bidPrice) || 0), 0);
    const waiting = unsettledItems().reduce((t, i) => t + (Number(i.bidPrice) || 0), 0);
    const tile = (label, val, bg, color, sub) => `<div style="flex:1; background:${bg}; border-radius:8px; padding:8px; text-align:center;"><div style="font-size:0.74rem; color:#7f8c8d;">${label}</div><div style="font-size:1.05rem; font-weight:bold; color:${color};">${val}</div>${sub ? `<div style="font-size:0.7rem; color:#7f8c8d; margin-top:2px;">${sub}</div>` : ''}</div>`;
    const head = `<div style="display:flex; gap:8px; margin-bottom:10px;">${tile('보관중', pendingN + '개', '#e8f4fd', '#2980b9')}${tile('아이템 판매 금액', fmt(soldTotal) + ' ' + UNIT, '#d5f4e6', '#27ae60', soldTotal ? (waiting ? '정산 대기 ' + fmt(waiting) : '모두 정산됨') : '')}</div>`;

    if (!list.length) { box.innerHTML = head + '<p style="color:#95a5a6; text-align:center; padding:14px; margin:0; font-size:0.88rem;">조건에 맞는 아이템이 없습니다.</p>'; return; }
    box.innerHTML = head + list.map(it => {
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
                    <div style="font-size:0.8rem; color:#666;">📅 ${esc(it.date)} ⚔️ ${esc(it.bossName)}${it.bossVariant ? ` <span style="display:inline-block; padding:1px 6px; border-radius:4px; background:#f4ecf7; color:#6c3483; font-size:0.72rem; font-weight:bold;">${esc(it.bossVariant)}${it.bossVariantName ? ' · ' + esc(it.bossVariantName) : ''}</span>` : ''}${serverBadge(it.bossServer)}</div>
                    <div style="font-size:0.8rem; color:#666;">획득: <b>${esc(it.winner)}</b>${sold ? ` → 낙찰: <b>${esc(it.buyer)}</b> <span style="color:#2980b9; font-weight:bold;">${fmt(it.bidPrice)} ${UNIT}</span>` : ''}</div>
                </div>
                <div style="display:flex; gap:6px; align-items:center;">${btns.join('')}</div>
            </div>
        </div>`;
    }).join('');
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
    const list = undeliveredList();
    const today = ymdOf(nowD());
    const ago = (ds) => {
        const n = Math.round((new Date(today + 'T00:00:00') - new Date(ds + 'T00:00:00')) / 86400000);
        return n <= 0 ? '오늘' : n + '일 전';
    };
    const head = `<div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:8px;">
        <div style="font-size:0.85rem; font-weight:bold; color:#d35400;">📭 아직 전달되지 않은 아이템 ${list.length}건 <span style="font-weight:normal; color:#95a5a6; font-size:0.76rem;">(최근 ${UNDELIV_DAYS}일)</span></div>
        ${actBtn('🔄 새로고침', 'Settle.reloadUndelivered()', '#5D6D7E')}
    </div>`;
    if (!list.length) { box.innerHTML = head + '<p style="color:#95a5a6; text-align:center; padding:14px; margin:0; font-size:0.88rem;">미전달 아이템이 없습니다. 👍</p>'; return; }
    box.innerHTML = head + list.map(d => {
        const pk = sid(d._pk), kk = sid(d._k);
        const marked = d.delivered === true;                 // 전달완료로 표시됐지만 보관함에는 없는 경우
        return `
        <div style="border:2px solid ${marked ? '#f5cba7' : '#f0e6cc'}; border-radius:8px; padding:10px 12px; margin-bottom:8px; background:white;">
            <div style="display:flex; justify-content:space-between; gap:8px; flex-wrap:wrap;">
                <div style="flex:1; min-width:150px;">
                    <div style="font-weight:bold; color:#2c3e50;">${esc(d.itemName)} ${marked ? badge('보관함 미등록', '#e67e22') : badge('미전달', '#d35400')}</div>
                    <div style="font-size:0.8rem; color:#666;">📅 ${esc(d.date)} (${ago(d.date)}) ⚔️ ${esc(d.bossName)}${d.bossVariant ? ` <span style="display:inline-block; padding:1px 6px; border-radius:4px; background:#f4ecf7; color:#6c3483; font-size:0.72rem; font-weight:bold;">${esc(d.bossVariant)}${d.bossVariantName ? ' · ' + esc(d.bossVariantName) : ''}</span>` : ''}</div>
                    <div style="font-size:0.8rem; color:#666;">획득: <b>${esc(d.winner)}</b>${serverBadge(d.bossServer || d.winnerServer)}</div>
                    ${marked ? '<div style="font-size:0.75rem; color:#e67e22; margin-top:2px;">전달완료로 표시되어 있지만 보관함에는 없습니다.' + (mg ? ' [전달 확인]을 누르면 보관함에 등록됩니다.' : '') + '</div>' : ''}
                </div>
                <div style="display:flex; gap:6px; align-items:center;">${mg ? actBtn('✅ 전달 확인', `Settle.confirmDelivery('${pk}', '${kk}')`, '#16a085') + actBtn('🗑️', `Settle.deleteUndelivered('${pk}', '${kk}')`, '#e74c3c') : ''}</div>
            </div>
        </div>`;
    }).join('') + (mg ? '' : '<p style="font-size:0.78rem; color:#7f8c8d; margin:6px 0 0;">ℹ️ 전달 확인은 관리자·담당자만 할 수 있습니다.</p>');
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
function distribute(total, recipients) {
    const list = recipients.slice().sort((a, b) => koCmp(a.name, b.name));
    const n = list.length;
    if (!n) return [];
    const base = Math.floor(total / n);
    let rem = total - base * n;
    return list.map(u => ({ userId: Number(u.id), name: u.name, server: u.server || '', amount: base + (rem-- > 0 ? 1 : 0) }));
}

function renderCalcActions() {
    const box = $('settle-calc-actions');
    if (!box) return;
    const n = unsettledItems().length;
    box.innerHTML = (canManage() ? actBtn('📊 정산 계산' + (n ? ' (' + n + ')' : ''), 'Settle.openCalc()', '#27ae60') : '')
                  + actBtn('📋 정산 내역', 'Settle.showHistory()', '#3498db');
}

function openCalc() {
    if (!canManage()) return;
    const items = unsettledItems();
    if (!items.length) { alert('정산할 아이템이 없습니다.\n(판매 완료 상태이고 아직 정산되지 않은 아이템만 대상입니다)'); return; }
    state.calcItemIds = items.map(i => String(i.id));
    state.recipients = new Set(getUsers().map(u => Number(u.id)));     // 기본: 전원
    renderCalc();
}
function closeCalc() { const b = $('settle-calc-area'); if (b) b.innerHTML = ''; }

function renderCalc() {
    const box = $('settle-calc-area');
    if (!box) return;
    const { items, total } = calcItems();
    const us = getUsers().slice().sort((a, b) => koCmp(a.name, b.name));
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
            <div style="font-size:0.85rem; font-weight:bold; margin:6px 0;">👥 정산 대상자 <span id="settle-rcpt-count" style="color:#27ae60;"></span></div>
            <div style="display:flex; gap:6px; flex-wrap:wrap; margin-bottom:6px;">
                ${actBtn('전체 선택', 'Settle.setRecipientsAll(true)', '#5D6D7E')}
                ${actBtn('전체 해제', 'Settle.setRecipientsAll(false)', '#95a5a6')}
                ${Object.keys(SERVERS).map(k => actBtn(SERVERS[k].name + '만', `Settle.setRecipientsServer('${k}')`, SERVERS[k].color)).join('')}
            </div>
            <div id="settle-rcpt-list" style="max-height:200px; overflow-y:auto; border:1px solid #eee; border-radius:8px;">
                ${us.map(u => `<label style="display:flex; align-items:center; gap:8px; padding:6px 10px; border-bottom:1px solid #f5f5f5; cursor:pointer;">
                    <input type="checkbox" style="${cbStyle}" data-uid="${Number(u.id)}" ${state.recipients.has(Number(u.id)) ? 'checked' : ''} onchange="Settle.toggleRecipient(${Number(u.id)}, this.checked)"> ${esc(u.name)}${serverBadge(u.server)}</label>`).join('')}
            </div>
            <div id="settle-calc-preview" style="margin-top:10px;"></div>
        </div>
        <div style="padding:10px 14px; border-top:1px solid #eee; display:flex; gap:8px;">
            ${actBtn('💾 정산 확정 저장', 'Settle.saveSettlement()', '#27ae60')}
            ${actBtn('닫기', 'Settle.closeCalc()', '#95a5a6')}
        </div>
    </div>`;
    renderCalcPreview();
}

function renderCalcPreview() {
    const el = $('settle-calc-preview'), cnt = $('settle-rcpt-count');
    if (!el) return;
    const { total } = calcItems();
    const recips = getUsers().filter(u => state.recipients.has(Number(u.id)));
    if (cnt) cnt.textContent = '(' + recips.length + '명 선택)';
    if (!recips.length) { el.innerHTML = '<div style="color:#c0392b; font-size:0.85rem;">대상자를 1명 이상 선택하세요.</div>'; return; }
    const base = Math.floor(total / recips.length), rem = total - base * recips.length;
    el.innerHTML = `<div style="background:#f0fff4; border:1px solid #a9dfbf; border-radius:8px; padding:10px 12px; font-size:0.88rem;">
        1인당 <b style="color:#27ae60;">${fmt(base)} ${UNIT}</b>
        ${rem ? `<span style="color:#7f8c8d; font-size:0.8rem;"> (남는 ${rem} ${UNIT}은 이름순 앞 ${rem}명에게 1씩)</span>` : ''}
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
    const { items, total } = calcItems();
    if (!items.length) { alert('정산할 아이템이 없습니다. (이미 정산되었을 수 있습니다)'); return; }
    const recips = getUsers().filter(u => state.recipients.has(Number(u.id)));
    if (!recips.length) { alert('정산 대상자를 1명 이상 선택하세요.'); return; }
    const dist = distribute(total, recips);
    if (!confirm(`아이템 ${items.length}개, 총 ${fmt(total)} ${UNIT}을(를) ${dist.length}명에게 배분하고 정산을 확정할까요?\n(확정 후에는 같은 아이템이 다시 정산되지 않습니다)`)) return;

    try {
        // 다른 사람이 먼저 정산했는지 서버 값으로 재확인
        const fresh = await Promise.all(items.map(i => db.ref('boss_storage/' + i.id + '/settledId').once('value')));
        if (fresh.some(s => s.val())) { alert('다른 사람이 이미 정산한 아이템이 포함되어 있습니다. 화면을 새로 연 뒤 다시 시도하세요.'); return; }

        const sidv = 'S' + Date.now();
        const recMap = {};
        dist.forEach(d => { recMap['u' + d.userId] = { userId: d.userId, name: d.name, server: d.server, amount: d.amount, received: false }; });
        const record = {
            id: sidv, createdAt: nowIso(), totalAmount: total, count: dist.length,
            items: items.map(i => ({ id: String(i.id), itemName: i.itemName, bossName: i.bossName, bossServer: i.bossServer || '', bossVariant: i.bossVariant || '', date: i.date, buyer: i.buyer, bidPrice: i.bidPrice })),
            recipients: recMap
        };
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
            <div id="settle-hist-prog-${rid}" style="font-size:0.78rem; color:#7f8c8d; margin-top:3px;">수령 확인 ${done}/${rc.length}</div>
            <details style="margin-top:6px;">
                <summary style="cursor:pointer; font-size:0.85rem; color:#2c3e50;">낙찰 아이템 / 대상자 보기</summary>
                <div style="font-size:0.8rem; margin:6px 0; padding:6px 8px; background:#f8f9fa; border-radius:6px;">
                    ${its.map(i => `<div style="display:flex; justify-content:space-between; gap:8px;"><span>${esc(i.itemName)}${i.bossVariant ? ' (' + esc(i.bossVariant) + ')' : ''} → ${esc(i.buyer)}</span><b>${fmt(i.bidPrice)}</b></div>`).join('')}
                </div>
                <div style="max-height:220px; overflow-y:auto; border:1px solid #eee; border-radius:6px;">
                    ${rc.map(x => `<div style="display:flex; justify-content:space-between; align-items:center; gap:8px; padding:6px 10px; border-bottom:1px solid #f3f3f3; font-size:0.85rem;">
                        <span>${esc(x.name)}${serverBadge(x.server)}</span>
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
// 💸 복구·축복 지원비 (주 단위 신청 → 운영진 승인 → 지급)
// ============================================================
const RB_MAX_IMAGES = 3;
const rb = {
    inited: false, week: '', requests: [], prices: { recovery: 0, blessing: 0 },
    shots: [], shotSeq: 0, ocrQ: Promise.resolve(), workerP: null,
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
const rbFind = (k) => rb.requests.find(r => sid(r.id) === k) || null;
function rbAmount(r) {
    const p = r.priceSnap || rb.prices;
    return (Number(r.recoveryCnt) || 0) * (Number(p.recovery) || 0) + (Number(r.blessingCnt) || 0) * (Number(p.blessing) || 0);
}

function rbBuild() {
    const lab = 'font-size:0.85rem; font-weight:bold; color:#555; display:block; margin-bottom:4px;';
    $('settle-pane-reimb').innerHTML = `
    <div class="card">
        <h2 style="font-size:1.05rem; margin:0 0 4px;">💸 복구비·축복비 지원 신청</h2>
        <p style="font-size:0.8rem; color:#7f8c8d; margin:0 0 12px; line-height:1.5;">게임의 <b>[호칭 → 호칭 리스트]</b> 화면 사진을 올리면 종류(복구·축복)와 점수(= 사용 횟수)를 자동으로 읽습니다. 운영진이 확정하면 혈에서 비용을 지급합니다.<br>⏰ 주간 호칭 랭킹은 <b>매주 수요일 05시</b>에 초기화되니, 초기화 전에 올려주세요.</p>
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:6px;">
            <label style="font-weight:bold; color:#2c3e50;">주차:</label>
            <select id="rb-week" onchange="Settle.rbLoadWeek()" style="width:auto; margin:0; padding:9px 12px; border:2px solid #5D6D7E; border-radius:8px; font-size:0.88rem; font-weight:bold;"></select>
        </div>
        <div id="rb-price-line" style="font-size:0.82rem; color:#7f8c8d;"></div>
    </div>

    <div class="card">
        <h3 style="margin:0 0 12px; color:#2c3e50; font-size:1rem;">📝 신청하기</h3>
        <div style="margin-bottom:12px;"><label style="${lab}">신청자</label><select id="rb-user" style="${inputStyle}"></select></div>
        <div style="margin-bottom:10px;">
            <label style="${lab}">호칭 화면 사진 <span style="font-weight:normal; color:#7f8c8d;">(복구 2장 · 축복 2장까지)</span></label>
            <p style="font-size:0.76rem; color:#7f8c8d; margin:0 0 8px; line-height:1.5;">"두려움없이"는 복구, "축복의기사"는 축복 화면입니다. 읽은 값이 틀리면 직접 고치세요. 다른 사람 사진이면 내 횟수로 바꿔 입력하세요.</p>
            <label for="rb-files" style="display:inline-block; padding:9px 16px; border:2px solid #3498db; border-radius:8px; color:#3498db; font-weight:bold; cursor:pointer; font-size:0.9rem;">🖼️ 사진 선택</label>
            <input type="file" id="rb-files" accept="image/*" multiple style="display:none;" onchange="Settle.rbHandleFiles(this)">
            <div id="rb-shots" style="margin-top:10px;"></div>
            <div id="rb-totals" style="font-size:0.9rem; color:#2c3e50; margin-top:2px;"></div>
        </div>
        <div style="margin-bottom:12px;"><label style="${lab}">메모 (선택)</label><input type="text" id="rb-memo" maxlength="100" placeholder="예: 본캐·부캐 합산" style="${inputStyle}"></div>
        <button class="btn btn-primary" id="rb-submit-btn" onclick="Settle.rbSubmit()" style="width:100%; padding:12px; font-size:1rem;">📤 제출</button>
    </div>

    <div class="card">
        <h3 style="margin:0 0 12px; color:#2c3e50; font-size:1rem;">📋 이 주차 신청 내역</h3>
        <div id="rb-list"></div>
    </div>
    <div class="card">
        <h3 style="margin:0 0 12px; color:#2c3e50; font-size:1rem;">🧾 주간 지급 요약</h3>
        <div id="rb-summary"></div>
    </div>`;
}

function rbInit() {
    if (!rb.inited) { rbBuild(); rbPopulateWeeks(); rb.inited = true; }
    rbPopulateUsers();
    if (!rb.priceBound) {
        rb.priceBound = true;
        db.ref('hunter_config/reimbursePrices').on('value', snap => {
            const v = snap.val() || {};
            rb.prices = { recovery: Number(v.recovery) || 0, blessing: Number(v.blessing) || 0 };
            rbRenderPriceLine();
            rbRender();
        });
    }
    if (!rb.weekRef) rbLoadWeek();
    rbRenderPriceLine();
    rbRender();
}

function rbPopulateWeeks() {
    const sel = $('rb-week');
    const thisStart = weekStartWed(nowD());
    let html = '';
    for (let i = 0; i >= -7; i--) {
        const st = new Date(thisStart); st.setDate(thisStart.getDate() + i * 7);
        const en = new Date(st); en.setDate(st.getDate() + 7);
        const prefix = i === 0 ? '이번 주 ' : (i === -1 ? '지난 주 ' : '');
        html += `<option value="${ymd(st)}">${prefix}(수 ${md(st)} 05시 ~ 수 ${md(en)} 05시)</option>`;
    }
    sel.innerHTML = html;
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
    if (rb.weekRef) rb.weekRef.off('value');
    const ref = db.ref('boss_reimburse/' + rb.week);
    rb.weekRef = ref;
    ref.on('value', snap => {
        if (rb.weekRef !== ref) return;
        const data = snap.val() || {};
        rb.requests = Object.values(data).filter(r => r && r.id)
            .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
        rbRender();
    });
}

function rbRenderPriceLine() {
    const el = $('rb-price-line');
    if (!el) return;
    const p = rb.prices;
    const txt = (p.recovery || p.blessing)
        ? `지급 단가(회당): 복구 ${fmt(p.recovery)} · 축복 ${fmt(p.blessing)} ${UNIT}`
        : '지급 단가가 아직 설정되지 않았습니다. (운영진이 복구·축복 단가를 각각 설정하면 금액이 계산됩니다)';
    el.innerHTML = esc(txt) + (isAdmin ? ' <button onclick="Settle.rbSetPrices()" style="margin-left:6px; padding:4px 10px; border:none; border-radius:6px; background:#8e44ad; color:white; font-size:0.78rem; font-weight:bold; cursor:pointer;">⚙️ 단가 설정</button>' : '');
}

// ── 이미지 선택/압축 ──
// ── 제출 ──
async function rbSubmit() {
    const user = userById(parseInt($('rb-user').value));
    const memo = $('rb-memo').value.trim();
    if (!rb.week) { alert('주차를 선택하세요.'); return; }
    if (!user)    { alert('신청자를 선택하세요.'); return; }
    if (rb.shots.length === 0) { alert('호칭 화면 사진을 1장 이상 올려주세요.'); return; }
    if (rb.shots.some(x => x.status === 'reading' && !x.manual)) { alert('사진을 읽는 중입니다. 잠시 뒤에 다시 눌러주세요. (횟수를 직접 입력해도 됩니다)'); return; }
    for (let i = 0; i < rb.shots.length; i++) {
        const x = rb.shots[i];
        if (!x.kind) { alert((i + 1) + '번째 사진의 종류(복구/축복)를 선택하세요.'); return; }
        if (x.cnt === '' || isNaN(Number(x.cnt)) || Number(x.cnt) < 0) { alert((i + 1) + '번째 사진의 횟수를 입력하세요.'); return; }
    }
    if (rbCountKind('recovery') > RB_MAX_PER_KIND || rbCountKind('blessing') > RB_MAX_PER_KIND) { alert('복구·축복 사진은 각각 ' + RB_MAX_PER_KIND + '장까지입니다.'); return; }
    const t = rbTotals();
    if (t.recovery + t.blessing <= 0) { alert('복구 또는 축복 횟수가 0입니다. 횟수를 확인하세요.'); return; }
    // 같은 사진을 두 번 올렸는지
    for (const kind of ['recovery', 'blessing']) {
        const same = rb.shots.filter(x => x.kind === kind);
        if (same.length === 2 && same[0].data === same[1].data) { alert(RB_KIND[kind] + ' 사진이 같은 사진으로 두 번 올라갔습니다. 하나를 지워주세요.'); return; }
        if (same.length === 2 && Number(same[0].cnt) === Number(same[1].cnt) && !confirm(RB_KIND[kind] + ' 사진 두 장의 횟수가 같습니다(' + same[0].cnt + '회).\n서로 다른 캐릭터 사진이 맞나요? 합산해서 신청합니다.')) return;
    }
    // 점수는 한 주 누적값이라, 같은 사람이 같은 주에 두 번 신청하면 이중으로 합산됨 → 한 사람당 한 건
    if (rb.requests.some(r => Number(r.userId) === Number(user.id) && r.status !== 'rejected')) {
        alert(user.name + '님은 이 주차에 이미 신청이 있습니다.\n횟수를 고치려면 기존 신청의 [횟수 수정]을 쓰거나, 삭제한 뒤 다시 올려주세요.');
        return;
    }

    const btn = $('rb-submit-btn');
    btn.disabled = true; btn.textContent = '제출 중...';
    const id = Date.now() + '_' + Number(user.id);
    const req = {
        id: id, userId: Number(user.id), name: user.name,
        recoveryCnt: t.recovery, blessingCnt: t.blessing,
        shots: rb.shots.map(x => ({ kind: x.kind, cnt: Number(x.cnt) || 0, auto: x.auto === null ? null : x.auto })),   // 사진별 횟수 + 자동 인식값(수정 여부 확인용)
        memo: memo, imgCount: rb.shots.length, status: 'pending', paid: false, createdAt: nowIso()
    };
    const updates = {};
    updates['boss_reimburse/' + rb.week + '/' + id] = req;
    updates['boss_reimburse_img/' + id] = rb.shots.map(x => x.data);
    try {
        await db.ref().update(updates);
        rb.shots = [];
        rbRenderShots();
        $('rb-memo').value = '';
        alert('✅ 제출되었습니다. 운영진 확인 후 확정되면 지급됩니다.');
    } catch (e) {
        alert('❌ 제출 실패: ' + e.message);
    } finally {
        btn.disabled = false; btn.textContent = '📤 제출';
    }
}

// ── 목록 ──
function rbStatusBadge(r) {
    if (r.status === 'approved') return r.paid ? badge('💵 지급완료', '#27ae60') : badge('✅ 확정', '#2980b9');
    if (r.status === 'rejected') return badge('❌ 반려', '#c0392b');
    return badge('⏳ 확인 대기', '#e67e22');
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

function rbRender() {
    const box = $('rb-list');
    if (!box) return;
    const myNames = myNameList();
    if (rb.requests.length === 0) {
        box.innerHTML = '<p style="color:#95a5a6; text-align:center; padding:20px; margin:0;">이 주차에 접수된 신청이 없습니다.</p>';
        rbRenderSummary();
        return;
    }
    box.innerHTML = rb.requests.map(r => {
        const k = sid(r.id);
        const amount = rbAmount(r);
        const pr = r.priceSnap || rb.prices;
        const isMine = myNames.includes(r.name);
        const locked = r.status === 'approved';                          // 확정되면 수정 불가
        const canEdit = !locked && (isAdmin || isMine);
        const canDelete = isAdmin || (isMine && (r.status === 'pending' || r.status === 'rejected'));
        const border = r.status === 'approved' ? (r.paid ? '#a9dfbf' : '#aed6f1') : (r.status === 'rejected' ? '#f5b7b1' : '#f0e6cc');
        const btns = [];
        if (r.imgCount > 0) btns.push(actBtn('🖼️ 증빙 ' + r.imgCount + '장', `Settle.rbShowImages('${k}')`, '#5D6D7E'));
        if (canEdit) btns.push(actBtn('✏️ 횟수 수정', `Settle.rbEdit('${k}')`, '#8e44ad'));
        if (isAdmin) {
            if (!locked) btns.push(actBtn('✅ 확정', `Settle.rbApprove('${k}')`, '#2980b9'));
            if (r.status === 'pending') btns.push(actBtn('❌ 반려', `Settle.rbReject('${k}')`, '#c0392b'));
            if (locked) btns.push(actBtn(r.paid ? '↩️ 지급 취소' : '💵 지급완료', `Settle.rbTogglePaid('${k}')`, '#27ae60'));
            if (locked && !r.paid) btns.push(actBtn('↩️ 확정 취소', `Settle.rbUnconfirm('${k}')`, '#7f8c8d'));
            if (r.paid && r.imgCount > 0) btns.push(actBtn('🧹 증빙 삭제', `Settle.rbDeleteImages('${k}')`, '#95a5a6'));
        }
        if (canDelete) btns.push(actBtn('🗑️', `Settle.rbDelete('${k}')`, '#e74c3c'));
        const shotsLine = rbShotsLine(r);
        return `
        <div style="background:white; border:2px solid ${border}; border-radius:10px; padding:12px; margin-bottom:10px;">
            <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap;">
                <div style="font-weight:bold; color:#2c3e50;">${esc(r.name)}${isMine ? ' <span style="padding:1px 6px; background:#ffc107; color:#333; border-radius:4px; font-size:0.72rem;">⭐ 나</span>' : ''}</div>
                ${rbStatusBadge(r)}
            </div>
            <div style="margin-top:6px; font-size:0.92rem; color:#555;">
                복구 <b>${fmt(r.recoveryCnt)}</b>회 · 축복 <b>${fmt(r.blessingCnt)}</b>회
                <span style="color:#2980b9; font-weight:bold;"> = ${fmt(amount)} ${UNIT}</span>${r.edited ? ' <span style="color:#8e44ad; font-size:0.76rem;">✏️수정됨</span>' : ''}
            </div>
            <div style="margin-top:2px; font-size:0.76rem; color:#95a5a6;">복구 ${fmt(r.recoveryCnt)}×${fmt(pr.recovery)} + 축복 ${fmt(r.blessingCnt)}×${fmt(pr.blessing)}</div>
            ${shotsLine ? `<div style="margin-top:2px; font-size:0.76rem; color:#7f8c8d;">${esc(shotsLine)}</div>` : ''}
            ${r.memo ? `<div style="margin-top:4px; font-size:0.85rem; color:#7f8c8d;">📝 ${esc(r.memo)}</div>` : ''}
            ${r.status === 'rejected' && r.rejectReason ? `<div style="margin-top:4px; font-size:0.85rem; color:#c0392b;">반려 사유: ${esc(r.rejectReason)}</div>` : ''}
            ${locked ? '<div style="margin-top:4px; font-size:0.76rem; color:#2980b9;">🔒 확정됨 — 횟수 수정 불가 · 증빙 사진 삭제됨</div>' : ''}
            <div style="margin-top:3px; font-size:0.76rem; color:#aaa;">${esc(new Date(r.createdAt).toLocaleString('ko-KR'))}</div>
            <div id="rb-imgs-${k}" style="display:flex; gap:6px; flex-wrap:wrap; margin-top:8px;"></div>
            ${btns.length ? `<div style="display:flex; gap:6px; flex-wrap:wrap; margin-top:10px;">${btns.join('')}</div>` : ''}
        </div>`;
    }).join('');
    rb.open.forEach(k => rbPaintImages(k));
    rbRenderSummary();
}

// ── 증빙 이미지 보기 ──
function rbShowImages(k) {
    if (rb.open.has(k)) {
        rb.open.delete(k);
        const box = $('rb-imgs-' + k);
        if (box) box.innerHTML = '';
        return;
    }
    rb.open.add(k);
    rbPaintImages(k);
}

async function rbPaintImages(k) {
    const r = rbFind(k);
    const box = $('rb-imgs-' + k);
    if (!r || !box) return;
    try {
        if (!rb.imgCache[r.id]) {
            box.innerHTML = '<span style="color:#aaa; font-size:0.85rem;">불러오는 중...</span>';
            const snap = await db.ref('boss_reimburse_img/' + r.id).once('value');
            rb.imgCache[r.id] = Object.values(snap.val() || {});
        }
        const imgs = rb.imgCache[r.id];
        const target = $('rb-imgs-' + k);
        if (!target || !rb.open.has(k)) return;
        target.innerHTML = imgs.length
            ? imgs.map((d, i) => `<img src="${rbSafeSrc(d)}" onclick="Settle.rbOpenImage('${k}', ${i})" style="width:96px; height:96px; object-fit:cover; border-radius:8px; border:1px solid #ddd; cursor:pointer;">`).join('')
            : '<span style="color:#aaa; font-size:0.85rem;">증빙 이미지가 없습니다 (삭제됨)</span>';
    } catch (e) {
        box.innerHTML = '<span style="color:#c0392b; font-size:0.85rem;">이미지를 불러오지 못했습니다.</span>';
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
    Object.keys(patch).forEach(key => { updates['boss_reimburse/' + rb.week + '/' + r.id + '/' + key] = patch[key]; });
    return db.ref().update(updates).catch(e => alert('❌ 저장 실패: ' + e.message));
}

// 확정: 횟수를 더 이상 수정할 수 없게 잠그고, 증빙 사진은 삭제 (횟수와 단가 기록만 남김)
async function rbApprove(k) {
    const r = rbFind(k);
    if (!r || !(await requireAdmin())) return;
    const missing = [];
    if ((Number(r.recoveryCnt) || 0) > 0 && !rb.prices.recovery) missing.push('복구');
    if ((Number(r.blessingCnt) || 0) > 0 && !rb.prices.blessing) missing.push('축복');
    if (missing.length && !confirm(missing.join('·') + ' 단가가 설정되지 않아 해당 금액이 0으로 계산됩니다. 계속 확정할까요?')) return;
    const imgN = Number(r.imgCount) || 0;
    if (!confirm(`${r.name}님 신청을 확정할까요?\n복구 ${fmt(r.recoveryCnt)}회 · 축복 ${fmt(r.blessingCnt)}회\n\n확정하면 횟수를 수정할 수 없고${imgN ? ', 증빙 사진 ' + imgN + '장은 삭제됩니다.' : '.'}`)) return;
    const base = 'boss_reimburse/' + rb.week + '/' + r.id;
    const updates = {};
    updates[base + '/status'] = 'approved';
    updates[base + '/priceSnap'] = { recovery: rb.prices.recovery, blessing: rb.prices.blessing };
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
    const mine = myNameList().includes(r.name);
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
        <p style="font-size:0.76rem; color:#95a5a6; margin:10px 0 0;">운영진이 확정하면 더 이상 수정할 수 없습니다.${r.status === 'rejected' ? ' 수정하면 다시 "확인 대기"로 돌아갑니다.' : ''}</p>
        <div style="display:flex; gap:8px; margin-top:14px;">
            ${actBtn('저장', `Settle.rbSaveEdit('${sid(r.id)}')`, '#8e44ad').replace('padding:6px 11px', 'flex:1; padding:11px')}
            ${actBtn('취소', 'Settle.closeModal()', '#95a5a6').replace('padding:6px 11px', 'flex:1; padding:11px')}
        </div>`);
}
async function rbSaveEdit(k) {
    const r = rbFind(k);
    if (!r) return;
    const rn = parseInt($('rb-edit-rec').value), bn = parseInt($('rb-edit-bls').value);
    if (isNaN(rn) || isNaN(bn) || rn < 0 || bn < 0) { alert('횟수는 0 이상의 숫자여야 합니다. (복구/축복 둘 다)'); return; }
    if (!isAdmin && !myNameList().includes(r.name)) { if (!(await requireAdmin())) return; }
    try {
        // 그 사이 운영진이 확정했다면 저장하지 않도록 서버 값으로 한 번 더 확인
        const res = await db.ref('boss_reimburse/' + rb.week + '/' + r.id).transaction(cur => {
            if (cur === null) return cur;
            if (cur.status === 'approved') return;                         // 중단
            cur.recoveryCnt = rn; cur.blessingCnt = bn;
            cur.status = 'pending'; delete cur.rejectReason;
            cur.edited = true; cur.editedAt = nowIso();
            return cur;
        });
        closeModal();
        if (res && res.committed === false) alert('이미 확정되어 수정할 수 없습니다.');
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
        updates['boss_reimburse/' + rb.week + '/' + r.id + '/paid'] = true;
        updates['boss_reimburse/' + rb.week + '/' + r.id + '/paidAt'] = now;
    });
    await db.ref().update(updates).catch(e => alert('❌ 저장 실패: ' + e.message));
}
async function rbDelete(k) {
    const r = rbFind(k);
    if (!r) return;
    const mine = myNameList().includes(r.name) && (r.status === 'pending' || r.status === 'rejected');
    if (!(isAdmin || mine)) { alert('삭제 권한이 없습니다.'); return; }
    if (!confirm('이 신청을 삭제할까요? (증빙 이미지도 함께 삭제됩니다)')) return;
    const updates = {};
    updates['boss_reimburse/' + rb.week + '/' + r.id] = null;
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
    updates['boss_reimburse/' + rb.week + '/' + r.id + '/imgCount'] = 0;
    await db.ref().update(updates).catch(e => alert('❌ 삭제 실패: ' + e.message));
    delete rb.imgCache[r.id];
    rb.open.delete(k);
}
async function rbSetPrices() {
    if (!(await requireAdmin())) return;
    const lab = 'font-size:0.85rem; font-weight:bold; color:#555; display:block; margin:12px 0 4px;';
    showModal(`
        <h3 style="margin:0 0 4px; color:#2c3e50;">⚙️ 지원비 단가 설정</h3>
        <p style="font-size:0.8rem; color:#7f8c8d; margin:0 0 4px;">복구비와 축복비는 단가가 달라서 각각 설정합니다. 신청 금액 = 횟수 × 단가.</p>
        <label style="${lab}">🩹 복구 1회당 지급액 (${UNIT})</label>
        <input type="number" id="rb-price-recovery" min="0" step="1" value="${Number(rb.prices.recovery) || 0}" style="${inputStyle}">
        <label style="${lab}">✨ 축복 1회당 지급액 (${UNIT})</label>
        <input type="number" id="rb-price-blessing" min="0" step="1" value="${Number(rb.prices.blessing) || 0}" style="${inputStyle}">
        <p style="font-size:0.76rem; color:#95a5a6; margin:10px 0 0;">이미 승인된 신청은 승인 당시 단가가 유지됩니다.</p>
        <div style="display:flex; gap:8px; margin-top:14px;">
            ${actBtn('저장', 'Settle.rbSavePrices()', '#8e44ad').replace('padding:6px 11px', 'flex:1; padding:11px')}
            ${actBtn('취소', 'Settle.closeModal()', '#95a5a6').replace('padding:6px 11px', 'flex:1; padding:11px')}
        </div>`);
}
async function rbSavePrices() {
    if (!(await requireAdmin())) return;                       // 저장 시점에도 관리자 확인
    const ra = parseInt($('rb-price-recovery').value), rbv = parseInt($('rb-price-blessing').value);
    if (isNaN(ra) || isNaN(rbv) || ra < 0 || rbv < 0) { alert('단가는 0 이상의 숫자로 입력하세요. (복구/축복 둘 다)'); return; }
    try {
        await db.ref('hunter_config/reimbursePrices').set({ recovery: ra, blessing: rbv });
        closeModal();
        alert('✅ 단가가 저장되었습니다.\n복구 ' + fmt(ra) + ' · 축복 ' + fmt(rbv) + ' ' + UNIT);
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
        const u = byUser[r.userId] || (byUser[r.userId] = { userId: r.userId, name: r.name, rec: 0, bless: 0, amount: 0, unpaid: 0 });
        const a = rbAmount(r);
        u.rec += Number(r.recoveryCnt) || 0;
        u.bless += Number(r.blessingCnt) || 0;
        u.amount += a;
        if (!r.paid) u.unpaid += a;
    });
    const rows = Object.values(byUser).sort((a, b) => b.amount - a.amount);
    const total = rows.reduce((s, u) => s + u.amount, 0);
    const unpaid = rows.reduce((s, u) => s + u.unpaid, 0);
    const tile = (label, val, bg, color) => `<div style="flex:1; min-width:90px; background:${bg}; border-radius:8px; padding:10px; text-align:center;"><div style="font-size:0.74rem; color:#7f8c8d;">${label}</div><div style="font-size:1rem; font-weight:bold; color:${color};">${val}</div></div>`;
    let html = `<div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px;">
        ${tile('승인 총액', fmt(total) + ' ' + UNIT, '#e8f4fd', '#2980b9')}
        ${tile('지급 완료', fmt(total - unpaid), '#d5f4e6', '#27ae60')}
        ${tile('미지급', fmt(unpaid), '#fef9e7', '#d35400')}
    </div>`;
    if (pendingCnt > 0) html += `<div style="margin-bottom:10px; padding:8px 12px; background:#fef9e7; border-radius:8px; font-size:0.85rem; color:#d35400;">⏳ 확인 대기 ${pendingCnt}건은 승인 후 요약에 반영됩니다.</div>`;
    if (rows.length === 0) {
        html += '<p style="color:#95a5a6; text-align:center; padding:12px; margin:0;">승인된 신청이 없습니다.</p>';
    } else {
        html += rows.map(u => `
        <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; padding:10px 12px; border:1px solid #e5e8ea; border-radius:8px; margin-bottom:6px; background:white;">
            <div><div style="font-weight:bold; color:#2c3e50;">${esc(u.name)}</div>
                 <div style="font-size:0.8rem; color:#7f8c8d;">복구 ${fmt(u.rec)} · 축복 ${fmt(u.bless)}</div></div>
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
    openCalc, closeCalc, toggleRecipient, setRecipientsAll, setRecipientsServer, saveSettlement,
    showHistory, hideHistory, toggleReceived, cancelSettlement,
    rbLoadWeek, rbHandleFiles, rbShotKind, rbShotCount, rbRemoveShot, rbSubmit, rbShowImages, rbOpenImage, rbSaveEdit, rbUnconfirm,
    rbApprove, rbReject, rbEdit, rbTogglePaid, rbPayUser, rbDelete, rbDeleteImages, rbSetPrices, rbSavePrices
};

initDropBox();   // 출석 탭의 드랍 칸 시작
initAdminItems(); // 관리 탭의 [보스 아이템 설정] 편집기
})();
