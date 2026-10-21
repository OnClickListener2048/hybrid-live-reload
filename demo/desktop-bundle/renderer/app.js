(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const state = {
    latest: null,
    lastStatus: null,
    logs: [],
    qrFor: null,
    logInitialized: false,
    sawLiveLog: false,
  };

  function formatTime(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '--:--:--';
    return date.toLocaleTimeString('zh-CN', { hour12: false });
  }

  function formatDateTime(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString('zh-CN', { hour12: false });
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '—';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  }

  function renderLogs() {
    const box = $('logs');
    const pinned = box.scrollTop + box.clientHeight >= box.scrollHeight - 24;
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
    if (state.logs.length > 300) state.logs.shift();
    renderLogs();
  }

  function uiLog(line) {
    appendLog({ at: new Date().toISOString(), line: `[ui] ${line}` });
  }

  async function updateQr(url) {
    state.qrFor = url;
    const img = $('qr');
    const placeholder = $('qr-placeholder');
    img.hidden = true;
    placeholder.hidden = false;
    placeholder.textContent = '生成中…';

    try {
      const dataUrl = await window.bundleDemo.getQr(url);
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
      placeholder.textContent = `二维码失败：${err.message}`;
    }
  }

  function applyLatest(latest, status) {
    state.latest = latest;
    if (!latest) {
      $('latest-version').textContent = '—';
      $('latest-size').textContent = '—';
      $('latest-built-at').textContent = '—';
      $('latest-file-count').textContent = '—';
      $('latest-patches').textContent = '—';
      $('latest-sha').textContent = '—';
      $('latest-url').textContent = '—';
      $('file-list').textContent = '还没有构建包';
      return;
    }

    $('latest-version').textContent = latest.version;
    $('latest-size').textContent = formatBytes(latest.size);
    $('latest-built-at').textContent = formatDateTime(latest.builtAt);
    $('latest-file-count').textContent = `${latest.fileCount} 个`;
    const patches =
      latest.patches && typeof latest.patches === 'object'
        ? Object.entries(latest.patches)
        : [];
    $('latest-patches').textContent = patches.length
      ? patches
          .map(
            ([base, patch]) =>
              `${base} → ${latest.version}：${patch.changedCount} 个变化 / ${formatBytes(
                patch.size
              )}`
          )
          .join('\n')
      : '无（还没有可对比的旧版本）';
    $('latest-sha').textContent = latest.sha256 || '—';
    $('latest-url').textContent =
      `${status.bundleServerUrl}/${latest.bundle}?token=…`;
    const files = latest.files && latest.files.length ? latest.files : [];
    $('file-list').textContent = files.length
      ? files.map((file) => `· ${file}`).join('\n')
      : '—';
  }

  function applyStatus(status) {
    if (!status) return;
    state.lastStatus = status;
    $('build-source').textContent = status.sourceLabel || '—';

    const pill = $('status-pill');
    const text = $('status-text');
    if (status.running) {
      pill.className = 'pill running';
      text.textContent = status.building ? '构建中…' : '运行中';
    } else if (status.lastError) {
      pill.className = 'pill error';
      text.textContent = '启动失败';
    } else {
      pill.className = 'pill starting';
      text.textContent = '启动中…';
    }

    $('pair-link').textContent = status.pairLink || '—';
    $('emulator-link').textContent = status.pairLinkEmulator || '—';
    $('sync-token').textContent = status.syncToken || '—';
    $('lan-warning').hidden = !status.lanIpIsLoopback;
    $('build-state').textContent = status.building
      ? 'building…'
      : 'latest';
    $('btn-build').disabled = Boolean(status.building);
    $('btn-build').textContent = status.building
      ? '正在构建…'
      : '构建新版本';

    applyLatest(status.latest, status);

    const qrTarget = status.qrLink || status.pairLink;
    if (qrTarget && qrTarget !== state.qrFor) {
      updateQr(qrTarget);
    }
  }

  async function copyText(text, button) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    const original = button.textContent;
    button.textContent = '已复制';
    setTimeout(() => {
      button.textContent = original;
    }, 1200);
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
    $('btn-build').addEventListener(
      'click',
      guard(async () => {
        uiLog('开始构建新的 bundle…');
        const status = await window.bundleDemo.build();
        applyStatus(status);
      })
    );

    $('btn-prod').addEventListener('click', () => {
      if (state.lastStatus && state.lastStatus.prodUrl) {
        window.bundleDemo.openUrl(state.lastStatus.prodUrl);
      }
    });

    $('btn-restart').addEventListener(
      'click',
      guard(async () => {
        $('status-pill').className = 'pill starting';
        $('status-text').textContent = '重启中…';
        const status = await window.bundleDemo.restart();
        applyStatus(status);
      })
    );

    $('copy-pair').addEventListener('click', () =>
      copyText($('pair-link').textContent, $('copy-pair'))
    );
    $('copy-emulator').addEventListener('click', () =>
      copyText($('emulator-link').textContent, $('copy-emulator'))
    );
  }

  async function boot() {
    window.bundleDemo.onLog(appendLog);
    window.bundleDemo.onStatus(applyStatus);
    bindEvents();

    try {
      const status = await window.bundleDemo.getStatus();
      state.lastStatus = status;
      if (!state.sawLiveLog && !state.logInitialized) {
        state.logs = (status.logs || []).slice(-300);
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
