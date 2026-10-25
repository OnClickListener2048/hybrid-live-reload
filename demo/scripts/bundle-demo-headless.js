'use strict';

const path = require('path');
const orchestrator = require('../core/bundle-orchestrator');

function parseSourceArg(argv) {
  const index = argv.indexOf('--source');
  if (index === -1) return null;
  const value = argv[index + 1];
  return value && !value.startsWith('--') ? value : null;
}

const sourceArg = parseSourceArg(process.argv);
if (sourceArg) {
  orchestrator.setSourceDir(path.resolve(path.join(__dirname, '..'), sourceArg));
}

let stopping = false;
let printed = false;

function printStatus(status) {
  printed = true;
  console.log('');
  console.log('Bundle Sync Demo (headless)');
  console.log(`  production page : ${status.prodUrl}`);
  console.log(`  Android emu prod: ${status.prodEmulatorUrl}`);
  console.log(`  bundle server   : ${status.bundleServerUrl}`);
  console.log(`  emulator sync   : ${status.bundleServerEmulatorUrl}`);
  console.log(`  build source    : ${status.sourceLabel || '—'}`);
  console.log(`  latest          : ${status.latest ? status.latest.version : '(none)'}`);
  console.log('');
  console.log('  Real phone pairing link (also shown as QR in the desktop app):');
  console.log(`  ${status.pairLink}`);
  console.log('');
  console.log('  Emulator deep link:');
  console.log(`  ${status.pairLinkEmulator}`);
  console.log('');
}

async function main() {
  orchestrator.on('log', (entry) => console.log(entry.line));
  orchestrator.on('status', (status) => {
    if (status.running) printStatus(status);
  });

  const status = await orchestrator.start();
  if (!printed) printStatus(status);
  console.log('Press Ctrl+C to stop.');

  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n${signal}: stopping...`);
    await orchestrator.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(async (err) => {
  console.error(`start failed: ${err.stack || err.message}`);
  await orchestrator.stop().catch(() => {});
  process.exit(1);
});
