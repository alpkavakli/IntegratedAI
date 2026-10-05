// @ts-check
/**
 * Site memory on the agent server: one JSON file per site in <dataDir>/memory/.
 * The memory logic itself (notes, page groups, what the model sees) is shared
 * with the extension's direct mode: extension/shared/agent/memory.js.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryStore as SharedMemoryStore } from '../../../extension/shared/agent/memory.js';

export { MEMORY_LIMITS } from '../../../extension/shared/agent/memory.js';

export class MemoryStore extends SharedMemoryStore {
  /** @param {string} dataDir */
  constructor(dataDir) {
    const dir = join(dataDir, 'memory');
    mkdirSync(dir, { recursive: true });
    const file = (/** @type {string} */ site) => join(dir, `${site.replace(/[^a-z0-9.-]/gi, '_')}.json`);
    super({
      read: (site) => (existsSync(file(site)) ? JSON.parse(readFileSync(file(site), 'utf8')) : null),
      write: (memory) => {
        // Write to a temporary file, then rename: a crash never leaves half a file.
        writeFileSync(`${file(memory.site)}.tmp`, JSON.stringify(memory, null, 1));
        renameSync(`${file(memory.site)}.tmp`, file(memory.site));
      },
    });
    this.dir = dir;
  }
}
