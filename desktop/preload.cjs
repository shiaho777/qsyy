const { contextBridge, ipcRenderer } = require('electron');

const on = (channel, cb) => {
  if (typeof cb === 'function') ipcRenderer.on(channel, (_event, value) => cb(value));
};

contextBridge.exposeInMainWorld('QsyyDesktop', {
  pollPassport(token) {
    return ipcRenderer.invoke('qsyy-qr-poll', String(token || ''));
  },
  stopPassportPoll(token) {
    return ipcRenderer.invoke('qsyy-qr-stop', String(token || ''));
  },
  // main window side: owns playback, feeds the floating lyrics window
  desktopLyrics: {
    toggle(want) { return ipcRenderer.invoke('qsyy-dl-toggle', typeof want === 'boolean' ? want : null); },
    status() { return ipcRenderer.invoke('qsyy-dl-status'); },
    pushState(state) { ipcRenderer.send('qsyy-dl-state', state); },
    pushClock(clock) { ipcRenderer.send('qsyy-dl-clock', clock); },
    onVisible(cb) { on('qsyy-dl-visible', cb); },
    onCommand(cb) { on('qsyy-dl-command', cb); },
  },
  // floating lyrics window side (desktop-lyrics.html)
  lyrics: {
    setHotspot(rect) { ipcRenderer.send('qsyy-dl-hotspot', rect); },
    fit(height) { ipcRenderer.send('qsyy-dl-fit', Number(height) || 0); },
    command(cmd) { ipcRenderer.send('qsyy-dl-cmd', String(cmd || '')); },
    setLocked(locked) { ipcRenderer.send('qsyy-dl-lock', Boolean(locked)); },
    onState(cb) { on('qsyy-dl-state', cb); },
    onClock(cb) { on('qsyy-dl-clock', cb); },
    onHover(cb) { on('qsyy-dl-hover', cb); },
    onLocked(cb) { on('qsyy-dl-locked', cb); },
  },
});
