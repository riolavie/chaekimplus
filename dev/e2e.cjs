// 주요 흐름 자동 점검 (테스트 서버를 먼저 켜 두세요: node dev/mock-server.mjs)
// 스크린샷 저장 폴더: OUT=폴더 node dev/e2e.cjs
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }
const B = process.env.BASE || 'http://localhost:8080/';
const OUT = process.env.OUT || '.';
const log = (...a) => console.log('•', ...a);
const post = body => fetch(B + 'api', { method: 'POST', body: JSON.stringify(body) }).then(r => r.json());
const names = ['김하늘', '이바다', '박구름', '최산', '정들', '한별', '윤솔', '강빛'];

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium' });
  const errors = [];
  const page = async vp => {
    const p = await (await browser.newContext({ viewport: vp || { width: 1280, height: 900 } })).newPage();
    p.on('pageerror', e => errors.push(e.message)); p.on('dialog', d => d.accept());
    return p;
  };
  const stamp = Date.now();
  const email = `t${stamp}@school.kr`;

  // 교사 가입 → 학반 세팅
  const t = await page();
  await t.goto(B); await t.click('#goTeacher'); await t.click('#toggle');
  await t.fill('[name=name]', '홍길동'); await t.fill('[name=email]', email);
  await t.fill('[name=password]', 'secret123'); await t.fill('[name=password2]', 'secret123'); await t.click('.primary');
  const pending = await t.waitForSelector('.welcome, #toLogin').then(e => e.getAttribute('id'));
  if (pending === 'toLogin') throw new Error('테스트 서버를 새로 켜고 실행하세요 (첫 교사가 관리자여야 함)');
  await t.click('#newClass');
  await t.fill('[name=className]', '3학년 2반');
  await t.fill('[name=roster]', names.map((n, i) => `${i + 1}\t${n}`).join('\n'));
  await t.click('#next');
  await t.click('#addRole'); await t.fill('#roleDefs .role-def:nth-child(1) [data-k=name]', '검사 담당');
  await t.fill('#roleDefs .role-def:nth-child(1) [data-k=count]', '1'); await t.check('#roleDefs .role-def:nth-child(1) [data-k=inspector]');
  await t.click('#addRole'); await t.fill('#roleDefs .role-def:nth-child(2) [data-k=name]', '교실 청소');
  await t.fill('#roleDefs .role-def:nth-child(2) [data-k=count]', '7');
  await t.click('#next'); await t.click('#random'); await t.click('#next'); await t.click('#next');
  await t.waitForFunction(() => document.querySelector('#syncbar').textContent.includes('모두 전송됨'));
  const code = (await t.textContent('.code-chip b')).trim();
  const cfg = (await post({ action: 'getClassConfig', classCode: code })).config;
  const insp = cfg.inspectors[0];
  const cleaners = cfg.tasks.find(x => !x.inspector).assigneeNos;
  log('학급', code, '| 검사 담당', insp, '| 청소', cleaners.join(','));

  // 학생(검사 담당) 입장: 1234 → 새 비밀번호, 평가 + 메모
  const s = await page({ width: 390, height: 844 });
  const studentLogin = async (p, no, pin, newPin) => {
    await p.goto(B); await p.click('#goStudent');
    await p.fill('[name=classNo]', '3학년 2반'); await p.fill('[name=number]', String(no)); await p.fill('[name=name]', names[no - 1]);
    await p.fill('[name=code]', code); await p.fill('[name=pin]', pin); await p.click('.primary');
    if (newPin) {
      await p.waitForSelector('#newPinWrap:not([hidden])');
      await p.fill('[name=newPin]', newPin); await p.fill('[name=newPin2]', newPin); await p.click('.primary');
    }
    await p.waitForSelector('#myEval');
  };
  await studentLogin(s, insp, '1234', '4321');
  const person = s.locator('.person').first();
  await person.locator('[data-v="4"]').click(); await person.locator('.memo-toggle').click();
  await person.locator('.memo').fill('바닥을 꼼꼼히 쓸었어요');
  await s.click('#allTop'); await s.click('#inspect .primary');
  await s.waitForSelector('#history .status.sent');
  log('학생 평가 전송 OK');

  // 지난 기록(API)
  const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const yest = new Date(Date.now() - 86400000 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const task = cfg.tasks.find(x => !x.inspector);
  await post({ action: 'submitRecords', classCode: code, student: { number: insp, name: names[insp - 1] },
    records: cleaners.map((no, i) => ({ recordId: `y${stamp}${i}`, date: yest, taskId: task.id, taskName: task.name, studentNo: no, studentName: names[no - 1], score: 3 + (i % 3), memo: i === 0 ? '조금 늦었지만 끝까지 함' : '', inspectedAt: yest + 'T09:00' })) });

  // 교사: 일별 보기 + 피드백
  await t.reload(); await t.waitForSelector('[data-act=day]'); await t.click('[data-act=day]');
  await t.waitForSelector('.day-table'); await t.waitForTimeout(500);
  log('일별(오늘):', (await t.textContent('.day-stats')).replace(/\s+/g, ' ').trim());
  const target = cleaners[0];
  await t.fill(`[data-fb="${target}"]`, '오늘 정말 꼼꼼했어요. 내일도 화이팅!');
  await t.click(`[data-save="${target}"]`);
  await t.waitForFunction(no => document.querySelector(`[data-save="${no}"]`).textContent.includes('✓'), target);
  await t.waitForFunction(() => document.querySelector('#syncbar').textContent.includes('모두 전송됨'));
  log('피드백 저장:', await t.textContent(`[data-save="${target}"]`));
  await t.click('#prevDay'); await t.waitForTimeout(200);
  log('일별(어제):', (await t.textContent('.day-stats')).replace(/\s+/g, ' ').trim());
  await t.click('#todayBtn'); await t.waitForTimeout(200);
  await t.screenshot({ path: `${OUT}/day-teacher.png`, fullPage: true });

  // 학생: 피드백 받은 학생 화면
  const s2 = await page({ width: 390, height: 844 });
  await studentLogin(s2, Number(target), '1234', '1357');
  await s2.waitForSelector('.day-card'); await s2.waitForTimeout(500);
  log('학생 오늘 카드:', (await s2.textContent('.day-card')).replace(/\s+/g, ' ').trim().slice(0, 120));
  log('달력 피드백 표시:', await s2.locator('.cal-day i').count());
  await s2.screenshot({ path: `${OUT}/day-student.png`, fullPage: true });
  await s2.click(`[data-day="${yest}"]`); await s2.waitForTimeout(100);
  log('학생 어제 카드:', (await s2.textContent('.day-card')).replace(/\s+/g, ' ').trim().slice(0, 80));

  log('페이지 오류:', errors.length ? errors : '없음');
  await browser.close();
  if (errors.length) process.exit(1);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
