'use strict';

// 화면 아래에 표시되는 앱 버전 (sw.js 의 CACHE 버전과 함께 올려주세요)
const APP_VERSION = 'v14 (2026.11.10)';

const SCALE = CONFIG.SCALE; // 높은 점수부터
const MAX_SCORE = Math.max(...SCALE.map(s => s.value));
const $app = document.getElementById('app');
const $sync = document.getElementById('syncbar');
const $user = document.getElementById('userbox');
const $dialog = document.getElementById('dialog');

const state = { student: null, teacher: null };
let viewSeq = 0; // 화면이 바뀌면 증가. 늦게 도착한 응답이 다른 화면을 덮어쓰지 않도록.

// ---------- 공통 유틸 ----------

const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const uid = () => (crypto.randomUUID ? crypto.randomUUID()
  : Date.now().toString(36) + Math.random().toString(36).slice(2));

function localDate(d = new Date()) {
  const t = new Date(d);
  t.setMinutes(t.getMinutes() - t.getTimezoneOffset());
  return t.toISOString().slice(0, 10);
}

function addMonth(ym, n) {
  const d = new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

const fmtTime = ts => new Date(ts).toLocaleString('ko-KR',
  { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

const monthLabel = ym => `${ym.slice(0, 4)}년 ${Number(ym.slice(5, 7))}월`;
const scaleLabel = v => (SCALE.find(s => s.value === Number(v)) || {}).label || '';
const scorePill = v => `<span class="pill s${esc(v)}">${esc(v)} ${esc(scaleLabel(v))}</span>`;
const byNo = (a, b) => Number(a) - Number(b);
const clone = o => JSON.parse(JSON.stringify(o));

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function toast(msg, type = '') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'show ' + type;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.className = ''; }, 2800);
}

function render(html) {
  viewSeq++;
  $app.className = 'wrap';
  $app.innerHTML = html;
  window.scrollTo(0, 0);
  return viewSeq;
}

function formError(root, msg) {
  const el = root.querySelector('.form-error');
  el.textContent = msg || '';
  el.hidden = !msg;
}

async function busy(btn, fn) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '처리 중…';
  try { return await fn(); } finally { btn.disabled = false; btn.textContent = label; }
}

async function pbkdf2(password, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: new TextEncoder().encode(salt), iterations: 100000, hash: 'SHA-256' }, key, 256);
  return btoa(String.fromCharCode(...new Uint8Array(bits)));
}

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const buf = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(buf, b => chars[b % chars.length]).join('');
}

function downloadCsv(filename, head, rows) {
  const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [head, ...rows].map(l => l.map(cell).join(','));
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function openDialog(html) {
  $dialog.innerHTML = html + '<div class="actions"><button class="btn" id="dlgClose">닫기</button></div>';
  $dialog.querySelector('#dlgClose').onclick = () => $dialog.close();
  if (!$dialog.open) $dialog.showModal();
}

// ---------- 학급 데이터 헬퍼 ----------
// 학급: { classCode, className, students:[{no,name}], tasks:[{id,name,count,inspector,assigneeNos}],
//         inspectors, evalTopN, evalMinChecks, rolesChangedAt, roleMonths:{'YYYY-MM': {번호: 역할id}} }

function normClass(c) {
  c.students = (c.students || []).slice().sort((a, b) => byNo(a.no, b.no));
  c.tasks = (c.tasks || []).map(t => {
    const assigneeNos = (t.assigneeNos || []).map(String);
    return { ...t, assigneeNos, inspector: !!t.inspector, count: t.count ?? Math.max(1, assigneeNos.length) };
  });
  c.inspectors = deriveInspectors(c);
  c.evalTopN = c.evalTopN || 3;
  c.evalMinChecks = c.evalMinChecks ?? 3;
  c.roleMonths = c.roleMonths || {};
  return c;
}

const deriveInspectors = c => [...new Set(c.tasks.filter(t => t.inspector).flatMap(t => t.assigneeNos))].sort(byNo);
const studentName = (cls, no) => (cls.students.find(s => s.no === String(no)) || {}).name || '';
const studentLabel = (cls, no) => `${no}번${studentName(cls, no) ? ' ' + studentName(cls, no) : ''}`;
const assigneeText = (cls, t) => t.assigneeNos.slice().sort(byNo).map(no => studentLabel(cls, no)).join(', ');

// 학생 번호 → 역할 id (한 학생은 한 역할)
function assignOf(cls) {
  const m = {};
  cls.tasks.forEach(t => t.assigneeNos.forEach(no => { if (!m[no]) m[no] = t.id; }));
  return m;
}

function applyAssign(cls, map) {
  const order = cls.students.map(s => s.no);
  cls.tasks.forEach(t => { t.assigneeNos = order.filter(no => map[no] === t.id); });
  cls.inspectors = deriveInspectors(cls);
}

// 대상 월보다 앞선 가장 최근 배정 (보통 지난달)
function previousAssign(cls, month) {
  const m = Object.keys(cls.roleMonths).filter(k => k < month).sort().pop();
  return m ? { month: m, map: cls.roleMonths[m] } : null;
}

// 이전 배정과 같은 역할을 피하는 랜덤 배정 (이분 매칭으로 최대한 많은 학생을 충족)
function randomAssign(cls, prevMap) {
  const slots = shuffle(cls.tasks.flatMap(t => Array(Math.max(0, t.count)).fill(t.id)));
  const students = shuffle(cls.students.map(s => s.no));
  const slotOwner = Array(slots.length).fill(-1);
  const order = slots.map((_, i) => i);

  function tryAssign(si, seen) {
    for (const j of shuffle(order)) {
      if (seen[j] || slots[j] === prevMap[students[si]]) continue;
      seen[j] = true;
      if (slotOwner[j] < 0 || tryAssign(slotOwner[j], seen)) {
        slotOwner[j] = si;
        return true;
      }
    }
    return false;
  }
  students.forEach((_, si) => tryAssign(si, []));

  const map = {};
  slotOwner.forEach((si, j) => { if (si >= 0) map[students[si]] = slots[j]; });
  // 남은 자리가 있는데 배정 못 받은 학생 = 이전 역할밖에 남지 않은 경우 → 어쩔 수 없이 배정하고 표시
  const free = slots.map((id, j) => (slotOwner[j] < 0 ? id : null)).filter(Boolean);
  const repeats = [];
  students.filter(no => !map[no]).forEach(no => {
    const k = free.indexOf(prevMap[no]);
    if (k >= 0) { map[no] = free.splice(k, 1)[0]; repeats.push(no); }
  });
  return { map, repeats };
}

// "1 김하늘", "1번 김하늘", "1,김하늘", "1<TAB>김하늘"(엑셀 붙여넣기) 모두 허용
function parseRoster(text) {
  const out = [];
  const bad = [];
  text.split(/\r?\n/).forEach(line => {
    if (!line.trim()) return;
    const m = line.match(/^\s*(\d+)\s*번?[\s,.\t:)]*(.*?)\s*$/);
    if (m) out.push({ no: String(Number(m[1])), name: m[2].trim() });
    else bad.push(line.trim());
  });
  return { students: out, bad };
}

// ---------- 상단 사용자 / 전송 상태 ----------

function renderUser() {
  const s = state.student;
  const who = state.teacher ? `${state.teacher.name} 선생님`
    : s ? `${s.classNo} ${s.number}번 ${s.name}` : '';
  $user.innerHTML = who ? `<span class="who">${esc(who)}</span><button class="link" id="logout">나가기</button>` : '';
  if (who) $user.querySelector('#logout').onclick = logout;
}

async function logout() {
  if (state.teacher) await DB.del('teacherSession');
  if (state.student) await DB.del('studentSession');
  state.teacher = state.student = null;
  renderUser();
  viewHome();
}

async function renderSync() {
  const ops = await DB.outboxAll();
  const failed = ops.filter(o => o.error);
  const last = await DB.get('lastSync');
  const online = navigator.onLine;
  $sync.className = 'syncbar ' + (online ? 'on' : 'off');
  $sync.innerHTML = `
    <span class="dot"></span>
    <span>${online ? '온라인' : '오프라인'}</span>
    <span class="sep">·</span>
    <span>${ops.length ? `전송 대기 <b>${ops.length}</b>건` : '모두 전송됨'}</span>
    ${failed.length ? `<button class="link danger" id="showFailed">실패 ${failed.length}건 보기</button>` : ''}
    <span class="grow"></span>
    ${last ? `<span class="muted small hide-sm">최근 전송 ${fmtTime(last)}</span>` : ''}
    ${ops.length ? `<button class="btn sm" id="syncNow" ${Sync.running ? 'disabled' : ''}>
      ${Sync.running ? '전송 중…' : '지금 전송'}</button>` : ''}`;
  const btn = $sync.querySelector('#syncNow');
  if (btn) btn.onclick = () => Sync.run().then(async () => {
    const left = (await DB.outboxAll()).length;
    if (left && !navigator.onLine) toast('오프라인 상태입니다. 와이파이 연결 후 자동으로 전송됩니다.');
  });
  const fb = $sync.querySelector('#showFailed');
  if (fb) fb.onclick = () => showFailed();
}

async function showFailed() {
  const ops = (await DB.outboxAll()).filter(o => o.error);
  openDialog(`
    <h3>전송 실패한 항목</h3>
    <p class="muted small">서버가 거절한 항목입니다. 문제를 해결하면 다음 전송 때 다시 시도하고, 필요 없으면 삭제하세요.</p>
    <ul class="list">${ops.map(o => `
      <li><div><b>${esc(o.label || o.action)}</b><div class="danger small">${esc(o.error)}</div></div>
      <button class="btn sm ghost" data-del="${o.id}">삭제</button></li>`).join('') || '<li>없음</li>'}
    </ul>`);
  $dialog.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!confirm('이 항목을 삭제할까요? 삭제하면 서버로 전송되지 않습니다.')) return;
    await DB.outboxDel(Number(b.dataset.del));
    renderSync();
    showFailed();
  });
}

Sync.listeners.add(renderSync);

Sync.onDone = async op => {
  if (op.action !== 'submitRecords') return;
  const key = historyKey(op.data.classCode, op.data.student.number);
  const hist = (await DB.get(key)) || [];
  const item = hist.find(h => h.batchId === op.data.batchId);
  if (item) {
    item.sent = true;
    await DB.set(key, hist);
  }
  if (document.getElementById('history')) renderHistory();
};

Sync.onAuthNeeded = () => {
  toast('선생님 로그인이 필요합니다. 다시 로그인하면 남은 항목이 전송됩니다.', 'warn');
};

// ---------- 서버 연결 확인 ----------

async function checkServer() {
  const lines = [`앱 버전 캐시: ${(await caches.keys().catch(() => [])).join(', ') || '없음'}`,
    `서버 주소: ${apiUrl() || '(비어 있음)'}`, `인터넷: ${navigator.onLine ? '연결됨' : '끊김'}`];
  let verdict;
  try {
    const r = await api('ping');
    lines.push(`서버 코드 버전: ${r.version || '예전 버전'} (필요: ${CONFIG.SERVER_VERSION} 이상)`);
    verdict = (r.version || 0) >= CONFIG.SERVER_VERSION
      ? `<p class="notice">✅ 서버와 정상적으로 연결됩니다. (서버 시각 ${esc(r.time)})</p>`
      : `<p class="notice warn">⚠️ 서버에는 연결되지만 <b>서버 코드가 예전 버전</b>이라 일부 기능(학생 입장 등)이 동작하지 않습니다.</p>
        <ol class="small">
          <li>⚙️ 서버 연결 화면의 <b>📋 서버 코드 복사</b>로 최신 코드를 복사합니다.</li>
          <li>Apps Script 편집기의 코드를 모두 지우고 붙여넣은 뒤 <b>저장</b>합니다.</li>
          <li><b>배포 → 배포 관리 → 수정(연필) → 버전: 새 버전 → 배포</b>를 누릅니다. (<b>새 배포</b>를 누르면 주소가 바뀌니 주의!)</li>
        </ol>`;
  } catch (e) {
    lines.push(`오류: ${e.message} [${e.code}]`);
    verdict = `<p class="notice warn">❌ 서버에 연결하지 못했습니다.</p>
      <ul class="small">
        <li>서버 주소를 브라우저에서 직접 열었을 때 <code>{"ok":true,...}</code>가 나오는지 확인하세요.</li>
        <li>Apps Script 배포 설정의 <b>액세스 권한</b>이 "Google 계정이 있는 모든 사용자"가 아니라 <b>"모든 사용자"</b>여야 합니다.</li>
        <li>코드를 바꾼 뒤에는 <b>배포 관리 → 수정 → 버전: 새 버전</b>으로 다시 배포해야 합니다.</li>
        <li>"알 수 없는 요청" 오류라면 Apps Script에 최신 <code>Code.gs</code>를 붙여넣었는지 확인하세요.</li>
      </ul>`;
  }
  openDialog(`<h3>서버 연결 확인</h3>${verdict}<pre class="diag">${esc(lines.join('\n'))}</pre>`);
}

