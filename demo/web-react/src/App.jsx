import { useEffect, useState } from 'react';

const info = window.__BUNDLE_INFO__ || { version: 'source', builtAt: '未打包' };
const params = new URLSearchParams(location.search);
const nativeToken = params.get('token') || '';
const isDevShell = /HybridDevShell/i.test(navigator.userAgent);
const pageOrigin = location.origin;
const pathWithSearch = location.pathname + location.search;

export default function App() {
  const [counter, setCounter] = useState(0);
  const [output, setOutput] = useState('');
  const [outputKind, setOutputKind] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadedAt, setLoadedAt] = useState('');

  const servedBy = isDevShell
    ? 'DevShell 拦截 → 手机本地 bundle'
    : '没有 DevShell 标记（可能是生产服务器）';
  const tokenLabel = nativeToken || '(URL 里没有 token)';

  function showOutput(text, kind = '') {
    setOutput(typeof text === 'string' ? text : JSON.stringify(text, null, 2));
    setOutputKind(kind);
  }

  function bumpCounter() {
    const next = counter + 1;
    localStorage.setItem('hybrid-demo-counter', String(next));
    setCounter(next);
  }

  async function callMe() {
    setBusy(true);
    showOutput('请求 /api/me …');
    try {
      const headers = nativeToken
        ? { authorization: `Bearer ${nativeToken}` }
        : {};
      const res = await fetch('/api/me', { cache: 'no-store', headers });
      showOutput(
        {
          status: res.status,
          note: '这个请求由 WebView 直接发给生产 origin，不经过 bundle。',
          body: await res.json(),
        },
        res.ok ? 'ok' : 'err'
      );
    } catch (err) {
      showOutput(`请求失败：${err.message}`, 'err');
    } finally {
      setBusy(false);
    }
  }

  async function callHealth() {
    setBusy(true);
    showOutput('请求 /api/health …');
    try {
      const res = await fetch('/api/health', { cache: 'no-store' });
      showOutput(
        { status: res.status, body: await res.json() },
        res.ok ? 'ok' : 'err'
      );
    } catch (err) {
      showOutput(`请求失败：${err.message}`, 'err');
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    setLoadedAt(new Date().toLocaleTimeString('zh-CN', { hour12: false }));
    setCounter(Number(localStorage.getItem('hybrid-demo-counter') || '0'));
    if (nativeToken) {
      callMe();
    } else {
      showOutput('Native 没有在 URL 里注入 token。点上面的按钮仍然可以检查后端。');
    }
    // Runs once on mount, same as the previous demo app.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="page">
      <header className="hero">
        <div className="brand">
          <span className="logo">R</span>
          <div>
            <p className="eyebrow">REACT + VITE</p>
            <h1>真实构建产物，跑在本地 bundle 里</h1>
          </div>
        </div>
        <span className={isDevShell ? 'badge devshell' : 'badge'}>
          {isDevShell ? 'LOCAL BUNDLE' : 'PRODUCTION'}
        </span>
      </header>

      <p className="lede">
        `index.html` 和带 hash 的 `assets/` 来自手机本地包；`/api` 请求仍然直连生产
        origin。换 source 不需要改同步链路。
      </p>

      <section className="version-card">
        <div>
          <p className="eyebrow">BUNDLE VERSION</p>
          <strong>{info.version}</strong>
        </div>
        <div className="version-meta">
          <span>{info.builtAt}</span>
          <span>加载于 {loadedAt}</span>
        </div>
      </section>

      <section className="grid">
        <div className="cell">
          <span className="label">origin</span>
          <code>{pageOrigin}</code>
        </div>
        <div className="cell">
          <span className="label">pathname</span>
          <code>{pathWithSearch}</code>
        </div>
        <div className="cell">
          <span className="label">静态资源</span>
          <span>{servedBy}</span>
        </div>
        <div className="cell">
          <span className="label">native token</span>
          <code className="token">{tokenLabel}</code>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>localStorage</h2>
          <span className="hint">切换 bundle 版本后计数应保留</span>
        </div>
        <div className="counter">
          <button className="primary" type="button" onClick={bumpCounter}>
            +1
          </button>
          <strong>{counter}</strong>
          <span>hybrid-demo-counter</span>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>生产 API</h2>
          <span className="hint">不会被 bundle 拦截</span>
        </div>
        <div className="actions">
          <button
            className="primary"
            type="button"
            disabled={busy}
            onClick={callMe}
          >
            带 token 调 /api/me
          </button>
          <button
            className="secondary"
            type="button"
            disabled={busy}
            onClick={callHealth}
          >
            调 /api/health
          </button>
        </div>
        <pre className={`output ${outputKind}`}>{output}</pre>
      </section>

      <p className="foot">
        这是 Vite 构建出的真实 React 工程：`assets/index-*.js` 和
        `assets/index-*.css` 会作为普通文件进入 bundle，增量补丁也只下载发生变化的
        hashed 文件。
      </p>
    </main>
  );
}
