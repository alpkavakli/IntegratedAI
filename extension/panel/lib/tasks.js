// @ts-check
/**
 * Saved tasks: page steps from an agent turn that worked, kept so the user can run them again
 * with one click, without asking the AI (free, fast, the same every time). Stored in
 * chrome.storage.local under "tasks", like patches; nothing leaves the browser.
 *
 * A task: { id, name, site, startUrl, steps, created, lastRun? }. steps are recorded by
 * AgentRunner (recordStep): targets that survive a reload, and never a password field's value.
 */

import { validateTaskSteps } from '../../shared/actions.js';
import { siteKey } from '../../shared/page-groups.js';

/** @typedef {import('./agent-runner.js').TaskStep} TaskStep */
/** @typedef {{ id: string, name: string, site: string, startUrl: string, steps: TaskStep[], created: number, lastRun?: number }} Task */

const KEY = 'tasks';
/** Plenty for one person; keeps storage small. */
const MAX_TASKS = 200;

/** @returns {Promise<Task[]>} newest first */
export async function listTasks() {
  const data = await chrome.storage.local.get(KEY);
  return /** @type {Task[]} */ (data[KEY] ?? []);
}

/**
 * Save a new task.
 * @param {{ name: string, startUrl: string, steps: TaskStep[] }} task
 * @returns {Promise<Task>}
 */
export async function saveTask({ name, startUrl, steps }) {
  if (!steps.length) throw new Error('There are no steps to save');
  const errors = validateTaskSteps(steps);
  if (errors.length) throw new Error(`These steps can't be saved: ${errors[0]}`);
  const task = {
    id: crypto.randomUUID(),
    name: name.trim().slice(0, 80) || 'Untitled task',
    site: siteKey(startUrl),
    startUrl,
    steps,
    created: Date.now(),
  };
  const tasks = await listTasks();
  if (tasks.length >= MAX_TASKS) throw new Error(`You have ${MAX_TASKS} saved tasks; delete some first`);
  await chrome.storage.local.set({ [KEY]: [task, ...tasks] });
  return task;
}

/**
 * @param {string} id
 * @param {Partial<Pick<Task, 'name' | 'lastRun'>>} changes
 */
export async function updateTask(id, changes) {
  const tasks = await listTasks();
  await chrome.storage.local.set({ [KEY]: tasks.map((t) => (t.id === id ? { ...t, ...changes } : t)) });
}

/** @param {string} id */
export async function deleteTask(id) {
  await chrome.storage.local.set({ [KEY]: (await listTasks()).filter((t) => t.id !== id) });
}

/**
 * A step in plain words, for the task's step list ('Type "Sam" into #name', 'Go to …').
 * @param {TaskStep} entry
 */
export function describeStep(entry) {
  if (entry.kind === 'navigate') {
    const { url, go } = entry.input;
    return url ? `Go to ${url}` : go === 'reload' ? 'Reload the page' : `Go ${go}`;
  }
  const s = entry.step;
  const verb = { click: 'Click', hover: 'Point at', type: 'Type into', select: 'Choose in', check: 'Tick', uncheck: 'Untick', submit: 'Submit the form of', scroll: 'Scroll', press: 'Press', wait: 'Wait for' }[/** @type {string} */ (s.action)] ?? s.action;
  /** @type {{ selector?: string, text?: string }[]} */
  const targets = s.alternatives ?? [];
  const named = targets.find((t) => t.text)?.text;
  const where = named ? `"${named}"` : targets[0]?.selector ?? s.selector ?? '';
  if (entry.secret) return `${verb} ${where} (password: you type it)`;
  if (s.action === 'type') return `Type "${String(s.value ?? '').slice(0, 60)}" into ${where}`;
  if (s.action === 'select') return `Choose "${s.value}" in ${where}`;
  if (s.action === 'press') return `Press ${s.value}${where ? ` in ${where}` : ''}`;
  if (s.action === 'scroll') return where ? `Scroll ${where}${s.value ? ` ${s.value}` : ' into view'}` : `Scroll the page ${s.value}`;
  if (s.action === 'wait' && !where) return `Wait ${s.value} s`;
  return `${verb} ${where}`.trim();
}
