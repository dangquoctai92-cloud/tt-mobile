'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const TT_APP_ID = 'tt-mobile';
const DEFAULT_GEMINI_API_ROOT = 'https://generativelanguage.googleapis.com/v1beta/models';
const ALLOWED_GEMINI_ROLES = new Set(['admin', 'manager']);

function isValidScriptUrl(u) {
  if (typeof u !== 'string') return false;
  try {
    const p = new URL(u.trim());
    return p.protocol === 'https:' && p.hostname === 'script.google.com' &&
      /^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(p.pathname) &&
      !p.username && !p.password && !p.search && !p.hash;
  } catch (_) { return false; }
}

function toPublicConfig(cfg) {
  const c = cfg || { version: 0 };
  return {
    ok: true,
    version: Number(c.version || 0),
    updatedAt: c.updatedAt || null,
    updatedBy: c.updatedBy || null,
    scriptUrl: c.scriptUrl || '',
    datasetId: c.datasetId || '',
    geminiConfigured: !!(c.geminiApiKey && String(c.geminiApiKey).trim()),
    geminiUpdatedAt: c.geminiUpdatedAt || null,
    geminiUpdatedBy: c.geminiUpdatedBy || null
  };
}

function scryptHash(password, saltHex) {
  return crypto.scryptSync(String(password), String(saltHex), 32);
}

function createBootstrapVerifier(bootstrapOpts) {
  if (!bootstrapOpts) return null;
  const user = String(bootstrapOpts.username || '').trim();
  if (!user) return null;
  let saltHex = bootstrapOpts.salt ? String(bootstrapOpts.salt) : '';
  let expectedDigest = null;
  if (bootstrapOpts.passwordHashHex && saltHex) {
    expectedDigest = Buffer.from(String(bootstrapOpts.passwordHashHex), 'hex');
  } else if (bootstrapOpts.password) {
    saltHex = crypto.randomBytes(16).toString('hex');
    expectedDigest = scryptHash(bootstrapOpts.password, saltHex);
  } else {
    return null;
  }
  return {
    verify(candidateUser, candidatePass) {
      if (typeof candidateUser !== 'string' || typeof candidatePass !== 'string') return false;
      const uA = Buffer.from(candidateUser.trim(), 'utf8');
      const uB = Buffer.from(user, 'utf8');
      const userOk = uA.length === uB.length && crypto.timingSafeEqual(uA, uB);
      const candDigest = scryptHash(candidatePass, saltHex);
      const passOk = candDigest.length === expectedDigest.length && crypto.timingSafeEqual(candDigest, expectedDigest);
      return userOk && passOk ? { username: user, role: 'admin' } : false;
    }
  };
}

function rowToConfig(row) {
  if (!row) {
    return {
      version: 0, updatedAt: null, updatedBy: null,
      scriptUrl: '', datasetId: '', geminiApiKey: '',
      geminiUpdatedAt: null, geminiUpdatedBy: null
    };
  }
  return {
    version: Number(row.version || 0),
    updatedAt: row.updated_at || null,
    updatedBy: row.updated_by || null,
    scriptUrl: row.script_url || '',
    datasetId: row.dataset_id || '',
    geminiApiKey: row.gemini_api_key || '',
    geminiUpdatedAt: row.gemini_updated_at || null,
    geminiUpdatedBy: row.gemini_updated_by || null
  };
}

