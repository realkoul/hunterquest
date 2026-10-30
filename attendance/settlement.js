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
    inited: false, pane: 'items', storageLoaded: false, dropTarget: 'follow', dropStRefs: {}, dropStorage: {},
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
        renderDrops(); renderStorage(); renderCalcActions();
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
    loadBossItems(t.bossId);
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

function loadBossItems(bossId) {
    state.bossItems = [];
    renderItemSelect();
    if (!bossId) return;
    db.ref('boss_items/' + bossId + '/items').once('value').then(snap => {
        if (dropTarget().bossId !== bossId) return;
        state.bossItems = Object.values(snap.val() || {}).filter(v => typeof v === 'string' && v.trim());
        renderItemSelect();
    }).catch(e => console.warn('아이템 목록 로드 실패:', e));
}
function renderItemSelect() {
    const sel = $('settle-drop-item');
    if (!sel) return;
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
function learnItem(bossId, name) {
    if (!bossId || state.bossItems.includes(name)) return Promise.resolve();
    return db.ref('boss_items/' + bossId + '/items').transaction(cur => {
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
    const date = t.date, bossId = t.bossId, boss = t.boss;

    const id = Date.now() + '_' + Number(winner.id);
    const isMgr = state.managers.includes(Number(winner.id));      // 담당자가 먹었으면 전달·보관함 자동 처리
    const drop = {
        id: id, itemName: itemName, winner: winner.name, winnerId: Number(winner.id), winnerServer: winner.server || '',
        bossId: bossId, bossName: boss.name, bossServer: winner.server || '', date: date,
        delivered: isMgr, inStorage: isMgr, timestamp: nowIso()
    };
    const updates = {};
    updates['boss_drops/' + date + '_' + bossId + '/items/' + id] = drop;
    if (isMgr) updates['boss_storage/' + id] = storageFromDrop(Object.assign({ _k: id }, drop));   // 보관함에도 실제로 등록
    try {
        await db.ref().update(updates);
        await learnItem(bossId, itemName);
        $('settle-drop-item').value = '';
        $('settle-drop-item-direct').value = '';
        $('settle-drop-item-direct').style.display = 'none';
        $('settle-drop-winner').value = '';
        showDropMsg('✅ ' + itemName + ' → ' + boss.time + ' ' + boss.name + (date !== ymdOf(nowD()) ? ' (' + date.slice(5) + ')' : '') + ' 기록 완료');
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
            <div style="font-size:0.82rem; color:#666; margin-top:3px;">
                획득: <b>${esc(d.winner)}</b>${serverBadge(d.winnerServer)}${mgrWinner ? ' ' + badge('담당자', '#8e44ad') : ''}
                ${mgrWinner && d.inStorage ? '<span style="color:#8e44ad; font-size:0.76rem;"> · 자동 보관함 등록</span>' : ''}
            </div>
            <div style="font-size:0.74rem; color:#aaa; margin-top:2px;">${esc(new Date(d.timestamp).toLocaleString('ko-KR'))}</div>
            ${controls}
        </div>`;
    }).join('');
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
    try { await db.ref().update(updates); } catch (e) { alert('❌ 저장 실패: ' + e.message); renderDrops(); }
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
    try { await db.ref().update(updates); } catch (e) { alert('❌ 삭제 실패: ' + e.message); }
}

// ============================================================
// 🏪 보관함
// ============================================================
function setStorageFilter(f) { state.stFilter = f; renderStorage(); }
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
        + '<span style="color:#ddd;">|</span>'
        + chip('전서버', !state.stServer, '#95a5a6', "Settle.setStorageServer('')")
        + Object.keys(SERVERS).map(k => chip(SERVERS[k].name, state.stServer === k, SERVERS[k].color, `Settle.setStorageServer('${k}')`)).join('');

    const list = state.storage.filter(i => {
        if (state.stFilter === 'pending' && i.sold) return false;
        if (state.stFilter === 'sold' && !i.sold) return false;
        if (state.stServer && i.bossServer !== state.stServer) return false;
        return true;
    }).sort((a, b) => String(b.addedAt || '').localeCompare(String(a.addedAt || '')));

    const pendingN = state.storage.filter(i => !i.sold).length;
    const waiting = unsettledItems().reduce((s, i) => s + (Number(i.bidPrice) || 0), 0);
    const tile = (label, val, bg, color) => `<div style="flex:1; background:${bg}; border-radius:8px; padding:8px; text-align:center;"><div style="font-size:0.74rem; color:#7f8c8d;">${label}</div><div style="font-size:1.05rem; font-weight:bold; color:${color};">${val}</div></div>`;
    const head = `<div style="display:flex; gap:8px; margin-bottom:10px;">${tile('보관중', pendingN + '개', '#e8f4fd', '#2980b9')}${tile('정산 대기 금액', fmt(waiting) + ' ' + UNIT, '#d5f4e6', '#27ae60')}</div>`;

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
                    <div style="font-size:0.8rem; color:#666;">📅 ${esc(it.date)} ⚔️ ${esc(it.bossName)}${serverBadge(it.bossServer)}</div>
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
    if (!confirm(`"${it.itemName}" 을(를) 보관함에서 삭제할까요?`)) return;
    const updates = {};
    updates['boss_storage/' + it.id] = null;
    if (it.dropPath) updates[it.dropPath + '/inStorage'] = false;
    try { await db.ref().update(updates); } catch (e) { alert('❌ 삭제 실패: ' + e.message); }
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
            ${items.map(i => `<div style="display:flex; justify-content:space-between; gap:8px; padding:3px 0; border-bottom:1px dashed #eee;"><span>${esc(i.itemName)} → ${esc(i.buyer)}</span><b style="color:#2980b9;">${fmt(i.bidPrice)}</b></div>`).join('')}
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
            items: items.map(i => ({ id: String(i.id), itemName: i.itemName, bossName: i.bossName, bossServer: i.bossServer || '', date: i.date, buyer: i.buyer, bidPrice: i.bidPrice })),
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
                    ${its.map(i => `<div style="display:flex; justify-content:space-between; gap:8px;"><span>${esc(i.itemName)} → ${esc(i.buyer)}</span><b>${fmt(i.bidPrice)}</b></div>`).join('')}
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
    pending: [], weekRef: null, priceBound: false, imgCache: {}, open: new Set()
};

// 날짜 도우미 (app.js 에 의존하지 않도록 자체 구현)
function weekStartSun(d) { const x = new Date(d); x.setDate(x.getDate() - x.getDay()); x.setHours(0, 0, 0, 0); return x; }
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
        <p style="font-size:0.8rem; color:#7f8c8d; margin:0 0 12px;">1주일 동안 사용한 복구·축복 수량을 입력하고 스크린샷을 올리면, 운영진 확인 후 혈에서 비용을 지급합니다.</p>
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:6px;">
            <label style="font-weight:bold; color:#2c3e50;">주차:</label>
            <select id="rb-week" onchange="Settle.rbLoadWeek()" style="width:auto; margin:0; padding:9px 12px; border:2px solid #5D6D7E; border-radius:8px; font-size:0.92rem; font-weight:bold;"></select>
        </div>
        <div id="rb-price-line" style="font-size:0.82rem; color:#7f8c8d;"></div>
    </div>

    <div class="card">
        <h3 style="margin:0 0 12px; color:#2c3e50; font-size:1rem;">📝 신청하기</h3>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:10px;">
            <div style="grid-column:1 / -1;"><label style="${lab}">신청자</label><select id="rb-user" style="${inputStyle}"></select></div>
            <div><label style="${lab}">복구 수량</label><input type="number" id="rb-recovery" min="0" value="0" style="${inputStyle}"></div>
            <div><label style="${lab}">축복 수량</label><input type="number" id="rb-blessing" min="0" value="0" style="${inputStyle}"></div>
        </div>
        <div style="margin-bottom:10px;">
            <label style="${lab}">증빙 스크린샷 (최대 ${RB_MAX_IMAGES}장)</label>
            <label for="rb-files" style="display:inline-block; padding:9px 16px; border:2px solid #3498db; border-radius:8px; color:#3498db; font-weight:bold; cursor:pointer; font-size:0.9rem;">🖼️ 이미지 선택</label>
            <input type="file" id="rb-files" accept="image/*" multiple style="display:none;" onchange="Settle.rbHandleFiles(this)">
            <div id="rb-preview" style="display:flex; gap:10px; flex-wrap:wrap; margin-top:10px;"></div>
        </div>
        <div style="margin-bottom:12px;"><label style="${lab}">메모 (선택)</label><input type="text" id="rb-memo" maxlength="100" placeholder="예: 오만 5~10층 복구 위주" style="${inputStyle}"></div>
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
    const thisStart = weekStartSun(new Date());
    let html = '';
    for (let i = 0; i >= -7; i--) {
        const s = new Date(thisStart); s.setDate(thisStart.getDate() + i * 7);
        const e = new Date(s); e.setDate(s.getDate() + 6);
        const prefix = i === 0 ? '이번 주 ' : (i === -1 ? '지난 주 ' : '');
        html += `<option value="${ymd(s)}">${prefix}(${md(s)} ~ ${md(e)})</option>`;
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
        ? `지급 단가(개당): 복구 ${fmt(p.recovery)} · 축복 ${fmt(p.blessing)} ${UNIT}`
        : '지급 단가가 아직 설정되지 않았습니다. (운영진이 복구·축복 단가를 각각 설정하면 금액이 계산됩니다)';
    el.innerHTML = esc(txt) + (isAdmin ? ' <button onclick="Settle.rbSetPrices()" style="margin-left:6px; padding:4px 10px; border:none; border-radius:6px; background:#8e44ad; color:white; font-size:0.78rem; font-weight:bold; cursor:pointer;">⚙️ 단가 설정</button>' : '');
}

// ── 이미지 선택/압축 ──
function rbHandleFiles(input) {
    const files = Array.from(input.files || []);
    input.value = '';
    if (files.length === 0) return;
    const room = RB_MAX_IMAGES - rb.pending.length;
    if (room <= 0) { alert('이미지는 최대 ' + RB_MAX_IMAGES + '장까지 올릴 수 있습니다.'); return; }
    if (files.length > room) alert('최대 ' + RB_MAX_IMAGES + '장까지라서 앞의 ' + room + '장만 사용합니다.');
    Promise.all(files.slice(0, room).map(rbCompress)).then(list => {
        list.forEach(d => { if (d) rb.pending.push(d); });
        rbRenderPreview();
    });
}

function rbCompress(file) {
    return new Promise(resolve => {
        if (!file || !file.type || file.type.indexOf('image/') !== 0) { resolve(null); return; }
        const reader = new FileReader();
        reader.onerror = () => resolve(null);
        reader.onload = e => {
            const img = new Image();
            img.onerror = () => resolve(null);
            img.onload = () => {
                const draw = (maxSide, q) => {
                    const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
                    const c = document.createElement('canvas');
                    c.width = Math.max(1, Math.round(img.width * scale));
                    c.height = Math.max(1, Math.round(img.height * scale));
                    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
                    return c.toDataURL('image/jpeg', q);
                };
                // 증빙 글자가 읽히도록 긴 변 1400px 기준, 너무 크면 한 단계 낮춤
                let out = draw(1400, 0.6);
                if (out.length > 380000) out = draw(1000, 0.5);
                resolve(out);
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    });
}

function rbRenderPreview() {
    const box = $('rb-preview');
    if (!box) return;
    box.innerHTML = rb.pending.map((d, i) => `
        <div style="position:relative; width:84px; height:84px;">
            <img src="${rbSafeSrc(d)}" style="width:84px; height:84px; object-fit:cover; border-radius:8px; border:1px solid #ddd;">
            <button onclick="Settle.rbRemovePending(${i})" style="position:absolute; top:-6px; right:-6px; width:22px; height:22px; border-radius:50%; border:none; background:#e74c3c; color:white; cursor:pointer; font-size:12px; line-height:1;">✕</button>
        </div>`).join('');
}
function rbRemovePending(i) { rb.pending.splice(i, 1); rbRenderPreview(); }

// ── 제출 ──
async function rbSubmit() {
    const user = userById(parseInt($('rb-user').value));
    const rec = parseInt($('rb-recovery').value) || 0;
    const bless = parseInt($('rb-blessing').value) || 0;
    const memo = $('rb-memo').value.trim();

    if (!rb.week)  { alert('주차를 선택하세요.'); return; }
    if (!user)     { alert('신청자를 선택하세요.'); return; }
    if (rec < 0 || bless < 0) { alert('수량은 0 이상으로 입력하세요.'); return; }
    if (rec + bless <= 0)     { alert('복구 또는 축복 수량을 입력하세요.'); return; }
    if (rb.pending.length === 0) { alert('증빙 스크린샷을 1장 이상 올려주세요.'); return; }

    const btn = $('rb-submit-btn');
    btn.disabled = true; btn.textContent = '제출 중...';
    const id = Date.now() + '_' + Number(user.id);
    const req = {
        id: id, userId: Number(user.id), name: user.name,
        recoveryCnt: rec, blessingCnt: bless, memo: memo,
        imgCount: rb.pending.length, status: 'pending', paid: false, createdAt: nowIso()
    };
    const updates = {};
    updates['boss_reimburse/' + rb.week + '/' + id] = req;
    updates['boss_reimburse_img/' + id] = rb.pending.slice();
    try {
        await db.ref().update(updates);
        rb.pending = [];
        rbRenderPreview();
        $('rb-recovery').value = 0; $('rb-blessing').value = 0; $('rb-memo').value = '';
        alert('✅ 제출되었습니다. 운영진 확인 후 지급됩니다.');
    } catch (e) {
        alert('❌ 제출 실패: ' + e.message);
    } finally {
        btn.disabled = false; btn.textContent = '📤 제출';
    }
}

// ── 목록 ──
function rbStatusBadge(r) {
    if (r.status === 'approved') return r.paid ? badge('💵 지급완료', '#27ae60') : badge('✅ 승인', '#2980b9');
    if (r.status === 'rejected') return badge('❌ 반려', '#c0392b');
    return badge('⏳ 확인 대기', '#e67e22');
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
        const canDelete = isAdmin || (isMine && r.status === 'pending');
        const border = r.status === 'approved' ? (r.paid ? '#a9dfbf' : '#aed6f1') : (r.status === 'rejected' ? '#f5b7b1' : '#f0e6cc');
        const btns = [];
        if (r.imgCount > 0) btns.push(actBtn('🖼️ 증빙 ' + r.imgCount + '장', `Settle.rbShowImages('${k}')`, '#5D6D7E'));
        if (isAdmin) {
            if (r.status !== 'approved') btns.push(actBtn('✅ 승인', `Settle.rbApprove('${k}')`, '#2980b9'));
            if (r.status !== 'rejected') btns.push(actBtn('❌ 반려', `Settle.rbReject('${k}')`, '#c0392b'));
            if (!r.paid) btns.push(actBtn('✏️ 수량 수정', `Settle.rbEdit('${k}')`, '#8e44ad'));
            if (r.status === 'approved') btns.push(actBtn(r.paid ? '↩️ 지급 취소' : '💵 지급완료', `Settle.rbTogglePaid('${k}')`, '#27ae60'));
            if (r.paid && r.imgCount > 0) btns.push(actBtn('🧹 증빙 삭제', `Settle.rbDeleteImages('${k}')`, '#95a5a6'));
        }
        if (canDelete) btns.push(actBtn('🗑️', `Settle.rbDelete('${k}')`, '#e74c3c'));
        return `
        <div style="background:white; border:2px solid ${border}; border-radius:10px; padding:12px; margin-bottom:10px;">
            <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap;">
                <div style="font-weight:bold; color:#2c3e50;">${esc(r.name)}${isMine ? ' <span style="padding:1px 6px; background:#ffc107; color:#333; border-radius:4px; font-size:0.72rem;">⭐ 나</span>' : ''}</div>
                ${rbStatusBadge(r)}
            </div>
            <div style="margin-top:6px; font-size:0.92rem; color:#555;">
                복구 <b>${fmt(r.recoveryCnt)}</b>개 · 축복 <b>${fmt(r.blessingCnt)}</b>개
                <span style="color:#2980b9; font-weight:bold;"> = ${fmt(amount)} ${UNIT}</span>
            </div>
            <div style="margin-top:2px; font-size:0.76rem; color:#95a5a6;">복구 ${fmt(r.recoveryCnt)}×${fmt(pr.recovery)} + 축복 ${fmt(r.blessingCnt)}×${fmt(pr.blessing)}</div>
            ${r.memo ? `<div style="margin-top:4px; font-size:0.85rem; color:#7f8c8d;">📝 ${esc(r.memo)}</div>` : ''}
            ${r.status === 'rejected' && r.rejectReason ? `<div style="margin-top:4px; font-size:0.85rem; color:#c0392b;">반려 사유: ${esc(r.rejectReason)}</div>` : ''}
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

async function rbApprove(k) {
    const r = rbFind(k);
    if (!r || !(await requireAdmin())) return;
    const missing = [];
    if ((Number(r.recoveryCnt) || 0) > 0 && !rb.prices.recovery) missing.push('복구');
    if ((Number(r.blessingCnt) || 0) > 0 && !rb.prices.blessing) missing.push('축복');
    if (missing.length && !confirm(missing.join('·') + ' 단가가 설정되지 않아 해당 금액이 0으로 계산됩니다. 계속 승인할까요?')) return;
    await rbUpdate(r, {
        status: 'approved', priceSnap: { recovery: rb.prices.recovery, blessing: rb.prices.blessing },
        reviewedAt: nowIso(), rejectReason: null
    });
}
async function rbReject(k) {
    const r = rbFind(k);
    if (!r || !(await requireAdmin())) return;
    const reason = prompt('반려 사유 (선택)', '');
    if (reason === null) return;
    await rbUpdate(r, { status: 'rejected', rejectReason: reason.trim() || null, paid: false, paidAt: null, priceSnap: null, reviewedAt: nowIso() });
}
async function rbEdit(k) {
    const r = rbFind(k);
    if (!r || !(await requireAdmin())) return;
    const a = prompt('복구 수량', r.recoveryCnt);
    if (a === null) return;
    const b = prompt('축복 수량', r.blessingCnt);
    if (b === null) return;
    const rn = parseInt(a), bn = parseInt(b);
    if (isNaN(rn) || isNaN(bn) || rn < 0 || bn < 0) { alert('수량은 0 이상의 숫자여야 합니다.'); return; }
    await rbUpdate(r, { recoveryCnt: rn, blessingCnt: bn });
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
    const mine = myNameList().includes(r.name) && r.status === 'pending';
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
        <p style="font-size:0.8rem; color:#7f8c8d; margin:0 0 4px;">복구비와 축복비는 단가가 달라서 각각 설정합니다. 신청 금액 = 수량 × 단가.</p>
        <label style="${lab}">🩹 복구 1개당 지급액 (${UNIT})</label>
        <input type="number" id="rb-price-recovery" min="0" step="1" value="${Number(rb.prices.recovery) || 0}" style="${inputStyle}">
        <label style="${lab}">✨ 축복 1개당 지급액 (${UNIT})</label>
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
    onDropTargetChange, refreshDropBox: () => syncDropBox(true), onItemSelect, addDrop, toggleDelivered, deleteDrop,
    setStorageFilter, setStorageServer, openAuction, confirmAuction, unsell, deleteStorage,
    openManagers, filterManagerRows, saveManagers,
    openCalc, closeCalc, toggleRecipient, setRecipientsAll, setRecipientsServer, saveSettlement,
    showHistory, hideHistory, toggleReceived, cancelSettlement,
    rbLoadWeek, rbHandleFiles, rbRemovePending, rbSubmit, rbShowImages, rbOpenImage,
    rbApprove, rbReject, rbEdit, rbTogglePaid, rbPayUser, rbDelete, rbDeleteImages, rbSetPrices, rbSavePrices
};

initDropBox();   // 출석 탭의 드랍 칸 시작
})();
