#!/usr/bin/env node
// @ts-check
/**
 * The "integratedai" command (from npm: npx integratedai, or npm install -g integratedai):
 *
 *   integratedai                     start the local agent server (prints the pairing token)
 *   integratedai install --id <id>   let the extension's Server button start and stop it (native messaging)
 *   integratedai uninstall           remove that again
 *   integratedai --version | --help
 */

import { readFileSync } from 'node:fs';

const [command] = process.argv.slice(2);
const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

if (!command) {
  await import('../src/index.js');
} else if (command === 'install' || command === 'uninstall') {
  // (scripts/services.mjs reads the same arguments: install/uninstall, then --id <id>.)
  await import('../../scripts/services.mjs');
} else if (command === '--version' || command === '-v') {
  console.log(version);
} else if (command === '--help' || command === '-h' || command === 'help') {
  console.log(`IntegratedAI agent server ${version}: lets the IntegratedAI Chrome extension use Claude Code or Codex
(your Claude or ChatGPT subscription) on this computer.

  integratedai                     start the server; paste the pairing token it prints into the extension's Options
  integratedai install --id <id>   let the extension's Server button start and stop the server
                                   (Options shows this command with your extension's ID)
  integratedai uninstall           remove the Server button's helper
  integratedai --version

Data, settings and the pairing token: ~/.integratedai/ (on Windows: C:\\Users\\<you>\\.integratedai\\)
Guide: https://github.com/alpkavakli/IntegratedAI#setup`);
} else {
  console.error(`Unknown command "${command}". Run "integratedai --help".`);
  process.exit(1);
}
