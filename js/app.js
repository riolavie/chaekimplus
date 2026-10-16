'use strict';

const RESULTS = CONFIG.RESULTS;
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

const fmtTime = ts => new Date(ts).toLocaleString('ko-KR',
  { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

const resultClass = r => ({ [RESULTS[0]]: 'good', [RESULTS[1]]: 'mid', [RESULTS[2]]: 'bad' }[r] || '');

const splitNames = s => String(s || '').split(/[,，、]/).map(x => x.trim()).filter(Boolean);

function toast(msg, type = '') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'show ' + type;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.className = ''; }, 2800);
}

function render(html) {
  viewSeq++;
  $app.innerHTML = html;
  window.scrollTo(0, 0);
  return viewSeq;
}

function formError(form, msg) {
  const el = form.querySelector('.form-error');
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
  $dialog.innerHTML = `
    <h3>전송 실패한 항목</h3>
    <p class="muted small">서버가 거절한 항목입니다. 문제를 해결하면 다음 전송 때 다시 시도하고, 필요 없으면 삭제하세요.</p>
    <ul class="list">${ops.map(o => `
      <li><div><b>${esc(o.label || o.action)}</b><div class="danger small">${esc(o.error)}</div></div>
      <button class="btn sm ghost" data-del="${o.id}">삭제</button></li>`).join('') || '<li>없음</li>'}
    </ul>
    <div class="actions"><button class="btn" id="dlgClose">닫기</button></div>`;
  $dialog.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!confirm('이 항목을 삭제할까요? 삭제하면 서버로 전송되지 않습니다.')) return;
    await DB.outboxDel(Number(b.dataset.del));
    renderSync();
    showFailed();
  });
  $dialog.querySelector('#dlgClose').onclick = () => $dialog.close();
  if (!$dialog.open) $dialog.showModal();
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

// ---------- 첫 화면 ----------

