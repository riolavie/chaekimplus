/**
 * 책임플러스 - Google Apps Script 서버
 *
 * 문의: riolavie0516@naver.com
 *
 * 설치 방법은 README.md 를 참고하세요.
 * 1) 구글 스프레드시트 > 확장 프로그램 > Apps Script 에 이 코드를 붙여넣기
 * 2) 함수 목록에서 setup 을 선택해 한 번 실행 (권한 승인)
 * 3) 배포 > 새 배포 > 웹 앱 (실행: 나 / 액세스 권한: 모든 사용자)
 */

// 교사 회원가입 코드. 비워두면 URL을 아는 누구나 교사로 가입할 수 있습니다.
// 예: const SIGNUP_CODE = 'our-school-2026';
const SIGNUP_CODE = '';

// 최고 관리자 교사 아이디(이메일 형식). 새로 가입한 교사는 관리자가 승인해야 로그인할 수 있습니다.
// 여러 명이면 쉼표로: ['admin@school.kr', 'vice@school.kr']
// 비워두면 이 서버에 가장 먼저 가입한 교사가 관리자가 됩니다.
const ADMIN_EMAILS = [];

// 문의처 (비밀번호 찾기 메일 등에 표시)
const CONTACT_EMAIL = 'riolavie0516@naver.com';

// 교사 로그인 유지 기간(일)
const SESSION_DAYS = 30;

// 서버 코드 버전. 앱이 이 값으로 서버 코드 업데이트가 필요한지 판단합니다.
const SERVER_VERSION = 14;

const SHEETS = {
  // status: '' 또는 approved = 승인됨, pending = 승인 대기, rejected = 거절됨
  Teachers: ['email', 'name', 'salt', 'hash', 'createdAt', 'status', 'decidedAt', 'decidedBy'],
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
  // 학생 개인 비밀번호(숫자 4자리). 교사가 확인할 수 있도록 pin 열에 저장 (salt·hash 는 이전 버전 호환용)
  StudentPins: ['classCode', 'studentNo', 'salt', 'hash', 'fails', 'lockedUntil', 'updatedAt', 'pin', 'mustChange'],
  StudentSessions: ['token', 'classCode', 'studentNo', 'expiresAt'],
};

