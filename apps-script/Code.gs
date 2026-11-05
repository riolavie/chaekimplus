/**
 * 책임플러스 - Google Apps Script 서버
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
  Classes: ['classCode', 'className', 'teacherEmail', 'inspectors', 'tasksJson', 'updatedAt',
            'studentsJson', 'settingsJson', 'rolesChangedAt', 'roleMonthsJson'],
  // 학생 한 명에 대한 평가 한 건이 한 줄 (5단 척도)
  Records: ['recordId', 'classCode', 'className', 'date', 'taskId', 'taskName', 'studentNo', 'studentName',
            'score', 'scoreLabel', 'memo', 'inspectorClass', 'inspectorNo', 'inspectorName', 'inspectedAt', 'receivedAt'],
  // 역할이 바뀔 때마다 한 줄씩 기록
  RoleHistory: ['classCode', 'month', 'changedAt', 'teacherEmail', 'assignments'],
  // 비밀번호 찾기 인증 코드 (해시로만 저장)
  Resets: ['email', 'codeHash', 'expiresAt', 'attempts', 'sentAt'],
};

const RESET_MINUTES = 15;   // 인증 코드 유효 시간
const RESET_MAX_TRIES = 5;  // 코드 입력 허용 횟수

const SCALE_LABELS = { 5: '매우 잘함', 4: '잘함', 3: '보통', 2: '아쉬움', 1: '노력 필요' };

function setup() {
  // 스프레드시트에서 연 Apps Script가 아니라 따로 만든 프로젝트라면, 저장용 스프레드시트를 새로 만듭니다.
  if (!SpreadsheetApp.getActiveSpreadsheet() && !PropertiesService.getScriptProperties().getProperty('SHEET_ID')) {
    const ss = SpreadsheetApp.create('책임플러스 DB');
    PropertiesService.getScriptProperties().setProperty('SHEET_ID', ss.getId());
  }
  Object.keys(SHEETS).forEach(sheet_);
  Logger.log('데이터 저장 위치: ' + ss_().getUrl());
  Logger.log('메일 발송 가능 수(오늘 남은 양): ' + MailApp.getRemainingDailyQuota());
}

/**
 * 관리자용: 메일을 받을 수 없는 선생님의 비밀번호를 직접 초기화합니다.
 * Apps Script 편집기에서 아래 함수의 이메일·새 비밀번호를 바꾼 뒤 resetPasswordByAdmin 을 실행하세요.
 */
function resetPasswordByAdmin() {
  const email = 'teacher@school.kr';   // ← 선생님 아이디
  const newPassword = 'change-me-123'; // ← 새 비밀번호 (6자 이상)
  setPassword_(normEmail_(email), newPassword);
  Logger.log(email + ' 의 비밀번호를 초기화했습니다. 선생님께 새 비밀번호를 알려주고, 로그인 후 바꾸도록 안내하세요.');
}

function ss_() {
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;
  const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!id) fail_('저장할 스프레드시트가 없습니다. Apps Script에서 setup 함수를 한 번 실행해 주세요.', 'SERVER');
  return SpreadsheetApp.openById(id);
}