function viewHome() {
  render(`
    <section class="hero">
      <h1>누구로 사용하나요?</h1>
      <p class="muted">인터넷이 없어도 검사할 수 있어요. 와이파이가 연결되면 선생님께 자동으로 전송됩니다.</p>
    </section>
    <div class="role-grid">
      <button class="role" id="goStudent">
        <span class="role-icon">🧹</span><b>학생</b><small>업무 검사하기</small>
      </button>
      <button class="role" id="goTeacher">
        <span class="role-icon">📋</span><b>교사</b><small>학급 설정 · 검사 기록 확인</small>
      </button>
    </div>
    ${CONFIG.API_URL ? '' : `<p class="notice warn">서버 주소가 아직 설정되지 않았습니다. <code>js/config.js</code>의 <code>API_URL</code>을 입력하세요.</p>`}`);
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
      <p class="form-error" hidden></p>
      <button class="btn primary block">입장하기</button>
      <button type="button" class="link" id="back">← 처음으로</button>
    </form>`);
  const f = document.getElementById('f');
  f.querySelector('#back').onclick = viewHome;
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
      let cfg;
      try {
        cfg = (await api('getClassConfig', { classCode: s.classCode })).config;
        await DB.set('config:' + s.classCode, cfg);
      } catch (err) {
        if (!isNetErr(err)) return formError(f, err.message);
        cfg = await DB.get('config:' + s.classCode);
        if (!cfg) return formError(f, '이 기기에서 처음 입장할 때는 인터넷 연결이 필요합니다. (학급 정보를 내려받아야 해요)');
      }
      state.student = s;
      state.teacher = null;
      await DB.del('teacherSession');
      await DB.set('studentSession', s);
      await DB.set('lastStudent', s);
      renderUser();
      viewStudent();
    });
  };
}

const historyKey = (code, number) => `history:${code}:${number}`;

async function viewStudent() {
  const s = state.student;
  const cfg = await DB.get('config:' + s.classCode);
  if (!cfg) return viewStudentLogin();
  const isInspector = cfg.inspectors.map(String).includes(s.number);
  const myTasks = cfg.tasks.filter(t => splitNames(t.assignees).some(n => n === s.name || n === s.number || n === s.number + '번'));

  const seq = render(`
    <section class="page-head">
      <div>
        <p class="eyebrow">${esc(cfg.className)}</p>
        <h1>${isInspector ? '업무 검사' : '나의 업무'}</h1>
      </div>
    </section>
    ${isInspector ? inspectFormHtml(cfg) : `
      <p class="notice">검사는 선생님이 지정한 검사 담당 학생만 할 수 있어요.</p>`}
    <section class="card">
      <h3>내 담당 업무</h3>
      ${myTasks.length ? `<ul class="list">${myTasks.map(t => `<li><b>${esc(t.name)}</b><span class="muted">${esc(t.assignees)}</span></li>`).join('')}</ul>`
        : '<p class="muted">지정된 업무가 없어요.</p>'}
    </section>
    ${isInspector ? '<section class="card"><h3>이 기기의 검사 기록</h3><div id="history"></div></section>' : ''}
    <section class="card">
      <h3>학급 전체 업무</h3>
      <ul class="list">${cfg.tasks.map(t => `<li><b>${esc(t.name)}</b><span class="muted">${esc(t.assignees)}</span></li>`).join('')}</ul>
    </section>`);

  if (isInspector) {
    bindInspectForm(cfg);
    renderHistory();
  }

  // 온라인이면 학급 정보 최신화 (검사 입력 중이 아닐 때만 화면 갱신)
  api('getClassConfig', { classCode: s.classCode }).then(async r => {
    if (JSON.stringify(r.config) === JSON.stringify(cfg)) return;
    await DB.set('config:' + s.classCode, r.config);
    if (seq === viewSeq && !document.querySelector('.seg button.on')) {
      toast('학급 정보가 업데이트되었습니다.');
      viewStudent();
    }
  }).catch(() => {});
}

function inspectFormHtml(cfg) {
  return `
    <form class="card" id="inspect">
      <div class="inspect-head">
        <label class="inline">검사 날짜 <input type="date" name="date" value="${localDate()}" required></label>
        <button type="button" class="btn sm ghost" id="allGood">모두 ${esc(RESULTS[0])}</button>
      </div>
      ${cfg.tasks.map(t => `
        <div class="task" data-id="${esc(t.id)}">
          <div class="task-head">
            <b>${esc(t.name)}</b>
            ${t.assignees ? `<span class="muted small">담당: ${esc(t.assignees)}</span>` : ''}
          </div>
          <div class="seg">${RESULTS.map(r => `<button type="button" class="${resultClass(r)}" data-r="${esc(r)}">${esc(r)}</button>`).join('')}</div>
          <input class="memo" placeholder="메모 (선택)" maxlength="200">
        </div>`).join('') || '<p class="muted">선생님이 아직 업무를 등록하지 않았어요.</p>'}
      <button class="btn primary block" ${cfg.tasks.length ? '' : 'disabled'}>검사 결과 저장</button>
      <p class="muted small center">저장하면 이 기기에 보관되고, 인터넷이 연결되면 자동으로 전송됩니다.</p>
    </form>`;
}

function bindInspectForm(cfg) {
  const f = document.getElementById('inspect');
  f.querySelectorAll('.seg').forEach(seg => {
    seg.onclick = e => {
      const b = e.target.closest('button');
      if (!b) return;
      const on = b.classList.contains('on');
      seg.querySelectorAll('button').forEach(x => x.classList.remove('on'));
      if (!on) b.classList.add('on');
    };
  });
  f.querySelector('#allGood').onclick = () => {
    f.querySelectorAll('.seg').forEach(seg => {
      if (seg.querySelector('.on')) return;
      seg.querySelector(`[data-r="${RESULTS[0]}"]`).classList.add('on');
    });
  };
  f.onsubmit = async e => {
    e.preventDefault();
    const s = state.student;
    const date = f.date.value;
    const now = new Date().toISOString();
    const records = [];
    f.querySelectorAll('.task').forEach(el => {
      const on = el.querySelector('.seg .on');
      if (!on) return;
      const t = cfg.tasks.find(x => x.id === el.dataset.id);
      records.push({
        recordId: uid(), date, taskId: t.id, taskName: t.name, assignees: t.assignees,
        result: on.dataset.r, memo: el.querySelector('.memo').value.trim(), inspectedAt: now,
      });
    });
    if (!records.length) return toast('검사 결과를 하나 이상 선택해 주세요.', 'warn');
    const missing = cfg.tasks.length - records.length;
    if (missing && !confirm(`${missing}개 업무는 결과가 선택되지 않았어요. 선택한 ${records.length}개만 저장할까요?`)) return;

    const batchId = uid();
    const key = historyKey(s.classCode, s.number);
    const hist = (await DB.get(key)) || [];
    hist.unshift({ batchId, date, savedAt: Date.now(), sent: false, records });
    await DB.set(key, hist.slice(0, 50));
    await Sync.enqueue('submitRecords', {
      classCode: s.classCode,
      student: { classNo: s.classNo, number: s.number, name: s.name },
      batchId, records,
    }, { label: `${s.number}번 ${s.name} · ${date} 검사 ${records.length}건` });

    toast(navigator.onLine ? '저장했습니다. 전송 중…' : '저장했습니다. 와이파이 연결 시 자동 전송됩니다.', 'ok');
    f.querySelectorAll('.seg .on').forEach(b => b.classList.remove('on'));
    f.querySelectorAll('.memo').forEach(m => { m.value = ''; });
    renderHistory();
  };
}

async function renderHistory() {
  const el = document.getElementById('history');
  if (!el || !state.student) return;
  const hist = (await DB.get(historyKey(state.student.classCode, state.student.number))) || [];
  el.innerHTML = hist.length ? `<ul class="list">${hist.slice(0, 10).map(h => {
    const counts = RESULTS.map(r => [r, h.records.filter(x => x.result === r).length]).filter(x => x[1]);
    return `<li>
      <div><b>${esc(h.date)}</b> <span class="muted small">${fmtTime(h.savedAt)} 저장</span>
        <div class="small">${counts.map(([r, n]) => `<span class="pill ${resultClass(r)}">${esc(r)} ${n}</span>`).join(' ')}</div>
      </div>
      <span class="status ${h.sent ? 'sent' : 'wait'}">${h.sent ? '전송 완료' : '전송 대기'}</span>
    </li>`;
  }).join('')}</ul>` : '<p class="muted">아직 검사 기록이 없어요.</p>';
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
      ${signup ? '' : '<p class="muted small">이 기기에서 한 번 로그인한 계정은 인터넷이 없어도 로그인할 수 있어요.</p>'}
    </form>`);
  const f = document.getElementById('f');
  f.querySelector('#back').onclick = viewHome;
  f.querySelector('#toggle').onclick = () => viewTeacherLogin(!signup);
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
      const salt = uid();
      await DB.set('teacherAuth:' + email, { email, name: r.name, token: r.token, salt, verifier: await pbkdf2(password, salt) });
      await DB.set('classes:' + email, r.classes);
      await startTeacher({ email, name: r.name, token: r.token });
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
  return [...map.values()];
}