const STUDENT_SESSION_DAYS = 180;
const DEFAULT_PIN = '1234';  // 처음·초기화 후 비밀번호. 학생은 입장하자마자 자기 비밀번호로 바꿈
const PIN_MAX_FAILS = 5;     // 연속으로 틀리면
const PIN_LOCK_MINUTES = 5;  // 이 시간 동안 잠금

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
  return out_({ ok: true, app: 'chaekim-plus', version: SERVER_VERSION, time: new Date().toISOString() });
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
  ping: () => ({ time: new Date().toISOString(), version: SERVER_VERSION }),

  signup(req) {
    if (SIGNUP_CODE && req.signupCode !== SIGNUP_CODE) fail_('가입 코드가 올바르지 않습니다.', 'BAD');
    const email = normEmail_(req.email);
    const name = String(req.name || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail_('아이디는 이메일 형식이어야 합니다.', 'BAD');
    if (!name) fail_('이름을 입력해 주세요.', 'BAD');
    if (String(req.password || '').length < 6) fail_('비밀번호는 6자 이상이어야 합니다.', 'BAD');
    if (findTeacher_(email)) fail_('이미 가입된 아이디입니다.', 'BAD');
    const salt = Utilities.getUuid();
    const now = new Date().toISOString();
    // 관리자 본인(또는 서버의 첫 교사)은 바로 승인, 그 밖에는 승인 대기
    const first = rows_('Teachers').length === 0;
    const auto = first || ADMIN_EMAILS.map(normEmail_).indexOf(email) >= 0;
    sheet_('Teachers').appendRow([email, name, salt, hash_(req.password, salt), now,
      auto ? 'approved' : 'pending', auto ? now : '', auto ? 'auto' : '']);
    if (!auto) {
      notifyAdmins_('[책임플러스] 교사 가입 승인 요청: ' + name,
        name + ' 선생님(' + email + ')이 가입을 신청했습니다.\n앱에서 교사로 로그인한 뒤 「교사 가입 관리」에서 승인 또는 거절해 주세요.' +
        (req.appUrl ? '\n\n앱 주소: ' + req.appUrl : ''));
      return { pending: true, email, name };
    }
    return { email, name, token: newSession_(email), classes: [], isAdmin: isAdmin_(email) };
  },

  login(req) {
    const email = normEmail_(req.email);
    const t = findTeacher_(email);
    if (!t || hash_(req.password, t.salt) !== t.hash) fail_('아이디 또는 비밀번호가 올바르지 않습니다.', 'BAD');
    checkApproved_(t);
    return { email, name: t.name, token: newSession_(email), classes: classesOf_(email), isAdmin: isAdmin_(email) };
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
            '\n\n이 코드는 ' + RESET_MINUTES + '분 동안 유효합니다.\n직접 요청하지 않으셨다면 이 메일을 무시하세요.' +
            '\n\n문의: ' + CONTACT_EMAIL,
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
    checkApproved_(t);
    return { email, name: t.name, token: newSession_(email), classes: classesOf_(email), isAdmin: isAdmin_(email) };
  },

  listClasses(req) {
    const email = auth_(req);
    return { classes: classesOf_(email), isAdmin: isAdmin_(email) };
  },

  // 관리자: 교사 목록과 가입 신청
  adminListTeachers(req) {
    adminAuth_(req);
    const classes = rows_('Classes');
    return {
      teachers: rows_('Teachers').map(t => {
        const mine = classes.filter(c => c.teacherEmail === t.email);
        return {
          email: t.email, name: t.name, createdAt: t.createdAt, status: t.status || 'approved',
          decidedAt: t.decidedAt || '', isAdmin: isAdmin_(t.email), classes: mine.length,
          students: mine.reduce((a, c) => a + parseJson_(c.studentsJson, []).length, 0),
        };
      }),
    };
  },

  // 관리자: 가입 승인 / 거절
  adminSetTeacherStatus(req) {
    const admin = adminAuth_(req);
    const status = req.status === 'approved' ? 'approved' : req.status === 'rejected' ? 'rejected' : '';
    if (!status) fail_('잘못된 요청입니다.', 'BAD');
    const t = findTeacher_(normEmail_(req.email));
    if (!t) fail_('교사를 찾을 수 없습니다.', 'NOT_FOUND');
    if (isAdmin_(t.email)) fail_('관리자 계정의 상태는 바꿀 수 없습니다.', 'BAD');
    sheet_('Teachers').getRange(t._row, 6, 1, 3).setValues([[status, new Date().toISOString(), admin]]);
    if (status === 'rejected') {
      const sessions = sheet_('Sessions');
      rows_('Sessions').filter(x => x.email === t.email)
        .forEach(x => sessions.getRange(x._row, 3).setValue('1970-01-01T00:00:00.000Z'));
    }
    try {
      MailApp.sendEmail(t.email, '[책임플러스] 교사 가입 ' + (status === 'approved' ? '승인 안내' : '결과 안내'),
        t.name + ' 선생님, 안녕하세요.\n\n' + (status === 'approved'
          ? '책임플러스 교사 가입이 승인되었습니다. 이제 로그인할 수 있습니다.' + (req.appUrl ? '\n앱 주소: ' + req.appUrl : '')
          : '책임플러스 교사 가입 신청이 승인되지 않았습니다.') + '\n\n문의: ' + CONTACT_EMAIL);
    } catch (e) { /* 아이디가 실제 메일 주소가 아니면 생략 */ }
    return { email: t.email, status };
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
      showMemos: !!c.showMemos,
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

  // 학생 입장: 반·번호·이름·학급 코드 + 개인 비밀번호(숫자 4자리)
  // 처음이거나 교사가 초기화했다면 비밀번호는 1234 이고, 맞게 입력하면 mustChange 를 돌려줌
  // → newPin·newPin2 와 함께 다시 오면 새 비밀번호로 바꾸고 입장
  studentLogin(req) {
    const c = findClass_(req.classCode);
    if (!c) fail_('학급 코드를 찾을 수 없습니다.', 'NOT_FOUND');
    const cls = toClass_(c);
    const no = String(parseInt(req.number, 10));
    const strip = v => String(v || '').replace(/\s/g, '');
    if (cls.students.length) {
      const st = cls.students.find(x => x.no === no);
      if (!st) fail_('학급 명단에 ' + no + '번 학생이 없습니다. 번호를 확인해 주세요.', 'BAD');
      if (st.name && strip(st.name) !== strip(req.name)) fail_(no + '번의 이름이 명단과 다릅니다. 번호와 이름을 확인해 주세요.', 'BAD');
    }
    const now = new Date();
    const pin = String(req.pin || '');
    const row = pinRow_(cls.classCode, no);
    if (row.lockedUntil && row.lockedUntil > now.toISOString()) {
      fail_('비밀번호를 여러 번 틀려 잠시 잠겼습니다. ' + PIN_LOCK_MINUTES + '분 뒤에 다시 해 보세요.', 'BAD');
    }
    if (!checkPin_(row, pin)) {
      const fails = Number(row.fails || 0) + 1;
      const lock = fails >= PIN_MAX_FAILS ? new Date(now.getTime() + PIN_LOCK_MINUTES * 60000).toISOString() : '';
      savePinRow_(row, { fails: String(fails >= PIN_MAX_FAILS ? 0 : fails), lockedUntil: lock });
      fail_('비밀번호가 맞지 않습니다.' + (lock ? ' 잠시 잠겼습니다. ' + PIN_LOCK_MINUTES + '분 뒤에 다시 해 보세요.'
        : ' (남은 기회 ' + (PIN_MAX_FAILS - fails) + '번) 처음이라면 ' + DEFAULT_PIN + '를 입력하고, 잊었다면 선생님께 초기화를 부탁하세요.'), 'BAD');
    }
    const mustChange = !row.pin && !row.hash ? true : row.mustChange === '1';
    let changed = false;
    if (mustChange) {
      if (!req.newPin) {
        savePinRow_(row, { fails: '0', lockedUntil: '' });
        return { mustChange: true };
      }
      validateNewPin_(req.newPin, req.newPin2);
      savePinRow_(row, { pin: String(req.newPin), mustChange: '', salt: '', hash: '', fails: '0', lockedUntil: '' });
      changed = true;
    } else if (!row.pin || row.fails !== '0' || row.lockedUntil) {
      // 이전 버전(해시만 있음)이면 교사가 볼 수 있도록 비밀번호 열로 옮겨 저장
      savePinRow_(row, { pin: pin, salt: '', hash: '', fails: '0', lockedUntil: '' });
    }
    const token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
    const expires = new Date(now.getTime() + STUDENT_SESSION_DAYS * 86400000).toISOString();
    sheet_('StudentSessions').appendRow([token, cls.classCode, no, expires]);
    delete cls.teacherEmail;
    delete cls.roleMonths;
    return { token, config: cls, changed };
  },

  // 학생: 내 비밀번호 바꾸기 (현재 비밀번호 확인)
  changeMyPin(req) {
    const s = studentAuth_(req);
    const row = pinRow_(s.classCode, s.studentNo);
    if (!checkPin_(row, String(req.pin || ''))) fail_('현재 비밀번호가 맞지 않습니다.', 'BAD');
    validateNewPin_(req.newPin, req.newPin2);
    savePinRow_(row, { pin: String(req.newPin), mustChange: '', salt: '', hash: '', fails: '0', lockedUntil: '' });
    return { changed: true };
  },

  // 교사: 학급 학생들의 비밀번호와 상태 보기
  listStudentPins(req) {
    const c = teacherClass_(req);
    const cls = toClass_(c);
    const now = new Date().toISOString();
    const rows = rows_('StudentPins').filter(r => r.classCode === c.classCode);
    return {
      pins: cls.students.map(st => {
        const r = rows.find(x => x.studentNo === st.no) || {};
        const isDefault = (!r.pin && !r.hash) || r.mustChange === '1';
        return {
          no: st.no, name: st.name,
          pin: isDefault ? DEFAULT_PIN : (r.pin || ''),
          status: isDefault ? 'default' : r.pin ? 'set' : 'hidden',
          locked: !!(r.lockedUntil && r.lockedUntil > now),
          updatedAt: r.updatedAt || '',
        };
      }),
    };
  },

  // 학생: 내가 받은 평가 (평가자는 숨기고, 메모는 선생님이 허용한 경우에만)
  myRecords(req) {
    const s = studentAuth_(req);
    const c = findClass_(s.classCode);
    if (!c) fail_('학급을 찾을 수 없습니다.', 'NOT_FOUND');
    const cls = toClass_(c);
    const all = rows_('Records').filter(r => r.classCode === cls.classCode);
    const mine = all.filter(r => r.studentNo === s.studentNo);
    const months = [];
    mine.forEach(r => { const m = r.date.slice(0, 7); if (months.indexOf(m) < 0) months.push(m); });
    return {
      showMemos: cls.showMemos,
      records: mine.map(r => ({
        date: r.date, taskName: r.taskName, score: Number(r.score),
        memo: cls.showMemos ? r.memo : '', inspectedAt: r.inspectedAt,
      })),
      months: months.sort().map(m => {
        const st = monthStats_(all, cls, m).find(x => x.no === s.studentNo) || {};
        return { month: m, excellent: !!st.excellent };
      }),
    };
  },

  // 교사: 학생 비밀번호를 1234 로 초기화 (studentNo 하나 또는 all: true 로 전체)
  // 학생은 다음 입장 때 1234 로 들어와 새 비밀번호를 정함
  resetStudentPin(req) {
    const c = teacherClass_(req);
    const cls = toClass_(c);
    const targets = req.all ? cls.students.map(st => st.no) : [String(parseInt(req.studentNo, 10))];
    targets.forEach(no => savePinRow_(pinRow_(c.classCode, no),
      { pin: '', mustChange: '1', salt: '', hash: '', fails: '0', lockedUntil: '' }));
    const sessions = sheet_('StudentSessions');
    rows_('StudentSessions').filter(x => x.classCode === c.classCode && targets.indexOf(x.studentNo) >= 0)
      .forEach(x => sessions.getRange(x._row, 4).setValue('1970-01-01T00:00:00.000Z'));
    return { reset: targets.length, defaultPin: DEFAULT_PIN };
  },
};

// ---------- 학생 비밀번호 헬퍼 ----------

// 학생의 비밀번호 행 (없으면 아직 저장되지 않은 빈 행)
function pinRow_(classCode, no) {
  return rows_('StudentPins').find(r => r.classCode === classCode && r.studentNo === no) ||
    { classCode, studentNo: no, salt: '', hash: '', fails: '0', lockedUntil: '', pin: '', mustChange: '' };
}

function checkPin_(row, pin) {
  if ((!row.pin && !row.hash) || row.mustChange === '1') return pin === DEFAULT_PIN;
  if (row.pin) return row.pin === pin;
  return hash_(pin, row.salt) === row.hash; // 이전 버전
}

function savePinRow_(row, changes) {
  Object.keys(changes).forEach(k => { row[k] = changes[k]; });
  row.updatedAt = new Date().toISOString();
  const data = SHEETS.StudentPins.map(k => String(row[k] == null ? '' : row[k]));
  const sh = sheet_('StudentPins');
  if (row._row) sh.getRange(row._row, 1, 1, data.length).setValues([data]);
  else { sh.appendRow(data); row._row = sh.getLastRow(); }
}

function validateNewPin_(pin, pin2) {
  pin = String(pin || '');
  if (!/^\d{4}$/.test(pin)) fail_('새 비밀번호는 숫자 4자리로 정해 주세요.', 'BAD');
  if (pin === DEFAULT_PIN) fail_(DEFAULT_PIN + '는 처음 비밀번호라서 쓸 수 없어요. 다른 숫자 4자리로 정해 주세요.', 'BAD');
  if (pin !== String(pin2 || '')) fail_('새 비밀번호 두 개가 서로 다릅니다. 다시 입력해 주세요.', 'BAD');
}

function studentAuth_(req) {
  const s = req.token && rows_('StudentSessions').find(r => r.token === req.token);
  if (!s || s.expiresAt < new Date().toISOString()) fail_('다시 입장해 주세요.', 'AUTH');
  return s;
}

function teacherClass_(req) {
  const email = auth_(req);
  const c = findClass_(req.classCode);
  if (!c || c.teacherEmail !== email) fail_('학급을 찾을 수 없습니다.', 'NOT_FOUND');
  return c;
}

// 한 달 동안 학생별 평균과 우수 학생 여부 (앱의 월별 우수 학생 계산과 같은 규칙)
function monthStats_(records, cls, month) {
  const map = {};
  records.filter(r => r.date.indexOf(month) === 0).forEach(r => {
    const v = Number(r.score);
    if (!v) return;
    const m = map[r.studentNo] || (map[r.studentNo] = { no: r.studentNo, total: 0, sum: 0, top: 0 });
    m.total++;
    m.sum += v;
    if (v === 5) m.top++;
  });
  const rows = Object.keys(map).map(k => {
    const m = map[k];
    m.avg = m.sum / m.total;
    m.eligible = m.total >= cls.evalMinChecks;
    return m;
  });
  rows.sort((a, b) => (b.eligible - a.eligible) || (b.avg - a.avg) || (b.top - a.top) || (b.total - a.total) || (a.no - b.no));
  rows.forEach((m, i) => {
    const p = rows[i - 1];
    if (!m.eligible) { m.rank = null; return; }
    m.rank = p && p.eligible && Math.abs(p.avg - m.avg) < 1e-9 && p.top === m.top ? p.rank : i + 1;
    m.excellent = m.rank <= cls.evalTopN;
  });
  return rows;
}

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

// 관리자: ADMIN_EMAILS, 비어 있으면 가장 먼저 가입한 교사
function isAdmin_(email) {
  const list = ADMIN_EMAILS.map(normEmail_).filter(Boolean);
  if (list.length) return list.indexOf(email) >= 0;
  const first = rows_('Teachers')[0];
  return !!first && first.email === email;
}

function adminAuth_(req) {
  const email = auth_(req);
  if (!isAdmin_(email)) fail_('관리자만 사용할 수 있습니다.', 'FORBIDDEN');
  return email;
}

function checkApproved_(t) {
  if (t.status === 'pending') fail_('가입 승인을 기다리는 중입니다. 관리자가 승인하면 로그인할 수 있어요.', 'PENDING');
  if (t.status === 'rejected') fail_('가입이 승인되지 않은 계정입니다. 관리자에게 문의해 주세요. (' + CONTACT_EMAIL + ')', 'BAD');
}

function notifyAdmins_(subject, body) {
  const list = ADMIN_EMAILS.length ? ADMIN_EMAILS : rows_('Teachers').slice(0, 1).map(t => t.email);
  list.forEach(to => {
    try { MailApp.sendEmail(to, subject, body); } catch (e) { /* 메일 주소가 아니면 생략 */ }
  });
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
    showMemos: !!settings.showMemos,
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