class SqliteConfigStore {
  constructor(dbPath) {
    this.dbPath = path.resolve(dbPath);
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS shared_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT,
        updated_by TEXT,
        script_url TEXT NOT NULL DEFAULT '',
        dataset_id TEXT NOT NULL DEFAULT '',
        gemini_api_key TEXT NOT NULL DEFAULT '',
        gemini_updated_at TEXT,
        gemini_updated_by TEXT
      );
      INSERT OR IGNORE INTO shared_config
        (id, version, updated_at, updated_by, script_url, dataset_id, gemini_api_key, gemini_updated_at, gemini_updated_by)
      VALUES (1, 0, NULL, NULL, '', '', '', NULL, NULL);
      CREATE TABLE IF NOT EXISTS token_origins (
        token_hash TEXT PRIMARY KEY,
        script_url TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    this._selectStmt = this.db.prepare('SELECT * FROM shared_config WHERE id = 1');
    this._getTokenOriginStmt = this.db.prepare('SELECT script_url FROM token_origins WHERE token_hash = ?');
    this._setTokenOriginStmt = this.db.prepare('INSERT INTO token_origins (token_hash, script_url, updated_at) VALUES (?, ?, ?) ON CONFLICT(token_hash) DO UPDATE SET script_url = excluded.script_url, updated_at = excluded.updated_at');
    this._pruneTokenOriginsStmt = this.db.prepare('DELETE FROM token_origins WHERE token_hash NOT IN (SELECT token_hash FROM token_origins ORDER BY updated_at DESC LIMIT 500)');
    this._updateCasStmt = this.db.prepare(`
      UPDATE shared_config
      SET version = ?, updated_at = ?, updated_by = ?, script_url = ?, dataset_id = ?,
          gemini_api_key = ?, gemini_updated_at = ?, gemini_updated_by = ?
      WHERE id = 1 AND version = ?
    `);
  }

  async read() {
    return rowToConfig(this._selectStmt.get());
  }

  async compareAndSwap({ expectedVersion, expectedDatasetId, buildNext }) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const cur = rowToConfig(this._selectStmt.get());
      if (Number(cur.version) !== Number(expectedVersion)) {
        this.db.exec('ROLLBACK');
        return { ok: false, reason: 'conflict', current: cur };
      }
      if (expectedDatasetId && cur.datasetId && cur.datasetId !== expectedDatasetId) {
        this.db.exec('ROLLBACK');
        return { ok: false, reason: 'dataset_mismatch', current: cur };
      }
      const nextCfg = buildNext(cur);
      const res = this._updateCasStmt.run(
        Number(nextCfg.version),
        nextCfg.updatedAt,
        nextCfg.updatedBy,
        nextCfg.scriptUrl,
        nextCfg.datasetId,
        nextCfg.geminiApiKey,
        nextCfg.geminiUpdatedAt,
        nextCfg.geminiUpdatedBy,
        Number(expectedVersion)
      );
      if (Number(res.changes) !== 1) {
        this.db.exec('ROLLBACK');
        const latest = rowToConfig(this._selectStmt.get());
        return { ok: false, reason: 'conflict', current: latest };
      }
      this.db.exec('COMMIT');
      return { ok: true, config: nextCfg };
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch (_) {}
      throw e;
    }
  }

  close() {
    try { this.db.close(); } catch (_) {}
  }

  _hashToken(token) {
    return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
  }

  async bindTokenOrigin(token, scriptUrl) {
    if (!token || !scriptUrl) return;
    const h = this._hashToken(token);
    this._setTokenOriginStmt.run(h, String(scriptUrl), Date.now());
    this._pruneTokenOriginsStmt.run();
  }

  async getTokenOrigin(token) {
    if (!token) return '';
    const row = this._getTokenOriginStmt.get(this._hashToken(token));
    return row && typeof row.script_url === 'string' ? row.script_url : '';
  }
}

function extractSessionToken(body, headers = {}) {
  const h = {};
  for (const [k, v] of Object.entries(headers || {})) h[k.toLowerCase()] = v;
  if (body && typeof body.sessionToken === 'string' && body.sessionToken.trim()) {
    return body.sessionToken.trim();
  }
  const auth = h.authorization;
  if (typeof auth === 'string' && /^Bearer\s+(.+)$/i.test(auth)) {
    return auth.replace(/^Bearer\s+/i, '').trim();
  }
  if (typeof h['x-tt-session-token'] === 'string' && h['x-tt-session-token'].trim()) {
    return h['x-tt-session-token'].trim();
  }
  return '';
}