async function viewTeacherHome() {
  const classes = await loadClasses();
  const seq = render(`
    <section class="page-head">
      <div><p class="eyebrow">교사</p><h1>내 학급</h1></div>
      <button class="btn primary" id="newClass">+ 새 학급</button>
    </section>
    ${classes.length ? `<div class="class-grid">${classes.map(c => `
      <article class="card class-card">
        <div class="class-top">
          <h3>${esc(c.className)}</h3>
          ${c.pending ? '<span class="status wait">전송 대기</span>' : ''}
        </div>
        <p class="code-chip" title="학생 입장용 학급 코드">학급 코드 <b>${esc(c.classCode)}</b></p>
        <p class="muted small">업무 ${c.tasks.length}개 · 검사 담당 ${c.inspectors.length ? c.inspectors.map(n => esc(n) + '번').join(', ') : '없음'}</p>
        <div class="actions">
          <button class="btn" data-records="${esc(c.classCode)}">검사 기록</button>
          <button class="btn ghost" data-edit="${esc(c.classCode)}">학급 설정</button>
        </div>
      </article>`).join('')}</div>`
      : `<section class="card empty"><p>아직 학급이 없습니다.</p><p class="muted">새 학급을 만들고 학생들에게 학급 코드를 알려주세요.</p></section>`}`);

  document.getElementById('newClass').onclick = () => viewClassEdit(null);
  $app.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => viewClassEdit(classes.find(c => c.classCode === b.dataset.edit)));
  $app.querySelectorAll('[data-records]').forEach(b => b.onclick = () => viewRecords(classes.find(c => c.classCode === b.dataset.records)));

  try {
    const r = await api('listClasses', { token: state.teacher.token });
    const before = JSON.stringify((await DB.get('classes:' + state.teacher.email)) || []);
    await DB.set('classes:' + state.teacher.email, r.classes);
    if (seq === viewSeq && before !== JSON.stringify(r.classes)) viewTeacherHome();
  } catch (e) {
    if (e.code === 'AUTH') Sync.onAuthNeeded();
  }
}

