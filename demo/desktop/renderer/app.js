(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const state = {
    latest: null,
    logs: [],
    qrFor: null,
    sawLiveLog: false,
    logInitialized: false,
  };

  function formatTime(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '--:--:--';
    return date.toLocaleTimeString('zh-CN', { hour12: false });
  }

  function renderLogs() {
    const box = $('logs');
    const pinned =
      box.scrollTop + box.clientHeight >= box.scrollHeight - 24;
    box.textContent =
      state.logs.length === 0
        ? '等待日志…'
        : state.logs
            .map((entry) => `[${formatTime(entry.at)}] ${entry.line}`)
            .join('\n');
    if (pinned) box.scrollTop = box.scrollHeight;
  }

  function appendLog(entry) {
    if (!entry || typeof entry.line !== 'string') return;
    state.sawLiveLog = true;
    state.logs.push(entry);
    if (state.logs.length > 250) state.logs.shift();
    renderLogs();
  }

  function uiLog(line) {
    appendLog({ at: new Date().toISOString(), line: `[ui] ${line}` });
  }

  function applyStatus(status) {
    state.latest = status;

    const pill = $('status-pill');
    const text = $('status-text');
    if (status.running) {
      pill.className = 'pill running';
      text.textContent = '运行中';
    } else if (status.lastError) {
      pill.className = 'pill error';
      text.textContent = '启动失败';
    } else {
      pill.className = 'pill stopped';
      text.textContent = '已停止';
    }

    $('phone-url').textContent = status.phoneUrl || '—';
    $('proxy-address').textContent = status.phoneProxy || '—';
    $('prod-url').textContent = status.prodUrl || '—';
    $('local-url').textContent = status.localUrl || '—';
    $('idp-url').textContent = status.idpUrl || '—';

    $('proxy-toggle').checked = Boolean(status.proxyEnabled);
    $('lan-warning').hidden = !status.lanIpIsLoopback;
    $('btn-phone').textContent = status.phoneOpen
      ? '聚焦手机窗口'
      : '打开手机窗口';

    if (status.phoneUrl && status.phoneUrl !== state.qrFor) {
      updateQr(status.phoneUrl);
    }
  }

  async function updateQr(url) {
    state.qrFor = url;
    const img = $('qr');
    const placeholder = $('qr-placeholder');
    img.hidden = true;
    placeholder.hidden = false;
    placeholder.textContent = '生成中…';

    try {
      const dataUrl = await window.demo.getQr(url);
      if (state.qrFor !== url) return;
      if (!dataUrl) {
        placeholder.textContent = '二维码不可用';
        return;
      }
      img.src = dataUrl;
      img.hidden = false;
      placeholder.hidden = true;
    } catch (err) {
      if (state.qrFor !== url) return;
      placeholder.textContent = `二维码生成失败：${err.message}`;
    }
  }

  function flash(button, message) {
    const original = button.dataset.label || button.textContent;
    button.dataset.label = original;
    button.textContent = message;
    button.classList.add('flash');
    setTimeout(() => {
      if (button.dataset.label) button.textContent = button.dataset.label;
      button.classList.remove('flash');
    }, 1200);
  }

  async function copyText(text, button) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    flash(button, '已复制');
  }

  function guard(fn) {
    return async (...args) => {
      try {
        await fn(...args);
      } catch (err) {
        uiLog(`操作失败：${err.message}`);
      }
    };
  }

  function bindEvents() {
    $('btn-restart').addEventListener(
      'click',
      guard(async () => {
        const pill = $('status-pill');
        pill.className = 'pill starting';
        $('status-text').textContent = '重启中…';
        const status = await window.demo.restart();
        applyStatus(status);
      })
    );

    $('btn-phone').addEventListener(
      'click',
      guard(async () => {
        const status = await window.demo.openPhone();
        applyStatus(status);
        if (!status.running) uiLog('服务未运行，请先重启服务');
      })
    );

    $('proxy-toggle').addEventListener(
      'change',
      guard(async (event) => {
        const enabled = event.target.checked;
        uiLog(enabled ? '代理已开启，手机窗口加载本地代码' : '代理已关闭，手机窗口直连生产');
        try {
          const status = await window.demo.setProxy(enabled);
          applyStatus(status);
        } catch (err) {
          event.target.checked = !enabled;
          throw err;
        }
      })
    );

    $('btn-clear').addEventListener(
      'click',
      guard(async () => {
        uiLog('清理手机 Cookie 与服务端 session…');
        const status = await window.demo.clearSession();
        applyStatus(status);
      })
    );

    $('btn-copy-url').addEventListener('click', () => {
      if (state.latest) {
        copyText(state.latest.phoneUrl, $('btn-copy-url'));
      }
    });

    $('btn-copy-proxy').addEventListener('click', () => {
      if (state.latest) {
        copyText(state.latest.phoneProxy, $('btn-copy-proxy'));
      }
    });

    document.querySelectorAll('[data-open]').forEach((button) => {
      button.addEventListener('click', () => {
        if (!state.latest) return;
        const urls = {
          prod: state.latest.prodUrl,
          local: state.latest.localUrl,
          idp: state.latest.idpUrl,
        };
        const url = urls[button.dataset.open];
        if (url) window.demo.openUrl(url);
      });
    });
  }

  async function boot() {
    window.demo.onLog(appendLog);
    window.demo.onStatus(applyStatus);
    bindEvents();

    try {
      const status = await window.demo.getStatus();
      if (!state.sawLiveLog && !state.logInitialized) {
        state.logs = (status.logs || []).slice(-250);
        state.logInitialized = true;
        renderLogs();
      }
      applyStatus(status);
    } catch (err) {
      uiLog(`连接主进程失败：${err.message}`);
    }
  }

  boot();
})();
