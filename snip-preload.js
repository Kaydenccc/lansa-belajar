'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Lapisan "pilih area": hanya bisa mengirim area pilihan (atau null jika batal) ke proses utama.
contextBridge.exposeInMainWorld('snip', {
  done: (rect) => ipcRenderer.send('snip-done', rect),
});
