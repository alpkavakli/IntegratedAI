// Adds on/off buttons for saved CSS patches that have a `toggle` (e.g. a dark
// theme switch). Runs in the extension's ISOLATED world: the page's scripts
// cannot call into it, and the button is built by this file (text only, no
// HTML or code from the model).
//
// Clicking a button asks the service worker to flip the patch's `enabled` flag;
// the worker then inserts/removes the CSS in every matching tab, and the choice
// is remembered (the patch is reapplied, or not, on the next page load).
(() => {
  if (window.top !== window) return; // top frame only

  /** @type {Map<string, HTMLButtonElement>} patch id → button */
  const buttons = new Map();
  /** @type {Map<string, any>} patch id → latest patch info */
  const patches = new Map();

  const BUTTON_STYLE = {
    font: 'inherit', fontSize: '15px', lineHeight: '1', cursor: 'pointer',
    padding: '5px 9px', margin: '0 6px', borderRadius: '999px',
    border: '1px solid rgba(127,127,127,.6)', background: 'transparent', color: 'inherit',
    verticalAlign: 'middle',
  };
  const FLOATING_STYLE = {
    position: 'fixed', right: '16px', bottom: '16px', zIndex: '2147483646', margin: '0',
    background: 'rgba(36,36,36,.92)', color: '#fff', boxShadow: '0 2px 8px rgba(0,0,0,.35)',
  };

  async function sync() {
    let res;
    try {
      res = await chrome.runtime.sendMessage({ cmd: 'toggles.forTab' });
    } catch {
      return; // extension reloaded or worker unavailable
    }
    if (!res?.ok) return;
    const current = new Map(res.value.map((p) => [p.id, p]));
    for (const [id, button] of buttons) {
      if (!current.has(id)) { button.remove(); buttons.delete(id); patches.delete(id); }
    }
    for (const patch of current.values()) {
      patches.set(patch.id, patch);
      render(patch);
    }
  }

  function render(patch) {
    let button = buttons.get(patch.id);
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'integratedai-toggle';
      button.dataset.integratedaiPatch = patch.id;
      button.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        button.disabled = true;
        try {
          await chrome.runtime.sendMessage({ cmd: 'patches.toggle', id: patch.id });
        } finally {
          button.disabled = false; // storage change → sync() updates the label
        }
      });
      buttons.set(patch.id, button);
    }
    const { toggle } = patch;
    button.textContent = patch.enabled ? (toggle.activeLabel || toggle.label) : toggle.label;
    button.title = `${patch.enabled ? 'Turn off' : 'Turn on'}: ${patch.name}`;
    button.setAttribute('aria-pressed', String(patch.enabled));
    place(button, toggle);
  }

  function place(button, toggle) {
    let target = null;
    if (toggle.placeSelector) {
      try { target = document.querySelector(toggle.placeSelector); } catch { target = null; }
    }
    button.removeAttribute('style');
    Object.assign(button.style, BUTTON_STYLE);
    if (!target) {
      Object.assign(button.style, FLOATING_STYLE);
      if (button.parentNode !== document.body) document.body.append(button);
      button.dataset.floating = '1';
      return;
    }
    delete button.dataset.floating;
    const position = toggle.position || 'append';
    const alreadyPlaced =
      (position === 'append' && button.parentNode === target) ||
      (position === 'prepend' && button.parentNode === target) ||
      (position === 'before' && button.nextSibling === target) ||
      (position === 'after' && button.previousSibling === target);
    if (alreadyPlaced) return;
    if (position === 'prepend') target.prepend(button);
    else if (position === 'before') target.before(button);
    else if (position === 'after') target.after(button);
    else target.append(button);
  }

  // Sites that re-render (SPAs) may remove our button or create the target later.
  let pending = 0;
  const observer = new MutationObserver(() => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = 0;
      for (const [id, button] of buttons) {
        const patch = patches.get(id);
        const wantsTarget = patch?.toggle.placeSelector && button.dataset.floating;
        if (!button.isConnected || wantsTarget) render(patch);
      }
    }, 300);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.patches) sync();
  });

  sync().then(() => observer.observe(document.documentElement, { childList: true, subtree: true }));
})();
