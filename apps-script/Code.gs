/**
 * 학급 업무 검사 - Google Apps Script 서버
 *
 * 설치 방법은 README.md 를 참고하세요.
 * 1) 구글 스프레드시트 > 확장 프로그램 > Apps Script 에 이 코드를 붙여넣기
 * 2) 함수 목록에서 setup 을 선택해 한 번 실행 (권한 승인)
 * 3) 배포 > 새 배포 > 웹 앱 (실행: 나 / 액세스 권한: 모든 사용자)
 */

// 교사 회원가입 코드. 비워두면 URL을 아는 누구나 교사로 가입할 수 있습니다.
// 예: const SIGNUP_CODE = 'our-school-2026';
const SIGNUP_CODE = '';

// 교사 로그인 유지 기간(일)
const SESSION_DAYS = 30;

const SHEETS = {
  Teachers: ['email', 'name', 'salt', 'hash', 'createdAt'],
  Sessions: ['token', 'email', 'expiresAt'],
  Classes: ['classCode', 'className', 'teacherEmail', 'inspectors', 'tasksJson', 'updatedAt'],
  Records: ['recordId', 'classCode', 'className', 'date', 'taskId', 'taskName', 'assignees', 'result', 'memo',
            'inspectorClass', 'inspectorNo', 'inspectorName', 'inspectedAt', 'receivedAt'],
};

function setup() {
  Object.keys(SHEETS).forEach(sheet_);
}

function doGet() {
  return out_({ ok: true, app: 'class-check', time: new Date().toISOString() });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return out_({ ok: false, error: '잘못된 요청입니다.', code: 'BAD' });
  }
  const fn = ACTIONS[req.action];
  if (!fn) return out_({ ok: false, error: '알 수 없는 요청: ' + req.action, code: 'BAD' });

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) {
    return out_({ ok: false, error: '서버가 바쁩니다. 잠시 후 다시 시도합니다.', code: 'BUSY' });
  }
  try {
    return out_(Object.assign({ ok: true }, fn(req)));
  } catch (err) {
    return out_({ ok: false, error: err.message, code: err.code || 'SERVER' });
  } finally {
    lock.releaseLock();
  }
}

