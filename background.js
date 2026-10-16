import { runImport, undoImport } from './lib/operations.js';

chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL('manager.html');
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find(tab => tab.url === url);
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else await chrome.tabs.create({ url });
});

let active = false;
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !['import', 'undo'].includes(message?.type)) return;
  if (active) { respond({ ok: false, error: 'Another bookmark operation is running. Wait for it to finish.' }); return; }
  active = true;
  const task = message.type === 'import' ? runImport(chrome, message.payload) : undoImport(chrome, message.id);
  task.then(result => respond({ ok: true, result }), error => respond({ ok: false, error: error.message }))
    .finally(() => { active = false; });
  return true;
});