// ---------- 교사: 학급 설정 ----------

function viewClassEdit(orig) {
  const isNew = !orig;
  const cls = orig ? JSON.parse(JSON.stringify(orig)) : {
    classCode: genCode(), className: '', inspectors: [],
    tasks: [{ id: uid(), name: '', assignees: '' }],
  };
  delete cls.pending;

  render(`
    <section class="page-head">
      <div><p class="eyebrow">${isNew ? '새 학급' : '학급 설정'}</p><h1>${isNew ? '학급 만들기' : esc(cls.className)}</h1></div>
    </section>
    <form class="card" id="f">
      <label>학급 이름<input name="className" required placeholder="예: 3학년 2반" value="${esc(cls.className)}"></label>
      <div class="code-box">
        <span>학생 입장용 학급 코드</span>
        <b>${esc(cls.classCode)}</b>
      </div>
      <label>검사 담당 학생 번호
        <input name="inspectors" placeholder="예: 3, 15, 22" inputmode="numeric" value="${esc(cls.inspectors.join(', '))}">
        <span class="hint">쉼표로 구분해 입력하세요. 이 번호의 학생만 검사 결과를 제출할 수 있습니다.</span>
      </label>

      <h3>업무 목록</h3>
      <p class="hint">담당 학생은 이름 또는 번호를 쉼표로 구분해 입력하세요. (예: 김하늘, 이바다)</p>
      <div id="tasks"></div>
      <button type="button" class="btn ghost block" id="addTask">+ 업무 추가</button>

      <p class="form-error" hidden></p>
      <div class="actions">
        <button type="button" class="btn ghost" id="cancel">취소</button>
        <button class="btn primary">저장</button>
      </div>
    </form>`);

  const f = document.getElementById('f');
  const $tasks = f.querySelector('#tasks');

  function readTasks() {
    $tasks.querySelectorAll('.task-row').forEach((row, i) => {
      cls.tasks[i].name = row.querySelector('[data-k=name]').value;
      cls.tasks[i].assignees = row.querySelector('[data-k=assignees]').value;
    });
  }
  function drawTasks() {
    $tasks.innerHTML = cls.tasks.map((t, i) => `
      <div class="task-row">
        <span class="num">${i + 1}</span>
        <input data-k="name" placeholder="업무 (예: 교실 바닥 쓸기)" value="${esc(t.name)}">
        <input data-k="assignees" placeholder="담당 학생" value="${esc(t.assignees)}">
        <button type="button" class="icon-btn" data-up="${i}" title="위로" ${i ? '' : 'disabled'}>↑</button>
        <button type="button" class="icon-btn" data-rm="${i}" title="삭제">✕</button>
      </div>`).join('');
    $tasks.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => {
      readTasks();
      cls.tasks.splice(Number(b.dataset.rm), 1);
      drawTasks();
    });
    $tasks.querySelectorAll('[data-up]').forEach(b => b.onclick = () => {
      readTasks();
      const i = Number(b.dataset.up);
      [cls.tasks[i - 1], cls.tasks[i]] = [cls.tasks[i], cls.tasks[i - 1]];
      drawTasks();
    });
  }
  drawTasks();

  f.querySelector('#addTask').onclick = () => {
    readTasks();
    cls.tasks.push({ id: uid(), name: '', assignees: '' });
    drawTasks();
    $tasks.querySelector('.task-row:last-child input').focus();
  };
  f.querySelector('#cancel').onclick = viewTeacherHome;

  f.onsubmit = async e => {
    e.preventDefault();
    formError(f);
    readTasks();
    cls.className = f.className.value.trim();
    cls.inspectors = [...new Set(f.inspectors.value.split(/[^0-9]+/).filter(Boolean).map(n => String(Number(n))))];
    cls.tasks = cls.tasks.filter(t => t.name.trim()).map(t => ({ ...t, name: t.name.trim(), assignees: t.assignees.trim() }));
    if (!cls.tasks.length) return formError(f, '업무를 하나 이상 입력해 주세요.');
    if (!cls.inspectors.length && !confirm('검사 담당 학생이 없으면 아무도 검사 결과를 제출할 수 없어요. 그래도 저장할까요?')) return;

    const email = state.teacher.email;
    const list = (await DB.get('classes:' + email)) || [];
    const i = list.findIndex(c => c.classCode === cls.classCode);
    if (i >= 0) list[i] = cls; else list.push(cls);
    await DB.set('classes:' + email, list);
    await Sync.enqueue('saveClass', { cls }, { auth: 'teacher', email, label: `학급 설정: ${cls.className}` });
    toast(navigator.onLine ? '저장했습니다.' : '저장했습니다. 와이파이 연결 시 서버에 반영됩니다.', 'ok');
    viewTeacherHome();
  };
}