// ---------- 서버 연결 (새 Apps Script 연결) ----------

const shareLink = url => `${location.origin}${location.pathname}?server=${encodeURIComponent(url)}`;

// 서버를 바꾸면 이전 서버의 로그인은 쓸 수 없으므로 로그아웃
async function switchServer(url) {
  const pending = (await DB.outboxAll()).length;
  if (pending && !confirm(`아직 전송되지 않은 기록이 ${pending}건 있습니다. 서버를 바꾸면 이 기록은 새 서버로 전송되어 실패할 수 있어요.\n먼저 인터넷에 연결해 전송하는 것을 권장합니다. 그래도 바꿀까요?`)) return false;
  setApiUrl(url);
  await DB.del('teacherSession');
  await DB.del('studentSession');
  state.teacher = state.student = null;
  renderUser();
  return true;
}

function viewServer() {
  const current = apiUrl();
  const custom = current && current !== CONFIG.API_URL;
  render(`
    <section class="page-head">
      <div><p class="eyebrow">설정</p><h1>서버 연결</h1></div>
      <button class="btn ghost" id="back">← 처음으로</button>
    </section>

    <section class="card">
      <h3>현재 연결된 서버</h3>
      ${current ? `<p class="diag">${esc(current)}</p>
        <p class="muted small">${custom ? '이 기기에서 직접 연결한 서버입니다.' : '앱에 기본으로 설정된 서버입니다.'}</p>`
        : '<p class="notice warn">연결된 서버가 없습니다.</p>'}
      <div class="actions">
        ${custom && CONFIG.API_URL ? '<button class="btn ghost" id="resetServer">기본 서버로 되돌리기</button>' : ''}
        ${current ? '<button class="btn" id="check">연결 확인</button>' : ''}
      </div>
    </section>

    <section class="card">
      <h3>새 서버 연결하기</h3>
      <p class="muted small">학교·학급별로 따로 데이터를 저장하려면, 선생님의 Google 계정으로 서버(Apps Script)를 만들어 연결하세요. 처음 한 번, 10분 정도 걸립니다.</p>
      <ol class="steps">
        <li><b>스프레드시트 만들기</b>
          <span><a href="https://sheets.new" target="_blank" rel="noopener">sheets.new</a>에서 새 스프레드시트를 만들고 이름을 정합니다. (예: 책임플러스 DB)</span></li>
        <li><b>Apps Script 열기</b>
          <span>스프레드시트 메뉴 <b>확장 프로그램 → Apps Script</b>를 누릅니다.</span></li>
        <li><b>서버 코드 붙여넣기</b>
          <span>편집기의 기존 코드를 모두 지우고, 아래 버튼으로 복사한 코드를 붙여넣은 뒤 저장(💾)합니다.</span>
          <span class="actions left"><button class="btn sm" id="copyCode">📋 서버 코드 복사</button>
            <a class="btn sm ghost" href="apps-script/Code.gs" target="_blank" rel="noopener">코드 보기</a></span></li>
        <li><b>setup 한 번 실행</b>
          <span>위쪽 함수 목록에서 <code>setup</code>을 고르고 <b>실행</b>을 누릅니다. 권한 창이 뜨면 <b>권한 검토 → 내 계정 선택 → 고급 → (안전하지 않음)으로 이동 → 허용</b> 순서로 진행합니다. 직접 만든 코드라서 나오는 안내이니 걱정하지 않으셔도 됩니다.</span></li>
        <li><b>웹 앱으로 배포</b>
          <span><b>배포 → 새 배포 → 유형 선택(⚙️) → 웹 앱</b>을 고르고,
            <b>실행 사용자: 나</b>, <b>액세스 권한: 모든 사용자</b>로 정한 뒤 <b>배포</b>를 누릅니다.
            나오는 <b>웹 앱 URL</b>(…/exec로 끝남)을 복사합니다.</span></li>
        <li><b>아래 칸에 붙여넣고 연결</b>
          <form id="f" class="server-form">
            <input name="url" required placeholder="https://script.google.com/macros/s/…/exec" autocomplete="off" spellcheck="false">
            <p class="form-error" hidden></p>
            <button class="btn primary block">연결 테스트 후 저장</button>
          </form></li>
      </ol>
      <p class="hint">💡 나중에 서버 코드를 고칠 때는 <b>새 배포</b> 대신 <b>배포 관리 → 수정(연필) → 버전: 새 버전 → 배포</b>를 하세요. 주소가 그대로라 다시 연결할 필요가 없습니다.</p>
    </section>

    ${current ? `<section class="card">
      <h3>학생 기기 연결 링크</h3>
      <p class="muted small">학생들이 이 링크로 처음 접속하면 같은 서버에 자동으로 연결됩니다. 링크를 학급 게시판에 올리거나 QR 코드로 만들어 나눠 주세요.</p>
      <div class="share-row"><input id="share" readonly value="${esc(shareLink(current))}"><button class="btn" id="copyShare">복사</button></div>
      ${custom ? '' : '<p class="muted small">기본 서버를 쓰는 경우에는 앱 주소만 알려줘도 됩니다.</p>'}
    </section>` : ''}`);

  document.getElementById('back').onclick = viewHome;
  const check = document.getElementById('check');
  if (check) check.onclick = checkServer;
  const reset = document.getElementById('resetServer');
  if (reset) reset.onclick = async () => {
    if (await switchServer(CONFIG.API_URL)) { toast('기본 서버로 되돌렸습니다.', 'ok'); viewServer(); }
  };
  const copy = async (text, msg) => {
    try { await navigator.clipboard.writeText(text); toast(msg, 'ok'); }
    catch (e) { toast('복사하지 못했습니다. 직접 선택해 복사해 주세요.', 'warn'); }
  };
  document.getElementById('copyCode').onclick = async () => {
    try {
      const res = await fetch('apps-script/Code.gs', { cache: 'no-cache' });
      if (!res.ok) throw new Error();
      await copy(await res.text(), '서버 코드를 복사했습니다. Apps Script 편집기에 붙여넣으세요.');
    } catch (e) {
      toast('코드를 불러오지 못했습니다. "코드 보기"에서 직접 복사해 주세요.', 'warn');
    }
  };
  const share = document.getElementById('copyShare');
  if (share) share.onclick = () => copy(document.getElementById('share').value, '연결 링크를 복사했습니다.');

  const f = document.getElementById('f');
  f.onsubmit = e => {
    e.preventDefault();
    busy(f.querySelector('.primary'), async () => {
      formError(f);
      const url = f.url.value.trim();
      if (!SERVER_PATTERN.test(url)) {
        return formError(f, 'Apps Script 웹 앱 주소가 아닙니다. "https://script.google.com/…/exec" 형태의 웹 앱 URL을 붙여넣어 주세요. (편집기 주소나 "/dev"로 끝나는 주소는 안 됩니다)');
      }
      try {
        await api('ping', {}, url);
      } catch (err) {
        return formError(f, `연결 테스트에 실패했습니다: ${err.message}\n배포의 액세스 권한이 "모든 사용자"인지, setup을 실행했는지 확인해 주세요.`);
      }
      if (url === current) return toast('이미 이 서버에 연결되어 있습니다.');
      if (await switchServer(url)) {
        toast('새 서버에 연결했습니다. 교사는 이 서버에서 새로 회원가입해 주세요.', 'ok');
        viewServer();
      }
    });
  };
}

// 저장된 앱 파일을 모두 지우고 새로 받기 (입력한 기록·로그인은 그대로 유지)
async function forceUpdate() {
  if (!navigator.onLine) return toast('인터넷에 연결된 상태에서 업데이트할 수 있어요.', 'warn');
  try {
    const regs = navigator.serviceWorker ? await navigator.serviceWorker.getRegistrations() : [];
    await Promise.all(regs.map(r => r.unregister()));
    const keys = await caches.keys();
    await Promise.all(keys.map(k => caches.delete(k)));
  } catch (e) { /* 지원하지 않는 브라우저 */ }
  location.reload();
}

// 연결 링크(?server=...)로 들어온 경우
async function applyServerFromLink() {
  const params = new URLSearchParams(location.search);
  const url = params.get('server');
  if (!url) return;
  params.delete('server');
  history.replaceState(null, '', location.pathname + (params.toString() ? '?' + params : '') + location.hash);
  if (!SERVER_PATTERN.test(url) || url === apiUrl()) return;
  if (await switchServer(url)) toast('선생님이 알려준 서버에 연결했습니다.', 'ok');
}

// ---------- 첫 화면 ----------

function viewHome() {
  render(`
    <section class="hero">
      <img class="hero-logo" src="icons/logo.png" alt="책임플러스" width="220" height="214">
      <h1>누구로 사용하나요?</h1>
      <p class="muted">인터넷이 없어도 검사할 수 있어요. 와이파이가 연결되면 선생님께 자동으로 전송됩니다.</p>
    </section>
    <div class="role-grid">
      <button class="role" id="goStudent">
        <span class="role-icon">🧹</span><b>학생</b><small>친구들 역할 평가하기</small>
      </button>
      <button class="role" id="goTeacher">
        <span class="role-icon">📋</span><b>교사</b><small>학반 세팅 · 월별 우수 학생</small>
      </button>
    </div>
    ${apiUrl() ? '' : `<p class="notice warn">서버가 아직 연결되지 않았습니다. 아래 <b>서버 연결</b>에서 연결해 주세요.</p>`}
    <p class="center"><button class="link sm" id="goServer">⚙️ 서버 연결</button></p>
    <p class="center muted small">책임플러스 ${APP_VERSION} · <button class="link sm" id="forceUpdate">최신 버전으로 업데이트</button></p>`);
  document.getElementById('goServer').onclick = () => viewServer();
  document.getElementById('forceUpdate').onclick = forceUpdate;
  document.getElementById('goStudent').onclick = viewStudentLogin;
  document.getElementById('goTeacher').onclick = () => viewTeacherLogin();
}

// ---------- 학생 ----------

async function viewStudentLogin() {
  const prev = (await DB.get('lastStudent')) || {};
  render(`
    <form class="card narrow" id="f" autocomplete="off">
      <h2>학생 입장</h2>
      <label>반<input name="classNo" required placeholder="예: 3학년 2반" value="${esc(prev.classNo)}"></label>
      <div class="row2">
        <label>번호<input name="number" required inputmode="numeric" pattern="[0-9]+" placeholder="예: 7" value="${esc(prev.number)}"></label>
        <label>이름<input name="name" required placeholder="예: 김하늘" value="${esc(prev.name)}"></label>
      </div>
      <label>학급 코드<input name="code" required placeholder="선생님이 알려준 코드" class="code-input" value="${esc(prev.classCode)}"></label>
      <label>개인 비밀번호 <span class="muted small">(숫자 4자리)</span>
        <input name="pin" type="password" required inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="off" class="pin-input" placeholder="••••">
        <span class="hint">처음이면 선생님이 알려준 <b>처음 비밀번호(1234)</b>를 입력하세요.</span>
      </label>
      <div id="newPinWrap" class="new-pin" hidden>
        <p class="notice">🔑 <b>나만 아는 새 비밀번호</b>를 정해 주세요. 숫자 4자리, 1234는 안 돼요. 꼭 기억하세요!</p>
        <div class="row2 even">
          <label>새 비밀번호<input name="newPin" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="off" class="pin-input" placeholder="••••"></label>
          <label>한 번 더<input name="newPin2" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="off" class="pin-input" placeholder="••••"></label>
        </div>
      </div>
      <p class="form-error" hidden></p>
      <button class="btn primary block">입장하기</button>
      <button type="button" class="link" id="back">← 처음으로</button>
    </form>`);
  const f = document.getElementById('f');
  const newPinWrap = f.querySelector('#newPinWrap');
  const showNewPin = on => {
    newPinWrap.hidden = !on;
    f.newPin.required = f.newPin2.required = on;
    f.querySelector('.primary').textContent = on ? '새 비밀번호로 입장하기' : '입장하기';
  };
  f.querySelector('#back').onclick = viewHome;
  // 학생 정보나 비밀번호를 바꾸면 새 비밀번호 단계를 처음부터
  ['classNo', 'number', 'name', 'code', 'pin'].forEach(n => f[n].addEventListener('input', () => showNewPin(false)));
  f.onsubmit = e => {
    e.preventDefault();
    busy(f.querySelector('.primary'), async () => {
      formError(f);
      const s = {
        classNo: f.classNo.value.trim(),
        number: String(Number(f.number.value)),
        name: f.name.value.trim(),
        classCode: f.code.value.trim().toUpperCase(),
      };
      const pin = f.pin.value;
      const authKey = `studentAuth:${s.classCode}:${s.number}`;
      let r;
      try {
        r = await api('studentLogin', { classCode: s.classCode, number: s.number, name: s.name, pin,
          newPin: newPinWrap.hidden ? '' : f.newPin.value, newPin2: newPinWrap.hidden ? '' : f.newPin2.value });
      } catch (err) {
        if (!isNetErr(err)) return formError(f, err.message);
        // 오프라인: 이 기기에서 입장한 적이 있으면 저장된 확인값으로 입장
        const a = await DB.get(authKey);
        const cfg = await DB.get('config:' + s.classCode);
        if (!a || !cfg) return formError(f, '이 기기에서 처음 입장할 때는 인터넷 연결이 필요합니다.');
        if (a.name.replace(/\s/g, '') !== s.name.replace(/\s/g, '') || await pbkdf2(pin, a.salt) !== a.verifier) {
          return formError(f, '이름이나 비밀번호가 맞지 않습니다.');
        }
        return enterStudent({ ...s, token: a.token });
      }
      if (r.mustChange) {
        showNewPin(true);
        f.newPin.focus();
        return;
      }
      const usedPin = r.changed ? f.newPin.value : pin;
      await DB.set('config:' + s.classCode, r.config);
      await saveStudentVerifier(authKey, s.name, r.token, usedPin);
      if (r.changed) toast('새 비밀번호를 정했어요. 다음부터 이 비밀번호로 입장해요.', 'ok');
      await enterStudent({ ...s, token: r.token });
    });
  };
}

