'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const demoRoot = path.join(__dirname, '..');
const keyDir = path.join(demoRoot, 'dev-keys');
const privateKeyPath = path.join(keyDir, 'bundle-signing-key.pem');
const publicPemPath = path.join(keyDir, 'bundle-signing-key.pub.pem');
const publicBase64Path = path.join(keyDir, 'bundle-signing-key.pub.base64');
const configPath = path.join(
  demoRoot,
  'app-android/web-debug-plugin/src/main/kotlin/com/example/hybriddebug/DevShellConfig.kt'
);

const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
});

const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
const publicBase64 = publicKey
  .export({ type: 'spki', format: 'der' })
  .toString('base64');

fs.mkdirSync(keyDir, { recursive: true });
fs.writeFileSync(privateKeyPath, privatePem, { mode: 0o600 });
fs.writeFileSync(publicPemPath, publicPem);
fs.writeFileSync(publicBase64Path, `${publicBase64}\n`);

const config = fs.readFileSync(configPath, 'utf8');
const pattern =
  /(const val BUNDLE_PUBLIC_KEY_BASE64\s*=\s*\n?\s*")[^"]*(")/;
if (!pattern.test(config)) {
  throw new Error(
    `Could not find BUNDLE_PUBLIC_KEY_BASE64 in ${path.relative(demoRoot, configPath)}`
  );
}
const updated = config.replace(pattern, `$1${publicBase64}$2`);
fs.writeFileSync(configPath, updated);

console.log(`Private key: ${path.relative(demoRoot, privateKeyPath)} (gitignored)`);
console.log(`Public key:  ${path.relative(demoRoot, publicBase64Path)}`);
console.log(
  `Pinned key:  ${path.relative(demoRoot, configPath)} updated`
);
console.log(
  '\nRebuild the devShell APK before syncing: the installed app must trust this new public key.'
);
