/* T&T Mobile — Gemini Panic model discovery & request control.
   Credential, discovery, and analysis sessions are deliberately independent.
   Keep keys out of URLs, persistent cache entries, logs and reports. */
(function () {
  'use strict';

  const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta/models';
  const CACHE_TTL_MS = 10 * 60 * 1000;
  const MAX_PAGES = 1000;
  const RETRY_DELAY_MS = 350;
  const MAX_OUTPUT_REQUEST = 8192;
  let models = [];
  let selectedModelId = '';
  let initialized = false;
  let keyReference = '';
  let credentialEpoch = 0;
  let discoveryEpoch = 0;
  let analysisEpoch = 0;
  let discoveryController = null;
  let discoveryPending = null;
  let cache = null;
  let discoveryState = 'unverified';
  let discoveryMessage = '';
  let analysisState = 'idle';
  let analysisMessage = '';
  const analysisControllers = new Set();
  // Only successful user-initiated structured JSON responses count as proof.
  // Scope: the current credential in memory; reset on change/removal.
  const verified = new Map();

  function idOf(value) {
    if (typeof value !== 'string') return '';
    const s = value.trim();
    const id = s.startsWith('models/') ? s.slice(7) : s;
    return /^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/.test(id) ? id : '';
  }

  function allowedModel(model) {
    if (!model || typeof model.name !== 'string' ||
        !/^models\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(model.name)) return false;
    if (!Array.isArray(model.supportedGenerationMethods) ||
        !model.supportedGenerationMethods.includes('generateContent')) return false;
    const id = idOf(model.name);
    if (!/^gemini-/i.test(id)) return false;
    // Exclude single-purpose media, audio, embeddings, robotics, tools and live.
    // This is a conservative feature filter, NOT a fixed generation allowlist.
    // Gemini Omni Flash is a dedicated video generation/editing family per Google model docs.
    // generateContent alone is NOT evidence of Panic-compatible structured JSON.
    const excluded = /(?:^|[-_.])(embedding|embed|tts|live|audio|speech|image|imagen|video|veo|omni|lyria|music|robotics|computer|native|banana|research|generation)(?:[-_.]|$)/i;
    if (excluded.test(id)) return false;
    const extra = /(?:image[-_]gen|text[-_]embedding|computer[-_]use|native[-_]audio|deep[-_]research)/i;
    if (extra.test(id)) return false;
    return true;
  }

  function modelById(id) { return models.find(m => idOf(m.name) === id) || null; }
  function error(message, code) {
    const e = new Error(message);
    e.safeMessage = message;
    if (code) e.code = code;
    return e;
  }
  function safeMessage(e) {
    if (e && e.safeMessage) return e.safeMessage;
    if (e && e.name === 'AbortError') return 'Yêu cầu Gemini hết thời gian hoặc bị ngắt.';
    return 'Lỗi mạng hoặc phản hồi không hợp lệ. Kiểm tra kết nối và thử lại.';
  }
  function apiError(status) {
    const descriptions = {
      400: 'Yêu cầu không hợp lệ hoặc model không hỗ trợ ảnh/JSON Schema. Không tự chuyển model.',
      401: 'API Key không hợp lệ hoặc chưa được cấp quyền.',
      403: 'API Key bị từ chối hoặc thiếu quyền sử dụng.',
      404: 'Model không tồn tại hoặc không khả dụng với API Key.',
      408: 'Máy chủ xử lý quá thời gian.',
      429: 'Hết hạn mức hoặc giới hạn tốc độ. Không đồng nghĩa model bắt buộc trả phí.'
    };
    const msg = descriptions[status] || (status >= 500
      ? 'Máy chủ Gemini đang lỗi (' + status + ').'
      : 'Gemini từ chối yêu cầu (' + status + ').');
    const e = error(msg);
    e.status = status;
    return e;
  }
  function activeCredentialToken() {
    const local = (typeof SETTINGS !== 'undefined' && SETTINGS && SETTINGS.geminiApiKey ? String(SETTINGS.geminiApiKey) : '').trim();
    if (local) return local;
    if (typeof SETTINGS !== 'undefined' && SETTINGS && SETTINGS.sharedGeminiConfigured === true) {
      const hasCloud = typeof ttCloudMode === 'function' && ttCloudMode() && !!(window.TTBackendSession && window.TTBackendSession.token);
      return '__SERVER__:' + String(SETTINGS.sharedGeminiToken || '') + ':' + (hasCloud ? 'auth' : 'noauth');
    }
    return '';
  }
  function isServerProxyToken(key) {
    return typeof key === 'string' && key.startsWith('__SERVER__:');
  }
  function currentState() {
    if (!activeCredentialToken()) return 'unconfigured';
    if (discoveryState === 'error' || discoveryState === 'empty') return discoveryState;
    if (analysisState === 'error') return 'error';
    if (analysisState === 'success') return 'success';
    if (analysisState === 'partial') return 'partial';
    if (discoveryState === 'loading') return 'loading';
    return discoveryState;
  }
  function renderBadge() {
    const badge = document.getElementById('gemini-status-badge');
    if (!badge) return;
    const state = currentState();
    let label = '', tone = 'neutral';
    if (state === 'unconfigured') { label = 'Chưa cấu hình API Key'; tone = 'error'; }
    else if (state === 'loading') label = 'Đang tải danh sách Gemini…';
    else if (state === 'error') { label = 'Gemini: lỗi kết nối/quyền/quota'; tone = 'error'; }
    else if (state === 'empty') { label = 'Không có model Panic phù hợp'; tone = 'error'; }
    else if (state === 'success') { label = 'Gemini: phân tích thành công'; tone = 'success'; }
    else if (state === 'partial') { label = 'Gemini: kết quả chưa đủ schema'; tone = 'neutral'; }
    else if (state === 'models') {
      if (selectedModelId && !modelById(selectedModelId)) {
        label = 'Model đã lưu không còn khả dụng'; tone = 'error';
      } else if (!selectedModelId) {
        label = 'Chưa chọn model Panic (vào Cài đặt)'; tone = 'neutral';
      } else {
        label = 'Panic AI: ' + selectedModelId; tone = 'success';
      }
    } else label = 'Đã lưu key — chưa xác minh';
    badge.replaceChildren();
    if (tone === 'error') {
      const icon = document.createElement('span');
      icon.className = 'tt-error-icon';
      icon.setAttribute('data-error-icon', 'true');
      icon.setAttribute('aria-hidden', 'true');
      icon.style.cssText = 'display:inline-flex;align-items:center;margin-right:5px;vertical-align:middle';
      icon.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>';
      badge.appendChild(icon);
    }
    badge.appendChild(document.createTextNode(label));
    const color = {
      neutral: ['var(--text2)', 'var(--bg3)', 'var(--border)'],
      success: ['#22c55e', 'rgba(34,197,94,.1)', 'rgba(34,197,94,.2)'],
      error: ['#ef4444', 'rgba(239,68,68,.1)', 'rgba(239,68,68,.2)']
    }[tone];
    badge.style.color = color[0];
    badge.style.background = color[1];
    badge.style.borderColor = color[2];
    badge.title = analysisMessage || discoveryMessage || label;
  }
  function fillModelSelect(selEl, selectedVal, blankText, hasKey) {
    if (!selEl) return;
    selEl.replaceChildren();
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = models.length
      ? blankText
      : (hasKey ? 'Chưa tải danh sách — bấm Tải danh sách model' : 'Nhập API Key trước để tải model');
    selEl.appendChild(blank);
    for (const model of models) {
      const id = idOf(model.name);
      const o = document.createElement('option');
      o.value = id;
      o.textContent = (model.displayName || id) + ' (' + id + ')';
      selEl.appendChild(o);
    }
    const val = idOf(selectedVal || '');
    if (val && !modelById(val)) {
      const savedOpt = document.createElement('option');
      savedOpt.value = val;
      savedOpt.textContent = val + (models.length ? ' (không còn trong danh sách)' : ' (đã lưu)');
      selEl.appendChild(savedOpt);
    }
    selEl.value = val || '';
    selEl.disabled = !hasKey && !val;
  }
  function renderSettingsModelControl(current, hasKey, msg) {
    const appVal = typeof SETTINGS !== 'undefined' && SETTINGS ? idOf(SETTINGS.imeiOcrModel || '') : '';
    fillModelSelect(document.getElementById('cfg-gemini-app-model'), appVal, 'Mặc định (gemini-flash-latest)', hasKey);
    fillModelSelect(document.getElementById('cfg-gemini-panic-model'), selectedModelId, 'Chọn model cho Panic Full...', hasKey);
    const cfgStatus = document.getElementById('cfg-gemini-model-status');
    const cfgRefresh = document.getElementById('btn-refresh-gemini-models');
    if (cfgStatus) {
      const appReady = !!(appVal && modelById(appVal));
      const panicReady = !!(selectedModelId && current);
      if (discoveryState === 'error') {
        cfgStatus.textContent = msg;
        cfgStatus.style.color = 'var(--red)';
      } else if (appReady || panicReady) {
        cfgStatus.textContent = 'Toàn app: ' + (appVal || 'Mặc định') + ' · Panic Full: ' + (selectedModelId || 'Chưa chọn') + '.';
        cfgStatus.style.color = panicReady ? 'var(--green)' : 'var(--text2)';
      } else {
        cfgStatus.textContent = msg;
        cfgStatus.style.color = 'var(--text3)';
      }
    }
    if (cfgRefresh) cfgRefresh.disabled = discoveryState === 'loading' || !hasKey;
  }
  function render() {
    if (!selectedModelId && typeof SETTINGS !== 'undefined' && SETTINGS && SETTINGS.geminiModel) {
      selectedModelId = idOf(SETTINGS.geminiModel);
    }
    const list = document.getElementById('gemini-menu-list');
    const status = document.getElementById('gemini-menu-status');
    const select = document.getElementById('gemini-model-select');
    const label = document.getElementById('gemini-selected-label');
    const refresh = document.getElementById('gemini-model-refresh');
    const current = modelById(selectedModelId);
    const hasKey = !!activeCredentialToken();
    let msg = '';
    if (!hasKey) msg = 'Chưa cấu hình API Key trong Cài đặt.';
    else if (discoveryState === 'loading') msg = 'Đang tải danh sách model…';
    else if (discoveryState === 'error') msg = discoveryMessage || 'Không tải được danh sách. Bấm làm mới.';
    else if (discoveryState === 'empty') msg = 'API không trả về model generateContent phù hợp.';
    else if (analysisState === 'partial') msg = 'Kết quả chưa đủ schema: không cấp bằng chứng tương thích để fallback.';
    else if (selectedModelId && !current && models.length) msg = 'Model đã lưu không còn trong danh sách. Chọn lại trước khi phân tích.';
    else if (!selectedModelId && models.length) msg = 'Đã tải ' + models.length + ' model. Chọn model cho Toàn app & Panic Full ở trên.';
    else if (models.length) msg = 'Đã tải ' + models.length + ' model (cache 10 phút).';
    else msg = 'Đã lưu key, chưa xác minh kết nối.';
    renderSettingsModelControl(current, hasKey, msg);
    renderBadge();
    if (!list || !status || !select || !label) return;
    label.textContent = selectedModelId
      ? (current ? ((current.displayName || selectedModelId) + ' (' + selectedModelId + ')')
        : 'Model đã lưu: ' + selectedModelId)
      : 'Chọn model Gemini';
    label.title = label.textContent;
    select.replaceChildren();
    const blank = document.createElement('option');
    blank.value = ''; blank.textContent = 'Chọn model'; select.appendChild(blank);
    list.replaceChildren();
    for (const model of models) {
      const id = idOf(model.name);
      const o = document.createElement('option');
      o.value = id;
      o.textContent = (model.displayName || id) + ' (' + id + ')';
      select.appendChild(o);
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'gemini-menu-item' + (id === selectedModelId ? ' active' : '');
      row.dataset.model = id;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(id === selectedModelId));
      const check = document.createElement('span');
      check.className = 'gemini-item-check';
      check.textContent = '✓';
      check.setAttribute('aria-hidden', 'true');
      check.style.visibility = id === selectedModelId ? 'visible' : 'hidden';
      const body = document.createElement('span');
      body.className = 'gemini-item-content';
      const name = document.createElement('span');
      name.className = 'gemini-item-title';
      name.textContent = model.displayName || id;
      const desc = document.createElement('span');
      desc.className = 'gemini-item-desc';
      const capabilities = verified.get(id);
      desc.textContent = id + ' · ' + (capabilities
        ? 'JSON đã xác minh: ' + [...capabilities].join(', ')
        : 'API liệt kê; ảnh/JSON chưa xác minh');
      body.append(name, desc);
      row.append(check, body);
      list.appendChild(row);
    }
    select.value = current ? selectedModelId : '';
    status.textContent = msg;
    status.setAttribute('role', discoveryState === 'error' ? 'alert' : 'status');
    if (refresh) refresh.disabled = discoveryState === 'loading' || !hasKey;
    const cb = document.getElementById('gemini-allow-fallback');
    if (cb) cb.checked = SETTINGS.geminiAllowFallback === true;
  }
  function storePreference() {
    // Updating Settings alone must not rewrite unrelated ticket/image DB.
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('suachua_settings') || '{}') || {}; } catch (_) {}
    saved.geminiModel = SETTINGS.geminiModel;
    saved.geminiAllowFallback = SETTINGS.geminiAllowFallback === true;
    localStorage.setItem('suachua_settings', JSON.stringify(saved));
  }
  function abortAnalysisControllers() {
    for (const controller of analysisControllers) controller.abort();
    analysisControllers.clear();
  }
  function selectModel(value) {
    const id = idOf(value);
    if (!id || !modelById(id)) return false;
    if (selectedModelId !== id) {
      analysisEpoch++;
      abortAnalysisControllers();
      analysisState = 'idle';
      analysisMessage = '';
    }
    selectedModelId = id;
    SETTINGS.geminiModel = id;
    storePreference();
    render();
    return true;
  }

  // Only credential change invalidates credentialEpoch. A discovery refresh
  // must NEVER invalidate an already running analysis of the same key.
  function invalidateKey() {
    const actual = activeCredentialToken();
    if (actual === keyReference) return;
    credentialEpoch++;
    discoveryEpoch++;
    analysisEpoch++;
    if (discoveryController) discoveryController.abort();
    discoveryController = null;
    discoveryPending = null;
    abortAnalysisControllers();
    models = [];
    cache = null;
    verified.clear();
    keyReference = actual;
    discoveryState = actual ? 'unverified' : 'unconfigured';
    discoveryMessage = '';
    analysisState = 'idle';
    analysisMessage = '';
    render();
  }
  function syncKey() {
    if (activeCredentialToken() !== keyReference) invalidateKey();
  }
  function beginAnalysis() {
    syncKey();
    analysisEpoch++;
    abortAnalysisControllers();
    analysisState = 'running';
    analysisMessage = '';
    render();
    return { credentialEpoch, analysisEpoch };
  }
  function isCurrentAnalysis(session) {
    syncKey();
    return !!session && session.credentialEpoch === credentialEpoch &&
      session.analysisEpoch === analysisEpoch;
  }
  function assertSession(session, key) {
    if (!isCurrentAnalysis(session) || key !== keyReference) {
      throw error('Phiên API/model đã thay đổi. Đã hủy kết quả cũ.', 'STALE_ANALYSIS');
    }
  }
  async function requestPage(key, controller, pageToken) {
    const serverMode = isServerProxyToken(key);
    if (serverMode && (typeof ttCloudMode !== 'function' || !ttCloudMode() || !window.TTBackendSession?.token)) {
      throw error('Cần đăng nhập phiên Cloud hợp lệ để tải danh sách model Gemini.');
    }
    const url = serverMode
      ? ('/api/gemini/models' + (pageToken ? '?pageToken=' + encodeURIComponent(pageToken) : ''))
      : (pageToken ? API_ROOT + '?pageToken=' + encodeURIComponent(pageToken) : API_ROOT);
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: serverMode
          ? { 'Authorization': 'Bearer ' + window.TTBackendSession.token }
          : { 'x-goog-api-key': key },
        signal: controller.signal,
        cache: 'no-store'
      });
      if (!res.ok) throw apiError(res.status);
      const data = await res.json();
      if (!data || !Array.isArray(data.models)) throw error('API trả danh sách model không hợp lệ.');
      return data;
    } finally { clearTimeout(timer); }
  }
  async function refreshModels(force) {
    syncKey();
    const key = keyReference;
    if (!key) { render(); return []; }
    if (discoveryPending && !force) return discoveryPending;
    if (!force && cache && cache.expiresAt > Date.now()) { render(); return models; }
    if (discoveryController) discoveryController.abort();
    const controller = new AbortController();
    discoveryController = controller;
    const thisDiscovery = ++discoveryEpoch;
    const thisCredential = credentialEpoch;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      discoveryState = 'error';
      discoveryMessage = 'Đang ngoại tuyến (Offline). Không thể tải danh sách model.';
      render();
      return [];
    }
    discoveryState = 'loading';
    discoveryMessage = '';
    render();
    const run = (async () => {
      const found = new Map(), seen = new Set();
      let pageToken = '', count = 0;
      do {
        if (++count > MAX_PAGES) throw error('Danh sách model quá nhiều trang.');
        const data = await requestPage(key, controller, pageToken);
        if (thisCredential !== credentialEpoch || thisDiscovery !== discoveryEpoch ||
            controller.signal.aborted) return [];
        for (const model of data.models) {
          if (allowedModel(model)) found.set(idOf(model.name), model);
        }
        pageToken = typeof data.nextPageToken === 'string' ? data.nextPageToken : '';
        if (pageToken && seen.has(pageToken)) throw error('API lặp nextPageToken.');
        if (pageToken) seen.add(pageToken);
      } while (pageToken);
      if (thisCredential !== credentialEpoch || thisDiscovery !== discoveryEpoch ||
          controller.signal.aborted) return [];
      models = [...found.values()].sort((a,b) =>
        (a.displayName || a.name).localeCompare(b.displayName || b.name));
      for (const id of verified.keys()) if (!modelById(id)) verified.delete(id);
      cache = { expiresAt: Date.now() + CACHE_TTL_MS };
      discoveryState = models.length ? 'models' : 'empty';
      render();
      return models;
    })().catch(e => {
      if (thisCredential !== credentialEpoch || thisDiscovery !== discoveryEpoch) return [];
      models = [];
      cache = null;
      discoveryState = 'error';
      discoveryMessage = safeMessage(e);
      render();
      return [];
    }).finally(() => {
      if (thisCredential === credentialEpoch && thisDiscovery === discoveryEpoch) {
        discoveryPending = null;
        discoveryController = null;
      }
    });
    discoveryPending = run;
    return run;
  }
  function initDropdown() {
    const trigger = document.getElementById('gemini-dropdown-trigger');
    const menu = document.getElementById('gemini-dropdown-menu');
    const list = document.getElementById('gemini-menu-list');
    const select = document.getElementById('gemini-model-select');
    if (!initialized) {
      selectedModelId = idOf(SETTINGS.geminiModel || '');
      keyReference = activeCredentialToken();
      if (trigger && menu && list && select) {
        trigger.addEventListener('click', event => {
          event.stopPropagation();
          const open = menu.classList.toggle('show');
          trigger.setAttribute('aria-expanded', String(open));
          if (open && (!cache || cache.expiresAt <= Date.now()) && !discoveryPending)
            void refreshModels(false);
        });
        list.addEventListener('click', event => {
          const target = event.target.closest('[data-model]');
          if (!target || !selectModel(target.dataset.model)) return;
          menu.classList.remove('show');
          trigger.setAttribute('aria-expanded', 'false');
        });
        select.addEventListener('change', () => selectModel(select.value));
        document.getElementById('gemini-model-refresh')?.addEventListener('click', event => {
          event.stopPropagation(); void refreshModels(true);
        });
        document.getElementById('gemini-allow-fallback')?.addEventListener('change', event => {
          SETTINGS.geminiAllowFallback = event.target.checked === true;
          storePreference(); render();
        });
        document.addEventListener('click', event => {
          if (!event.target.closest('#gemini-custom-dropdown')) {
            menu.classList.remove('show');
            trigger.setAttribute('aria-expanded', 'false');
          }
        });
      }
      const save = window.saveSettings;
      if (typeof save === 'function') {
        window.saveSettings = function() {
          const before = (SETTINGS.geminiApiKey || '').trim();
          const task = save.apply(this, arguments);
          if ((SETTINGS.geminiApiKey || '').trim() !== before) invalidateKey();
          return task;
        };
      }
      initialized = true;
    }
    syncKey(); render();
    if (keyReference && (!cache || cache.expiresAt <= Date.now()) && !discoveryPending)
      void refreshModels(false);
  }
  function selected() {
    syncKey();
    if (!selectedModelId || !modelById(selectedModelId) ||
        !cache || cache.expiresAt <= Date.now()) {
      throw error('Model chưa có trong danh sách API hiện tại. Làm mới và chọn model.');
    }
    return selectedModelId;
  }
  function outputTokenBudget(model) {
    if (!model || typeof model.outputTokenLimit !== 'number' ||
        !Number.isSafeInteger(model.outputTokenLimit) || model.outputTokenLimit <= 0) {
      throw error('Metadata outputTokenLimit không hợp lệ. Hãy làm mới danh sách model.');
    }
    return Math.min(MAX_OUTPUT_REQUEST, model.outputTokenLimit);
  }
  function recordVerified(id, inputKind) {
    const set = verified.get(id) || new Set();
    set.add(inputKind);
    verified.set(id, set);
  }
  function verifiedFallback(id, inputKind) {
    const proof = verified.get(id);
    return !!proof && proof.has(inputKind) && !!modelById(id) &&
      allowedModel(modelById(id));
  }
  // Validate against the existing PANIC_SCHEMA. Do not weaken or copy its required fields.
  // Only an ORIGINAL, complete JSON object with matching types can prove support.
  function matchesPanicSchema(value, schema) {
    if (!schema || typeof schema !== 'object') return false;
    const type = String(schema.type || '').toUpperCase();
    if (type === 'STRING') return typeof value === 'string';
    if (type === 'INTEGER') return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 100;
    if (type === 'NUMBER') return typeof value === 'number' && Number.isFinite(value);
    if (type === 'BOOLEAN') return typeof value === 'boolean';
    if (type === 'ARRAY') {
      return Array.isArray(value) && !!schema.items &&
        value.every(item => matchesPanicSchema(item, schema.items));
    }
    if (type === 'OBJECT') {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
      const fields = schema.properties || {};
      const required = Array.isArray(schema.required) ? schema.required : [];
      if (!required.every(name => Object.prototype.hasOwnProperty.call(value, name))) return false;
      return Object.keys(fields).every(name =>
        !Object.prototype.hasOwnProperty.call(value, name) ||
        matchesPanicSchema(value[name], fields[name]));
    }
    return false;
  }
  function originalSchemaProof(raw, finishReason) {
    // JSON.parse has no repair/recovery. docJsonGemini() intentionally may repair,
    // so its result must never be used as proof unless this strict check passes.
    if (finishReason !== 'STOP' || typeof raw !== 'string') return false;
    try {
      return matchesPanicSchema(JSON.parse(raw.trim()), PANIC_SCHEMA);
    } catch (_) { return false; }
  }
  function pause(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
  async function generateFor(modelId, model, parts, key, session) {
    const limit = outputTokenBudget(model); // Never exceed an API-reported limit.
    const payload = {
      contents: [{ parts }],
      generationConfig: {
        temperature: 0,
        topP: 0.1,
        maxOutputTokens: limit,
        responseMimeType: 'application/json',
        responseSchema: PANIC_SCHEMA
      }
    };
    const serverMode = isServerProxyToken(key);
    if (serverMode && (typeof ttCloudMode !== 'function' || !ttCloudMode() || !window.TTBackendSession?.token)) {
      throw error('Cần đăng nhập phiên Cloud hợp lệ (Admin/Kỹ thuật) để phân tích bằng Gemini.');
    }
    const url = serverMode
      ? ('/api/gemini/models/' + encodeURIComponent(modelId) + '/generateContent')
      : (API_ROOT + '/' + encodeURIComponent(modelId) + ':generateContent');
    for (let attempt = 0; attempt < 2; attempt++) {
      assertSession(session, key);
      const aborter = new AbortController();
      analysisControllers.add(aborter);
      const timeout = setTimeout(() => aborter.abort(), 30000);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: serverMode
            ? { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + window.TTBackendSession.token }
            : { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify(payload),
          signal: aborter.signal,
          cache: 'no-store'
        });
        assertSession(session, key); // Headers might have arrived for an old key.
        if (!res.ok) throw apiError(res.status);
        const data = await res.json();
        assertSession(session, key); // RACE01: body may arrive AFTER key removal.
        const candidate = data && data.candidates && data.candidates[0];
        const raw = ((candidate && candidate.content && candidate.content.parts) || [])
          .map(item => item.text || '').join('');
        const diagnosis = docJsonGemini(raw);
        if (!diagnosis || typeof diagnosis !== 'object' || Array.isArray(diagnosis) ||
            !(diagnosis.code || diagnosis.cause))
          throw error('Gemini không trả về JSON chẩn đoán hợp lệ.');
        // A syntactically valid but incomplete/wrongly typed object, a repaired
        // fragment, and any non-STOP response must NEVER confer fallback proof.
        const schemaVerified = originalSchemaProof(raw, candidate && candidate.finishReason);
        if (!schemaVerified) {
          const note = 'Kết quả AI chưa đủ schema hoặc JSON đã phục hồi/bị cắt. ' +
            'Chỉ tham khảo; không xác minh model để dùng dự phòng.';
          diagnosis.warning = ((typeof diagnosis.warning === 'string' && diagnosis.warning)
            ? diagnosis.warning + ' ' : '') + note;
          // Never re-label invalid or incomplete confidence as trustworthy.
          diagnosis.code='KHÔNG ĐỦ DỮ LIỆU';
          diagnosis.deviceModel='';
          diagnosis.confidence=0;
          diagnosis.evidence=[];
          diagnosis.errorLine='';
          diagnosis.cause='Kết quả AI thiếu trường hoặc sai định dạng.';
          diagnosis.solution='Thử lại với log đầy đủ và model phù hợp.';
          diagnosis.parts=[];
          diagnosis.steps=[];
        }
        assertSession(session, key); // Before releasing diagnosis and metadata.
        return {
          diagnosis,
          schemaVerified,
          actualModelId: typeof data.modelVersion === 'string' && data.modelVersion
            ? data.modelVersion : modelId
        };
      } catch (e) {
        assertSession(session, key);
        if (attempt === 0 && (e.status === 429 || e.status === 408 ||
            e.status >= 500 || e.name === 'AbortError')) {
          await pause(RETRY_DELAY_MS);
          assertSession(session, key); // No retry after credential/analysis change.
          continue;
        }
        throw e;
      } finally {
        clearTimeout(timeout);
        analysisControllers.delete(aborter);
      }
    }
  }
  async function callAI(logText, base64Image, apiKey, modelName, session) {
    syncKey();
    const run = session || beginAnalysis();
    assertSession(run, (apiKey || '').trim());
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      const offlineErr = error('Đang ngoại tuyến (Offline). Không thể gọi Gemini API.');
      analysisState = 'error';
      analysisMessage = safeMessage(offlineErr);
      render();
      throw offlineErr;
    }
    if (!selectedModelId && typeof SETTINGS !== 'undefined' && SETTINGS && SETTINGS.geminiModel) {
      selectedModelId = idOf(SETTINGS.geminiModel);
    }
    if (selectedModelId && (!cache || cache.expiresAt <= Date.now() || !modelById(selectedModelId))) {
      await refreshModels(false);
      assertSession(run, (apiKey || '').trim());
    }
    const requestedModelId = selected();
    if (idOf(modelName) !== requestedModelId)
      throw error('Lựa chọn model đã thay đổi. Vui lòng thử lại.');
    const kind = base64Image ? 'image' : 'text';
    const parts = [{ text: buildPanicPrompt(logText, kind === 'image') }];
    if (kind === 'image') {
      const match = /^data:(image\/(?:jpeg|png|webp|heic|heif));base64,([A-Za-z0-9+/=]+)$/i.exec(base64Image);
      if (!match) throw error('Định dạng ảnh không hợp lệ.');
      parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
    }
    const key = (apiKey || '').trim();
    assertSession(run, key);
    const candidates = [requestedModelId];
    if (SETTINGS.geminiAllowFallback === true) {
      const other = models.find(m => idOf(m.name) !== requestedModelId &&
        verifiedFallback(idOf(m.name), kind));
      if (other) candidates.push(idOf(other.name));
    }
    let lastError;
    for (let i = 0; i < candidates.length; i++) {
      const id = candidates[i];
      assertSession(run, key);
      try {
        const data = await generateFor(id, modelById(id), parts, key, run);
        assertSession(run, key);
        if (data.schemaVerified) recordVerified(id, kind); // Only original, complete STOP JSON matching PANIC_SCHEMA.
        assertSession(run, key);
        analysisState = data.schemaVerified ? 'success' : 'partial';
        analysisMessage = data.schemaVerified ? '' : 'Kết quả chưa đủ schema; không xác minh fallback.';
        render();
        assertSession(run, key);
        return {
          diagnosis: data.diagnosis,
          requestedModelId,
          actualModelId: data.actualModelId,
          fallbackUsed: i > 0,
          schemaVerified: data.schemaVerified
        };
      } catch (e) {
        assertSession(run, key);
        lastError = e;
        if (i >= candidates.length - 1 || !(e.status === 408 || e.status === 429 ||
            e.status >= 500 || e.name === 'AbortError')) break;
      }
    }
    assertSession(run, key);
    analysisState = 'error';
    analysisMessage = safeMessage(lastError);
    render();
    throw lastError;
  }
  window.initGeminiCustomDropdown = initDropdown;
  window.updateGeminiStatusBadge = renderBadge;
  window.callGeminiAI = callAI;
  window.geminiPanicModels = {
    refresh: refreshModels,
    choose: selectModel,
    render,
    beginAnalysis,
    isCurrentAnalysis,
    getModels: () => models.map(m => ({
      name: m.name, displayName: m.displayName,
      outputTokenLimit: m.outputTokenLimit,
      verifiedText: verifiedFallback(idOf(m.name), 'text'),
      verifiedImage: verifiedFallback(idOf(m.name), 'image')
    })),
    getSelected: () => selectedModelId || idOf(typeof SETTINGS !== 'undefined' && SETTINGS ? SETTINGS.geminiModel : ''),
    getCredentialEpoch: () => { syncKey(); return credentialEpoch; },
    getState: currentState,
    getMessage: () => analysisMessage || discoveryMessage,
    invalidateKey
  };
})();