// 오프라인 입장용 확인값 (비밀번호 자체는 저장하지 않음)
async function saveStudentVerifier(authKey, name, token, pin) {
  const salt = uid();
  await DB.set(authKey, { name, token, salt, verifier: await pbkdf2(pin, salt) });
}

// 학생: 내 비밀번호 바꾸기
function changeMyPinDialog() {
  const s = state.student;
  openDialog(`
    <h3>🔑 비밀번호 바꾸기</h3>
    <form id="pf">
      <label>지금 비밀번호<input name="pin" type="password" required inputmode="numeric" pattern="[0-9]{4}" maxlength="4" class="pin-input" placeholder="••••"></label>
      <div class="row2 even">
        <label>새 비밀번호<input name="newPin" type="password" required inputmode="numeric" pattern="[0-9]{4}" maxlength="4" class="pin-input" placeholder="••••"></label>
        <label>한 번 더<input name="newPin2" type="password" required inputmode="numeric" pattern="[0-9]{4}" maxlength="4" class="pin-input" placeholder="••••"></label>
      </div>
      <p class="form-error" hidden></p>
      <button class="btn primary block">바꾸기</button>
    </form>`);
  const pf = $dialog.querySelector('#pf');
  pf.onsubmit = e => {
    e.preventDefault();
    busy(pf.querySelector('.primary'), async () => {
      formError(pf);
      try {
        await api('changeMyPin', { token: s.token, pin: pf.pin.value, newPin: pf.newPin.value, newPin2: pf.newPin2.value });
        await saveStudentVerifier(`studentAuth:${s.classCode}:${s.number}`, s.name, s.token, pf.newPin.value);
        $dialog.close();
        toast('비밀번호를 바꿨어요. 다음부터 새 비밀번호로 입장해요.', 'ok');
      } catch (err) {
        formError(pf, isNetErr(err) ? '인터넷에 연결된 상태에서 바꿀 수 있어요.' : err.message);
      }
    });
  };
}

async function enterStudent(s) {
  state.student = s;
  state.teacher = null;
  await DB.del('teacherSession');
  await DB.set('studentSession', s);
  await DB.set('lastStudent', { classNo: s.classNo, number: s.number, name: s.name, classCode: s.classCode });
  renderUser();
  viewStudent();
}

const historyKey = (code, number) => `history:${code}:${number}`;

async function viewStudent() {
  const s = state.student;
  const raw = await DB.get('config:' + s.classCode);
  if (!raw || !s.token) return viewStudentLogin(); // 개인 비밀번호 도입 전 입장 기록이면 다시 입장
  const cfg = normClass(clone(raw));
  const isInspector = cfg.inspectors.includes(s.number);
  const myEval = '<section class="card" id="myEval"><h3>나의 평가</h3><div id="myEvalBody"><p class="muted">불러오는 중…</p></div></section>';
  const myTasks = cfg.tasks.filter(t => t.assigneeNos.includes(s.number));

  const seq = render(`
    <section class="page-head">
      <div>
        <p class="eyebrow">${esc(cfg.className)}</p>
        <h1>${isInspector ? '역할 평가' : '나의 역할'}</h1>
      </div>
    </section>
    <section class="card my-role">
      <div><span class="muted small">내 역할</span>
        <b>${myTasks.length ? myTasks.map(t => esc(t.name)).join(', ') : '없음'}</b></div>
      <div class="role-side">
        ${isInspector ? '<span class="status sent">검사 담당</span>' : ''}
        <button class="link sm" id="changePin">🔑 비밀번호 바꾸기</button>
      </div>
    </section>
    ${isInspector ? inspectFormHtml(cfg, s.number) + myEval : `${myEval}
      <p class="notice">평가는 선생님이 지정한 검사 담당 학생만 할 수 있어요.</p>`}
    ${isInspector ? '<section class="card"><h3>내가 입력한 평가 (이 기기)</h3><div id="history"></div></section>' : ''}
    <section class="card">
      <h3>학급 전체 역할</h3>
      <ul class="list">${cfg.tasks.map(t => `<li><b>${esc(t.name)}${t.inspector ? ' <span class="tag">검사</span>' : ''}</b>
        <span class="muted">${esc(assigneeText(cfg, t) || '미배정')}</span></li>`).join('')}</ul>
    </section>`);

  document.getElementById('changePin').onclick = changeMyPinDialog;
  if (isInspector) {
    bindInspectForm(cfg);
    renderHistory();
  }
  loadMyRecords(seq);

  // 온라인이면 학급 정보(역할 배정 등) 최신화. 평가 입력 중이 아닐 때만 화면 갱신
  api('getClassConfig', { classCode: s.classCode }).then(async r => {
    if (JSON.stringify(r.config) === JSON.stringify(raw)) return;
    await DB.set('config:' + s.classCode, r.config);
    if (seq === viewSeq && !document.querySelector('.scale button.on')) {
      toast('역할이나 학급 정보가 업데이트되었습니다.');
      viewStudent();
    }
  }).catch(() => {});
}

// ---------- 학생: 나의 평가 ----------

async function loadMyRecords(seq) {
  const s = state.student;
  const key = `myrecs:${s.classCode}:${s.number}`;
  let data = await DB.get(key);
  let month = null;
  const draw = () => {
    if (seq !== viewSeq || !document.getElementById('myEvalBody')) return;
    month = drawMyRecords(data, month, m => { month = m; draw(); });
  };
  draw();
  try {
    const r = await api('myRecords', { token: s.token });
    data = { ...r, fetchedAt: Date.now() };
    await DB.set(key, data);
    draw();
  } catch (e) {
    const el = document.getElementById('myEvalBody');
    if (!el || seq !== viewSeq) return;
    if (e.code === 'AUTH') {
      el.innerHTML = '<p class="notice warn">비밀번호가 초기화되었거나 입장 기간이 지났어요. 다시 입장해 주세요.</p><button class="btn" id="reLogin">다시 입장하기</button>';
      el.querySelector('#reLogin').onclick = logout;
    } else if (!data) {
      el.innerHTML = '<p class="muted">인터넷에 연결되면 나의 평가를 볼 수 있어요.</p>';
    }
  }
}

function drawMyRecords(data, month, onMonth) {
  const el = document.getElementById('myEvalBody');
  if (!data) return month;
  const recs = data.records || [];
  if (!recs.length) {
    el.innerHTML = '<p class="muted">아직 받은 평가가 없어요. 역할을 열심히 해 봐요! 💪</p>';
    return month;
  }
  const thisMonth = localDate().slice(0, 7);
  const months = [...new Set(recs.map(r => r.date.slice(0, 7)))].sort().reverse();
  if (!month || !months.includes(month)) month = months.includes(thisMonth) ? thisMonth : months[0];
  const rs = recs.filter(r => r.date.startsWith(month)).sort((a, b) => (b.date + b.inspectedAt).localeCompare(a.date + a.inspectedAt));
  const cnt = {};
  rs.forEach(r => { cnt[r.score] = (cnt[r.score] || 0) + 1; });
  const avg = rs.reduce((a, r) => a + Number(r.score), 0) / rs.length;
  const info = (data.months || []).find(m => m.month === month) || {};
  const monthAvg = m => {
    const x = recs.filter(r => r.date.startsWith(m));
    return { n: x.length, avg: x.reduce((a, r) => a + Number(r.score), 0) / x.length };
  };

  el.innerHTML = `
    ${months.length > 1 ? `<div class="month-pills">${months.map(m => `<button class="${m === month ? 'on' : ''}" data-m="${m}">${Number(m.slice(5))}월</button>`).join('')}</div>` : ''}
    <div class="my-summary">
      <div class="my-score"><span class="muted small">${monthLabel(month)} 평균</span>
        <b>${avg.toFixed(2)}<small> / ${MAX_SCORE}</small></b>
        <span class="muted small">평가 ${rs.length}회</span></div>
      <div class="my-dist">
        ${info.excellent ? `<p class="badge-excellent">🏆 ${Number(month.slice(5))}월 우수 학생${month === thisMonth ? ' <small>(지금까지 기준)</small>' : ''}</p>` : ''}
        ${stackBar(cnt, rs.length)}
        ${scaleLegend()}
      </div>
    </div>
    <ul class="list my-list">${rs.map(r => `<li>
      <div><b>${esc(r.date.slice(5).replace('-', '/'))}</b> <span class="muted small">${esc(r.taskName)}</span>
        ${r.memo ? `<p class="memo-text">💬 ${esc(r.memo)}</p>` : ''}</div>
      ${scorePill(r.score)}</li>`).join('')}</ul>
    ${months.length > 1 ? `<h4>월별 기록</h4><ul class="list compact">${months.map(m => {
      const x = monthAvg(m);
      const ex = ((data.months || []).find(y => y.month === m) || {}).excellent;
      return `<li><span>${monthLabel(m)} ${ex ? '🏆' : ''}</span><span class="muted small">평가 ${x.n}회 · 평균 <b>${x.avg.toFixed(2)}</b></span></li>`;
    }).join('')}</ul>` : ''}
    <p class="muted small">평가한 친구는 공개되지 않아요.${data.showMemos ? '' : ' 메모는 선생님만 볼 수 있어요.'}
      ${data.fetchedAt ? `<br>${fmtTime(data.fetchedAt)} 기준` : ''}</p>`;
  el.querySelectorAll('[data-m]').forEach(b => b.onclick = () => onMonth(b.dataset.m));
  return month;
}

function inspectFormHtml(cfg, myNo) {
  const tasks = cfg.tasks.filter(t => !t.inspector && t.assigneeNos.some(no => no !== myNo));
  return `
    <form class="card" id="inspect">
      <div class="inspect-head">
        <label class="inline">평가 날짜 <input type="date" name="date" value="${localDate()}" required></label>
        <button type="button" class="btn sm ghost" id="allTop">빈칸 모두 ${MAX_SCORE}점</button>
      </div>
      <div class="scale-legend">${SCALE.map(x => `<span><i class="s${x.value}"></i>${x.value} ${esc(x.label)}</span>`).join('')}</div>
      ${tasks.map(t => `
        <div class="task">
          <div class="task-head"><b>${esc(t.name)}</b></div>
          ${t.assigneeNos.filter(no => no !== myNo).slice().sort(byNo).map(no => `
            <div class="person" data-task="${esc(t.id)}" data-no="${esc(no)}">
              <div class="person-head">
                <span class="pname">${esc(studentLabel(cfg, no))}</span>
                <button type="button" class="link sm memo-toggle">+ 메모</button>
              </div>
              <div class="scale">${SCALE.map(x => `<button type="button" class="s${x.value}" data-v="${x.value}" title="${esc(x.label)}">
                <b>${x.value}</b><small>${esc(x.label)}</small></button>`).join('')}</div>
              <input class="memo" hidden maxlength="200" placeholder="${esc(studentName(cfg, no) || no + '번')} 학생에 대한 메모">
            </div>`).join('')}
        </div>`).join('') || '<p class="muted">평가할 역할이 아직 배정되지 않았어요.</p>'}
      <button class="btn primary block" ${tasks.length ? '' : 'disabled'}>평가 저장</button>
      <p class="muted small center">저장하면 이 기기에 보관되고, 인터넷이 연결되면 자동으로 전송됩니다.</p>
    </form>`;
}

