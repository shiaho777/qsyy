const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('QsyyDesktop', {
  pollPassport(token) {
    return ipcRenderer.invoke('qsyy-qr-poll', String(token || ''));
  },
  stopPassportPoll(token) {
    return ipcRenderer.invoke('qsyy-qr-stop', String(token || ''));
  },
});