// ---------- 교사: 검사 기록 ----------

async function viewRecords(cls) {
  const today = localDate();
  const monthStart = today.slice(0, 8) + '01';
  const seq = render(`
    <section class="page-head">
      <div><p class="eyebrow">${esc(cls.className)} · 학급 코드 ${esc(cls.classCode)}</p><h1>검사 기록</h1></div>
      <button class="btn ghost" id="back">← 학급 목록</button>
    </section>
    <section class="card filters">
      <label>시작일<input type="date" id="from" value="${monthStart}"></label>
      <label>종료일<input type="date" id="to" value="${today}"></label>
      <label>업무<select id="task"><option value="">전체</option>
        ${cls.tasks.map(t => `<option value="${esc(t.name)}">${esc(t.name)}</option>`).join('')}</select></label>
      <div class="filter-actions">
        <button class="btn" id="refresh">새로고침</button>
        <button class="btn ghost" id="csv">CSV 저장</button>
      </div>
      <p class="muted small" id="fetchInfo"></p>
    </section>
    <div id="out"></div>`);

  document.getElementById('back').onclick = viewTeacherHome;
  ['from', 'to', 'task'].forEach(id => { document.getElementById(id).onchange = draw; });
  document.getElementById('csv').onclick = () => exportCsv(filtered(), cls);
  const refreshBtn = document.getElementById('refresh');
  refreshBtn.onclick = () => busy(refreshBtn, fetchRecords);

  let cache = (await DB.get('records:' + cls.classCode)) || { records: [], fetchedAt: null };

  function filtered() {
    const from = document.getElementById('from').value;
    const to = document.getElementById('to').value;
    const task = document.getElementById('task').value;
    return cache.records
      .filter(r => (!from || r.date >= from) && (!to || r.date <= to) && (!task || r.taskName === task))
      .sort((a, b) => (b.date + b.inspectedAt).localeCompare(a.date + a.inspectedAt));
  }

  function draw() {
    document.getElementById('fetchInfo').textContent = cache.fetchedAt
      ? `${fmtTime(cache.fetchedAt)}에 받은 기록입니다. 원본은 구글 스프레드시트 'Records' 시트에 누적됩니다.`
      : '아직 서버에서 기록을 받지 않았습니다. 인터넷 연결 후 새로고침을 눌러주세요.';
    const rows = filtered();
    document.getElementById('out').innerHTML = rows.length ? `
      ${summaryHtml(rows)}
      ${personHtml(rows)}
      <section class="card">
        <h3>상세 기록 <span class="muted small">${rows.length}건</span></h3>
        <div class="table-wrap"><table>
          <thead><tr><th>날짜</th><th>업무</th><th>담당</th><th>결과</th><th>메모</th><th>검사자</th></tr></thead>
          <tbody>${rows.slice(0, 300).map(r => `<tr>
            <td class="nowrap">${esc(r.date)}</td><td>${esc(r.taskName)}</td><td>${esc(r.assignees)}</td>
            <td><span class="pill ${resultClass(r.result)}">${esc(r.result)}</span></td>
            <td>${esc(r.memo)}</td><td class="nowrap">${esc(r.inspectorNo)}번 ${esc(r.inspectorName)}</td>
          </tr>`).join('')}</tbody>
        </table></div>
        ${rows.length > 300 ? '<p class="muted small">최근 300건만 표시합니다. 전체는 CSV로 저장하세요.</p>' : ''}
      </section>` : '<section class="card empty"><p>해당 기간의 검사 기록이 없습니다.</p></section>';
  }

  async function fetchRecords() {
    try {
      const r = await api('getRecords', { token: state.teacher.token, classCode: cls.classCode });
      cache = { records: r.records, fetchedAt: Date.now() };
      await DB.set('records:' + cls.classCode, cache);
      if (seq === viewSeq) draw();
    } catch (e) {
      if (e.code === 'AUTH') Sync.onAuthNeeded();
      else if (seq === viewSeq) toast(isNetErr(e) ? '오프라인입니다. 저장된 기록을 보여드립니다.' : e.message, 'warn');
    }
  }

  draw();
  fetchRecords();
}