function bindInspectForm(cfg) {
  const f = document.getElementById('inspect');
  f.querySelectorAll('.scale').forEach(scale => {
    scale.onclick = e => {
      const b = e.target.closest('button');
      if (!b) return;
      const on = b.classList.contains('on');
      scale.querySelectorAll('button').forEach(x => x.classList.remove('on'));
      if (!on) b.classList.add('on');
    };
  });
  f.querySelectorAll('.memo-toggle').forEach(btn => {
    btn.onclick = () => {
      const input = btn.closest('.person').querySelector('.memo');
      input.hidden = !input.hidden;
      if (!input.hidden) input.focus();
    };
  });
  f.querySelectorAll('.memo').forEach(input => {
    input.oninput = () => {
      input.closest('.person').querySelector('.memo-toggle').textContent = input.value.trim() ? '✓ 메모' : '+ 메모';
    };
  });
  f.querySelector('#allTop').onclick = () => {
    f.querySelectorAll('.scale').forEach(scale => {
      if (!scale.querySelector('.on')) scale.querySelector(`[data-v="${MAX_SCORE}"]`).classList.add('on');
    });
  };
  f.onsubmit = async e => {
    e.preventDefault();
    const s = state.student;
    const date = f.date.value;
    const now = new Date().toISOString();
    const records = [];
    const people = f.querySelectorAll('.person');
    people.forEach(el => {
      const on = el.querySelector('.scale .on');
      const memo = el.querySelector('.memo').value.trim();
      if (!on) return;
      const t = cfg.tasks.find(x => x.id === el.dataset.task);
      records.push({
        recordId: uid(), date, taskId: t.id, taskName: t.name,
        studentNo: el.dataset.no, studentName: studentName(cfg, el.dataset.no),
        score: Number(on.dataset.v), memo, inspectedAt: now,
      });
    });
    const memoOnly = [...people].filter(el => !el.querySelector('.scale .on') && el.querySelector('.memo').value.trim());
    if (memoOnly.length) return toast('메모를 남긴 학생은 점수도 선택해 주세요.', 'warn');
    if (!records.length) return toast('평가할 학생의 점수를 하나 이상 선택해 주세요.', 'warn');
    const missing = people.length - records.length;
    if (missing && !confirm(`${missing}명은 점수를 선택하지 않았어요. 선택한 ${records.length}명만 저장할까요?`)) return;

    const batchId = uid();
    const key = historyKey(s.classCode, s.number);
    const hist = (await DB.get(key)) || [];
    hist.unshift({ batchId, date, savedAt: Date.now(), sent: false, records });
    await DB.set(key, hist.slice(0, 50));
    await Sync.enqueue('submitRecords', {
      classCode: s.classCode,
      student: { classNo: s.classNo, number: s.number, name: s.name },
      batchId, records,
    }, { label: `${s.number}번 ${s.name} · ${date} 평가 ${records.length}명` });

    toast(navigator.onLine ? '저장했습니다. 전송 중…' : '저장했습니다. 와이파이 연결 시 자동 전송됩니다.', 'ok');
    f.querySelectorAll('.scale .on').forEach(b => b.classList.remove('on'));
    f.querySelectorAll('.memo').forEach(m => { m.value = ''; m.hidden = true; });
    f.querySelectorAll('.memo-toggle').forEach(b => { b.textContent = '+ 메모'; });
    renderHistory();
  };
}

async function renderHistory() {
  const el = document.getElementById('history');
  if (!el || !state.student) return;
  const hist = (await DB.get(historyKey(state.student.classCode, state.student.number))) || [];
  el.innerHTML = hist.length ? `<ul class="list">${hist.slice(0, 10).map(h => {
    const avg = h.records.reduce((a, r) => a + Number(r.score || 0), 0) / h.records.length;
    const memos = h.records.filter(r => r.memo).length;
    return `<li>
      <div><b>${esc(h.date)}</b> <span class="muted small">${fmtTime(h.savedAt)} 저장</span>
        <div class="small muted">${h.records.length}명 평가 · 평균 ${avg.toFixed(1)}점${memos ? ` · 메모 ${memos}개` : ''}</div>
      </div>
      <span class="status ${h.sent ? 'sent' : 'wait'}">${h.sent ? '전송 완료' : '전송 대기'}</span>
    </li>`;
  }).join('')}</ul>` : '<p class="muted">아직 평가 기록이 없어요.</p>';
}

// ---------- 교사: 로그인 ----------

function viewTeacherLogin(signup = false) {
  render(`
    <form class="card narrow" id="f">
      <h2>${signup ? '교사 회원가입' : '교사 로그인'}</h2>
      ${signup ? '<label>이름<input name="name" required placeholder="예: 홍길동" autocomplete="name"></label>' : ''}
      <label>아이디 (이메일)<input name="email" type="email" required autocomplete="username" placeholder="teacher@school.kr"></label>
      <label>비밀번호<input name="password" type="password" required minlength="6" autocomplete="${signup ? 'new-password' : 'current-password'}"></label>
      ${signup ? `
        <label>비밀번호 확인<input name="password2" type="password" required minlength="6" autocomplete="new-password"></label>
        <label>가입 코드 <span class="muted small">(관리자가 정한 경우에만)</span><input name="signupCode"></label>` : ''}
      <p class="form-error" hidden></p>
      <button class="btn primary block">${signup ? '가입하기' : '로그인'}</button>
      <div class="split">
        <button type="button" class="link" id="back">← 처음으로</button>
        <button type="button" class="link" id="toggle">${signup ? '로그인으로' : '처음이신가요? 회원가입'}</button>
      </div>
      ${signup ? '' : `<p class="center"><button type="button" class="link sm" id="forgot">비밀번호를 잊으셨나요?</button></p>
        <p class="muted small">이 기기에서 한 번 로그인한 계정은 인터넷이 없어도 로그인할 수 있어요.</p>`}
    </form>`);
  const f = document.getElementById('f');
  f.querySelector('#back').onclick = viewHome;
  f.querySelector('#toggle').onclick = () => viewTeacherLogin(!signup);
  if (!signup) f.querySelector('#forgot').onclick = () => viewForgot(f.email.value.trim());
  f.onsubmit = e => {
    e.preventDefault();
    busy(f.querySelector('.primary'), async () => {
      formError(f);
      const email = f.email.value.trim().toLowerCase();
      const password = f.password.value;
      if (signup && password !== f.password2.value) return formError(f, '비밀번호가 서로 다릅니다.');
      let r;
      try {
        r = signup
          ? await api('signup', { email, password, name: f.name.value.trim(), signupCode: f.signupCode.value.trim() })
          : await api('login', { email, password });
      } catch (err) {
        if (signup || !isNetErr(err)) return formError(f, err.message);
        return offlineLogin(f, email, password);
      }
      await finishOnlineLogin(email, password, r);
    });
  };
}

// 온라인 로그인 성공: 오프라인 로그인용 확인값을 이 기기에 저장
async function finishOnlineLogin(email, password, r) {
  const salt = uid();
  await DB.set('teacherAuth:' + email, { email, name: r.name, token: r.token, salt, verifier: await pbkdf2(password, salt) });
  await DB.set('classes:' + email, r.classes);
  await startTeacher({ email, name: r.name, token: r.token });
}

// 비밀번호 찾기: ① 아이디(이메일)로 인증 코드 받기 → ② 코드 + 새 비밀번호
function viewForgot(prefill = '') {
  render(`
    <form class="card narrow" id="f1">
      <h2>비밀번호 찾기</h2>
      <p class="muted small">가입한 아이디(이메일)로 6자리 인증 코드를 보내드립니다. 인터넷 연결이 필요합니다.</p>
      <label>아이디 (이메일)<input name="email" type="email" required autocomplete="username" value="${esc(prefill)}"></label>
      <p class="form-error" hidden></p>
      <button class="btn primary block">인증 코드 받기</button>
      <div class="split">
        <button type="button" class="link" id="back">← 로그인으로</button>
        <button type="button" class="link" id="haveCode">이미 코드를 받았어요</button>
      </div>
    </form>
    <form class="card narrow" id="f2" hidden>
      <h2>새 비밀번호 설정</h2>
      <p class="notice small" id="sentMsg"></p>
      <label>인증 코드<input name="code" required inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="6자리 숫자" autocomplete="one-time-code" class="code-input"></label>
      <label>새 비밀번호<input name="password" type="password" required minlength="6" autocomplete="new-password"></label>
      <label>새 비밀번호 확인<input name="password2" type="password" required minlength="6" autocomplete="new-password"></label>
      <p class="form-error" hidden></p>
      <button class="btn primary block">비밀번호 바꾸고 로그인</button>
      <div class="split">
        <button type="button" class="link" id="back2">← 로그인으로</button>
        <button type="button" class="link" id="resend">코드 다시 받기</button>
      </div>
      <p class="muted small">메일이 오지 않으면 스팸함을 확인하거나, 앱을 설치한 관리자에게 비밀번호 초기화를 요청하세요.</p>
    </form>`);
  const f1 = document.getElementById('f1');
  const f2 = document.getElementById('f2');
  let email = prefill.toLowerCase();
  const showStep2 = msg => {
    email = f1.email.value.trim().toLowerCase();
    document.getElementById('sentMsg').textContent = msg || `${email} 로 받은 인증 코드를 입력하세요.`;
    f1.hidden = true;
    f2.hidden = false;
    f2.code.focus();
  };
  f1.querySelector('#back').onclick = () => viewTeacherLogin();
  f2.querySelector('#back2').onclick = () => viewTeacherLogin();
  f1.querySelector('#haveCode').onclick = () => {
    if (!f1.email.reportValidity()) return;
    showStep2();
  };
  f2.querySelector('#resend').onclick = () => { f1.hidden = false; f2.hidden = true; };
  f1.onsubmit = e => {
    e.preventDefault();
    busy(f1.querySelector('.primary'), async () => {
      formError(f1);
      try {
        const r = await api('requestReset', { email: f1.email.value.trim().toLowerCase() });
        showStep2(r.message);
      } catch (err) {
        formError(f1, err.message);
      }
    });
  };
  f2.onsubmit = e => {
    e.preventDefault();
    busy(f2.querySelector('.primary'), async () => {
      formError(f2);
      const password = f2.password.value;
      if (password !== f2.password2.value) return formError(f2, '비밀번호가 서로 다릅니다.');
      try {
        const r = await api('resetPassword', { email, code: f2.code.value.trim(), password });
        toast('비밀번호를 바꿨습니다.', 'ok');
        await finishOnlineLogin(email, password, r);
      } catch (err) {
        formError(f2, err.message);
      }
    });
  };
}

async function offlineLogin(f, email, password) {
  const a = await DB.get('teacherAuth:' + email);
  if (!a) return formError(f, '인터넷에 연결할 수 없습니다. 이 기기에서 처음 로그인할 때는 인터넷이 필요합니다.');
  if (await pbkdf2(password, a.salt) !== a.verifier) return formError(f, '아이디 또는 비밀번호가 올바르지 않습니다.');
  toast('오프라인으로 로그인했습니다.');
  await startTeacher({ email, name: a.name, token: a.token });
}

async function startTeacher(session) {
  state.teacher = session;
  state.student = null;
  await DB.del('studentSession');
  await DB.set('teacherSession', session);
  renderUser();
  Sync.run();
  viewTeacherHome();
}

// ---------- 교사: 학급 목록 ----------

async function loadClasses() {
  const email = state.teacher.email;
  const list = (await DB.get('classes:' + email)) || [];
  // 아직 전송되지 않은 학급 설정 변경을 반영
  const map = new Map(list.map(c => [c.classCode, c]));
  (await DB.outboxAll())
    .filter(o => o.action === 'saveClass' && o.email === email)
    .forEach(o => map.set(o.data.cls.classCode, { ...o.data.cls, pending: true }));
  return [...map.values()].map(c => normClass(clone(c)));
}