function doGet() {
  return out_({ ok: true, app: 'chaekim-plus', time: new Date().toISOString() });
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

  // 비밀번호 찾기 1단계: 가입된 이메일이면 6자리 인증 코드를 메일로 보냄
  requestReset(req) {
    const email = normEmail_(req.email);
    const done = { message: '가입된 아이디라면 인증 코드를 메일로 보냈습니다. 메일함(스팸함 포함)을 확인해 주세요.' };
    const t = findTeacher_(email);
    if (!t) return done; // 가입 여부를 드러내지 않음
    const prev = rows_('Resets').find(r => r.email === email);
    if (prev && Date.now() - new Date(prev.sentAt).getTime() < 60 * 1000) {
      fail_('인증 코드를 방금 보냈습니다. 1분 뒤에 다시 요청해 주세요.', 'BAD');
    }
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const now = new Date();
    const row = [email, hash_(code, email), new Date(now.getTime() + RESET_MINUTES * 60000).toISOString(), '0', now.toISOString()];
    const sh = sheet_('Resets');
    if (prev) sh.getRange(prev._row, 1, 1, row.length).setValues([row]);
    else sh.appendRow(row);
    MailApp.sendEmail({
      to: email,
      subject: '[책임플러스] 비밀번호 재설정 인증 코드',
      body: t.name + ' 선생님, 안녕하세요.\n\n비밀번호 재설정 인증 코드: ' + code +
            '\n\n이 코드는 ' + RESET_MINUTES + '분 동안 유효합니다.\n직접 요청하지 않으셨다면 이 메일을 무시하세요.',
    });
    return done;
  },

  // 비밀번호 찾기 2단계: 코드 확인 후 새 비밀번호 저장, 바로 로그인
  resetPassword(req) {
    const email = normEmail_(req.email);
    const invalid = '인증 코드가 올바르지 않거나 만료되었습니다. 코드를 다시 요청해 주세요.';
    const r = rows_('Resets').find(x => x.email === email);
    if (!r || !r.codeHash || r.expiresAt < new Date().toISOString()) fail_(invalid, 'BAD');
    const tries = Number(r.attempts || 0) + 1;
    const sh = sheet_('Resets');
    if (tries > RESET_MAX_TRIES) {
      sh.getRange(r._row, 2).setValue('');
      fail_('입력 횟수를 넘었습니다. 인증 코드를 다시 요청해 주세요.', 'BAD');
    }
    if (hash_(String(req.code || '').trim(), email) !== r.codeHash) {
      sh.getRange(r._row, 4).setValue(String(tries));
      fail_('인증 코드가 올바르지 않습니다. (남은 시도 ' + (RESET_MAX_TRIES - tries) + '회)', 'BAD');
    }
    if (String(req.password || '').length < 6) fail_('비밀번호는 6자 이상이어야 합니다.', 'BAD');
    sh.getRange(r._row, 2).setValue(''); // 코드는 한 번만 사용
    setPassword_(email, req.password);
    const t = findTeacher_(email);
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
    const students = (c.students || [])
      .map(s => ({ no: String(parseInt(s.no, 10)), name: String(s.name || '').trim() }))
      .filter(s => s.no !== 'NaN');
    const tasks = (c.tasks || [])
      .filter(t => t && String(t.name || '').trim())
      .map(t => ({
        id: String(t.id),
        name: String(t.name).trim(),
        count: clampInt_(t.count, 0, 100, 1),
        inspector: !!t.inspector,
        assigneeNos: (t.assigneeNos || []).map(String),
      }));
    // 검사 담당 = '검사 역할'로 표시된 역할에 배정된 학생
    const inspectors = [];
    tasks.filter(t => t.inspector).forEach(t => t.assigneeNos.forEach(no => {
      if (inspectors.indexOf(no) < 0) inspectors.push(no);
    }));
    const settings = {
      evalTopN: clampInt_(c.evalTopN, 1, 30, 3),
      evalMinChecks: clampInt_(c.evalMinChecks, 0, 100, 3),
    };
    const roleMonths = {};
    Object.keys(c.roleMonths || {}).forEach(m => {
      if (/^\d{4}-\d{2}$/.test(m)) roleMonths[m] = c.roleMonths[m];
    });
    const now = new Date().toISOString();
    const row = [code, className, email, inspectors.join(','), JSON.stringify(tasks), now,
                 JSON.stringify(students), JSON.stringify(settings), String(c.rolesChangedAt || ''),
                 JSON.stringify(roleMonths)];

    const sh = sheet_('Classes');
    const existing = rows_('Classes').find(r => r.classCode === code);
    const prev = existing ? toClass_(existing) : { tasks: [] };
    if (existing) {
      if (existing.teacherEmail !== email) fail_('이미 다른 선생님이 사용 중인 학급 코드입니다.', 'FORBIDDEN');
      sh.getRange(existing._row, 1, 1, row.length).setValues([row]);
    } else {
      sh.appendRow(row);
    }
    const after = rolesText_(tasks, students);
    if (after && after !== rolesText_(prev.tasks, students)) {
      const month = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM');
      sheet_('RoleHistory').appendRow([code, String(c.rolesMonth || month), now, email, after]);
    }
    return { cls: toClass_(rows_('Classes').find(r => r.classCode === code)) };
  },

  getClassConfig(req) {
    const c = findClass_(req.classCode);
    if (!c) fail_('학급 코드를 찾을 수 없습니다.', 'NOT_FOUND');
    const cls = toClass_(c);
    delete cls.teacherEmail;
    delete cls.roleMonths;
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
      const score = parseInt(r.score, 10);
      if (!r.recordId || seen[r.recordId] || !SCALE_LABELS[score]) return;
      seen[r.recordId] = true;
      rows.push([r.recordId, cls.classCode, cls.className, r.date, r.taskId, r.taskName,
                 String(r.studentNo), r.studentName || '', String(score), SCALE_LABELS[score], r.memo || '',
                 st.classNo || '', String(st.number), st.name || '', r.inspectedAt || '', now]);
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
  const ss = ss_();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    // 날짜·코드가 자동 변환되지 않도록 모든 칸을 텍스트 형식으로
    sh.getRange(1, 1, sh.getMaxRows(), SHEETS[name].length).setNumberFormat('@');
    sh.getRange(1, 1, 1, SHEETS[name].length).setValues([SHEETS[name]]).setFontWeight('bold');
    sh.setFrozenRows(1);
  } else if (sh.getLastColumn() < SHEETS[name].length) {
    // 앱 업데이트로 열이 추가된 경우 머리글을 보충
    sh.getRange(1, 1, sh.getMaxRows(), SHEETS[name].length).setNumberFormat('@');
    sh.getRange(1, 1, 1, SHEETS[name].length).setValues([SHEETS[name]]).setFontWeight('bold');
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

// 비밀번호를 바꾸고, 기존 로그인(다른 기기 포함)은 모두 만료
function setPassword_(email, password) {
  if (String(password || '').length < 6) fail_('비밀번호는 6자 이상이어야 합니다.', 'BAD');
  const t = findTeacher_(email);
  if (!t) fail_('가입되지 않은 아이디입니다: ' + email, 'NOT_FOUND');
  const salt = Utilities.getUuid();
  sheet_('Teachers').getRange(t._row, 3, 1, 2).setValues([[salt, hash_(password, salt)]]);
  const sessions = sheet_('Sessions');
  rows_('Sessions').filter(s => s.email === email).reverse()
    .forEach(s => sessions.getRange(s._row, 3).setValue('1970-01-01T00:00:00.000Z'));
}

function classesOf_(email) {
  return rows_('Classes').filter(r => r.teacherEmail === email).map(toClass_);
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

function parseJson_(s, def) {
  try { return s ? JSON.parse(s) : def; } catch (e) { return def; }
}

function toClass_(r) {
  const settings = parseJson_(r.settingsJson, {});
  return {
    classCode: r.classCode,
    className: r.className,
    teacherEmail: r.teacherEmail,
    students: parseJson_(r.studentsJson, []),
    inspectors: r.inspectors ? r.inspectors.split(',') : [],
    tasks: parseJson_(r.tasksJson, []),
    evalTopN: settings.evalTopN || 3,
    evalMinChecks: settings.evalMinChecks == null ? 3 : settings.evalMinChecks,
    rolesChangedAt: r.rolesChangedAt || '',
    roleMonths: parseJson_(r.roleMonthsJson, {}),
    updatedAt: r.updatedAt,
  };
}

function clampInt_(v, min, max, def) {
  const n = parseInt(v, 10);
  return isNaN(n) ? def : Math.min(max, Math.max(min, n));
}

// 역할 배정을 사람이 읽을 수 있는 글로 (RoleHistory 시트용). 아무도 배정되지 않았으면 ''
function rolesText_(tasks, students) {
  const nameOf = no => {
    const s = (students || []).find(x => x.no === String(no));
    return no + '번' + (s && s.name ? ' ' + s.name : '');
  };
  const parts = (tasks || [])
    .filter(t => (t.assigneeNos || []).length)
    .map(t => t.name + ': ' + t.assigneeNos.map(nameOf).join(', '));
  return parts.join(' / ');
}
