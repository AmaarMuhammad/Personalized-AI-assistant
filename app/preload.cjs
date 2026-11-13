// The only bridge between the window and the rest of Jarvis. The page gets
// these named functions and nothing else: no Node.js, no file access.
const { contextBridge, ipcRenderer } = require('electron');

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('jarvis', {
  send: call('chat:send'),
  transcribe: call('voice:transcribe'),
  stopSpeaking: call('voice:stop'),
  prepareVoice: call('voice:prepare'),
  testVoice: call('voice:test'),
  stop: call('chat:stop'),
  newChat: call('chat:new'),
  history: call('chat:history'),
  answer: call('approval:answer'),
  pendingApprovals: call('approval:list'),
  activity: call('activity:list'),
  getMemory: call('memory:get'),
  setMemory: call('memory:set'),
  getSettings: call('settings:get'),
  setSettings: call('settings:set'),
  openLink: call('app:openLink'),
  openFolder: call('app:openFolder'),
  status: call('app:status'),
  health: call('health:get'),
  googleStatus: call('google:status'),
  googleChooseClient: call('google:chooseClient'),
  googleConnect: call('google:connect'),
  googleDisconnect: call('google:disconnect'),
  chats: call('chats:list'),
  getChat: call('chats:get'),
  continueChat: call('chats:continue'),
  renameChat: call('chats:rename'),
  deleteChat: call('chats:delete'),
  memoryFacts: call('memory:facts'),
  addFact: call('memory:add'),
  updateFact: call('memory:update'),
  removeFact: call('memory:remove'),
  memoryHistory: call('memory:history'),
  restoreMemory: call('memory:restore'),
  pendingMemory: call('memory:pending'),
  approvePendingMemory: call('memory:approvePending'),
  rejectPendingMemory: call('memory:rejectPending'),
  backupNow: call('backup:now'),
  dashboard: call('dashboard:get'),
  restoreBackup: call('backup:restore'),
  onEvent(cb) {
    const listener = (_e, msg) => cb(msg);
    ipcRenderer.on('jarvis:event', listener);
    return () => ipcRenderer.removeListener('jarvis:event', listener);
  },
});