async function saveClassLocal(cls, label) {
  const email = state.teacher.email;
  const data = clone(cls);
  delete data.pending;
  const list = (await DB.get('classes:' + email)) || [];
  const i = list.findIndex(c => c.classCode === data.classCode);
  if (i >= 0) list[i] = data; else list.push(data);
  await DB.set('classes:' + email, list);
  await Sync.enqueue('saveClass', { cls: data }, { auth: 'teacher', email, label });
}

// 학급 카드에 보여줄 이번 달 요약 (이번 달 기록이 없으면 기록이 있는 최근 달)
function classSummary(cls, records) {
  const thisMonth = localDate().slice(0, 7);
  const months = [...new Set(records.map(r => r.date.slice(0, 7)))].sort();
  const month = records.some(r => r.date.startsWith(thisMonth)) ? thisMonth : months.pop() || thisMonth;
  const rs = records.filter(r => r.date.startsWith(month));
  const avg = rs.length ? rs.reduce((a, r) => a + Number(r.score), 0) / rs.length : null;
  const ranking = monthlyRanking(records, cls, month);
  return {
    month, count: rs.length, avg,
    rated: new Set(rs.map(r => r.studentNo)).size,
    lastDate: records.reduce((m, r) => (r.date > m ? r.date : m), ''),
    winners: ranking.filter(r => r.excellent).slice(0, 3),
  };
}

async function viewTeacherHome(refresh = true) {
  const classes = await loadClasses();
  const recs = {};
  for (const c of classes) recs[c.classCode] = ((await DB.get('records:' + c.classCode)) || {}).records || [];
  const pending = (await DB.outboxAll()).length;
  const thisMonth = localDate().slice(0, 7);
  const sums = Object.fromEntries(classes.map(c => [c.classCode, classSummary(c, recs[c.classCode])]));
  const totalStudents = classes.reduce((a, c) => a + c.students.length, 0);
  const monthCount = classes.reduce((a, c) => a + recs[c.classCode].filter(r => r.date.startsWith(thisMonth)).length, 0);
  const today = new Date().toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'long' });
  const medal = r => (r === 1 ? '🥇' : r === 2 ? '🥈' : r === 3 ? '🥉' : `${r}위`);
  const memos = classes.flatMap(c => recs[c.classCode].filter(r => r.memo).map(r => ({ ...r, cls: c })))
    .sort((a, b) => (b.date + b.inspectedAt).localeCompare(a.date + a.inspectedAt)).slice(0, 6);
  const appLink = apiUrl() && apiUrl() !== CONFIG.API_URL ? shareLink(apiUrl()) : `${location.origin}${location.pathname}`;

  const classCard = c => {
    const m = sums[c.classCode];
    const label = m.month === thisMonth ? '이번 달' : `${Number(m.month.slice(5))}월`;
    return `
      <article class="card class-card">
        <div class="class-top">
          <div>
            <h3>${esc(c.className)}</h3>
            <p class="muted small">${c.rolesChangedAt ? `최근 역할 배정 ${fmtTime(c.rolesChangedAt)}` : '아직 역할을 배정하지 않았어요'}
              ${m.lastDate ? ` · 최근 평가 ${esc(m.lastDate.slice(5).replace('-', '/'))}` : ''}</p>
          </div>
          <div class="class-code">
            ${c.pending ? '<span class="status wait">전송 대기</span>' : ''}
            <span class="code-chip" title="학생 입장용 학급 코드">학급 코드 <b>${esc(c.classCode)}</b></span>
          </div>
        </div>
        <div class="tiles">
          <div class="tile"><span>학생</span><b>${c.students.length}<small>명</small></b></div>
          <div class="tile"><span>역할 · 검사 담당</span><b>${c.tasks.length}<small>개</small> · ${c.inspectors.length}<small>명</small></b></div>
          <div class="tile"><span>${label} 평가</span><b>${m.count}<small>건</small></b></div>
          <div class="tile"><span>${label} 평균 점수</span><b>${m.avg == null ? '–' : m.avg.toFixed(2)}<small>/ ${MAX_SCORE}</small></b></div>
        </div>
        <div class="mini-winners">
          <span class="muted small">${label} 우수 학생</span>
          ${m.winners.length ? m.winners.map(w => `<span class="chip">${medal(w.rank)} ${esc(w.no)}번 ${esc(w.name)} <small>${w.avg.toFixed(2)}</small></span>`).join('')
            : `<span class="muted small">— ${m.count ? `최소 ${c.evalMinChecks}회 평가받은 학생이 아직 없어요` : '아직 평가 기록이 없어요'}</span>`}
        </div>
        <p class="card-links"><button class="link sm" data-act="pins" data-code="${esc(c.classCode)}">🔑 학생 비밀번호 관리</button></p>
        <div class="card-actions four">
          <button class="btn primary" data-act="eval" data-code="${esc(c.classCode)}">🏆 월별 우수 학생</button>
          <button class="btn" data-act="assign" data-code="${esc(c.classCode)}">🎲 역할 배정</button>
          <button class="btn" data-act="records" data-code="${esc(c.classCode)}">📝 평가 기록 · 메모</button>
          <button class="btn ghost" data-act="setup" data-code="${esc(c.classCode)}">⚙️ 학반 설정</button>
        </div>
      </article>`;
  };

  const seq = render(`
    <section class="welcome">
      <div>
        <p class="eyebrow">${esc(today)}</p>
        <h1>${esc(state.teacher.name)} 선생님, 안녕하세요 👋</h1>
        <div class="welcome-stats">
          <span>학급 <b>${classes.length}</b></span>
          <span>학생 <b>${totalStudents}</b>명</span>
          <span>이번 달 평가 <b>${monthCount}</b>건</span>
          <span>${pending ? `전송 대기 <b>${pending}</b>건` : '모두 전송됨'}</span>
        </div>
      </div>
      <button class="btn primary" id="newClass">+ 학반 초기 세팅</button>
    </section>

    <div class="dash">
      <div class="dash-main">
        <h2 class="section-title">내 학급</h2>
        ${classes.length ? classes.map(classCard).join('') : `
          <section class="card onboarding">
            <h3>첫 학급을 만들어 볼까요?</h3>
            <p class="muted">학반 초기 세팅에서 4단계로 학급을 준비합니다. 5분이면 충분해요.</p>
            <ol class="steps">
              <li><b>학생 명단</b><span>번호와 이름을 붙여넣기 (엑셀·나이스 복사 가능)</span></li>
              <li><b>학급 역할</b><span>역할 이름과 인원, 검사 역할 지정</span></li>
              <li><b>학생별 배정</b><span>🎲 랜덤 배정 또는 직접 선택</span></li>
              <li><b>평가 기준</b><span>월별 우수 학생 수와 최소 평가 횟수</span></li>
            </ol>
            <button class="btn primary" id="newClass2">학반 초기 세팅 시작</button>
          </section>`}
        ${classes.length ? `
        <h2 class="section-title">최근 평가 메모</h2>
        <section class="card">
          ${memos.length ? `<ul class="memo-feed">${memos.map(r => `
            <li data-memo="${esc(r.cls.classCode)}">
              <div class="memo-meta">
                <b>${esc(r.studentNo)}번 ${esc(r.studentName)}</b>
                ${scorePill(r.score)}
                <span class="muted small">${esc(r.date.slice(5).replace('-', '/'))} · ${esc(r.taskName)}${classes.length > 1 ? ` · ${esc(r.cls.className)}` : ''} · 평가 ${esc(r.inspectorNo)}번</span>
              </div>
              <p>${esc(r.memo)}</p>
            </li>`).join('')}</ul>
            <p class="muted small">메모 전체는 각 학급의 <b>평가 기록 · 메모</b>에서 볼 수 있어요.</p>`
          : '<p class="muted">아직 메모가 없습니다. 검사 담당 학생이 평가할 때 남긴 메모가 여기에 모입니다.</p>'}
        </section>` : ''}
      </div>

      <aside class="dash-side">
        <section class="card">
          <h3>학생 입장 안내</h3>
          <p class="muted small">학생에게 아래 앱 주소와 학급 코드를 알려주세요. 처음 한 번만 인터넷이 필요합니다.</p>
          <div class="share-row"><input id="appLink" readonly value="${esc(appLink)}"><button class="btn sm" id="copyLink">복사</button></div>
          ${classes.length ? `<ul class="list compact">${classes.map(c => `<li><span>${esc(c.className)}</span><b class="mono">${esc(c.classCode)}</b></li>`).join('')}</ul>` : ''}
        </section>

        <section class="card">
          <h3>이렇게 사용해요</h3>
          <ol class="steps compact">
            <li><b>학반 초기 세팅</b><span>명단 → 역할 → 배정 → 평가 기준</span></li>
            <li><b>학생 입장</b><span>앱 주소 + 학급 코드 안내</span></li>
            <li><b>매일 평가</b><span>검사 담당 학생이 친구들을 5단계로 평가 (와이파이 없어도 OK)</span></li>
            <li><b>월말 정리</b><span>🏆 월별 우수 학생 확인 → 🎲 다음 달 역할 랜덤 배정</span></li>
          </ol>
        </section>

        <section class="card">
          <h3>서버 · 앱 정보</h3>
          <ul class="list compact">
            <li><span>서버</span><b id="serverState" class="muted">확인 중…</b></li>
            <li><span>앱 버전</span><b>${esc(APP_VERSION)}</b></li>
          </ul>
          <div class="actions left">
            <button class="btn sm ghost" id="goServer">⚙️ 서버 연결</button>
            <button class="btn sm ghost" id="forceUpdate">최신 버전으로 업데이트</button>
          </div>
        </section>
      </aside>
    </div>`);
  $app.classList.add('wide');

  document.getElementById('newClass').onclick = () => viewSetup(null);
  const n2 = document.getElementById('newClass2');
  if (n2) n2.onclick = () => viewSetup(null);
  document.getElementById('goServer').onclick = () => viewServer();
  document.getElementById('forceUpdate').onclick = forceUpdate;
  document.getElementById('copyLink').onclick = async () => {
    try { await navigator.clipboard.writeText(document.getElementById('appLink').value); toast('앱 주소를 복사했습니다.', 'ok'); }
    catch (e) { toast('복사하지 못했습니다. 직접 선택해 복사해 주세요.', 'warn'); }
  };
  $app.querySelectorAll('[data-act]').forEach(b => b.onclick = () => {
    const c = classes.find(x => x.classCode === b.dataset.code);
    ({ eval: () => viewRecords(c, 'eval'), records: () => viewRecords(c, 'list'),
       assign: () => viewSetup(c, 3), setup: () => viewSetup(c, 1), pins: () => viewPins(c) })[b.dataset.act]();
  });
  $app.querySelectorAll('[data-memo]').forEach(li => li.onclick = () =>
    viewRecords(classes.find(x => x.classCode === li.dataset.memo), 'list'));

  api('ping').then(r => ((r.version || 0) >= CONFIG.SERVER_VERSION ? '✅ 연결됨' : '⚠️ 서버 코드 업데이트 필요'),
    e => (isNetErr(e) && !navigator.onLine ? '오프라인' : '❌ 연결 안 됨'))
    .then(t => { const el = document.getElementById('serverState'); if (el && seq === viewSeq) el.textContent = t; });

  if (!refresh) return;
  try {
    const r = await api('listClasses', { token: state.teacher.token });
    const before = JSON.stringify((await DB.get('classes:' + state.teacher.email)) || []);
    await DB.set('classes:' + state.teacher.email, r.classes);
    let changed = before !== JSON.stringify(r.classes);
    // 학급별 평가 기록을 받아 요약을 최신으로
    for (const c of r.classes) {
      const got = await api('getRecords', { token: state.teacher.token, classCode: c.classCode });
      const old = ((await DB.get('records:' + c.classCode)) || {}).records || [];
      await DB.set('records:' + c.classCode, { records: got.records, fetchedAt: Date.now() });
      if (got.records.length !== old.length) changed = true;
    }
    if (seq === viewSeq && changed) viewTeacherHome(false);
  } catch (e) {
    if (e.code === 'AUTH') Sync.onAuthNeeded();
  }
}

// ---------- 교사: 학반 세팅 (① 명단 ② 역할 ③ 배정 ④ 평가 기준) ----------

const STEPS = ['학생 명단', '학급 역할', '학생별 배정', '평가 기준'];

