// 개발용 테스트 서버: 앱 파일을 제공하고, apps-script/Code.gs 를 Google 서비스 흉내(메모리 시트)로 실행합니다.
// 실행: node dev/mock-server.mjs  →  http://localhost:8080  (앱의 서버 주소가 자동으로 /api 로 바뀜)
// 예전 서버 코드로 시험하려면: CODE=경로/Code.gs node dev/mock-server.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8080);
const sheets = new Map();
const mails = [];

const mkSheet = () => {
  const data = [];
  return {
    _data: data,
    appendRow(r) { data.push(r.map(String)); },
    getLastRow() { return data.length; },
    getLastColumn() { return data[0] ? data[0].length : 0; },
    getMaxRows() { return 1000; },
    setFrozenRows() {},
    getDataRange() { return { getValues: () => data.map(r => r.slice()) }; },
    getRange(row, col, nr = 1, nc = 1) {
      return {
        setNumberFormat() { return this; },
        setFontWeight() { return this; },
        setValue(v) { (data[row - 1] ||= [])[col - 1] = String(v); return this; },
        setValues(vals) { vals.forEach((v, i) => { const r = (data[row - 1 + i] ||= []); v.forEach((x, j) => { r[col - 1 + j] = String(x); }); }); return this; },
        getValues() { return Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => (data[row - 1 + i] || [])[col - 1 + j] ?? '')); },
      };
    },
  };
};

const ctx = {
  SpreadsheetApp: { getActiveSpreadsheet: () => ({ getUrl: () => 'mock://sheet', getSheetByName: n => sheets.get(n) || null, insertSheet: n => { const s = mkSheet(); sheets.set(n, s); return s; } }) },
  Utilities: {
    getUuid: () => crypto.randomUUID(),
    computeDigest: (_a, s) => [...crypto.createHash('sha256').update(s, 'utf8').digest()].map(b => (b > 127 ? b - 256 : b)),
    base64Encode: bytes => Buffer.from(bytes.map(b => b & 255)).toString('base64'),
    formatDate: d => d.toISOString().slice(0, 10),
    DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
  },
  Session: { getScriptTimeZone: () => 'Asia/Seoul' },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
  MailApp: { sendEmail: (a, b, c) => mails.push(typeof a === 'string' ? { to: a, subject: b, body: c } : a), getRemainingDailyQuota: () => 100 },
  PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {} }) },
  Logger: { log() {} },
  ContentService: { MimeType: { JSON: 'json' }, createTextOutput: t => ({ text: t, setMimeType() { return this; } }) },
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(process.env.CODE || path.join(ROOT, 'apps-script/Code.gs'), 'utf8') + '\nthis.doPost = doPost;', ctx);

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.gs': 'text/plain' };
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(ctx.doPost({ postData: { contents: body } }).text); });
    return;
  }
  if (url.pathname === '/__mail') return res.end(JSON.stringify(mails.at(-1) || null));
  if (url.pathname === '/__sheets') return res.end(JSON.stringify(Object.fromEntries([...sheets].map(([k, v]) => [k, v._data]))));
  const p = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  let content = fs.readFileSync(f);
  if (p === '/js/config.js') content = Buffer.from(content.toString().replace(/API_URL: '[^']*'/, "API_URL: '/api'"));
  res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' });
  res.end(content);
}).listen(PORT, () => console.log(`mock server http://localhost:${PORT}`));
