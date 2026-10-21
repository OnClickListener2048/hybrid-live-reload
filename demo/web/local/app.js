(function () {
  'use strict';

  // ----- 改这里，保存后手机页面会自动刷新 -----
  const LOCAL_VERSION = 'local-v1';
  const LOCAL_NOTE = '编辑 web/local/app.js 里的 LOCAL_NOTE，保存后页面会自动刷新。';
  // --------------------------------------------

  window.__LOADED_AT__ = new Date().toISOString();

  const $ = (id) => document.getElementById(id);

  function show(value) {
    const text =
      typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    $('output').textContent = text;
  }

  function updateEnv() {
    $('origin').textContent = location.origin;
    $('href').textContent = location.href;
    $('served').textContent = window.__SERVED_BY__ || 'unknown';
    $('cookie').textContent = document.cookie || '(没有可见 Cookie)';
    if ($('local-version')) $('local-version').textContent = LOCAL_VERSION;
    if ($('loaded-at')) $('loaded-at').textContent = window.__LOADED_AT__;
    if ($('note')) $('note').textContent = LOCAL_NOTE;
  }

  async function refreshAuth() {
    updateEnv();
    $('auth').textContent = '检查中…';
    $('auth').className = 'muted';
    try {
      const res = await fetch('/api/me', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        $('auth').textContent = `已登录：${data.user}（session 来自 ${data.server}）`;
        $('auth').className = 'ok';
      } else {
        $('auth').textContent = '未登录';
        $('auth').className = 'muted';
      }
    } catch (err) {
      $('auth').textContent = `检查失败：${err.message}`;
      $('auth').className = 'muted';
    }
    updateEnv();
  }

  async function handleCallback() {
    const params = new URLSearchParams(location.search);
    const code = params.get('code');
    if (!code) return;

    show(`收到回调 code=${code}\n这一步的页面来自本地 dev server，但 /oauth/token 会透传到真实后端…`);
    try {
      const res = await fetch('/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      show({
        token_exchange: data,
        note: `Cookie 已写在 ${location.origin} 下。切换代理后登录态仍然有效。`,
        local_version: LOCAL_VERSION,
      });
      history.replaceState({}, '', '/');
    } catch (err) {
      show(`换取会话失败：${err.message}`);
    }
  }

  function connectLiveReload() {
    if (!('EventSource' in window)) return;
    const events = new EventSource('/__events');
    events.addEventListener('reload', () => {
      location.reload();
    });
    events.addEventListener('error', () => {
      // EventSource 会自动重连；这里不打断页面。
      console.warn('[hybrid-demo] live reload connection lost, retrying…');
    });
    window.addEventListener('beforeunload', () => events.close());
  }

  $('login').addEventListener('click', () => {
    show('跳转 /api/login/start → IdP → /callback');
    location.href = '/api/login/start';
  });

  $('logout').addEventListener('click', async () => {
    try {
      await fetch('/api/logout', { method: 'POST' });
      show('已退出，服务端 session 已删除');
      await refreshAuth();
    } catch (err) {
      show(`退出失败：${err.message}`);
    }
  });

  $('ping').addEventListener('click', async () => {
    try {
      const res = await fetch('/api/health', { cache: 'no-store' });
      show({ status: res.status, body: await res.json() });
    } catch (err) {
      show(`请求失败：${err.message}`);
    }
  });

  $('clear').addEventListener('click', async () => {
    try {
      await fetch('/api/logout', { method: 'POST' });
      document.cookie = 'demo_ui=; Max-Age=0; Path=/';
      show('Cookie 已清理');
      await refreshAuth();
    } catch (err) {
      show(`清理失败：${err.message}`);
    }
  });

  connectLiveReload();
  handleCallback().then(refreshAuth);
})();
