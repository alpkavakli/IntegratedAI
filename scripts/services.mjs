// @ts-check
/**
 * Register (or remove) the native messaging host that lets the extension's "Server" button start and
 * stop the local agent server (server/native-host/host.js). Run once per computer:
 *
 *   npm run services:install -- --id <extension id>   (the extension shows this command with its ID filled in)
 *   npm run services:uninstall
 *
 * It writes a small launcher and the host manifest to ~/.integratedai/native-host/ and tells Chrome
 * (and Chromium and Edge) where they are: on Windows in the registry (HKCU), on macOS and Linux in each
 * browser's NativeMessagingHosts folder. Only the extension IDs given here may use the host; IDs given
 * earlier are kept (a development copy and the Web Store version have different IDs).
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir } from '../server/src/config.js';

const NAME = 'com.integratedai.server';
const HOST = fileURLToPath(new URL('../server/native-host/host.js', import.meta.url));
const dir = join(dataDir(), 'native-host');
const manifestPath = join(dir, `${NAME}.json`);
const win = platform() === 'win32';

/** Browser registry keys (Windows) or manifest folders (macOS, Linux). */
const TARGETS = win
  ? ['Google\\Chrome', 'Chromium', 'Microsoft\\Edge'].map((b) => `HKCU\\Software\\${b}\\NativeMessagingHosts\\${NAME}`)
  : platform() === 'darwin'
    ? ['Google/Chrome', 'Chromium', 'Microsoft Edge'].map((b) => join(homedir(), 'Library/Application Support', b, 'NativeMessagingHosts'))
    : ['google-chrome', 'chromium', 'microsoft-edge'].map((b) => join(homedir(), '.config', b, 'NativeMessagingHosts'));

const [command = 'install', ...args] = process.argv.slice(2);
if (command === 'install') install();
else if (command === 'uninstall') uninstall();
else {
  console.error(`Unknown command "${command}": use install or uninstall`);
  process.exit(1);
}

function install() {
  const ids = [];
  for (let i = 0; i < args.length; i++) if (args[i] === '--id' && args[i + 1]) ids.push(args[++i]);
  for (const id of ids) {
    if (!/^[a-p]{32}$/.test(id)) {
      console.error(`"${id}" is not an extension ID (32 letters a–p; chrome://extensions shows it with Developer mode on).`);
      process.exit(1);
    }
  }
  const earlier = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')).allowed_origins ?? [] : [];
  const origins = [...new Set([...earlier, ...ids.map((id) => `chrome-extension://${id}/`)])];
  if (!origins.length) {
    console.error('Give the extension\'s ID: npm run services:install -- --id <id>\n'
      + '(The extension shows this command with its ID when you click its Server button.)');
    process.exit(1);
  }

  mkdirSync(dir, { recursive: true });
  // Chrome starts the launcher; it runs the host with this Node.js (the one running this script).
  const launcher = join(dir, win ? 'host.bat' : 'host.sh');
  writeFileSync(launcher, win
    ? `@echo off\r\n"${process.execPath}" "${HOST}" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${HOST}" "$@"\n`);
  if (!win) chmodSync(launcher, 0o755);
  writeFileSync(manifestPath, `${JSON.stringify({
    name: NAME,
    description: 'IntegratedAI: start and stop the local agent server',
    path: launcher,
    type: 'stdio',
    allowed_origins: origins,
  }, null, 2)}\n`);

  for (const target of TARGETS) {
    if (win) {
      execFileSync('reg', ['add', target, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], { stdio: 'ignore' });
    } else {
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, `${NAME}.json`), readFileSync(manifestPath));
    }
  }
  console.log(`Registered the IntegratedAI server helper for ${origins.length} extension ID(s).`);
  console.log('Reload the extension\'s panel; its Server button now starts and stops the server.');
}

function uninstall() {
  for (const target of TARGETS) {
    try {
      if (win) execFileSync('reg', ['delete', target, '/f'], { stdio: 'ignore' });
      else rmSync(join(target, `${NAME}.json`), { force: true });
    } catch { /* wasn't registered there */ }
  }
  rmSync(dir, { recursive: true, force: true });
  console.log('Removed the IntegratedAI server helper. (The server itself is untouched; npm start still works.)');
}