function viewSetup(orig, startStep = 1) {
  const isNew = !orig;
  const cls = orig ? normClass(clone(orig)) : normClass({ classCode: genCode(), className: '', tasks: [] });
  delete cls.pending;
  const thisMonth = localDate().slice(0, 7);
  let step = startStep;
  let month = thisMonth;
  const savedAssign = assignOf(cls);
  let assign = { ...savedAssign };
  let repeats = []; // 랜덤 배정에서 이전 역할을 피하지 못한 학생

  render(`
    <section class="page-head">
      <div><p class="eyebrow">${isNew ? '새 학급' : esc(cls.className)}</p><h1>${isNew ? '학반 초기 세팅' : '학반 설정'}</h1></div>
      <button class="btn ghost" id="back">← 학급 목록</button>
    </section>
    <nav class="stepper" id="stepper"></nav>
    <section class="card" id="stepCard">
      <div id="stepBody"></div>
      <p class="form-error" hidden></p>
      <div class="step-nav">
        <button class="btn ghost" id="prev">← 이전</button>
        <span class="grow"></span>
        <button class="btn ghost" id="saveNow">저장</button>
        <button class="btn primary" id="next">다음 →</button>
      </div>
    </section>`);

  const $card = document.getElementById('stepCard');
  const $body = document.getElementById('stepBody');
  document.getElementById('back').onclick = viewTeacherHome;

  function draw() {
    formError($card);
    document.getElementById('stepper').innerHTML = STEPS.map((name, i) => `
      <button class="${i + 1 === step ? 'on' : ''} ${i + 1 < step ? 'done' : ''}" data-step="${i + 1}">
        <span>${i + 1}</span>${esc(name)}</button>`).join('');
    document.querySelectorAll('[data-step]').forEach(b => b.onclick = () => go(Number(b.dataset.step)));
    document.getElementById('prev').style.visibility = step > 1 ? 'visible' : 'hidden';
    document.getElementById('next').textContent = step < 4 ? '다음 →' : '저장';
    document.getElementById('saveNow').hidden = step === 4 || isNew;
    [null, drawRoster, drawRoles, drawAssign, drawEval][step]();
  }

  // 현재 단계의 입력을 cls 에 반영. 문제가 있으면 오류 문구를 돌려줌
  function collect() {
    if (step === 1) {
      const className = $body.querySelector('[name=className]').value.trim();
      const { students, bad } = parseRoster($body.querySelector('[name=roster]').value);
      if (!className) return '학급 이름을 입력해 주세요.';
      if (bad.length) return `명단에서 번호를 읽을 수 없는 줄이 있습니다: "${bad[0]}"`;
      if (!students.length) return '학생 명단을 입력해 주세요.';
      const dup = students.find((s, i) => students.findIndex(x => x.no === s.no) !== i);
      if (dup) return `명단에 ${dup.no}번이 두 번 있습니다.`;
      cls.className = className;
      cls.students = students.sort((a, b) => byNo(a.no, b.no));
      const nos = new Set(cls.students.map(s => s.no));
      Object.keys(assign).forEach(no => { if (!nos.has(no)) delete assign[no]; });
    }
    if (step === 2) {
      readRoles();
      cls.tasks = cls.tasks.filter(t => t.name.trim());
      if (!cls.tasks.length) return '역할을 하나 이상 입력해 주세요.';
      if (!cls.tasks.some(t => t.inspector)) return '검사 역할을 하나 이상 지정해 주세요. (평가를 입력할 학생)';
      const ids = new Set(cls.tasks.map(t => t.id));
      Object.keys(assign).forEach(no => { if (!ids.has(assign[no])) delete assign[no]; });
    }
    if (step === 4) {
      cls.evalTopN = Math.max(1, Number($body.querySelector('[name=evalTopN]').value) || 3);
      cls.evalMinChecks = Math.max(0, Number($body.querySelector('[name=evalMinChecks]').value) || 0);
      cls.showMemos = $body.querySelector('[name=showMemos]').checked;
    }
    return '';
  }

  function go(n) {
    if (n === step) return;
    const err = collect();
    if (err) return formError($card, err);
    if (n > 1 && !cls.students.length) { step = 1; draw(); return formError($card, '먼저 학생 명단을 입력해 주세요.'); }
    if (n > 2 && !cls.tasks.length) { step = 2; draw(); return formError($card, '먼저 역할을 입력해 주세요.'); }
    step = n;
    draw();
    window.scrollTo(0, 0);
  }

  document.getElementById('prev').onclick = () => go(step - 1);
  document.getElementById('next').onclick = () => (step < 4 ? go(step + 1) : save());
  document.getElementById('saveNow').onclick = save;

  async function save() {
    const err = collect();
    if (err) return formError($card, err);
    if (!cls.students.length || !cls.tasks.length) return formError($card, '학생 명단과 역할을 먼저 입력해 주세요.');
    const sameMap = (a, b) => Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => a[k] === b[k]);
    const changed = !sameMap(savedAssign, assign) || !cls.roleMonths[month];
    applyAssign(cls, assign);
    if (!cls.inspectors.length && !confirm('검사 역할에 배정된 학생이 없으면 아무도 평가를 입력할 수 없어요. 그래도 저장할까요?')) return;
    if (changed && Object.keys(assign).length) {
      cls.roleMonths[month] = { ...assign };
      cls.rolesMonth = month;
      cls.rolesChangedAt = new Date().toISOString();
    }
    await saveClassLocal(cls, `${isNew ? '학반 세팅' : '학반 설정'}: ${cls.className}`);
    toast(isNew ? `학급을 만들었습니다. 학생들에게 학급 코드 ${cls.classCode}를 알려주세요.`
      : navigator.onLine ? '저장했습니다. 학생 기기에는 다음 접속 때 반영됩니다.' : '저장했습니다. 와이파이 연결 시 서버에 반영됩니다.', 'ok');
    viewTeacherHome();
  }

  // ① 학생 명단
  function drawRoster() {
    $body.innerHTML = `
      <label>학급 이름<input name="className" required placeholder="예: 3학년 2반" value="${esc(cls.className)}"></label>
      <div class="code-box"><span>학생 입장용 학급 코드</span><b>${esc(cls.classCode)}</b></div>
      <label>학생 명단
        <textarea name="roster" rows="12" placeholder="한 줄에 한 명씩: 번호 이름&#10;1 김하늘&#10;2 이바다&#10;3 박구름">${esc(cls.students.map(s => `${s.no} ${s.name}`).join('\n'))}</textarea>
        <span class="hint">엑셀·나이스에서 번호·이름 두 열을 복사해 붙여넣어도 됩니다. 명단에 있는 학생만 입장할 수 있어요.</span>
      </label>
      <p class="muted small" id="rosterCount"></p>
      ${isNew ? '<p class="hint">🔑 학생 개인 비밀번호는 처음에 모두 <b>1234</b>이고, 학생이 처음 입장할 때 자기 비밀번호로 바꿉니다.</p>' : `<div class="pin-reset">
        <span><b>🔑 학생 비밀번호 관리</b><br><span class="muted small">학생별 비밀번호 확인, 1234로 초기화</span></span>
        <button type="button" class="btn sm" id="pinManage">열기</button>
      </div>`}`;
    const pm = $body.querySelector('#pinManage');
    if (pm) pm.onclick = () => viewPins(cls);
    const ta = $body.querySelector('[name=roster]');
    const count = () => {
      const { students, bad } = parseRoster(ta.value);
      $body.querySelector('#rosterCount').textContent = `${students.length}명${bad.length ? ` · 읽을 수 없는 줄 ${bad.length}개` : ''}`;
    };
    ta.oninput = count;
    count();
  }

  // ② 학급 역할
  function readRoles() {
    $body.querySelectorAll('#roleDefs .role-def').forEach((row, i) => {
      const t = cls.tasks[i];
      t.name = row.querySelector('[data-k=name]').value;
      t.count = Math.max(0, Number(row.querySelector('[data-k=count]').value) || 0);
      t.inspector = row.querySelector('[data-k=inspector]').checked;
    });
  }
  function drawRoles() {
    const total = cls.tasks.reduce((a, t) => a + (Number(t.count) || 0), 0);
    $body.innerHTML = `
      <p class="hint">역할마다 맡을 인원을 정하세요. 한 역할을 여러 명이 맡을 수 있습니다.
        <b>검사</b>에 체크한 역할의 학생이 친구들을 평가합니다.</p>
      <div class="role-def head"><span>역할</span><span>인원</span><span>검사</span><span></span></div>
      <div id="roleDefs">${cls.tasks.map((t, i) => `
        <div class="role-def">
          <input data-k="name" placeholder="역할 이름 (예: 칠판 정리)" value="${esc(t.name)}">
          <input data-k="count" type="number" min="0" max="100" value="${esc(t.count)}">
          <label class="check"><input type="checkbox" data-k="inspector" ${t.inspector ? 'checked' : ''}><span class="sr">검사 역할</span></label>
          <span class="row-btns">
            <button type="button" class="icon-btn" data-up="${i}" title="위로" ${i ? '' : 'disabled'}>↑</button>
            <button type="button" class="icon-btn" data-rm="${i}" title="삭제">✕</button>
          </span>
        </div>`).join('')}</div>
      <div class="toolbar">
        <button type="button" class="btn ghost" id="addRole">+ 역할 추가</button>
        ${cls.tasks.length ? '' : '<button type="button" class="btn ghost" id="sample">예시 역할 불러오기</button>'}
      </div>
      <p class="summary-line ${total !== cls.students.length ? 'warn-text' : ''}" id="roleTotal">
        역할 인원 합계 <b>${total}</b>명 / 학생 <b>${cls.students.length}</b>명
        ${total < cls.students.length ? `· ${cls.students.length - total}명은 역할이 없게 됩니다` : total > cls.students.length ? `· ${total - cls.students.length}자리가 비게 됩니다` : '· 딱 맞아요 👍'}
      </p>`;
    $body.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { readRoles(); cls.tasks.splice(Number(b.dataset.rm), 1); drawRoles(); });
    $body.querySelectorAll('[data-up]').forEach(b => b.onclick = () => {
      readRoles();
      const i = Number(b.dataset.up);
      [cls.tasks[i - 1], cls.tasks[i]] = [cls.tasks[i], cls.tasks[i - 1]];
      drawRoles();
    });
    $body.querySelectorAll('[data-k=count], [data-k=inspector]').forEach(el => { el.onchange = () => { readRoles(); drawRoles(); }; });
    $body.querySelector('#addRole').onclick = () => {
      readRoles();
      cls.tasks.push({ id: uid(), name: '', count: 1, inspector: false, assigneeNos: [] });
      drawRoles();
      $body.querySelector('#roleDefs .role-def:last-child [data-k=name]').focus();
    };
    const sample = $body.querySelector('#sample');
    if (sample) sample.onclick = () => {
      cls.tasks = CONFIG.SAMPLE_ROLES.map(r => ({ id: uid(), name: r.name, count: r.count, inspector: !!r.inspector, assigneeNos: [] }));
      drawRoles();
    };
  }

  // ③ 학생별 배정
  function drawAssign() {
    const prev = previousAssign(cls, month);
    const prevMap = prev ? prev.map : {};
    const taskName = id => (cls.tasks.find(t => t.id === id) || {}).name || '';
    const used = id => Object.values(assign).filter(v => v === id).length;
    const months = [...new Set([addMonth(thisMonth, -1), thisMonth, addMonth(thisMonth, 1), ...Object.keys(cls.roleMonths)])].sort();

    $body.innerHTML = `
      <div class="assign-top">
        <label class="inline">배정 월 <select id="month">${months.map(m => `<option value="${m}" ${m === month ? 'selected' : ''}>${monthLabel(m)}</option>`).join('')}</select></label>
        <span class="muted small">${prev ? `비교 대상: ${monthLabel(prev.month)} 배정` : '이전 배정 기록 없음'}</span>
      </div>
      <div class="toolbar">
        <button type="button" class="btn primary" id="random">🎲 랜덤 배정</button>
        <button type="button" class="btn" id="rotate">한 칸씩 돌리기 ↓</button>
        <span class="grow"></span>
        <button type="button" class="btn ghost sm" id="clear">모두 비우기</button>
        <button type="button" class="btn ghost sm" id="reset">되돌리기</button>
      </div>
      <p class="hint">랜덤 배정은 ${prev ? `${monthLabel(prev.month)}에 맡았던 역할과 겹치지 않게` : '무작위로'} 역할 인원에 맞춰 배정합니다. 배정 후 직접 고칠 수 있어요.</p>
      <div class="capacity">${cls.tasks.map(t => {
        const n = used(t.id);
        return `<span class="cap ${n > t.count ? 'over' : n < t.count ? 'under' : 'full'}">${esc(t.name)} <b>${n}/${t.count}</b></span>`;
      }).join('')}</div>
      <div class="assign-row head"><span>학생</span><span>이번 역할</span><span>지난 역할</span></div>
      ${cls.students.map(s => {
        const cur = assign[s.no] || '';
        const same = cur && prevMap[s.no] === cur;
        const changed = cur !== (savedAssign[s.no] || '');
        return `<div class="assign-row ${changed ? 'changed' : ''}">
          <span class="who"><b>${esc(s.no)}</b> ${esc(s.name)}</span>
          <select data-no="${esc(s.no)}">
            <option value="">— 없음 —</option>
            ${cls.tasks.map(t => `<option value="${esc(t.id)}" ${cur === t.id ? 'selected' : ''}>${esc(t.name)}${t.inspector ? ' (검사)' : ''} · ${used(t.id)}/${t.count}</option>`).join('')}
          </select>
          <span class="prev ${same ? 'dup' : ''}">${esc(taskName(prevMap[s.no])) || '—'}${same ? ' ⚠ 중복' : ''}</span>
        </div>`;
      }).join('')}
      <p class="summary-line" id="assignSummary">
        배정 ${Object.keys(assign).length}/${cls.students.length}명 ·
        지난 역할과 중복 ${cls.students.filter(s => assign[s.no] && prevMap[s.no] === assign[s.no]).length}명
      </p>`;

    $body.querySelector('#month').onchange = e => { month = e.target.value; drawAssign(); };
    $body.querySelectorAll('select[data-no]').forEach(sel => sel.onchange = () => {
      if (sel.value) assign[sel.dataset.no] = sel.value; else delete assign[sel.dataset.no];
      drawAssign();
    });
    $body.querySelector('#random').onclick = () => {
      const r = randomAssign(cls, prevMap);
      assign = r.map;
      repeats = r.repeats;
      drawAssign();
      toast(repeats.length
        ? `${repeats.length}명은 인원 제약 때문에 지난 역할과 같아졌습니다. (⚠ 표시)`
        : prev ? '지난 역할과 겹치지 않게 랜덤 배정했습니다. 확인 후 저장하세요.' : '랜덤 배정했습니다. 확인 후 저장하세요.', repeats.length ? 'warn' : '');
    };
    $body.querySelector('#rotate').onclick = () => {
      const order = cls.students.map(s => s.no);
      const next = {};
      order.forEach((no, i) => {
        const from = order[(i - 1 + order.length) % order.length];
        if (assign[from]) next[no] = assign[from];
      });
      assign = next;
      drawAssign();
      toast('한 칸씩 돌렸습니다. (각 학생의 역할이 다음 번호 학생에게)');
    };
    $body.querySelector('#clear').onclick = () => { assign = {}; drawAssign(); };
    $body.querySelector('#reset').onclick = () => { assign = { ...savedAssign }; drawAssign(); };
  }

  // ④ 평가 기준
  function drawEval() {
    $body.innerHTML = `
      <h3>월별 우수 학생 기준</h3>
      <p class="hint">점수는 한 달 동안 받은 개인 평가(${SCALE.map(s => `${s.value} ${esc(s.label)}`).join(', ')})의 평균입니다.</p>
      <div class="row2 even">
        <label>우수 학생 수<input name="evalTopN" type="number" min="1" max="30" value="${cls.evalTopN}">
          <span class="hint">매달 상위 몇 명 (동점자는 모두 포함)</span></label>
        <label>최소 평가 횟수<input name="evalMinChecks" type="number" min="0" max="100" value="${cls.evalMinChecks}">
          <span class="hint">한 달에 이 횟수 이상 평가받은 학생만 선정</span></label>
      </div>
      <h3>학생 화면 공개</h3>
      <p class="hint">학생은 자기 화면의 <b>나의 평가</b>에서 날짜별 점수와 월 평균, 우수 학생 선정 여부를 볼 수 있습니다. 평가한 친구는 공개되지 않습니다.</p>
      <label class="check"><input type="checkbox" name="showMemos" ${cls.showMemos ? 'checked' : ''}> 친구들이 남긴 메모도 학생에게 보여주기</label>
      <h3>세팅 요약</h3>
      <ul class="list">
        <li><b>학급</b><span>${esc(cls.className)} · 코드 <b>${esc(cls.classCode)}</b></span></li>
        <li><b>학생</b><span>${cls.students.length}명</span></li>
        <li><b>역할</b><span>${cls.tasks.length}개 (검사 역할 ${cls.tasks.filter(t => t.inspector).length}개)</span></li>
        <li><b>배정</b><span>${Object.keys(assign).length}명 · ${monthLabel(month)}</span></li>
      </ul>`;
  }

  draw();
}