const ACTIONS = {
  ping: () => ({ time: new Date().toISOString() }),

  signup(req) {
    if (SIGNUP_CODE && req.signupCode !== SIGNUP_CODE) fail_('가입 코드가 올바르지 않습니다.', 'BAD');
    const email = normEmail_(req.email);
    const name = String(req.name || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail_('아이디는 이메일 형식이어야 합니다.', 'BAD');
    if (!name) fail_('이름을 입력해 주세요.', 'BAD');
    if (String(req.password || '').length < 6) fail_('비밀번호는 6자 이상이어야 합니다.', 'BAD');
    if (findTeacher_(email)) fail_('이미 가입된 아이디입니다.', 'BAD');
    const salt = Utilities.getUuid();
    sheet_('Teachers').appendRow([email, name, salt, hash_(req.password, salt), new Date().toISOString()]);
    return { email, name, token: newSession_(email), classes: [] };
  },

  login(req) {
    const email = normEmail_(req.email);
    const t = findTeacher_(email);
    if (!t || hash_(req.password, t.salt) !== t.hash) fail_('아이디 또는 비밀번호가 올바르지 않습니다.', 'BAD');
    return { email, name: t.name, token: newSession_(email), classes: classesOf_(email) };
  },

  listClasses(req) {
    return { classes: classesOf_(auth_(req)) };
  },

  saveClass(req) {
    const email = auth_(req);
    const c = req.cls || {};
    const code = String(c.classCode || '').toUpperCase();
    if (!/^[A-Z0-9]{4,10}$/.test(code)) fail_('학급 코드 형식이 올바르지 않습니다.', 'BAD');
    const className = String(c.className || '').trim();
    if (!className) fail_('학급 이름을 입력해 주세요.', 'BAD');
    const tasks = (c.tasks || [])
      .filter(t => t && String(t.name || '').trim())
      .map(t => ({ id: String(t.id), name: String(t.name).trim(), assignees: String(t.assignees || '').trim() }));
    const inspectors = (c.inspectors || []).map(String).filter(Boolean).join(',');
    const row = [code, className, email, inspectors, JSON.stringify(tasks), new Date().toISOString()];

    const sh = sheet_('Classes');
    const existing = rows_('Classes').find(r => r.classCode === code);
    if (existing) {
      if (existing.teacherEmail !== email) fail_('이미 다른 선생님이 사용 중인 학급 코드입니다.', 'FORBIDDEN');
      sh.getRange(existing._row, 1, 1, row.length).setValues([row]);
    } else {
      sh.appendRow(row);
    }
    return { cls: toClass_(rows_('Classes').find(r => r.classCode === code)) };
  },

  getClassConfig(req) {
    const c = findClass_(req.classCode);
    if (!c) fail_('학급 코드를 찾을 수 없습니다.', 'NOT_FOUND');
    const cls = toClass_(c);
    delete cls.teacherEmail;
    return { config: cls };
  },

  submitRecords(req) {
    const c = findClass_(req.classCode);
    if (!c) fail_('학급 코드를 찾을 수 없습니다.', 'NOT_FOUND');
    const cls = toClass_(c);
    const st = req.student || {};
    if (cls.inspectors.indexOf(String(st.number)) < 0) {
      fail_(st.number + '번 학생은 검사 담당 학생이 아닙니다. 선생님께 확인해 주세요.', 'FORBIDDEN');
    }
    const sh = sheet_('Records');
    const seen = {};
    if (sh.getLastRow() > 1) {
      sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().forEach(r => { seen[r[0]] = true; });
    }
    const now = new Date().toISOString();
    const rows = [];
    (req.records || []).forEach(r => {
      if (!r.recordId || seen[r.recordId]) return;
      seen[r.recordId] = true;
      rows.push([r.recordId, cls.classCode, cls.className, r.date, r.taskId, r.taskName, r.assignees || '',
                 r.result, r.memo || '', st.classNo || '', String(st.number), st.name || '', r.inspectedAt || '', now]);
    });
    if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
    return { accepted: rows.length, duplicates: (req.records || []).length - rows.length };
  },

  getRecords(req) {
    const email = auth_(req);
    const c = findClass_(req.classCode);
    if (!c || c.teacherEmail !== email) fail_('학급을 찾을 수 없습니다.', 'NOT_FOUND');
    const records = rows_('Records')
      .filter(r => r.classCode === c.classCode)
      .map(r => { delete r._row; return r; });
    return { records };
  },
};

// ---------- 헬퍼 ----------

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function fail_(msg, code) {
  const e = new Error(msg);
  e.code = code || 'SERVER';
  throw e;
}

function sheet_(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    // 날짜·코드가 자동 변환되지 않도록 모든 칸을 텍스트 형식으로
    sh.getRange(1, 1, sh.getMaxRows(), SHEETS[name].length).setNumberFormat('@');
    sh.getRange(1, 1, 1, SHEETS[name].length).setValues([SHEETS[name]]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function rows_(name) {
  const values = sheet_(name).getDataRange().getValues();
  const head = values.shift();
  const tz = Session.getScriptTimeZone();
  return values.map((r, i) => {
    const o = { _row: i + 2 };
    head.forEach((k, j) => {
      const v = r[j];
      o[k] = v instanceof Date ? Utilities.formatDate(v, tz, 'yyyy-MM-dd') : String(v);
    });
    return o;
  });
}

function normEmail_(s) {
  return String(s || '').trim().toLowerCase();
}

function hash_(password, salt) {
  let h = salt + '|' + password;
  for (let i = 0; i < 300; i++) {
    h = Utilities.base64Encode(
      Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h + salt, Utilities.Charset.UTF_8));
  }
  return h;
}

function findTeacher_(email) {
  return rows_('Teachers').find(r => r.email === email);
}

function newSession_(email) {
  const token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  sheet_('Sessions').appendRow([token, email, expires]);
  return token;
}

function auth_(req) {
  const s = req.token && rows_('Sessions').find(r => r.token === req.token);
  if (!s || s.expiresAt < new Date().toISOString()) {
    fail_('로그인이 만료되었습니다. 다시 로그인해 주세요.', 'AUTH');
  }
  return s.email;
}

function findClass_(code) {
  code = String(code || '').trim().toUpperCase();
  return rows_('Classes').find(r => r.classCode === code);
}

function toClass_(r) {
  return {
    classCode: r.classCode,
    className: r.className,
    teacherEmail: r.teacherEmail,
    inspectors: r.inspectors ? r.inspectors.split(',') : [],
    tasks: r.tasksJson ? JSON.parse(r.tasksJson) : [],
    updatedAt: r.updatedAt,
  };
}

function classesOf_(email) {
  return rows_('Classes').filter(r => r.teacherEmail === email).map(toClass_);
}
