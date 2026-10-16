// IndexedDB: 기기 안의 오프라인 저장소
//  - kv: 로그인 정보, 학급 설정, 기록 캐시 등
//  - outbox: 인터넷이 연결되면 서버로 보낼 작업 대기열
const DB = (() => {
  let dbp;

  function open() {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        const req = indexedDB.open('class-check', 1);
        req.onupgradeneeded = () => {
          const d = req.result;
          d.createObjectStore('kv');
          d.createObjectStore('outbox', { keyPath: 'id', autoIncrement: true });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbp;
  }

  async function tx(store, mode, fn) {
    const d = await open();
    return new Promise((resolve, reject) => {
      const t = d.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  return {
    get: key => tx('kv', 'readonly', s => s.get(key)),
    set: (key, val) => tx('kv', 'readwrite', s => s.put(val, key)),
    del: key => tx('kv', 'readwrite', s => s.delete(key)),
    outboxAll: () => tx('outbox', 'readonly', s => s.getAll()),
    outboxAdd: op => tx('outbox', 'readwrite', s => s.add(op)),
    outboxPut: op => tx('outbox', 'readwrite', s => s.put(op)),
    outboxDel: id => tx('outbox', 'readwrite', s => s.delete(id)),
  };
})();