// ---------- 교사: 기록 (월별 우수 학생 / 평가 기록) ----------

// 한 달 동안 학생별 평균 점수와 순위
function monthlyRanking(records, cls, month) {
  const map = new Map();
  records.filter(r => r.date.startsWith(month)).forEach(r => {
    const v = Number(r.score);
    if (!v) return;
    const m = map.get(r.studentNo) || { no: r.studentNo, fallbackName: r.studentName, cnt: {}, total: 0, sum: 0, memos: 0 };
    m.cnt[v] = (m.cnt[v] || 0) + 1;
    m.total++;
    m.sum += v;
    if (r.memo) m.memos++;
    map.set(r.studentNo, m);
  });
  const top = m => m.cnt[MAX_SCORE] || 0;
  const rows = [...map.values()].map(m => ({
    ...m, name: studentName(cls, m.no) || m.fallbackName, avg: m.sum / m.total, eligible: m.total >= cls.evalMinChecks,
  }));
  rows.sort((a, b) => (b.eligible - a.eligible) || (b.avg - a.avg) || (top(b) - top(a)) ||
    (b.total - a.total) || byNo(a.no, b.no));
  // 평균과 최고점 횟수가 같으면 같은 순위
  rows.forEach((m, i) => {
    const p = rows[i - 1];
    if (!m.eligible) { m.rank = null; return; }
    m.rank = p && p.eligible && Math.abs(p.avg - m.avg) < 1e-9 && top(p) === top(m) ? p.rank : i + 1;
  });
  rows.forEach(m => { m.excellent = m.eligible && m.rank <= cls.evalTopN; });
  return rows;
}

function stackBar(cnt, total) {
  return `<div class="bar">${SCALE.map(s => cnt[s.value]
    ? `<span class="s${s.value}" style="width:${(cnt[s.value] / total) * 100}%" title="${s.value}점 ${cnt[s.value]}회"></span>` : '').join('')}</div>`;
}

const scaleLegend = () => `<div class="legend">${SCALE.map(s => `<span><i class="s${s.value}"></i>${s.value} ${esc(s.label)}</span>`).join('')}</div>`;

function showStudentDetail(cls, records, no, month) {
  const rows = records.filter(r => r.studentNo === no && (!month || r.date.startsWith(month)))
    .sort((a, b) => (a.date + a.inspectedAt).localeCompare(b.date + b.inspectedAt));
  const avg = rows.reduce((a, r) => a + Number(r.score), 0) / (rows.length || 1);
  openDialog(`
    <h3>${esc(studentLabel(cls, no))} <span class="muted small">${month ? monthLabel(month) : ''}</span></h3>
    <p class="muted small">평가 ${rows.length}회 · 평균 ${avg.toFixed(2)}점 · 메모 ${rows.filter(r => r.memo).length}개</p>
    <div class="table-wrap"><table>
      <thead><tr><th>날짜</th><th>역할</th><th>점수</th><th>메모</th><th>평가자</th></tr></thead>
      <tbody>${rows.map(r => `<tr><td class="nowrap">${esc(r.date.slice(5))}</td><td>${esc(r.taskName)}</td>
        <td class="nowrap">${scorePill(r.score)}</td><td>${esc(r.memo)}</td>
        <td class="nowrap">${esc(r.inspectorNo)}번 ${esc(r.inspectorName)}</td></tr>`).join('')}</tbody>
    </table></div>
    <div class="actions left"><button class="btn sm ghost" id="pinResetDlg">🔑 이 학생 비밀번호를 1234로 초기화</button></div>`);
  $dialog.querySelector('#pinResetDlg').onclick = () => resetStudentPin(cls, no);
}

async function resetStudentPin(cls, no, after) {
  const who = no ? `${studentLabel(cls, no)} 학생의` : '학급 학생 전체의';
  if (!confirm(`${who} 비밀번호를 1234로 초기화할까요?\n학생은 다음에 1234로 입장한 뒤 새 비밀번호를 정합니다.`)) return;
  try {
    const r = await api('resetStudentPin', { token: state.teacher.token, classCode: cls.classCode, ...(no ? { studentNo: no } : { all: true }) });
    toast(`${no ? studentLabel(cls, no) + ' 학생' : `${r.reset}명`}의 비밀번호를 ${r.defaultPin}(으)로 초기화했습니다.`, 'ok');
    if (after) after();
  } catch (e) {
    if (e.code === 'AUTH') Sync.onAuthNeeded();
    else toast(isNetErr(e) ? '인터넷에 연결된 상태에서 초기화할 수 있어요.' : e.message, 'warn');
  }
}

// 교사: 학생 비밀번호 확인·초기화
async function viewPins(cls) {
  let show = false;
  let pins = null;
  let error = '';
  const draw = () => {
    openDialog(`
      <h3>🔑 학생 비밀번호 관리 <span class="muted small">${esc(cls.className)}</span></h3>
      <p class="hint">처음이거나 초기화한 학생의 비밀번호는 <b>1234</b>이고, 학생은 입장하자마자 자기 비밀번호로 바꿉니다.
        잊은 학생은 <b>초기화</b>한 뒤 1234로 입장하게 해 주세요.</p>
      ${pins ? `
        <div class="toolbar">
          <label class="check"><input type="checkbox" id="showPins" ${show ? 'checked' : ''}> 비밀번호 보기</label>
          <span class="grow"></span>
          <button class="btn sm ghost" id="resetAll">전체 1234로 초기화</button>
        </div>
        <p class="muted small">학생이 정함 ${pins.filter(p => p.status !== 'default').length}명 · 처음 비밀번호(1234) ${pins.filter(p => p.status === 'default').length}명</p>
        <div class="table-wrap pins-table"><table>
          <thead><tr><th>번호</th><th>이름</th><th>비밀번호</th><th>상태</th><th></th></tr></thead>
          <tbody>${pins.map(p => `<tr>
            <td>${esc(p.no)}</td><td class="nowrap">${esc(p.name)}</td>
            <td class="mono">${p.status === 'hidden' ? '<span class="muted small">다음 입장 후 표시</span>' : show || p.status === 'default' ? esc(p.pin) : '••••'}</td>
            <td class="nowrap">${p.status === 'default' ? '<span class="status wait">처음 비밀번호</span>' : '<span class="status sent">학생이 정함</span>'}${p.locked ? ' <span class="status wait">🔒 잠김</span>' : ''}</td>
            <td><button class="btn sm ghost" data-reset="${esc(p.no)}">초기화</button></td></tr>`).join('')}</tbody>
        </table></div>`
      : error ? `<p class="notice warn">${esc(error)}</p>` : '<p class="muted">불러오는 중…</p>'}`);
    const sp = $dialog.querySelector('#showPins');
    if (sp) sp.onchange = () => { show = sp.checked; draw(); };
    const ra = $dialog.querySelector('#resetAll');
    if (ra) ra.onclick = () => resetStudentPin(cls, null, load);
    $dialog.querySelectorAll('[data-reset]').forEach(b => b.onclick = () => resetStudentPin(cls, b.dataset.reset, load));
  };
  const load = async () => {
    try {
      pins = (await api('listStudentPins', { token: state.teacher.token, classCode: cls.classCode })).pins;
      error = '';
    } catch (e) {
      if (e.code === 'AUTH') Sync.onAuthNeeded();
      error = isNetErr(e) ? '인터넷에 연결된 상태에서 볼 수 있어요.' : e.message;
    }
    draw();
  };
  draw();
  load();
}

