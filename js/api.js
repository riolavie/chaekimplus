class ApiError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

// 네트워크 문제로 실패한 경우(나중에 다시 시도하면 되는 경우)
const isNetErr = e => e && ['NETWORK', 'NO_URL', 'BUSY'].includes(e.code);

async function api(action, data = {}) {
  if (!CONFIG.API_URL) throw new ApiError('서버 주소(API_URL)가 설정되지 않았습니다.', 'NO_URL');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  let res;
  try {
    // text/plain 으로 보내야 Apps Script 에서 CORS 사전요청 없이 동작합니다.
    res = await fetch(CONFIG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, ...data }),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new ApiError('인터넷에 연결할 수 없습니다.', 'NETWORK');
  } finally {
    clearTimeout(timer);
  }
  let json;
  try {
    json = await res.json();
  } catch (e) {
    throw new ApiError('서버 응답을 읽을 수 없습니다.', 'NETWORK');
  }
  if (!json.ok) throw new ApiError(json.error || '서버 오류', json.code || 'SERVER');
  return json;
}

// 전송 대기열: 오프라인에서 만든 작업을 쌓아두었다가 연결되면 순서대로 전송
const Sync = {
  running: false,
  listeners: new Set(),
  onDone: async () => {},
  onAuthNeeded: () => {},

  notify() {
    this.listeners.forEach(fn => fn());
  },

  async enqueue(action, data, meta = {}) {
    await DB.outboxAdd({ action, data, ...meta, createdAt: Date.now(), error: null });
    this.notify();
    this.run();
  },

  async run() {
    if (this.running) return;
    this.running = true;
    this.notify();
    let authNeeded = false;
    try {
      const ops = await DB.outboxAll();
      for (const op of ops) {
        const data = { ...op.data };
        if (op.auth === 'teacher') {
          const s = await DB.get('teacherSession');
          if (!s || s.email !== op.email) { authNeeded = true; continue; }
          data.token = s.token;
        }
        try {
          const res = await api(op.action, data);
          await DB.outboxDel(op.id);
          await DB.set('lastSync', Date.now());
          await this.onDone(op, res);
        } catch (e) {
          if (isNetErr(e)) break;
          if (e.code === 'AUTH') { authNeeded = true; continue; }
          op.error = e.message;
          await DB.outboxPut(op);
        }
      }
    } finally {
      this.running = false;
      this.notify();
    }
    if (authNeeded) this.onAuthNeeded();
  },
};
