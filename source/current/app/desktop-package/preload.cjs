const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('siparisTakip', {
  platform: process.platform,
  desktop: true,
  googleLogin: () => ipcRenderer.invoke('desktop-google-login'),
  openWhatsApp: () => ipcRenderer.invoke('open-whatsapp'),
  saveWhatsAppSourceFile: (source) => ipcRenderer.invoke('save-whatsapp-source-file', source),
  showOrderContextMenu: (source) => ipcRenderer.send('order-context-menu', source),
  onLocalSourceFileSaved: (callback) => ipcRenderer.on('local-source-file-saved', (_event, value) => callback(value)),
  syncCustomers: (customers) => ipcRenderer.send('sync-customers', customers),
  syncOrders: (orders) => ipcRenderer.send('sync-orders', orders),
  syncCurrentManager: (email) => ipcRenderer.send('sync-current-manager', email),
})
