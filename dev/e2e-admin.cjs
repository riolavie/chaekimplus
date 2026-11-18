// 학급 코드 바꾸기 · 새 버전 알림 · 관리자 콘솔 점검 (테스트 서버를 새로 켠 뒤 실행)
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }
const B = process.env.BASE || 'http://localhost:8080/';
const OUT = process.env.OUT || '.';
const log = (...a) => console.log('•', ...a);
const post = body => fetch(B + 'api', { method: 'POST', body: JSON.stringify(body) }).then(r => r.json());

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium' });
  const errors = [];
  const page = async (vp, ctxOpts = {}) => {
    const c = await browser.newContext({ viewport: vp || { width: 1280, height: 900 }, ...ctxOpts });
    const p = await c.newPage(); p.on('pageerror', e => errors.push(e.message)); p.on('dialog', d => d.accept());
    return [c, p];
  };
  // 준비: 관리자(첫 교사), 다른 교사, 학급
  const admin = await post({ action: 'signup', email: 'boss@s.kr', password: 'pass1234', name: '황관리' });
  await post({ action: 'signup', email: 'new@s.kr', password: 'pass1234', name: '신규교사' });
  const cls = { classCode: 'OLD123', className: '6학년 1반', students: [{ no: 1, name: '가람' }, { no: 2, name: '나래' }],
    tasks: [{ id: 'i', name: '검사', count: 1, inspector: true, assigneeNos: ['2'] }, { id: 'f', name: '칠판', count: 1, assigneeNos: ['1'] }] };
  await post({ action: 'saveClass', token: admin.token, cls });
  const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  await post({ action: 'submitRecords', classCode: 'OLD123', student: { number: '2' }, records: [{ recordId: 'a1', date: today, taskId: 'f', taskName: '칠판', studentNo: '1', score: 5, memo: '' }] });
  // 학생 1: 비밀번호 정함
  await post({ action: 'studentLogin', classCode: 'OLD123', number: 1, name: '가람', pin: '1234', newPin: '2468', newPin2: '2468' });

  // 검사 담당 학생 기기: 오프라인 상태에서 예전 코드로 평가 저장
  const [sc, s] = await page({ width: 390, height: 844 });
  await s.goto(B); await s.click('#goStudent');
  await s.fill('[name=classNo]', '6-1'); await s.fill('[name=number]', '2'); await s.fill('[name=name]', '나래'); await s.fill('[name=code]', 'OLD123');
  await s.fill('[name=pin]', '1234'); await s.click('.primary'); await s.waitForSelector('#newPinWrap:not([hidden])');
  await s.fill('[name=newPin]', '1357'); await s.fill('[name=newPin2]', '1357'); await s.click('.primary'); await s.waitForSelector('#inspect');
  await sc.setOffline(true);
  await s.click('#allTop'); await s.click('#inspect .primary'); await s.waitForSelector('#history .status.wait');
  log('학생 오프라인 평가 대기 중');

  // 교사(관리자): 학급 코드 바꾸기
  const [, t] = await page();
  await t.goto(B); await t.click('#goTeacher'); await t.fill('[name=email]', 'boss@s.kr'); await t.fill('[name=password]', 'pass1234'); await t.click('.primary');
  await t.waitForSelector('[data-act=setup]'); await t.click('[data-act=setup]');
  await t.fill('[name=roster]', '1 가람\n2 나래\n3 다솜'); // 저장 안 한 입력
  await t.click('#changeCode'); await t.fill('#ccf [name=code]', 'NEW777'); await t.click('#ccf .primary');
  await t.waitForFunction(() => document.querySelector('.code-box b').textContent === 'NEW777');
  log('코드 변경 후 화면:', await t.textContent('.code-box b'), '| 입력 유지:', (await t.inputValue('[name=roster]')).split('\n').length, '줄');
  log('같은 코드 재사용:', (await post({ action: 'changeClassCode', token: admin.token, classCode: 'NEW777', newCode: 'NEW777' })).error);

  // 학생: 예전 코드 새 입장 → 안내 / 대기 평가는 전송됨 / 비밀번호 유지
  log('예전 코드 입장:', (await post({ action: 'studentLogin', classCode: 'OLD123', number: 1, name: '가람', pin: '2468' })).error);
  log('새 코드 + 기존 비밀번호:', !!(await post({ action: 'studentLogin', classCode: 'NEW777', number: 1, name: '가람', pin: '2468' })).token);
  await sc.setOffline(false); await s.evaluate(() => window.dispatchEvent(new Event('online')));
  await s.waitForSelector('#history .status.sent'); log('예전 코드로 대기하던 평가 전송: OK');
  const recs = (await post({ action: 'getRecords', token: admin.token, classCode: 'NEW777' })).records;
  log('새 코드 학급의 기록 수:', recs.length, '| 코드:', [...new Set(recs.map(r => r.classCode))].join(','));
  log('예전 코드로 학급 다시 만들기 차단:', (await post({ action: 'saveClass', token: admin.token, cls })).error);

  // 관리자 콘솔
  await t.goto(B + '#admin'); await t.waitForSelector('.admin-head'); await t.waitForSelector('.admin-tiles');
  log('콘솔 현황:', (await t.locator('.admin-tiles .tile').allTextContents()).map(x => x.replace(/\s+/g, ' ')).slice(0, 5).join(' | '));
  log('교사 탭 배지:', await t.textContent('[data-badge="teachers"]'));
  await t.screenshot({ path: `${OUT}/admin-overview.png`, fullPage: true });
  await t.click('[data-atab=teachers]'); await t.waitForSelector('[data-ok]');
  await t.click('[data-ok="new@s.kr"]'); await t.waitForTimeout(800);
  log('승인 후 대기:', await t.locator('[data-no]').count());
  await t.click('[data-atab=classes]'); await t.waitForSelector('#classRows');
  log('학급 탭:', (await t.locator('#classRows tr').first().textContent()).replace(/\s+/g, ' ').trim());
  await t.screenshot({ path: `${OUT}/admin-classes.png`, fullPage: true });
  await t.click('[data-atab=system]'); await t.waitForSelector('.admin-grid');
  log('시스템 탭:', (await t.locator('.admin-grid .list').first().textContent()).replace(/\s+/g, ' ').trim());
  await t.screenshot({ path: `${OUT}/admin-system.png`, fullPage: true });

  // 비관리자는 콘솔 접근 불가
  const [, n] = await page();
  await n.goto(B); await n.click('#goTeacher'); await n.fill('[name=email]', 'new@s.kr'); await n.fill('[name=password]', 'pass1234'); await n.click('.primary');
  await n.waitForSelector('.welcome'); await n.goto(B + '#admin'); await n.waitForSelector('.welcome');
  log('비관리자 #admin → 교사 화면으로:', await n.locator('.admin-head').count() === 0);

  // 새 버전 알림 (version.json 이 더 새 버전이라고 가정)
  const [uc, u] = await page({ width: 390, height: 844 });
  await uc.route('**/version.json', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ version: 'v99', date: '2099.01.01', notes: ['테스트'] }) }));
  await u.goto(B); await u.waitForSelector('#updatebar:not([hidden])');
  log('업데이트 띠:', (await u.textContent('#updatebar')).replace(/\s+/g, ' ').trim());
  log('버튼 아래 안내:', (await u.textContent('.update-hint')).trim());
  await u.screenshot({ path: `${OUT}/update-notice.png` });
  const [, u2] = await page({ width: 390, height: 844 });
  await u2.goto(B); await u2.waitForSelector('.update-hint'); await u2.waitForTimeout(800);
  log('최신일 때 띠 숨김:', await u2.locator('#updatebar').isHidden(), '| 안내:', (await u2.textContent('.update-hint')).trim().slice(0, 25));

  log('페이지 오류:', errors.length ? errors : '없음');
  await browser.close();
  if (errors.length) process.exit(1);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
