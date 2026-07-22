/**
 * Always load SBTR / users / team mapping from the live API.
 * The bundle no longer ships booking data — SOBHA_PAYLOAD is empty.
 * PIN and SSO login both wait for /api/v1 before showing the dashboard.
 */
(function () {
  'use strict';

  var API_BASE = '/api/v1';
  var POLL_MS = 5000;
  var lastSeenRevision = null;
  var pollTimer = null;
  var refreshInFlight = false;
  var bootInFlight = false;
  var REVISION_KEY = 'sobha_data_revision';

  // Never trust any leftover embedded snapshot.
  window.SOBHA_PAYLOAD = { records: [], auth: {} };

  function token() {
    return sessionStorage.getItem('sobha_token') || '';
  }

  function authHeaders() {
    var headers = {
      Accept: 'application/json',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    };
    var t = token();
    if (t) headers.Authorization = 'Bearer ' + t;
    return headers;
  }

  function cacheBust(path) {
    var sep = path.indexOf('?') >= 0 ? '&' : '?';
    return path + sep + '_=' + Date.now();
  }

  function usersToAuth(users) {
    var auth = {};
    (users || []).forEach(function (u) {
      auth[u.username] = {
        pin: '',
        name: u.name,
        role: u.role,
        scope_type: u.scope_type,
        scope_value: u.scope_value,
        email: u.email || '',
      };
    });
    return auth;
  }

  function revisionFromMeta(meta) {
    if (!meta) return null;
    return [meta.updated_at || '', meta.sbtr_as_of || '', String(meta.row_count || 0)].join('|');
  }

  function ensureBootOverlayStyles() {
    if (document.getElementById('sobhaBootOverlayStyles')) return;
    var style = document.createElement('style');
    style.id = 'sobhaBootOverlayStyles';
    style.textContent = [
      'html.sobha-boot-lock, html.sobha-boot-lock body { overflow: hidden !important; height: 100%; }',
      'html.sobha-boot-lock #loginWrap,',
      'html.sobha-boot-lock #home,',
      'html.sobha-boot-lock #app,',
      'html.sobha-boot-lock #mappingView,',
      'html.sobha-boot-lock #__bundler_thumbnail,',
      'html.sobha-boot-lock #__bundler_loading {',
      '  visibility: hidden !important;',
      '  pointer-events: none !important;',
      '}',
      '#sobhaBootOverlay {',
      '  position: fixed;',
      '  inset: 0;',
      '  z-index: 2147483647;',
      '  display: none;',
      '  align-items: center;',
      '  justify-content: center;',
      '  background: #f8f6f1;',
      '  font-family: Calibri, "Trebuchet MS", sans-serif;',
      '  color: #1a1814;',
      '}',
      '#sobhaBootOverlay.sobha-boot-visible { display: flex; }',
      '#sobhaBootOverlay .sobha-boot-panel {',
      '  text-align: center;',
      '  padding: 48px 56px;',
      '  max-width: 420px;',
      '  width: calc(100% - 48px);',
      '}',
      '#sobhaBootOverlay .sobha-boot-brand {',
      '  font-family: Georgia, "Times New Roman", serif;',
      '  font-size: 34px;',
      '  font-weight: 700;',
      '  letter-spacing: 0.28em;',
      '  color: #b08a4e;',
      '  margin-bottom: 28px;',
      '}',
      '#sobhaBootOverlay .sobha-boot-rule {',
      '  width: 72px;',
      '  height: 3px;',
      '  background: linear-gradient(90deg, transparent, #b08a4e, transparent);',
      '  margin: 0 auto 32px;',
      '}',
      '#sobhaBootOverlay .sobha-boot-spinner {',
      '  width: 52px;',
      '  height: 52px;',
      '  margin: 0 auto 28px;',
      '  border: 3px solid #e8e3d7;',
      '  border-top-color: #b08a4e;',
      '  border-radius: 50%;',
      '  animation: sobhaBootSpin 0.9s linear infinite;',
      '}',
      '#sobhaBootOverlay.sobha-boot-error .sobha-boot-spinner { display: none; }',
      '#sobhaBootOverlay .sobha-boot-title {',
      '  font-size: 22px;',
      '  font-weight: 700;',
      '  letter-spacing: 0.04em;',
      '  margin-bottom: 10px;',
      '  color: #0d0c0a;',
      '}',
      '#sobhaBootOverlay .sobha-boot-sub {',
      '  font-size: 14px;',
      '  line-height: 1.6;',
      '  color: #8a8170;',
      '  min-height: 22px;',
      '}',
      '#sobhaBootOverlay.sobha-boot-error .sobha-boot-title { color: #b53a3a; }',
      '@keyframes sobhaBootSpin { to { transform: rotate(360deg); } }',
    ].join('\n');
    (document.head || document.documentElement).appendChild(style);
  }

  function lockBootScreen() {
    ensureBootOverlayStyles();
    document.documentElement.classList.add('sobha-boot-lock');
    var thumb = document.getElementById('__bundler_thumbnail');
    if (thumb) thumb.style.display = 'none';
    var loading = document.getElementById('__bundler_loading');
    if (loading) loading.style.display = 'none';
  }

  function unlockBootScreen() {
    document.documentElement.classList.remove('sobha-boot-lock');
  }

  function showBootOverlay(message, mode) {
    ensureBootOverlayStyles();
    lockBootScreen();
    var id = 'sobhaBootOverlay';
    var el = document.getElementById(id);
    // After document.replaceWith the old overlay node is gone — always recreate if missing.
    if (!el || !(document.body || document.documentElement).contains(el)) {
      if (el && el.parentNode) {
        try { el.parentNode.removeChild(el); } catch (e) {}
      }
      el = document.createElement('div');
      el.id = id;
      el.innerHTML =
        '<div class="sobha-boot-panel">' +
        '<div class="sobha-boot-brand">SOBHA</div>' +
        '<div class="sobha-boot-rule"></div>' +
        '<div class="sobha-boot-spinner" aria-hidden="true"></div>' +
        '<div class="sobha-boot-title"></div>' +
        '<div class="sobha-boot-sub"></div>' +
        '</div>';
      (document.body || document.documentElement).appendChild(el);
    }

    mode = mode || 'loading';
    var titleEl = el.querySelector('.sobha-boot-title');
    var subEl = el.querySelector('.sobha-boot-sub');
    el.classList.remove('sobha-boot-error', 'sobha-boot-static', 'sobha-boot-visible');

    if (mode === 'error') {
      el.classList.add('sobha-boot-error', 'sobha-boot-static', 'sobha-boot-visible');
      if (titleEl) titleEl.textContent = 'Unable to Load Data';
      if (subEl) subEl.textContent = message || 'Please refresh and try again.';
      return;
    }

    if (mode === 'signin') {
      el.classList.add('sobha-boot-visible');
      if (titleEl) titleEl.textContent = 'Signing You In';
      if (subEl) subEl.textContent = message || 'Verifying your credentials';
      return;
    }

    if (mode === 'prepare') {
      el.classList.add('sobha-boot-visible');
      if (titleEl) titleEl.textContent = 'Sobha Sales Performance';
      if (subEl) subEl.textContent = message || 'Preparing your workspace';
      return;
    }

    el.classList.add('sobha-boot-visible');
    if (titleEl) titleEl.textContent = 'Loading SBTR Data';
    if (subEl) {
      subEl.textContent =
        message || 'Fetching the latest sales performance report';
    }
  }

  function hideBootOverlay() {
    unlockBootScreen();
    var el = document.getElementById('sobhaBootOverlay');
    if (el) {
      el.classList.remove('sobha-boot-visible', 'sobha-boot-error', 'sobha-boot-static');
    }
  }

  window.sobhaShowBootOverlay = showBootOverlay;
  window.sobhaHideBootOverlay = hideBootOverlay;

  async function fetchMeta() {
    var res = await fetch(API_BASE + cacheBust('/meta'), {
      credentials: 'same-origin',
      headers: authHeaders(),
      cache: 'no-store',
    });
    if (!res.ok) throw new Error('/meta failed (' + res.status + ')');
    return res.json();
  }

  async function fetchDashboardPayload() {
    var headers = authHeaders();
    if (!token()) throw new Error('Not authenticated');

    async function get(path) {
      var res = await fetch(API_BASE + cacheBust(path), {
        credentials: 'same-origin',
        headers: headers,
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(path + ' failed (' + res.status + ')');
      return res.json();
    }

    var bookingsRes = await get('/bookings');
    var usersRes = await get('/users');
    var mappingRes = await get('/team-mapping');
    var metaRes = await get('/meta');

    return {
      records: bookingsRes.records || [],
      auth: usersToAuth(usersRes.users || []),
      mapping: mappingRes,
      meta: metaRes,
    };
  }

  function applyTeamMapping(mapping) {
    if (!mapping || !mapping.headers) return;
    window.TEAM_MAPPING_DEFAULT = mapping;
    window.mappingData = mapping;
    try {
      localStorage.setItem('sobha_team_mapping_v1', JSON.stringify(mapping));
    } catch (e) {}
  }

  function applyMeta(meta) {
    if (!meta) return;
    var el = document.getElementById('dataAsOf');
    if (el && meta.sbtr_as_of) el.textContent = meta.sbtr_as_of;
    var rev = revisionFromMeta(meta);
    if (rev) {
      lastSeenRevision = rev;
      try {
        localStorage.setItem(REVISION_KEY, rev);
      } catch (e) {}
    }
  }

  function applyRecordsToGlobals(payload) {
    if (payload.records) window.ALL = payload.records;
    if (payload.auth && Object.keys(payload.auth).length) window.AUTH = payload.auth;
    window._personIndex = null;
    window._orgTree = null;
    window._mappingCols = null;
    window._mapTree = null;
    applyTeamMapping(payload.mapping);
    applyMeta(payload.meta);
  }

  function showUpdateBanner() {
    var id = 'sobhaDataUpdateBanner';
    var existing = document.getElementById(id);
    if (existing) existing.remove();
    var banner = document.createElement('div');
    banner.id = id;
    banner.textContent = 'New SBTR data loaded';
    banner.style.cssText =
      'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:100000;' +
      'background:#0d0c0a;color:#f5ecd9;padding:10px 18px;border-radius:8px;' +
      'font:13px/1.4 Calibri,Trebuchet MS,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.2);';
    document.body.appendChild(banner);
    window.setTimeout(function () {
      if (banner.parentNode) banner.parentNode.removeChild(banner);
    }, 3500);
  }

  function getOriginalInit() {
    if (window.SOBHA_INIT && typeof window.SOBHA_INIT.__sobhaOriginal === 'function') {
      return window.SOBHA_INIT.__sobhaOriginal;
    }
    return null;
  }

  function runOriginalInit(records, auth) {
    var original = getOriginalInit();
    if (original) {
      original({ records: records || [], auth: auth || {} });
      return true;
    }
    if (typeof window.SOBHA_INIT === 'function' && !window.SOBHA_INIT.__apiWrapped) {
      window.SOBHA_INIT({ records: records || [], auth: auth || {} });
      return true;
    }
    return false;
  }

  function refreshDashboardUIIfOpen() {
    if (runOriginalInit(window.ALL, window.AUTH)) return;
    var home = document.getElementById('home');
    var app = document.getElementById('app');
    if (app && app.classList.contains('show') && typeof window.enterDashboard === 'function') {
      window.enterDashboard();
      return;
    }
    if (home && home.classList.contains('show') && typeof window.enterHome === 'function') {
      window.enterHome();
      return;
    }
    if (typeof window.applyFilters === 'function') window.applyFilters();
  }

  function fetchWithRetry(attempts, delayMs) {
    attempts = attempts || 8;
    delayMs = delayMs || 800;
    var tryOnce = function (left) {
      return fetchDashboardPayload().catch(function (err) {
        if (left <= 1) throw err;
        return new Promise(function (resolve) {
          window.setTimeout(resolve, delayMs);
        }).then(function () {
          return tryOnce(left - 1);
        });
      });
    };
    return tryOnce(attempts);
  }

  /**
   * Server-only boot for authenticated sessions (PIN or SSO).
   * Never uses embedded SOBHA_PAYLOAD booking data.
   */
  window.sobhaBootFromServer = function () {
    if (!token()) {
      hideBootOverlay();
      runOriginalInit([], {});
      return Promise.resolve(false);
    }
    if (bootInFlight) return Promise.resolve(false);
    if (window.__sobhaApiInitDone && window._sobhaReady) {
      hideBootOverlay();
      return Promise.resolve(true);
    }

    bootInFlight = true;
    showBootOverlay('Fetching the latest sales performance report');

    return fetchWithRetry(10, 1000)
      .then(function (fresh) {
        applyRecordsToGlobals(fresh);
        window.__sobhaApiInitDone = true;
        runOriginalInit(window.ALL, window.AUTH);
        window.setTimeout(hideBootOverlay, 150);
        startDatasetPoll();
        return true;
      })
      .catch(function (err) {
        console.error('[dashboard-data] server boot failed:', err.message || err);
        showBootOverlay(
          (err.message || 'Please check your connection and refresh the page.') +
            ' If this continues, contact your administrator.',
          'error'
        );
        return false;
      })
      .finally(function () {
        bootInFlight = false;
      });
  };

  function createWrappedInit(original) {
    if (!original || original.__apiWrapped) return original;
    function wrappedInit(payload) {
      // Logged out: empty shell is fine for the login screen.
      if (!token()) {
        original({ records: [], auth: {} });
        return;
      }
      // Logged in: ignore any payload (embedded or otherwise) — API only.
      window.sobhaBootFromServer();
    }
    wrappedInit.__apiWrapped = true;
    wrappedInit.__sobhaOriginal = original;
    return wrappedInit;
  }

  function installSobhaInitTrap() {
    if (window.__sobhaInitTrapInstalled) return;
    window.__sobhaInitTrapInstalled = true;
    var stored = null;
    try {
      Object.defineProperty(window, 'SOBHA_INIT', {
        configurable: true,
        enumerable: true,
        get: function () {
          return stored;
        },
        set: function (fn) {
          if (typeof fn !== 'function') {
            stored = fn;
            return;
          }
          if (fn.__apiWrapped) {
            stored = fn;
            return;
          }
          stored = createWrappedInit(fn);
        },
      });
    } catch (err) {
      console.warn('[dashboard-data] SOBHA_INIT trap failed:', err.message || err);
    }
  }

  async function apiLogin(username, password) {
    // Prefer shared API client (tries /api/v1 then /api) when available.
    if (window.API && typeof window.API.login === 'function') {
      return window.API.login(username, password);
    }

    var bases = [API_BASE, '/api'];
    var lastErr = null;
    for (var i = 0; i < bases.length; i++) {
      try {
        var res = await fetch(bases[i] + '/auth/login', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ username: username, password: password }),
          cache: 'no-store',
        });
        var data = null;
        try {
          data = await res.json();
        } catch (e) {}
        if (!res.ok) {
          var detail = data && data.detail ? data.detail : 'Invalid username or PIN';
          throw new Error(typeof detail === 'string' ? detail : 'Invalid username or PIN');
        }
        return data;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error('Invalid username or PIN');
  }

  function wrapSobhaInit() {
    if (typeof window.SOBHA_INIT !== 'function' || window.SOBHA_INIT.__apiWrapped) return;
    window.SOBHA_INIT = createWrappedInit(window.SOBHA_INIT);
  }

  var pinLoginBusy = false;

  function showLoginErrorFromQuery() {
    try {
      var params = new URLSearchParams(window.location.search || '');
      var msg = params.get('login_error');
      if (!msg) return;
      var err = document.getElementById('loginErr');
      if (err) {
        err.textContent = msg;
        err.classList.add('show');
      }
      // Clean the URL so refresh doesn't keep showing the error.
      if (window.history && window.history.replaceState) {
        window.history.replaceState({}, '', window.location.pathname || '/');
      }
    } catch (e) {}
  }

  /**
   * Cloudflare blocks JSON fetch POSTs to /api/v1/auth/login ("Just a moment…").
   * Use a classic form POST to /login instead (full page navigation).
   */
  function submitPinLoginForm(username, password) {
    var form = document.createElement('form');
    form.method = 'POST';
    form.action = '/login';
    form.acceptCharset = 'UTF-8';
    form.style.display = 'none';

    var u = document.createElement('input');
    u.type = 'hidden';
    u.name = 'username';
    u.value = username;
    form.appendChild(u);

    var p = document.createElement('input');
    p.type = 'hidden';
    p.name = 'password';
    p.value = password;
    form.appendChild(p);

    document.body.appendChild(form);
    form.submit();
  }

  /**
   * Canonical username/PIN login — always hits the server.
   * Used by patched bundle doLogin, window.doLogin trap, and capture listeners.
   */
  window.sobhaPinLogin = function sobhaPinLogin() {
    if (pinLoginBusy) return;
    var userEl = document.getElementById('loginUser');
    var pinEl = document.getElementById('loginPin');
    var err = document.getElementById('loginErr');
    var user = userEl ? userEl.value.trim().toLowerCase() : '';
    var pin = pinEl ? pinEl.value.trim() : '';

    if (!user || !pin) {
      if (err) {
        err.textContent = 'Enter username and PIN';
        err.classList.add('show');
      }
      return;
    }

    pinLoginBusy = true;
    if (err) {
      err.textContent = 'Signing in…';
      err.classList.add('show');
    }
    showBootOverlay('Verifying your credentials', 'signin');

    // Prefer form POST (Cloudflare-safe). Fall back to JSON API only on localhost.
    var host = (window.location && window.location.hostname) || '';
    var isLocal = host === 'localhost' || host === '127.0.0.1';
    if (!isLocal) {
      submitPinLoginForm(user, pin);
      return;
    }

    apiLogin(user, pin)
      .then(function (loginData) {
        if (!loginData || !loginData.token) {
          throw new Error('Login failed: no token returned');
        }
        sessionStorage.setItem('sobha_token', loginData.token);
        if (typeof window.sobhaMarkLoginForReload === 'function') {
          window.sobhaMarkLoginForReload();
        }

        if (loginData.role === 'admin' && user === 'admin') {
          window.location.href = '/admin';
          return null;
        }

        showBootOverlay('Preparing your dashboard');
        return fetchWithRetry(8, 800).then(function (fresh) {
          applyRecordsToGlobals(fresh);
          var profile = Object.assign(
            {
              username: loginData.username || user,
              name: loginData.name || user,
              role: loginData.role || 'viewer',
              scope_type: loginData.scope_type || 'all',
              scope_value: loginData.scope_value || '',
              email: loginData.email || '',
            },
            (fresh.auth && fresh.auth[user]) || {}
          );
          profile.pin = pin;
          window.AUTH = fresh.auth || {};
          window.currentUser = profile;
          sessionStorage.setItem('sobha_user_v5', JSON.stringify(profile));
          sessionStorage.setItem('sobha_user', JSON.stringify(profile));
          window.__sobhaApiInitDone = true;
          if (err) err.classList.remove('show');
          window.location.reload();
        });
      })
      .catch(function (e) {
        console.warn('[dashboard-data] PIN login failed:', e && e.message ? e.message : e);
        var msg = e && e.message ? e.message : 'Invalid username or PIN';
        if (e && e.cloudflare) {
          msg = 'Login blocked by Cloudflare. Retrying via secure form…';
          if (err) {
            err.textContent = msg;
            err.classList.add('show');
          }
          submitPinLoginForm(user, pin);
          return;
        }
        if (err) {
          err.textContent = msg;
          err.classList.add('show');
        }
        try {
          sessionStorage.removeItem('sobha_token');
        } catch (x) {}
        hideBootOverlay();
        pinLoginBusy = false;
      });
  };

  function installDoLoginTrap() {
    if (window.__sobhaDoLoginTrapInstalled) return;
    window.__sobhaDoLoginTrapInstalled = true;
    var stored = window.sobhaPinLogin;
    try {
      Object.defineProperty(window, 'doLogin', {
        configurable: true,
        enumerable: true,
        get: function () {
          return stored || window.sobhaPinLogin;
        },
        set: function () {
          // Bundle may assign doLogin — always keep the server-backed version.
          stored = window.sobhaPinLogin;
        },
      });
    } catch (err) {
      window.doLogin = window.sobhaPinLogin;
    }
  }

  function installPinLoginCaptureHandlers() {
    if (window.__sobhaPinLoginCaptureInstalled) return;
    window.__sobhaPinLoginCaptureInstalled = true;

    document.addEventListener(
      'click',
      function (event) {
        var btn =
          event.target && event.target.closest
            ? event.target.closest('.btn-login')
            : null;
        if (!btn) return;
        // Only on the dashboard login screen, not admin.
        if (window.location.pathname.indexOf('/admin') === 0) return;
        event.preventDefault();
        event.stopPropagation();
        window.sobhaPinLogin();
      },
      true
    );

    document.addEventListener(
      'keydown',
      function (event) {
        if (event.key !== 'Enter') return;
        var t = event.target;
        if (!t || !t.id) return;
        if (t.id !== 'loginUser' && t.id !== 'loginPin') return;
        if (window.location.pathname.indexOf('/admin') === 0) return;
        event.preventDefault();
        event.stopPropagation();
        window.sobhaPinLogin();
      },
      true
    );
  }

  function patchDoLogin() {
    installDoLoginTrap();
    installPinLoginCaptureHandlers();
    window.doLogin = window.sobhaPinLogin;
  }

  window.sobhaRefreshDashboardFromApi = function (opts) {
    opts = opts || {};
    if (!token() || refreshInFlight) return Promise.resolve(false);
    refreshInFlight = true;
    return fetchDashboardPayload()
      .then(function (fresh) {
        applyRecordsToGlobals(fresh);
        window.__sobhaApiInitDone = true;
        refreshDashboardUIIfOpen();
        if (opts.notify) showUpdateBanner();
        return true;
      })
      .catch(function (err) {
        console.warn('[dashboard-data] refresh failed:', err.message || err);
        return false;
      })
      .finally(function () {
        refreshInFlight = false;
      });
  };

  async function checkForDatasetUpdate() {
    if (!token() || document.hidden || refreshInFlight) return;
    try {
      var meta = await fetchMeta();
      var rev = revisionFromMeta(meta);
      if (!rev) return;

      if (lastSeenRevision == null) {
        lastSeenRevision = rev;
        try {
          localStorage.setItem(REVISION_KEY, rev);
        } catch (e) {}
        if (!window.__sobhaApiInitDone) {
          await window.sobhaRefreshDashboardFromApi({ notify: false });
        }
        return;
      }

      if (rev !== lastSeenRevision) {
        lastSeenRevision = rev;
        try {
          localStorage.setItem(REVISION_KEY, rev);
        } catch (e) {}
        await window.sobhaRefreshDashboardFromApi({ notify: true });
      }
    } catch (err) {
      // Ignore transient poll errors.
    }
  }

  function startDatasetPoll() {
    if (pollTimer) return;
    if (!token()) return;
    pollTimer = window.setInterval(checkForDatasetUpdate, POLL_MS);
    checkForDatasetUpdate();
  }

  window.sobhaInstallDashboardHooks = function () {
    wrapSobhaInit();
    patchDoLogin();
    if (!token()) {
      hideBootOverlay();
      return;
    }
    showBootOverlay('Fetching the latest sales performance report');
    if (typeof window.SOBHA_INIT === 'function') {
      window.sobhaBootFromServer();
    }
  };

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return;
    if (!token()) return;
    checkForDatasetUpdate();
  });

  window.addEventListener('storage', function (event) {
    if (event.key !== REVISION_KEY || !event.newValue || !token()) return;
    if (event.newValue === lastSeenRevision) return;
    lastSeenRevision = event.newValue;
    window.sobhaRefreshDashboardFromApi({ notify: true });
  });

  try {
    if (typeof BroadcastChannel !== 'undefined') {
      var channel = new BroadcastChannel('sobha_dataset');
      channel.onmessage = function (event) {
        if (!event || !event.data || event.data.type !== 'dataset-updated') return;
        if (!token()) return;
        if (event.data.revision && event.data.revision !== lastSeenRevision) {
          lastSeenRevision = event.data.revision;
        }
        window.sobhaRefreshDashboardFromApi({ notify: true });
      };
    }
  } catch (e) {}

  installSobhaInitTrap();
  installDoLoginTrap();
  installPinLoginCaptureHandlers();
  showLoginErrorFromQuery();
  // First paint cover: if scripts load while a session exists, never flash UI.
  // Logged-out visitors briefly see prepare splash until hooks reveal the login form.
  if (token()) {
    showBootOverlay('Fetching the latest sales performance report');
  } else {
    showBootOverlay('Preparing your workspace', 'prepare');
  }
  window.sobhaInstallDashboardHooks();
})();
