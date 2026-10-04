// Registers the "AI" tab in DevTools. The panel page itself is loaded lazily
// the first time the user opens the tab, and then stays alive while DevTools is open.
chrome.devtools.panels.create('AI', 'icons/icon32.png', 'panel/panel.html');
