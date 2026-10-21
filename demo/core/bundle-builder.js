'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

const DEFAULT_SOURCE = path.join(__dirname, '..', 'web', 'bundle');
const DEFAULT_OUT = path.join(__dirname, '..', 'dist');
const DEFAULT_KEY = path.join(__dirname, '..', 'dev-keys', 'bundle-signing-key.pem');
const KEY_ID = 'demo-dev-1';
const FORMAT = 1;

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function readLatest(outDir = DEFAULT_OUT) {
  try {
    return JSON.parse(fs.readFileSync(path.join(outDir, 'latest.json'), 'utf8'));
  } catch {
    return null;
  }
}

function readVersionManifest(outDir, version) {
  if (!/^[A-Za-z0-9._-]+$/.test(version)) return null;
  try {
    return JSON.parse(
      fs.readFileSync(
        path.join(outDir, 'bundles', version, 'manifest.json'),
        'utf8'
      )
    );
  } catch {
    return null;
  }
}

function listBuiltVersions(outDir) {
  try {
    return fs
      .readdirSync(path.join(outDir, 'bundles'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => /^[A-Za-z0-9._-]+$/.test(name));
  } catch {
    return [];
  }
}

function nextVersion(outDir = DEFAULT_OUT) {
  const latest = readLatest(outDir);
  const current = latest && /^v(\d+)$/.exec(latest.version || '');
  if (current) return `v${Number(current[1]) + 1}`;
  return 'v1';
}

function listFiles(root, base = root) {
  const out = [];
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.DS_Store') continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFiles(full, base));
    } else if (entry.isFile()) {
      const rel = path.relative(base, full).split(path.sep).join('/');
      if (rel === 'build-info.js') continue;
      out.push({ rel, full });
    }
  }
  return out;
}

function publicKeyBase64(keyPath = DEFAULT_KEY) {
  const privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath, 'utf8'));
  return crypto
    .createPublicKey(privateKey)
    .export({ type: 'spki', format: 'der' })
    .toString('base64');
}

async function buildBundle({
  sourceDir = DEFAULT_SOURCE,
  outDir = DEFAULT_OUT,
  version,
  keyPath = DEFAULT_KEY,
  logger = () => {},
} = {}) {
  const finalVersion = version || nextVersion(outDir);
  if (!/^[A-Za-z0-9._-]+$/.test(finalVersion)) {
    throw new Error(`invalid version: ${finalVersion}`);
  }

  const builtAt = new Date().toISOString();
  const sourceFiles = listFiles(sourceDir).sort((a, b) => a.rel.localeCompare(b.rel));
  if (!sourceFiles.some((file) => file.rel === 'index.html')) {
    throw new Error(`bundle source has no index.html: ${sourceDir}`);
  }

  const zip = new JSZip();
  const files = {};
  const contents = new Map();

  for (const file of sourceFiles) {
    const data = fs.readFileSync(file.full);
    files[file.rel] = {
      size: data.length,
      sha256: sha256(data),
    };
    contents.set(file.rel, data);
    zip.file(file.rel, data);
  }

  const buildInfo = `window.__BUNDLE_INFO__ = ${JSON.stringify(
    {
      version: finalVersion,
      builtAt,
    },
    null,
    2
  )};\n`;
  const buildInfoBuffer = Buffer.from(buildInfo, 'utf8');
  files['build-info.js'] = {
    size: buildInfoBuffer.length,
    sha256: sha256(buildInfoBuffer),
  };
  contents.set('build-info.js', buildInfoBuffer);
  zip.file('build-info.js', buildInfoBuffer);

  const manifest = {
    format: FORMAT,
    version: finalVersion,
    builtAt,
    entry: 'index.html',
    files,
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  zip.file('manifest.json', manifestBytes);

  const zipBuffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
    platform: 'UNIX',
  });

  const privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath, 'utf8'));
  const signature = crypto.sign('sha256', manifestBytes, privateKey).toString('base64');

  const buildDir = path.join(outDir, 'bundles', finalVersion);
  fs.mkdirSync(buildDir, { recursive: true });
  fs.writeFileSync(path.join(buildDir, 'manifest.json'), manifestBytes);
  fs.writeFileSync(path.join(buildDir, 'bundle.zip'), zipBuffer);

  // Generate a file-level patch from every retained version to this one.
  // The client picks the patch matching its active version and falls back to
  // the full bundle when there is no match or verification fails.
  const patches = {};
  for (const baseVersion of listBuiltVersions(outDir)) {
    if (baseVersion === finalVersion) continue;
    const baseManifest = readVersionManifest(outDir, baseVersion);
    if (!baseManifest || !baseManifest.files) continue;
    const patch = await buildPatchForBase({
      baseVersion,
      baseManifest,
      targetVersion: finalVersion,
      targetManifest: manifest,
      contents,
      buildDir,
      privateKey,
      fullSize: zipBuffer.length,
    });
    if (patch) patches[baseVersion] = patch;
  }

  const latest = {
    format: FORMAT,
    version: finalVersion,
    builtAt,
    entry: manifest.entry,
    fileCount: Object.keys(files).length,
    bundle: `bundles/${finalVersion}/bundle.zip`,
    manifest: `bundles/${finalVersion}/manifest.json`,
    size: zipBuffer.length,
    sha256: sha256(zipBuffer),
    keyId: KEY_ID,
    signature,
    patches,
  };

  fs.mkdirSync(outDir, { recursive: true });
  const latestTmp = path.join(outDir, `.latest-${process.pid}.tmp`);
  fs.writeFileSync(latestTmp, `${JSON.stringify(latest, null, 2)}\n`);
  fs.renameSync(latestTmp, path.join(outDir, 'latest.json'));

  logger(
    `[bundle] built ${finalVersion}: ${latest.fileCount} files, ` +
      `${(zipBuffer.length / 1024).toFixed(1)} KiB, sha256=${latest.sha256.slice(0, 12)}…`
  );
  const patchBases = Object.keys(patches);
  if (patchBases.length > 0) {
    logger(
      `[bundle] patches: ${patchBases
        .map((base) => {
          const patch = patches[base];
          return `${base}→${finalVersion} ${patch.changedCount} files/` +
            `${(patch.size / 1024).toFixed(1)} KiB`;
        })
        .join(', ')}`
    );
  }

  return { latest, manifest, manifestBytes, zipBuffer, buildDir, patches };
}