function stackBar(cnt, total) {
  return `<div class="bar">${RESULTS.map(r => cnt[r]
    ? `<span class="${resultClass(r)}" style="width:${(cnt[r] / total) * 100}%" title="${esc(r)} ${cnt[r]}"></span>` : '').join('')}</div>`;
}

function summaryHtml(rows) {
  const byTask = new Map();
  rows.forEach(r => {
    const m = byTask.get(r.taskName) || { cnt: {}, total: 0 };
    m.cnt[r.result] = (m.cnt[r.result] || 0) + 1;
    m.total++;
    byTask.set(r.taskName, m);
  });
  return `<section class="card">
    <h3>업무별 요약</h3>
    <div class="legend">${RESULTS.map(r => `<span><i class="${resultClass(r)}"></i>${esc(r)}</span>`).join('')}</div>
    <div class="table-wrap"><table class="summary">
      <thead><tr><th>업무</th>${RESULTS.map(r => `<th class="num">${esc(r)}</th>`).join('')}<th class="bar-col">비율</th></tr></thead>
      <tbody>${[...byTask].map(([name, m]) => `<tr>
        <td>${esc(name)}</td>${RESULTS.map(r => `<td class="num">${m.cnt[r] || 0}</td>`).join('')}
        <td class="bar-col">${stackBar(m.cnt, m.total)}</td></tr>`).join('')}</tbody>
    </table></div>
  </section>`;
}

function personHtml(rows) {
  const byPerson = new Map();
  rows.forEach(r => splitNames(r.assignees).forEach(n => {
    const m = byPerson.get(n) || { cnt: {}, total: 0 };
    m.cnt[r.result] = (m.cnt[r.result] || 0) + 1;
    m.total++;
    byPerson.set(n, m);
  }));
  if (!byPerson.size) return '';
  const bad = RESULTS[RESULTS.length - 1];
  const list = [...byPerson].sort((a, b) => (b[1].cnt[bad] || 0) - (a[1].cnt[bad] || 0) || a[0].localeCompare(b[0], 'ko'));
  return `<section class="card">
    <h3>학생별 누적 <span class="muted small">${esc(bad)} 많은 순</span></h3>
    <div class="table-wrap"><table class="summary">
      <thead><tr><th>학생</th>${RESULTS.map(r => `<th class="num">${esc(r)}</th>`).join('')}<th class="bar-col">비율</th></tr></thead>
      <tbody>${list.map(([name, m]) => `<tr>
        <td>${esc(name)}</td>${RESULTS.map(r => `<td class="num">${m.cnt[r] || 0}</td>`).join('')}
        <td class="bar-col">${stackBar(m.cnt, m.total)}</td></tr>`).join('')}</tbody>
    </table></div>
  </section>`;
}

function exportCsv(rows, cls) {
  const head = ['날짜', '업무', '담당', '결과', '메모', '검사자 반', '검사자 번호', '검사자 이름', '검사 시각'];
  const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [head, ...rows.map(r => [r.date, r.taskName, r.assignees, r.result, r.memo,
    r.inspectorClass, r.inspectorNo, r.inspectorName, r.inspectedAt])].map(l => l.map(cell).join(','));
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${cls.className}_검사기록_${localDate()}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- 시작 ----------

async function init() {
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  window.addEventListener('online', () => { renderSync(); Sync.run(); });
  window.addEventListener('offline', renderSync);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) Sync.run(); });
  setInterval(async () => {
    if (navigator.onLine && (await DB.outboxAll()).length) Sync.run();
  }, 30000);

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
