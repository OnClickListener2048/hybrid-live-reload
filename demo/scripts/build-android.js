'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const isWindows = process.platform === 'win32';
const projectDir = path.join(__dirname, '..', 'app-android');
const gradlew = isWindows ? 'gradlew.bat' : './gradlew';

const target = (process.argv[2] || process.env.ANDROID_FLAVOR || 'devShell').toLowerCase();
const known = {
  devshell: {
    task: 'assembleDevShellDebug',
    apk: 'app/build/outputs/apk/devShell/debug/app-devShell-debug.apk',
  },
  production: {
    task: 'assembleProductionDebug',
    apk: 'app/build/outputs/apk/production/debug/app-production-debug.apk',
  },
  all: {
    task: 'assembleDebug',
    apk: null,
  },
};

const selected = known[target];
if (!selected) {
  console.error(`Unknown Android target "${target}". Use devShell, production or all.`);
  process.exit(1);
}

const child = spawn(gradlew, [selected.task], {
  cwd: projectDir,
  stdio: 'inherit',
  shell: isWindows,
});

child.on('error', (err) => {
  console.error(`Failed to start Gradle: ${err.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`Gradle stopped by ${signal}`);
    process.exit(1);
  }
  if (code === 0 && selected.apk) {
    const apk = path.join(projectDir, selected.apk);
    if (fs.existsSync(apk)) {
      console.log(`\nAPK: ${apk}`);
    }
  }
  process.exit(code ?? 1);
});