async function buildPatchForBase({
  baseVersion,
  baseManifest,
  targetVersion,
  targetManifest,
  contents,
  buildDir,
  privateKey,
  fullSize,
}) {
  const baseFiles = baseManifest.files || {};
  const targetFiles = targetManifest.files;
  const changed = Object.keys(targetFiles)
    .filter((name) => {
      const base = baseFiles[name];
      const target = targetFiles[name];
      return !base || base.size !== target.size || base.sha256 !== target.sha256;
    })
    .sort();
  const removed = Object.keys(baseFiles)
    .filter((name) => !targetFiles[name])
    .sort();

  if (changed.length === 0 && removed.length === 0) return null;

  const patchManifest = {
    format: FORMAT,
    kind: 'patch',
    version: targetVersion,
    baseVersion,
    builtAt: targetManifest.builtAt,
    entry: targetManifest.entry,
    files: targetFiles,
    changed,
    removed,
  };
  const manifestBytes = Buffer.from(
    `${JSON.stringify(patchManifest, null, 2)}\n`,
    'utf8'
  );

  const patchZip = new JSZip();
  for (const name of changed) {
    const data = contents.get(name);
    if (!data) throw new Error(`patch source missing: ${name}`);
    patchZip.file(name, data);
  }
  const zipBuffer = await patchZip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
    platform: 'UNIX',
  });

  const baseName = `patch-from-${baseVersion}`;
  fs.writeFileSync(path.join(buildDir, `${baseName}.json`), manifestBytes);
  fs.writeFileSync(path.join(buildDir, `${baseName}.zip`), zipBuffer);

  return {
    format: FORMAT,
    version: targetVersion,
    baseVersion,
    fileCount: Object.keys(targetFiles).length,
    changedCount: changed.length,
    removedCount: removed.length,
    changed,
    removed,
    manifest: `bundles/${targetVersion}/${baseName}.json`,
    zip: `bundles/${targetVersion}/${baseName}.zip`,
    size: zipBuffer.length,
    fullSize,
    sha256: sha256(zipBuffer),
    keyId: KEY_ID,
    signature: crypto
      .sign('sha256', manifestBytes, privateKey)
      .toString('base64'),
  };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const name = token.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) {
      args[name] = true;
    } else {
      args[name] = value;
      i += 1;
    }
  }
  return args;
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  buildBundle({
    sourceDir: args.source ? path.resolve(args.source) : DEFAULT_SOURCE,
    outDir: args.out ? path.resolve(args.out) : DEFAULT_OUT,
    keyPath: args.key ? path.resolve(args.key) : DEFAULT_KEY,
    version: typeof args.version === 'string' ? args.version : undefined,
    logger: console.log,
  })
    .then(({ latest }) => {
      console.log(`latest.json -> ${latest.version}`);
    })
    .catch((err) => {
      console.error(`build failed: ${err.message}`);
      process.exitCode = 1;
    });
}

module.exports = {
  buildBundle,
  readLatest,
  nextVersion,
  publicKeyBase64,
  sha256,
  DEFAULT_SOURCE,
  DEFAULT_OUT,
  DEFAULT_KEY,
  KEY_ID,
};
