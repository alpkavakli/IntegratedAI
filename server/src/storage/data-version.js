// @ts-check
/**
 * Versioning for the server's data folder (~/.integratedai), so updates never
 * lose or corrupt conversations, site memory or settings.
 *
 *   <dataDir>/data-version.json   { "version": 1, "updatedAt": "…", "by": "0.1.0" }
 *
 * On every start:
 *   - version missing      → data from before versioning (or a fresh folder): stamp it as version 1
 *   - version < current    → back up the folder to <dataDir>/backups/before-v<N>-<date>/, then run
 *                            the migrations in order and stamp the new version
 *   - version > current    → this code is OLDER than the data (downgrade): refuse to start instead
 *                            of writing data in a format the newer version wouldn't expect
 *
 * To change a file format in a future update: add a migration to MIGRATIONS with
 * `to: <next version>` and bump DATA_VERSION. Migrations must be safe to re-run on
 * partially migrated data (the backup is there for anything else).
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The data format this version of the server reads and writes. */
export const DATA_VERSION = 1;

/** Folders that are not user data and are not backed up. */
const NOT_BACKED_UP = new Set(['backups', 'logs', 'claude-cli-workspace']);

/**
 * @typedef {{ to: number, description: string, run: (dataDir: string) => void }} Migration
 * @type {Migration[]}
 */
export const MIGRATIONS = [
  // Example for a future format change:
  // { to: 2, description: 'Add `pinned` to conversations', run: (dir) => { … } },
];

/**
 * Bring the data folder to DATA_VERSION. Returns what was done (for the startup log).
 * Throws if the data is newer than this code.
 * @param {string} dataDir
 * @param {{ appVersion?: string, migrations?: Migration[], currentVersion?: number }} [opts]  overrides for tests
 */
export function prepareDataDir(dataDir, opts = {}) {
  const migrations = opts.migrations ?? MIGRATIONS;
  const current = opts.currentVersion ?? DATA_VERSION;
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, 'data-version.json');
  const stamp = (/** @type {number} */ version) => writeFileSync(file, JSON.stringify({
    version, updatedAt: new Date().toISOString(), by: opts.appVersion ?? 'unknown',
  }, null, 2));

  if (!existsSync(file)) {
    stamp(current);
    return { from: null, to: current, backup: null, ran: [] };
  }

  const found = Number(JSON.parse(readFileSync(file, 'utf8')).version);
  if (!Number.isInteger(found) || found < 1) throw new Error(`Unreadable data version in ${file}`);
  if (found > current) {
    throw new Error(
      `Your data in ${dataDir} was written by a newer version of IntegratedAI (data version ${found}; this version understands ${current}). ` +
      'Update IntegratedAI instead of running an older version, so your conversations and memory are not damaged.',
    );
  }
  if (found === current) return { from: found, to: current, backup: null, ran: [] };

  const backup = backupDataDir(dataDir, `before-v${current}`);
  const ran = [];
  for (const migration of migrations.filter((m) => m.to > found && m.to <= current).sort((a, b) => a.to - b.to)) {
    migration.run(dataDir);
    stamp(migration.to);
    ran.push(`v${migration.to}: ${migration.description}`);
  }
  stamp(current);
  return { from: found, to: current, backup, ran };
}

/**
 * Copy the user data (not logs, backups or the CLI workspace) to <dataDir>/backups/<label>-<timestamp>/.
 * @param {string} dataDir
 * @param {string} label
 * @returns {string} the backup folder
 */
export function backupDataDir(dataDir, label) {
  const target = join(dataDir, 'backups', `${label}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(dataDir)) {
    if (NOT_BACKED_UP.has(entry)) continue;
    cpSync(join(dataDir, entry), join(target, entry), { recursive: true });
  }
  return target;
}

/**
 * Counts and locations for the "Your data" section of the extension options.
 * @param {string} dataDir
 */
export function dataInfo(dataDir) {
  const count = (/** @type {string} */ sub, /** @type {RegExp} */ pattern) => {
    try { return readdirSync(join(dataDir, sub)).filter((f) => pattern.test(f)).length; } catch { return 0; }
  };
  return {
    dataDir,
    dataVersion: DATA_VERSION,
    conversations: count('conversations', /^[0-9a-f-]{36}\.json$/),
    memorySites: count('memory', /\.json$/),
    backups: count('backups', /./),
  };
}