async function viewRecords(cls, tab = 'eval') {
  const today = localDate();
  const seq = render(`
    <section class="page-head">
      <div><p class="eyebrow">${esc(cls.className)} · 학급 코드 ${esc(cls.classCode)}</p>
        <h1>${tab === 'eval' ? '월별 우수 학생' : '평가 기록'}</h1></div>
      <button class="btn ghost" id="back">← 학급 목록</button>
    </section>
    <nav class="tabs">
      <button data-tab="eval" class="${tab === 'eval' ? 'on' : ''}">🏆 월별 우수 학생</button>
      <button data-tab="list" class="${tab === 'list' ? 'on' : ''}">평가 기록 · 메모</button>
    </nav>
    <section class="card filters" id="filters"></section>
    <div id="out"></div>`);

  document.getElementById('back').onclick = viewTeacherHome;
  $app.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => viewRecords(cls, b.dataset.tab));

  let cache = (await DB.get('records:' + cls.classCode)) || { records: [], fetchedAt: null };
  const $f = document.getElementById('filters');
  const info = () => (cache.fetchedAt
    ? `${fmtTime(cache.fetchedAt)}에 받은 기록입니다. 원본은 구글 스프레드시트 'Records' 시트에 누적됩니다.`
    : '아직 서버에서 기록을 받지 않았습니다. 인터넷 연결 후 새로고침을 눌러주세요.');
  const actions = `
    <div class="filter-actions">
      <button class="btn" id="refresh">새로고침</button>
      <button class="btn ghost" id="csv">CSV 저장</button>
    </div>
    <p class="muted small" id="fetchInfo"></p>`;

  if (tab === 'eval') {
    $f.innerHTML = `<label>월<select id="month"></select></label>${actions}`;
  } else {
    $f.innerHTML = `
      <label>시작일<input type="date" id="from" value="${today.slice(0, 8)}01"></label>
      <label>종료일<input type="date" id="to" value="${today}"></label>
      <label>역할<select id="task"><option value="">전체</option>
        ${cls.tasks.filter(t => !t.inspector).map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}</select></label>
      <label>학생<select id="student"><option value="">전체</option>
        ${cls.students.map(s => `<option value="${esc(s.no)}">${esc(s.no)}번 ${esc(s.name)}</option>`).join('')}</select></label>
      <label class="check memo-only"><input type="checkbox" id="memoOnly"> 메모 있는 기록만</label>
      ${actions}`;
  }
  const refreshBtn = document.getElementById('refresh');
  refreshBtn.onclick = () => busy(refreshBtn, fetchRecords);

  function fillMonths() {
    const sel = document.getElementById('month');
    const cur = sel.value;
    const months = [...new Set([today.slice(0, 7), ...cache.records.map(r => r.date.slice(0, 7))])].sort().reverse();
    sel.innerHTML = months.map(m => `<option value="${m}">${monthLabel(m)}</option>`).join('');
    const withData = months.find(m => cache.records.some(r => r.date.startsWith(m)));
    const curHasData = cache.records.some(r => r.date.startsWith(cur));
    sel.value = months.includes(cur) && curHasData ? cur : withData || months[0];
  }

  function draw() {
    document.getElementById('fetchInfo').textContent = info();
    if (tab === 'eval') drawEval(); else drawList();
  }

  // --- 월별 우수 학생
  function drawEval() {
    const month = document.getElementById('month').value;
    const rows = monthlyRanking(cache.records, cls, month);
    const winners = rows.filter(r => r.excellent);
    const medal = r => (r === 1 ? '🥇' : r === 2 ? '🥈' : r === 3 ? '🥉' : `${r}위`);
    const allMonths = [...new Set(cache.records.map(r => r.date.slice(0, 7)))].sort().reverse();
    const monthly = allMonths.map(m => ({ m, w: monthlyRanking(cache.records, cls, m).filter(r => r.excellent) }));
    const tally = new Map();
    monthly.forEach(({ m, w }) => w.forEach(r => {
      const t = tally.get(r.no) || { no: r.no, months: [] };
      t.months.push(m);
      tally.set(r.no, t);
    }));
    const tallyRows = [...tally.values()].sort((a, b) => b.months.length - a.months.length || byNo(a.no, b.no));
    const unrated = cls.students.filter(s => !rows.some(r => r.no === s.no));

    document.getElementById('out').innerHTML = `
      <section class="card">
        <h3>${monthLabel(month)} 우수 학생</h3>
        <p class="hint">점수 = 한 달 동안 받은 개인 평가(${MAX_SCORE}점 만점)의 평균.
          ${cls.evalMinChecks}회 이상 평가받은 학생 중 상위 ${cls.evalTopN}명 (동점자 포함). 기준은 학반 설정 ④에서 바꿀 수 있어요.</p>
        ${winners.length ? `<div class="winners">${winners.map(r => `
          <button class="winner" data-no="${esc(r.no)}">
            <span class="medal">${medal(r.rank)}</span>
            <b>${esc(r.no)}번 ${esc(r.name)}</b>
            <span class="score">${r.avg.toFixed(2)}<small>/ ${MAX_SCORE}</small></span>
            <span class="muted small">평가 ${r.total}회 · ${MAX_SCORE}점 ${r.cnt[MAX_SCORE] || 0}회${r.memos ? ` · 메모 ${r.memos}` : ''}</span>
          </button>`).join('')}</div>`
        : '<p class="empty-inline">이 달에는 기준을 충족한 학생이 아직 없습니다.</p>'}
      </section>

      <section class="card">
        <h3>${monthLabel(month)} 전체 순위 <span class="muted small">학생을 누르면 평가·메모를 볼 수 있어요</span></h3>
        ${rows.length ? `${scaleLegend()}
        <div class="table-wrap"><table class="summary">
          <thead><tr><th>순위</th><th>학생</th><th class="num">평가</th><th class="num">평균</th><th class="bar-col">점수 분포</th><th class="num">메모</th></tr></thead>
          <tbody>${rows.map(r => `<tr class="click ${r.excellent ? 'hl' : ''} ${r.eligible ? '' : 'dim'}" data-no="${esc(r.no)}">
            <td class="nowrap">${r.eligible ? (r.excellent ? medal(r.rank) : r.rank + '위') : '<span class="small">횟수 부족</span>'}</td>
            <td class="nowrap">${esc(r.no)}번 ${esc(r.name)}</td>
            <td class="num">${r.total}</td>
            <td class="num"><b>${r.avg.toFixed(2)}</b></td>
            <td class="bar-col">${stackBar(r.cnt, r.total)}</td>
            <td class="num">${r.memos || ''}</td></tr>`).join('')}</tbody>
        </table></div>
        ${unrated.length ? `<p class="muted small">이 달 평가 없음: ${esc(unrated.map(s => s.no + '번').join(', '))} (검사 역할 등)</p>` : ''}`
        : '<p class="muted">이 달의 평가 기록이 없습니다.</p>'}
      </section>

      <section class="card">
        <h3>월별 우수 학생 누적</h3>
        ${monthly.length ? `<div class="table-wrap"><table>
          <thead><tr><th>월</th><th>우수 학생</th></tr></thead>
          <tbody>${monthly.map(({ m, w }) => `<tr><td class="nowrap">${monthLabel(m)}</td>
            <td>${w.length ? w.map(r => `<span class="chip">${medal(r.rank)} ${esc(r.no)}번 ${esc(r.name)}</span>`).join(' ') : '<span class="muted">해당 없음</span>'}</td></tr>`).join('')}</tbody>
        </table></div>
        ${tallyRows.length ? `<h4>우수 학생 선정 횟수</h4>
        <div class="table-wrap"><table>
          <thead><tr><th>학생</th><th class="num">횟수</th><th>선정된 달</th></tr></thead>
          <tbody>${tallyRows.map(t => `<tr><td class="nowrap">${esc(studentLabel(cls, t.no))}</td><td class="num"><b>${t.months.length}</b></td>
            <td class="small">${t.months.map(m => `${Number(m.slice(5))}월`).join(', ')}</td></tr>`).join('')}</tbody>
        </table></div>` : ''}`
        : '<p class="muted">아직 기록이 없습니다.</p>'}
      </section>`;

    $app.querySelectorAll('#out [data-no]').forEach(el => {
      el.onclick = () => showStudentDetail(cls, cache.records, el.dataset.no, month);
    });
    document.getElementById('csv').onclick = () => downloadCsv(
      `${cls.className}_${month}_월별평가.csv`,
      ['순위', '우수', '번호', '이름', '평가 횟수', '평균', ...SCALE.map(s => `${s.value}점`), '메모 수'],
      rows.map(r => [r.eligible ? r.rank : '횟수 부족', r.excellent ? '우수' : '', r.no, r.name, r.total,
        r.avg.toFixed(2), ...SCALE.map(s => r.cnt[s.value] || 0), r.memos]));
  }

  // --- 평가 기록 · 메모
  function drawList() {
    const from = document.getElementById('from').value;
    const to = document.getElementById('to').value;
    const taskId = document.getElementById('task').value;
    const no = document.getElementById('student').value;
    const memoOnly = document.getElementById('memoOnly').checked;
    const rows = cache.records
      .filter(r => (!from || r.date >= from) && (!to || r.date <= to) && (!taskId || r.taskId === taskId) &&
        (!no || r.studentNo === no) && (!memoOnly || r.memo))
      .sort((a, b) => (b.date + b.inspectedAt).localeCompare(a.date + a.inspectedAt));

    const byTask = new Map();
    rows.forEach(r => {
      const m = byTask.get(r.taskName) || { cnt: {}, total: 0, sum: 0 };
      m.cnt[r.score] = (m.cnt[r.score] || 0) + 1;
      m.total++;
      m.sum += Number(r.score);
      byTask.set(r.taskName, m);
    });

    document.getElementById('out').innerHTML = rows.length ? `
      <section class="card">
        <h3>역할별 요약</h3>
        ${scaleLegend()}
        <div class="table-wrap"><table class="summary">
          <thead><tr><th>역할</th><th class="num">평가</th><th class="num">평균</th><th class="bar-col">점수 분포</th></tr></thead>
          <tbody>${[...byTask].map(([name, m]) => `<tr>
            <td>${esc(name)}</td><td class="num">${m.total}</td><td class="num"><b>${(m.sum / m.total).toFixed(2)}</b></td>
            <td class="bar-col">${stackBar(m.cnt, m.total)}</td></tr>`).join('')}</tbody>
        </table></div>
      </section>
      <section class="card">
        <h3>상세 기록 <span class="muted small">${rows.length}건</span></h3>
        <div class="table-wrap"><table>
          <thead><tr><th>날짜</th><th>학생</th><th>역할</th><th>점수</th><th>메모</th><th>평가자</th></tr></thead>
          <tbody>${rows.slice(0, 300).map(r => `<tr>
            <td class="nowrap">${esc(r.date)}</td><td class="nowrap">${esc(r.studentNo)}번 ${esc(r.studentName)}</td>
            <td>${esc(r.taskName)}</td><td class="nowrap">${scorePill(r.score)}</td>
            <td>${esc(r.memo)}</td><td class="nowrap">${esc(r.inspectorNo)}번 ${esc(r.inspectorName)}</td>
          </tr>`).join('')}</tbody>
        </table></div>
        ${rows.length > 300 ? '<p class="muted small">최근 300건만 표시합니다. 전체는 CSV로 저장하세요.</p>' : ''}
      </section>` : '<section class="card empty"><p>조건에 맞는 평가 기록이 없습니다.</p></section>';

    document.getElementById('csv').onclick = () => downloadCsv(
      `${cls.className}_평가기록_${localDate()}.csv`,
      ['날짜', '번호', '이름', '역할', '점수', '척도', '메모', '평가자 번호', '평가자 이름', '평가 시각'],
      rows.map(r => [r.date, r.studentNo, r.studentName, r.taskName, r.score, scaleLabel(r.score), r.memo,
        r.inspectorNo, r.inspectorName, r.inspectedAt]));
  }

  async function fetchRecords() {
    try {
      const r = await api('getRecords', { token: state.teacher.token, classCode: cls.classCode });
      cache = { records: r.records, fetchedAt: Date.now() };
      await DB.set('records:' + cls.classCode, cache);
      if (seq !== viewSeq) return;
      if (tab === 'eval') fillMonths();
      draw();
    } catch (e) {
      if (e.code === 'AUTH') Sync.onAuthNeeded();
      else if (seq === viewSeq) toast(isNetErr(e) ? '오프라인입니다. 저장된 기록을 보여드립니다.' : e.message, 'warn');
    }
  }

  if (tab === 'eval') fillMonths();
  $f.querySelectorAll('select, input').forEach(el => { el.onchange = draw; });
  draw();
  fetchRecords();
}

// ---------- 시작 ----------

async function init() {
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
    // 새 버전이 설치되면 한 번 새로고침해서 바로 적용
    let reloaded = false;
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController && !reloaded) { reloaded = true; location.reload(); }
    });
  }
  window.addEventListener('online', () => { renderSync(); Sync.run(); });
  window.addEventListener('offline', renderSync);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) Sync.run(); });
  setInterval(async () => {
    if (navigator.onLine && (await DB.outboxAll()).length) Sync.run();
  }, 30000);

  await applyServerFromLink();
  state.teacher = (await DB.get('teacherSession')) || null;
  state.student = state.teacher ? null : (await DB.get('studentSession')) || null;
  renderUser();
  renderSync();
  if (state.teacher) viewTeacherHome();
  else if (state.student) viewStudent();
  else viewHome();
  Sync.run();
}

init();
