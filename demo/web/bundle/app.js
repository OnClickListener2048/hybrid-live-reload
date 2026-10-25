(function () {
  'use strict';

  // ----- 改这里，重新构建 + 同步，手机上会立刻看到新文案 -----
  const BUNDLE_NOTE = '这是 v4：cleartext 已关闭，页面仍是本地包，增量补丁通过自定义 TCP 下载；origin 和 localStorage 仍然不变。';
  // -----------------------------------------------------------

  const $ = (id) => document.getElementById(id);
  const info = window.__BUNDLE_INFO__ || {
    version: 'source',
    builtAt: '未打包',
  };
  const params = new URLSearchParams(location.search);
  const nativeToken = params.get('token') || '';
  const isDevShell = /HybridDevShell/i.test(navigator.userAgent);

  function setOutput(text, kind) {
    const box = $('api-output');
    box.textContent =
      typeof text === 'string' ? text : JSON.stringify(text, null, 2);
    box.className = `output${kind ? ` ${kind}` : ''}`;
  }

  function renderEnvironment() {
    $('bundle-version').textContent = `bundle ${info.version}`;
    $('built-at').textContent = info.builtAt || '—';
    $('loaded-at').textContent = new Date().toLocaleTimeString('zh-CN', {
      hour12: false,
    });
    $('origin').textContent = location.origin;
    $('pathname').textContent = location.pathname + location.search;
    $('served-by').textContent = isDevShell
      ? 'DevShell 拦截 → 手机本地 bundle'
      : '没有 DevShell 标记（可能是生产服务器）';
    $('mode-label').textContent = isDevShell ? 'DevShell' : 'Browser';
    $('ua').textContent = navigator.userAgent;
    $('token').textContent = nativeToken || '(URL 里没有 token)';
    $('note').textContent = BUNDLE_NOTE;
  }

  function renderCounter() {
    const current = Number(localStorage.getItem('hybrid-demo-counter') || '0');
    $('counter').textContent = String(current);
  }

  async function callMe() {
    $('api-me').disabled = true;
    setOutput('请求 /api/me …');
    try {
      const headers = {};
      if (nativeToken) headers.authorization = `Bearer ${nativeToken}`;
      const res = await fetch('/api/me', { cache: 'no-store', headers });
      const body = await res.json();
      setOutput(
        {
          status: res.status,
          note: '这个请求由 WebView 直接发给生产 origin，不经过 bundle。',
          body,
        },
        res.ok ? 'ok' : 'err'
      );
    } catch (err) {
      setOutput(`请求失败：${err.message}`, 'err');
    } finally {
      $('api-me').disabled = false;
    }
  }

  async function callHealth() {
    $('api-health').disabled = true;
    setOutput('请求 /api/health …');
    try {
      const res = await fetch('/api/health', { cache: 'no-store' });
      setOutput(
        { status: res.status, body: await res.json() },
        res.ok ? 'ok' : 'err'
      );
    } catch (err) {
      setOutput(`请求失败：${err.message}`, 'err');
    } finally {
      $('api-health').disabled = false;
    }
  }

  $('api-me').addEventListener('click', callMe);
  $('api-health').addEventListener('click', callHealth);
  $('counter-btn').addEventListener('click', () => {
    const next = Number(localStorage.getItem('hybrid-demo-counter') || '0') + 1;
    localStorage.setItem('hybrid-demo-counter', String(next));
    renderCounter();
  });

  renderEnvironment();
  renderCounter();

  if (nativeToken) {
    callMe();
  } else {
    setOutput('Native 没有在 URL 里注入 token。点上面的按钮仍然可以检查后端。');
  }
})();