function createSharedConfigService(opts = {}) {
  const store = opts.store || new SqliteConfigStore(opts.dbPath || opts.configFilePath);
  const fetchFn = opts.fetchFn || globalThis.fetch;
  const geminiApiRoot = opts.geminiApiRoot || DEFAULT_GEMINI_API_ROOT;
  const geminiTimeoutMs = Number(opts.geminiTimeoutMs) > 0 ? Number(opts.geminiTimeoutMs) : 12000;
  const bootstrapVerifier = createBootstrapVerifier(
    opts.bootstrapAdmin || (process.env.TT_BOOTSTRAP_ADMIN_USER && (process.env.TT_BOOTSTRAP_ADMIN_PASS || process.env.TT_BOOTSTRAP_ADMIN_HASH)
      ? {
          username: process.env.TT_BOOTSTRAP_ADMIN_USER,
          password: process.env.TT_BOOTSTRAP_ADMIN_PASS,
          passwordHashHex: process.env.TT_BOOTSTRAP_ADMIN_HASH,
          salt: process.env.TT_BOOTSTRAP_ADMIN_SALT
        }
      : null)
  );

  async function callBackendJson(scriptUrl, payload, timeoutMs = 9000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchFn(scriptUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      if (!res.ok) throw Object.assign(new Error('HTTP_' + res.status), { status: res.status });
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function verifyScriptCapabilities(url) {
    if (!isValidScriptUrl(url)) {
      return { ok: false, field: 'scriptUrl', errorCode: 'INVALID_SCRIPT_URL', message: 'URL Apps Script không hợp lệ (cần dạng https://script.google.com/macros/s/.../exec).' };
    }
    try {
      const info = await callBackendJson(url.trim(), { action: 'capabilities', requestedProtocol: 2 }, 9000);
      if (!info || info.ok !== true || info.action !== 'capabilities' ||
        info.appId !== TT_APP_ID || Number(info.protocolVersion) < 2 ||
        Number(info.schemaVersion) < 2 || !/^[A-Za-z0-9_-]{8,}$/.test(String(info.datasetId || '')) ||
        info.revisionAck !== true || info.imageAck !== true ||
        info.idempotency !== true || info.authRequired !== true) {
        return { ok: false, field: 'scriptUrl', errorCode: 'SCRIPT_URL_CAPABILITIES_INVALID', message: 'URL Apps Script không đáp ứng giao thức an toàn v2 hoặc thiếu datasetId hợp lệ.' };
      }
      return { ok: true, datasetId: String(info.datasetId), url: url.trim() };
    } catch (e) {
      return { ok: false, field: 'scriptUrl', errorCode: 'SCRIPT_URL_UNREACHABLE', message: 'Không kết nối được URL Apps Script (' + (e.message || 'timeout') + ').' };
    }
  }

  async function verifySessionAgainstActiveBackend(activeConfig, token, allowedRoles) {
    if (!token) {
      return { ok: false, status: 401, field: 'auth', errorCode: 'AUTH_REQUIRED', message: 'Cần phiên đăng nhập hợp lệ.' };
    }
    if (!isValidScriptUrl(activeConfig.scriptUrl) || !activeConfig.datasetId) {
      return { ok: false, status: 503, field: 'auth', errorCode: 'BACKEND_NOT_CONFIGURED', message: 'Máy chủ chưa cấu hình URL Apps Script hoạt động.' };
    }
    const boundOrigin = await store.getTokenOrigin?.(token);
    if (boundOrigin && boundOrigin !== activeConfig.scriptUrl) {
      return {
        ok: false,
        status: 401,
        field: 'auth',
        errorCode: 'TOKEN_ENDPOINT_MISMATCH',
        message: 'Phiên thuộc URL Apps Script cũ; vui lòng đăng nhập lại trên URL mới.'
      };
    }
    try {
      const who = await callBackendJson(activeConfig.scriptUrl, {
        action: 'whoami',
        appId: TT_APP_ID,
        protocolVersion: 2,
        datasetId: activeConfig.datasetId,
        sessionToken: token
      }, 9000);
      if (!who || who.ok !== true || who.action !== 'whoami' || !who.actor || !who.actor.username || who.datasetId !== activeConfig.datasetId) {
        return { ok: false, status: 401, field: 'auth', errorCode: (who && who.errorCode) || 'AUTH_REQUIRED', message: 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn.' };
      }
      if (!allowedRoles.has(String(who.actor.role))) {
        return { ok: false, status: 403, field: 'auth', errorCode: 'PERMISSION_DENIED', message: 'Tài khoản không có quyền thực hiện thao tác này.' };
      }
      if (!boundOrigin) {
        await store.bindTokenOrigin?.(token, activeConfig.scriptUrl);
      }
      return { ok: true, actor: who.actor, datasetId: who.datasetId, sessionToken: token, issuedByUrl: activeConfig.scriptUrl };
    } catch (e) {
      return { ok: false, status: 502, field: 'auth', errorCode: 'AUTH_BACKEND_ERROR', message: 'Không xác minh được phiên đăng nhập với backend (' + (e.message || 'error') + ').' };
    }
  }

  async function verifyConfigWriter(currentConfig, body, headers, nextScriptUrl) {
    // Initial setup (version === 0): MUST use server pre-configured bootstrap admin auth!
    if (Number(currentConfig.version || 0) === 0 || !currentConfig.scriptUrl) {
      if (!bootstrapVerifier) {
        return {
          ok: false,
          status: 403,
          field: 'auth',
          errorCode: 'BOOTSTRAP_ADMIN_NOT_CONFIGURED',
          message: 'Máy chủ chưa thiết lập tài khoản quản trị khởi tạo.'
        };
      }
      const username = String(body.adminUsername || '').trim();
      const password = String(body.adminPassword || '');
      if (!username || !password) {
        return { ok: false, status: 401, field: 'auth', errorCode: 'AUTH_REQUIRED', message: 'Cần tài khoản quản trị thiết lập sẵn trên máy chủ cho lần cài đặt đầu tiên.' };
      }
      const bootActor = bootstrapVerifier.verify(username, password);
      if (!bootActor) {
        return { ok: false, status: 401, field: 'auth', errorCode: 'BOOTSTRAP_AUTH_FAILED', message: 'Tài khoản hoặc mật khẩu quản trị khởi tạo không đúng.' };
      }
      return { ok: true, actor: bootActor, isBootstrap: true };
    }

    // Subsequent updates (version >= 1): verify against CURRENT trusted store Apps Script endpoint only!
    const token = extractSessionToken(body, headers);
    if (token) {
      return verifySessionAgainstActiveBackend(currentConfig, token, new Set(['admin']));
    }
    const username = String(body.adminUsername || '').trim();
    const password = String(body.adminPassword || '');
    if (!username || !password) {
      return { ok: false, status: 401, field: 'auth', errorCode: 'AUTH_REQUIRED', message: 'Cần đăng nhập tài khoản quản trị (admin) để ghi cấu hình chung.' };
    }
    try {
      const loginRes = await callBackendJson(currentConfig.scriptUrl, {
        action: 'login',
        appId: TT_APP_ID,
        protocolVersion: 2,
        datasetId: currentConfig.datasetId,
        username,
        password
      }, 9000);
      if (!loginRes || loginRes.ok !== true || !loginRes.actor) {
        return { ok: false, status: 401, field: 'auth', errorCode: (loginRes && loginRes.errorCode) || 'AUTH_FAILED', message: 'Tài khoản hoặc mật khẩu quản trị không đúng.' };
      }
      if (loginRes.actor.role !== 'admin') {
        return { ok: false, status: 403, field: 'auth', errorCode: 'PERMISSION_DENIED', message: 'Chỉ quản trị viên (admin) mới được phép đổi cấu hình chung.' };
      }
      if (loginRes.sessionToken) {
        await store.bindTokenOrigin?.(loginRes.sessionToken, currentConfig.scriptUrl);
      }
      return {
        ok: true,
        actor: loginRes.actor,
        sessionToken: loginRes.sessionToken,
        expiresAt: loginRes.expiresAt,
        datasetId: currentConfig.datasetId,
        issuedByUrl: currentConfig.scriptUrl
      };
    } catch (e) {
      const msg = (e && e.name === 'AbortError')
        ? 'Quá thời gian xác thực (9s) với máy chủ Apps Script hiện hành; hãy đăng nhập trước trên màn hình đăng nhập hoặc cập nhật backend-v2.gs.'
        : 'Không xác thực được với máy chủ Apps Script hiện hành (' + (e && e.message || 'failed') + ').';
      return { ok: false, status: 502, field: 'auth', errorCode: 'AUTH_BACKEND_ERROR', message: msg };
    }
  }

  async function verifyGeminiKey(apiKey) {
    const k = String(apiKey || '').trim();
    if (!k) return { ok: false, field: 'geminiApiKey', errorCode: 'GEMINI_KEY_EMPTY', message: 'Khóa Gemini trống.' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), geminiTimeoutMs);
    try {
      const res = await fetchFn(geminiApiRoot, {
        method: 'GET',
        headers: { 'x-goog-api-key': k },
        signal: controller.signal
      });
      if (!res.ok) {
        return { ok: false, field: 'geminiApiKey', errorCode: 'GEMINI_HTTP_' + res.status, message: 'Kiểm tra khóa Gemini thất bại (HTTP ' + res.status + ' — khóa sai hoặc bị từ chối).' };
      }
      const contentType = String(res.headers?.get?.('content-type') || '').toLowerCase();
      const rawText = await res.text();
      if (contentType.includes('text/html') || /^\s*</.test(rawText)) {
        return { ok: false, field: 'geminiApiKey', errorCode: 'GEMINI_HTML_RESPONSE', message: 'Phản hồi kiểm tra khóa Gemini trả về HTML không hợp lệ.' };
      }
      let data;
      try {
        data = JSON.parse(rawText);
      } catch (_) {
        return { ok: false, field: 'geminiApiKey', errorCode: 'GEMINI_INVALID_JSON', message: 'Phản hồi kiểm tra khóa Gemini không phải JSON hợp lệ.' };
      }
      if (!data || typeof data !== 'object' || data.error || !Array.isArray(data.models)) {
        return { ok: false, field: 'geminiApiKey', errorCode: 'GEMINI_MODELS_MISSING', message: 'Phản hồi kiểm tra khóa Gemini thiếu danh sách models hợp lệ.' };
      }
      return { ok: true };
    } catch (e) {
      if (e && e.name === 'AbortError') {
        return { ok: false, field: 'geminiApiKey', errorCode: 'GEMINI_TIMEOUT', message: 'Hết thời gian chờ khi kiểm tra khóa Gemini.' };
      }
      return { ok: false, field: 'geminiApiKey', errorCode: 'GEMINI_NETWORK_ERROR', message: 'Không kết nối được Gemini để kiểm tra khóa (' + (e.message || 'network') + ').' };
    } finally {
      clearTimeout(timer);
    }
  }

  async function getConfig() {
    const cfg = await store.read();
    return { status: 200, body: toPublicConfig(cfg) };
  }

  async function updateConfig(rawBody, headers = {}) {
    let body = rawBody;
    if (typeof rawBody === 'string') {
      try { body = JSON.parse(rawBody || '{}'); } catch (_) {
        return { status: 400, body: { ok: false, errorCode: 'INVALID_JSON', message: 'Dữ liệu cấu hình không hợp lệ.' } };
      }
    }
    if (!body || typeof body !== 'object') {
      return { status: 400, body: { ok: false, errorCode: 'INVALID_BODY', message: 'Thiếu dữ liệu cấu hình.' } };
    }

    const currentSnapshot = await store.read();
    const expectedVersion = Number(body.expectedVersion);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
      return {
        status: 400,
        body: { ok: false, field: 'version', errorCode: 'INVALID_EXPECTED_VERSION', message: 'Thiếu phiên bản cấu hình hiện tại (expectedVersion).', current: toPublicConfig(currentSnapshot) }
      };
    }

    const proposedScriptUrl = typeof body.scriptUrl === 'string' ? body.scriptUrl.trim() : '';
    const nextScriptUrl = proposedScriptUrl || currentSnapshot.scriptUrl || '';

    // 1. Admin auth FIRST (server bootstrap credentials at v0, or current Apps Script admin at v>=1)
    const authRes = await verifyConfigWriter(currentSnapshot, body, headers, nextScriptUrl);
    if (!authRes.ok) {
      return { status: authRes.status, body: { ok: false, field: authRes.field || 'auth', errorCode: authRes.errorCode, message: authRes.message, current: toPublicConfig(currentSnapshot) } };
    }

    // Pre-check version before expensive network calls
    if (expectedVersion !== Number(currentSnapshot.version || 0)) {
      return {
        status: 409,
        body: {
          ok: false,
          field: 'version',
          errorCode: 'CONFIG_VERSION_CONFLICT',
          message: 'Cấu hình chung đã được cập nhật lên phiên bản v' + currentSnapshot.version + (currentSnapshot.updatedBy ? ' bởi ' + currentSnapshot.updatedBy : '') + '. Vui lòng tải bản mới nhất trước khi lưu.',
          current: toPublicConfig(currentSnapshot)
        }
      };
    }

    if (!nextScriptUrl) {
      return {
        status: 422,
        body: { ok: false, field: 'scriptUrl', errorCode: 'SCRIPT_URL_REQUIRED', message: 'Vui lòng nhập URL Apps Script hợp lệ.', current: toPublicConfig(currentSnapshot) }
      };
    }

    // 2. Verify target URL capabilities & ENFORCE matching datasetId once dataset is pinned!
    const capCheck = await verifyScriptCapabilities(nextScriptUrl);
    if (!capCheck.ok) {
      return {
        status: 422,
        body: { ok: false, field: 'scriptUrl', errorCode: capCheck.errorCode, message: capCheck.message, current: toPublicConfig(currentSnapshot) }
      };
    }
    if (currentSnapshot.datasetId && capCheck.datasetId !== currentSnapshot.datasetId) {
      return {
        status: 409,
        body: {
          ok: false,
          field: 'scriptUrl',
          errorCode: 'DATASET_MISMATCH',
          message: 'URL Apps Script mới thuộc dataset khác (' + capCheck.datasetId + '), phải khớp dataset đang dùng của cửa hàng (' + currentSnapshot.datasetId + '). Giữ nguyên URL, khóa và dữ liệu chờ.',
          current: toPublicConfig(currentSnapshot)
        }
      };
    }

    // 3. Verify new Gemini key if provided
    const newKey = typeof body.geminiApiKey === 'string' ? body.geminiApiKey.trim() : '';
    if (newKey) {
      const keyCheck = await verifyGeminiKey(newKey);
      if (!keyCheck.ok) {
        return {
          status: 422,
          body: { ok: false, field: 'geminiApiKey', errorCode: keyCheck.errorCode, message: keyCheck.message, current: toPublicConfig(currentSnapshot) }
        };
      }
    }

    // 4. Transactional compare-and-set inside SQLite BEGIN IMMEDIATE (or DO transaction)
    const nowIso = new Date().toISOString();
    let cas;
    try {
      cas = await store.compareAndSwap({
        expectedVersion,
        expectedDatasetId: currentSnapshot.datasetId ? capCheck.datasetId : null,
        buildNext: (cur) => ({
          version: Number(cur.version || 0) + 1,
          updatedAt: nowIso,
          updatedBy: authRes.actor.username,
          scriptUrl: capCheck.url,
          datasetId: cur.datasetId || capCheck.datasetId,
          geminiApiKey: newKey || cur.geminiApiKey || '',
          geminiUpdatedAt: newKey ? nowIso : (cur.geminiUpdatedAt || null),
          geminiUpdatedBy: newKey ? authRes.actor.username : (cur.geminiUpdatedBy || null)
        })
      });
    } catch (e) {
      return {
        status: 500,
        body: {
          ok: false,
          field: 'storage',
          errorCode: 'CONFIG_WRITE_FAILED',
          message: 'Lỗi ghi cấu hình vào CSDL (' + (e.message || 'write_failed') + '); bản đang hoạt động được giữ nguyên.',
          current: toPublicConfig(await store.read())
        }
      };
    }

    if (!cas.ok) {
      if (cas.reason === 'dataset_mismatch') {
        return {
          status: 409,
          body: {
            ok: false,
            field: 'scriptUrl',
            errorCode: 'DATASET_MISMATCH',
            message: 'URL Apps Script mới không khớp dataset đang dùng (' + cas.current.datasetId + ').',
            current: toPublicConfig(cas.current)
          }
        };
      }
      return {
        status: 409,
        body: {
          ok: false,
          field: 'version',
          errorCode: 'CONFIG_VERSION_CONFLICT',
          message: 'Cấu hình chung vừa được cập nhật lên phiên bản v' + cas.current.version + (cas.current.updatedBy ? ' bởi ' + cas.current.updatedBy : '') + '. Vui lòng tải bản mới nhất trước khi lưu.',
          current: toPublicConfig(cas.current)
        }
      };
    }

    const urlChanged = !!(currentSnapshot.scriptUrl && currentSnapshot.scriptUrl !== cas.config.scriptUrl);
    const sameEndpointSession = (!urlChanged && authRes.sessionToken && authRes.issuedByUrl === cas.config.scriptUrl)
      ? {
          token: authRes.sessionToken,
          actor: authRes.actor,
          datasetId: cas.config.datasetId,
          url: authRes.issuedByUrl,
          expiresAt: authRes.expiresAt || null
        }
      : null;

    const out = {
      ...toPublicConfig(cas.config),
      ...(urlChanged ? { requiresReauth: true } : {}),
      ...(sameEndpointSession ? { authSession: sameEndpointSession } : {})
    };
    return { status: 200, body: out };
  }

  async function verifyGeminiAccess(headers) {
    const cfg = await store.read();
    const key = String(cfg.geminiApiKey || '').trim();
    if (!key) {
      return { ok: false, status: 400, error: { code: 400, errorCode: 'GEMINI_NOT_CONFIGURED', message: 'Chưa cấu hình khóa Gemini trên máy chủ.' } };
    }
    const token = extractSessionToken(null, headers);
    const sessionCheck = await verifySessionAgainstActiveBackend(cfg, token, ALLOWED_GEMINI_ROLES);
    if (!sessionCheck.ok) {
      return { ok: false, status: sessionCheck.status, error: { code: sessionCheck.status, errorCode: sessionCheck.errorCode, message: sessionCheck.message } };
    }
    return { ok: true, apiKey: key, actor: sessionCheck.actor };
  }

  async function proxyGeminiModels(searchParams, headers = {}) {
    const access = await verifyGeminiAccess(headers);
    if (!access.ok) {
      return { status: access.status, body: { ok: false, errorCode: access.error.errorCode, error: access.error } };
    }
    const pt = searchParams ? searchParams.get('pageToken') : '';
    const upstreamUrl = pt ? `${geminiApiRoot}?pageToken=${encodeURIComponent(pt)}` : geminiApiRoot;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await fetchFn(upstreamUrl, {
        method: 'GET',
        headers: { 'x-goog-api-key': access.apiKey },
        signal: controller.signal
      });
      const text = await res.text();
      return { status: res.status, rawBody: text, contentType: res.headers.get('content-type') || 'application/json; charset=utf-8' };
    } finally {
      clearTimeout(timer);
    }
  }

  async function proxyGeminiGenerate(modelId, rawBody, headers = {}) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/.test(String(modelId || ''))) {
      return { status: 400, body: { error: { code: 400, message: 'Tên model Gemini không hợp lệ.' } } };
    }
    const access = await verifyGeminiAccess(headers);
    if (!access.ok) {
      return { status: access.status, body: { ok: false, errorCode: access.error.errorCode, error: access.error } };
    }
    const upstreamUrl = `${geminiApiRoot}/${encodeURIComponent(modelId)}:generateContent`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const res = await fetchFn(upstreamUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': access.apiKey },
        body: typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody || {}),
        signal: controller.signal
      });
      const text = await res.text();
      return { status: res.status, rawBody: text, contentType: res.headers.get('content-type') || 'application/json; charset=utf-8' };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    getConfig,
    updateConfig,
    proxyGeminiModels,
    proxyGeminiGenerate,
    toPublicConfig,
    isValidScriptUrl
  };
}

module.exports = {
  SqliteConfigStore,
  createSharedConfigService,
  toPublicConfig,
  isValidScriptUrl
};
