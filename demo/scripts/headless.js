'use strict';

const orchestrator = require('../core/orchestrator');

orchestrator.on('log', (entry) => {
  console.log(entry.line);
});

(async () => {
  try {
    const status = await orchestrator.start();
    console.log('');
    console.log('=== Hybrid Live Reload Demo ===');
    console.log('Phone URL   :', status.phoneUrl);
    console.log('Phone proxy :', status.phoneProxy);
    console.log('Local dev   :', status.localUrl);
    console.log('Fake IdP    :', status.idpUrl);
    if (status.lanIpIsLoopback) {
      console.log('');
      console.log('注意：没有检测到局域网 IP，手机无法直接访问。');
      console.log('连接 Wi-Fi 后重启，或用模拟器 / 桌面端的手机窗口。');
    }
    console.log('');
    console.log('手机 Wi-Fi 代理填上面的 proxy 地址，然后打开 Phone URL。');
    console.log('按 Ctrl+C 停止。');
  } catch (err) {
    console.error('启动失败：', err.message);
    process.exit(1);
  }
})();

async function shutdown() {
  await orchestrator.stop();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
