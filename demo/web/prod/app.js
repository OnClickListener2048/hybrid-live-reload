(function () {
  'use strict';

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

    show(`收到回调 code=${code}\n正在向真实后端 /oauth/token 换取会话…`);
    try {
      const res = await fetch('/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      show({
        token_exchange: data,
        note: `Cookie 已写在 ${location.origin} 下。刷新或切换代理后登录态仍然有效。`,
      });
      history.replaceState({}, '', '/');
    } catch (err) {
      show(`换取会话失败：${err.message}`);
    }
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

  handleCallback().then(refreshAuth);
})();
