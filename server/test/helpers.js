import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULTS } from '../src/config.js';

/** A config object pointing at a throwaway data folder. */
export function testConfig(overrides = {}) {
  return {
    ...structuredClone(DEFAULTS),
    token: 'test-token',
    dataDir: mkdtempSync(join(tmpdir(), 'integratedai-test-')),
    ...overrides,
  };
}

/** Collect all events from an async generator. */
export async function collect(gen) {
  const out = [];
  for await (const ev of gen) out.push(ev);
  return out;
}
