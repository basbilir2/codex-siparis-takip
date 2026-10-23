const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require('electron')
const fs = require('fs')
const path = require('path')
const { startDesktopGoogleLogin } = require('./desktop-oauth.cjs')
const { matchesAlias, projectKey } = require('./whatsapp-extractor.cjs')

app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')

const PRODUCTION_URL = 'https://PRIVATE_VALUE_011/?desktop=1944'
const WHATSAPP_URL = 'https://web.whatsapp.com/'
const GOOGLE_DESKTOP_CLIENT_ID = '381265617199-q19s5sv4cd84v3l796g3n0lj7uhpvdrm.apps.googleusercontent.com'
const GOOGLE_DESKTOP_CLIENT_SECRET = 'PRIVATE_VALUE_008'
const smokeTest = process.argv.includes('--smoke-test')

let mainWindow = null
let whatsappWindow = null
let registeredCustomers = []
let registeredOrders = []
let localSourceFiles = {}
let pendingSourceDownload = null
let currentManagerEmail = ''
const downloadBoundSessions = new WeakSet()
let quitting = false
let googleLoginPromise = null

function customerCachePath() {
  return path.join(app.getPath('userData'), 'registered-customers.json')
}

function orderCachePath() {
  return path.join(app.getPath('userData'), 'registered-orders.json')
}

function localSourceFileIndexPath() {
  return path.join(app.getPath('userData'), 'local-source-files.json')
}

function archiveRootConfigPath() {
  return path.join(app.getPath('userData'), 'archive-root.txt')
}

function configuredArchiveRoot() {
  try {
    const configured = fs.readFileSync(archiveRootConfigPath(), 'utf8').trim()
    if (configured && path.isAbsolute(configured)) return path.resolve(configured)
  } catch {}
  return path.join(app.getPath('documents'), 'İzmirde Reklam Sipariş Takip')
}

function sourceFileKey(value) {
  const context = safeProjectContext(value)
  const manager = String(context.managerEmail || 'yerel').toLocaleLowerCase('tr-TR')
  return context.messageId ? `${manager}::${context.messageId}` : `${manager}::${projectKey(context.chat)}::${projectKey(context.title)}`
}

function isSourceAttachment(value) {
  return /\.(?:pdf|ai|cdr|eps|svg|psd|png|jpe?g|tiff?|webp|zip|rar|docx?|xlsx?)$/i.test(String(value?.title || '').trim())
}

function safeFolderName(value, fallback = 'Belirtilmemis') {
  let name = [...String(value || '')].map((character) => character.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(character) ? ' ' : character).join('').replace(/[. ]+$/g, '').replace(/\s+/g, ' ').trim().slice(0, 90)
  if (!name) name = fallback
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) name = `_${name}`
  return name
}

function sourceArchiveRoot(context) {
  return path.join(configuredArchiveRoot(), 'Yöneticiler', safeFolderName(context.managerEmail, 'Yerel Yonetici'), 'Müşteriler')
}

function archiveCustomerName(context) {
  const customer = registeredCustomers.find((item) => item.id === context.customerId) || findCustomer(context.chat)
  if (context.quickTracking || customer?.quickTracking) return 'Perakende'
  return context.customerName || customer?.displayName || context.chat || 'Musteri'
}

function ensureCustomerArchiveFolders(managerEmail, customers = registeredCustomers) {
  if (!managerEmail) return
  const root = sourceArchiveRoot({ managerEmail })
  const names = new Set(customers.map((customer) => customer.quickTracking ? 'Perakende' : customer.displayName).filter(Boolean))
  names.forEach((name) => fs.mkdirSync(path.join(root, safeFolderName(name, 'Musteri')), { recursive: true }))
}

function sourceArchiveDate(context) {
  const match = String(context.timestamp || '').match(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})\b/)
  if (!match) {
    const now = new Date()
    return { year: String(now.getFullYear()), month: String(now.getMonth() + 1).padStart(2, '0') }
  }
  const year = match[3].length === 2 ? `20${match[3]}` : match[3]
  return { year, month: String(match[2]).padStart(2, '0') }
}

function availableSourcePath(context, suggestedName) {
  const root = path.resolve(sourceArchiveRoot(context))
  const date = sourceArchiveDate(context)
  const rawFileName = path.basename(String(suggestedName || context.title || 'dosya'))
  const extension = path.extname(rawFileName).slice(0, 12)
  const fileBase = safeFolderName(path.basename(rawFileName, extension), 'dosya')
  const projectName = safeFolderName(path.basename(context.title || fileBase, path.extname(context.title || '')), 'Siparis')
  const directory = path.resolve(root, safeFolderName(archiveCustomerName(context), 'Musteri'), date.year, date.month, projectName)
  const boundary = `${root}${path.sep}`.toLocaleLowerCase('tr-TR')
  if (!`${directory}${path.sep}`.toLocaleLowerCase('tr-TR').startsWith(boundary)) throw new Error('Güvenli olmayan arşiv yolu.')
  fs.mkdirSync(directory, { recursive: true })
  let candidate = path.join(directory, `${fileBase}${extension}`)
  for (let index = 2; fs.existsSync(candidate); index += 1) candidate = path.join(directory, `${fileBase} (${index})${extension}`)
  return candidate
}

function saveLocalSourceFileIndex() {
  fs.writeFile(localSourceFileIndexPath(), JSON.stringify(localSourceFiles, null, 2), () => {})
}

function localSourceFile(value) {
  const key = sourceFileKey(value)
  const entry = localSourceFiles[key]
  if (!entry?.path || !fs.existsSync(entry.path)) {
    if (entry) {
      delete localSourceFiles[key]
      saveLocalSourceFileIndex()
    }
    return null
  }
  return entry
}

function loadCachedCustomers() {
  try {
    registeredCustomers = safeCustomerList(JSON.parse(fs.readFileSync(customerCachePath(), 'utf8')))
  } catch {
    registeredCustomers = []
  }
  try {
    registeredOrders = safeOrderList(JSON.parse(fs.readFileSync(orderCachePath(), 'utf8')))
  } catch {
    registeredOrders = []
  }
  try {
    localSourceFiles = JSON.parse(fs.readFileSync(localSourceFileIndexPath(), 'utf8')) || {}
  } catch {
    localSourceFiles = {}
  }
}

function saveCachedCustomers() {
  fs.writeFile(customerCachePath(), JSON.stringify(registeredCustomers), () => {})
}

function saveCachedOrders() {
  fs.writeFile(orderCachePath(), JSON.stringify(registeredOrders), () => {})
}

app.setName('İzmirde Reklam Sipariş Takip')
app.setAppUserModelId('com.izmirde.reklam.siparistakip.production')

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) app.quit()

function chromeUserAgent() {
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`
}

function safeCustomerList(value) {
  if (!Array.isArray(value)) return []
  return value.slice(0, 1000).map((item) => ({
    id: String(item?.id || '').slice(0, 160),
    displayName: String(item?.displayName || '').trim().slice(0, 120),
    quickTracking: Boolean(item?.quickTracking),
    aliases: Array.isArray(item?.aliases) ? item.aliases.map((alias) => String(alias || '').trim().slice(0, 160)).filter(Boolean).slice(0, 5) : [],
  })).filter((item) => item.id && item.aliases.length)
}

function safeOrderList(value) {
  if (!Array.isArray(value)) return []
  return value.slice(0, 10000).map((item) => ({
    id: String(item?.id || '').slice(0, 160),
    customerId: String(item?.customerId || '').slice(0, 160),
    name: String(item?.name || '').trim().slice(0, 240),
    status: String(item?.status || '').trim().slice(0, 40),
  })).filter((item) => item.id && item.customerId && item.name)
}

function safeProjectContext(value) {
  let phone = String(value?.phone || '').replace(/\D/g, '').slice(-15)
  if (phone.length === 10 && phone.startsWith('5')) phone = `90${phone}`
  return {
    title: String(value?.title || '').trim().slice(0, 240),
    chat: String(value?.chat || '').trim().slice(0, 120),
    messageId: String(value?.messageId || '').trim().slice(0, 360),
    phone,
    timestamp: String(value?.timestamp || '').trim().slice(0, 80),
    orderDate: String(value?.orderDate || '').trim().slice(0, 80),
    managerEmail: String(value?.managerEmail || '').trim().toLocaleLowerCase('tr-TR').slice(0, 180),
    customerId: String(value?.customerId || '').trim().slice(0, 160),
    customerName: String(value?.customerName || '').trim().slice(0, 120),
    quickTracking: Boolean(value?.quickTracking),
  }
}

function findCustomer(chat) {
  return registeredCustomers.find((customer) => customer.aliases.some((alias) => matchesAlias(chat, alias))) || null
}

function findOrder(title, customerId) {
  const key = projectKey(title)
  if (!key || !customerId) return null
  return registeredOrders.find((order) => order.customerId === customerId && projectKey(order.name) === key) || null
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1080,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f4f6fb',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      partition: 'persist:izmirde-siparis-takip',
    },
  })

  mainWindow.webContents.setUserAgent(chromeUserAgent())
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(WHATSAPP_URL)) {
      openWhatsApp()
      return { action: 'deny' }
    }
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
    quitting = true
    if (whatsappWindow && !whatsappWindow.isDestroyed()) whatsappWindow.destroy()
    app.quit()
  })
  mainWindow.webContents.session.clearCache()
    .catch(() => {})
    .finally(() => mainWindow?.loadURL(PRODUCTION_URL))
}

function bindWhatsAppDownloads(browserSession) {
  if (downloadBoundSessions.has(browserSession)) return
  downloadBoundSessions.add(browserSession)
  browserSession.on('will-download', (_event, item, webContents) => {
    if (!pendingSourceDownload || Date.now() - pendingSourceDownload.requestedAt > 45000) {
      pendingSourceDownload = null
      return
    }
    if (!whatsappWindow || whatsappWindow.isDestroyed() || webContents !== whatsappWindow.webContents) return
    const context = pendingSourceDownload.context
    pendingSourceDownload = null
    let targetPath = ''
    try {
      targetPath = availableSourcePath(context, item.getFilename())
      item.setSavePath(targetPath)
    } catch (error) {
      dialog.showMessageBox(mainWindow || whatsappWindow, { type: 'error', title: 'Yerel arşiv', message: 'Dosya arşiv yolu oluşturulamadı.', detail: error.message, buttons: ['Tamam'] })
      return
    }
    item.once('done', (_downloadEvent, state) => {
      if (state === 'completed' && fs.existsSync(targetPath)) {
        localSourceFiles[sourceFileKey(context)] = { path: targetPath, chat: context.chat, title: context.title, messageId: context.messageId, managerEmail: context.managerEmail, savedAt: new Date().toISOString() }
        saveLocalSourceFileIndex()
        mainWindow?.webContents.send('local-source-file-saved', { title: context.title })
      } else if (state !== 'cancelled') {
        dialog.showMessageBox(mainWindow || whatsappWindow, { type: 'warning', title: 'Yerel arşiv', message: 'WhatsApp dosyası yerel arşive indirilemedi.', detail: 'Sipariş kaydı online tabloda korunuyor.', buttons: ['Tamam'] })
      }
    })
  })
}

function createWhatsAppWindow() {
  whatsappWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1000,
    minHeight: 680,
    show: false,
    autoHideMenuBar: true,
    title: 'WhatsApp Sipariş Al',
    backgroundColor: '#101513',
    webPreferences: {
      preload: path.join(__dirname, 'whatsapp-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      partition: 'persist:izmirde-whatsapp',
    },
  })

  whatsappWindow.webContents.setUserAgent(chromeUserAgent())
  bindWhatsAppDownloads(whatsappWindow.webContents.session)
  whatsappWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  whatsappWindow.once('ready-to-show', () => whatsappWindow?.show())
  whatsappWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault()
      whatsappWindow.hide()
    }
  })
  whatsappWindow.on('closed', () => { whatsappWindow = null })
  whatsappWindow.loadURL(WHATSAPP_URL)
}

async function runSmokeTest() {
  const result = { main: null, whatsapp: null }
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Sipariş Takip ekranı zaman aşımına uğradı.')), 30000)
      mainWindow.webContents.once('did-finish-load', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    await new Promise((resolve) => setTimeout(resolve, 1500))
    result.main = {
      url: mainWindow.webContents.getURL(),
      title: mainWindow.webContents.getTitle(),
      desktopApi: await mainWindow.webContents.executeJavaScript('Boolean(window.siparisTakip?.desktop && window.siparisTakip?.googleLogin && window.siparisTakip?.openWhatsApp && window.siparisTakip?.syncCustomers && window.siparisTakip?.syncOrders)'),
      hasLoginOrPanel: await mainWindow.webContents.executeJavaScript('/Google ile devam et|Siparişler|WhatsApp/.test(document.body.innerText)'),
    }

    createWhatsAppWindow()
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WhatsApp ekranı zaman aşımına uğradı.')), 45000)
      whatsappWindow.webContents.once('did-finish-load', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    await new Promise((resolve) => setTimeout(resolve, 3500))
    result.whatsapp = {
      url: whatsappWindow.webContents.getURL(),
      title: whatsappWindow.webContents.getTitle(),
      pageLoaded: await whatsappWindow.webContents.executeJavaScript('document.body.innerText.trim().length > 20'),
    }
    process.stdout.write(`DESKTOP_SMOKE_RESULT=${JSON.stringify(result)}\n`)
    quitting = true
    app.exit(0)
  } catch (error) {
    process.stderr.write(`DESKTOP_SMOKE_ERROR=${error.message}\n`)
    quitting = true
    app.exit(1)
  }
}

function openWhatsApp() {
  const created = !whatsappWindow || whatsappWindow.isDestroyed()
  if (created) createWhatsAppWindow()
  else {
    whatsappWindow.show()
    whatsappWindow.focus()
  }
  return created
}

function showWhatsAppSource(value) {
  const context = safeProjectContext(value)
  if (!context.chat || !context.title) return
  const created = openWhatsApp()
  const reveal = () => {
    if (!whatsappWindow || whatsappWindow.isDestroyed()) return
    whatsappWindow.webContents.send('whatsapp-show-source', context)
    whatsappWindow.show()
    whatsappWindow.focus()
  }
  if (created || whatsappWindow.webContents.isLoading() || !whatsappWindow.webContents.getURL().startsWith(WHATSAPP_URL)) {
    whatsappWindow.webContents.once('did-finish-load', () => setTimeout(reveal, 1800))
  }
  else reveal()
}

async function showWhatsAppSourceInfo(value) {
  const context = safeProjectContext(value)
  if (!mainWindow || !context.chat || !context.title) return
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'WhatsApp Sipariş Kaynağı',
    message: context.title,
    detail: `WhatsApp görüşmesi: ${context.chat}\nMesaj tarihi: ${context.timestamp || 'Eski kayıtta tutulmamış'}\nSipariş kayıt tarihi: ${context.orderDate || 'Belirtilmemiş'}\n\nBu sipariş, yukarıdaki mesaj veya dosyadan oluşturuldu. Bu bilgi WhatsApp senkronizasyonundan bağımsızdır.`,
    buttons: ['Mesajı WhatsApp’ta bulmayı dene', 'Kapat'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  })
  if (result.response === 0) showWhatsAppSource(context)
}

ipcMain.handle('open-whatsapp', () => {
  openWhatsApp()
  return { ok: true }
})

ipcMain.handle('save-whatsapp-source-file', (event, value) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false }
  const context = safeProjectContext(value)
  if (!context.chat || !context.title || !context.managerEmail || !whatsappWindow || whatsappWindow.isDestroyed()) return { ok: false }
  if (!isSourceAttachment(context)) return { ok: false, noFile: true }
  if (localSourceFile(context)) return { ok: true, alreadySaved: true }
  pendingSourceDownload = { context, requestedAt: Date.now() }
  whatsappWindow.webContents.send('whatsapp-download-source', context)
  return { ok: true }
})

ipcMain.on('whatsapp-stage-source-download', (event, value) => {
  if (!whatsappWindow || event.sender !== whatsappWindow.webContents || !currentManagerEmail) return
  const context = { ...safeProjectContext(value), managerEmail: currentManagerEmail }
  if (!context.chat || !context.title || !isSourceAttachment(context) || localSourceFile(context)) return
  pendingSourceDownload = { context, requestedAt: Date.now() }
})

ipcMain.on('whatsapp-source-download-failed', (event, value) => {
  if (!whatsappWindow || event.sender !== whatsappWindow.webContents) return
  pendingSourceDownload = null
  const context = safeProjectContext(value)
  dialog.showMessageBox(mainWindow || whatsappWindow, {
    type: 'warning',
    title: 'Yerel arşiv',
    message: 'WhatsApp dosyası yerel arşive indirilemedi.',
    detail: `${context.title || 'Dosya'}\nSipariş online tabloda kaydedildi; dosya WhatsApp ekranından elle indirilebilir.`,
    buttons: ['Tamam'],
  })
})

ipcMain.handle('whatsapp-click-point', async (event, value) => {
  if (!whatsappWindow || event.sender !== whatsappWindow.webContents) return false
  const x = Math.round(Number(value?.x))
  const y = Math.round(Number(value?.y))
  const bounds = whatsappWindow.getContentBounds()
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= bounds.width || y >= bounds.height) return false
  whatsappWindow.show()
  whatsappWindow.focus()
  await new Promise((resolve) => setTimeout(resolve, 150))
  const webContents = whatsappWindow.webContents
  const attachedHere = !webContents.debugger.isAttached()
  try {
    if (attachedHere) webContents.debugger.attach('1.3')
    await webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
    return true
  } catch {
    return false
  } finally {
    if (attachedHere && webContents.debugger.isAttached()) webContents.debugger.detach()
  }
})

ipcMain.on('whatsapp-open-phone-source', (event, value) => {
  if (!whatsappWindow || event.sender !== whatsappWindow.webContents) return
  const context = safeProjectContext(value)
  if (!context.phone) return
  const url = new URL('send/', WHATSAPP_URL)
  url.searchParams.set('phone', context.phone)
  whatsappWindow.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      if (!whatsappWindow || whatsappWindow.isDestroyed()) return
      whatsappWindow.webContents.send('whatsapp-show-source', { ...context, phoneOpened: true })
      whatsappWindow.show()
      whatsappWindow.focus()
    }, 2200)
  })
  whatsappWindow.loadURL(url.toString())
})

ipcMain.on('order-context-menu', (event, value) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return
  const context = safeProjectContext(value)
  if (!context.chat || !context.title) return
  const localFile = localSourceFile(context)
  Menu.buildFromTemplate([
    {
      label: localFile ? 'Yerel dosyayı aç' : 'Yerel dosya bu bilgisayarda yok',
      enabled: Boolean(localFile),
      click: async () => {
        const error = await shell.openPath(localFile.path)
        if (error) dialog.showMessageBox(mainWindow, { type: 'warning', title: 'Yerel arşiv', message: 'Dosya açılamadı.', detail: error, buttons: ['Tamam'] })
      },
    },
    { label: 'Dosyanın klasörünü aç', enabled: Boolean(localFile), click: () => shell.showItemInFolder(localFile.path) },
    { type: 'separator' },
    { label: 'WhatsApp sipariş kaynağını göster', click: () => showWhatsAppSourceInfo(context) },
  ]).popup({ window: mainWindow })
})

ipcMain.handle('desktop-google-login', async (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error('Geçersiz giriş isteği.')
  if (!googleLoginPromise) {
    googleLoginPromise = startDesktopGoogleLogin({
      clientId: GOOGLE_DESKTOP_CLIENT_ID,
      clientSecret: GOOGLE_DESKTOP_CLIENT_SECRET,
      openExternal: (url) => shell.openExternal(url),
    })
  }
  try {
    const result = await googleLoginPromise
    mainWindow.show()
    mainWindow.focus()
    return result
  } finally {
    googleLoginPromise = null
  }
})

ipcMain.on('sync-customers', (event, customers) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return
  registeredCustomers = safeCustomerList(customers)
  saveCachedCustomers()
  try { ensureCustomerArchiveFolders(currentManagerEmail) } catch {}
})

ipcMain.on('sync-orders', (event, orders) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return
  registeredOrders = safeOrderList(orders)
  saveCachedOrders()
})

ipcMain.on('sync-current-manager', (event, email) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return
  currentManagerEmail = String(email || '').trim().toLocaleLowerCase('tr-TR').slice(0, 180)
  try { ensureCustomerArchiveFolders(currentManagerEmail) } catch {}
})

ipcMain.handle('whatsapp-project-context', (event, value) => {
  if (!whatsappWindow || event.sender !== whatsappWindow.webContents) return { order: { enabled: false }, quick: { enabled: false }, cancel: { enabled: false }, customer: { enabled: false } }
  const context = safeProjectContext(value)
  const customer = findCustomer(context.chat)
  const order = customer ? findOrder(context.title, customer.id) : null
  const customerContext = customer ? { customerId: customer.id, customerName: customer.displayName, quickTracking: customer.quickTracking } : {}
  return {
    order: { enabled: Boolean(context.title && context.chat && customer), payload: customer ? { ...context, ...customerContext } : null },
    quick: { enabled: Boolean(context.title && context.chat && !customer), payload: { ...context, customerName: 'Perakende', quickTracking: true } },
    cancel: {
      enabled: Boolean(order && order.status !== 'İptal Edildi'),
      reason: !customer ? 'Bu görüşme kayıtlı bir müşteri değil.' : !order ? 'Bu proje Sipariş Takip’te kayıtlı değil. Hiçbir kayıt değiştirilmedi.' : 'Bu proje zaten iptal edilmiş.',
      payload: order ? { ...context, ...customerContext, orderId: order.id } : null,
    },
    customer: { enabled: Boolean(context.chat && !customer), reason: customer ? 'Bu müşteri zaten kayıtlı.' : '', payload: { ...context } },
  }
})

ipcMain.on('whatsapp-open-project', (event, value) => {
  if (!whatsappWindow || event.sender !== whatsappWindow.webContents || !mainWindow) return
  const context = safeProjectContext(value)
  const customer = findCustomer(context.chat)
  if (!context.title || !customer) return
  const url = new URL(PRODUCTION_URL)
  url.searchParams.set('waTitle', context.title)
  url.searchParams.set('waChat', context.chat)
  url.searchParams.set('waCustomerId', customer.id)
  if (context.messageId) url.searchParams.set('waMessageId', context.messageId)
  if (context.phone) url.searchParams.set('waPhone', context.phone)
  if (context.timestamp) url.searchParams.set('waTimestamp', context.timestamp)
  mainWindow.loadURL(url.toString())
  mainWindow.show()
  mainWindow.focus()
})

ipcMain.on('whatsapp-cancel-project', (event, value) => {
  if (!whatsappWindow || event.sender !== whatsappWindow.webContents || !mainWindow) return
  const context = safeProjectContext(value)
  const customer = findCustomer(context.chat)
  const order = customer ? findOrder(context.title, customer.id) : null
  if (!order || order.status === 'İptal Edildi') return
  const url = new URL(PRODUCTION_URL)
  url.searchParams.set('waAction', 'cancel')
  url.searchParams.set('waTitle', context.title)
  url.searchParams.set('waChat', context.chat)
  url.searchParams.set('waCustomerId', customer.id)
  url.searchParams.set('waOrderId', order.id)
  mainWindow.loadURL(url.toString())
  mainWindow.show()
  mainWindow.focus()
})

ipcMain.on('whatsapp-add-customer', (event, value) => {
  if (!whatsappWindow || event.sender !== whatsappWindow.webContents || !mainWindow) return
  const context = safeProjectContext(value)
  if (!context.chat || findCustomer(context.chat)) return
  const url = new URL(PRODUCTION_URL)
  url.searchParams.set('waAction', 'customer')
  url.searchParams.set('waChat', context.chat)
  mainWindow.loadURL(url.toString())
  mainWindow.show()
  mainWindow.focus()
})

ipcMain.on('whatsapp-add-quick-order', (event, value) => {
  if (!whatsappWindow || event.sender !== whatsappWindow.webContents || !mainWindow) return
  const context = safeProjectContext(value)
  if (!context.chat || !context.title || findCustomer(context.chat)) return
  const url = new URL(PRODUCTION_URL)
  url.searchParams.set('waAction', 'quick')
  url.searchParams.set('waTitle', context.title)
  url.searchParams.set('waChat', context.chat)
  if (context.messageId) url.searchParams.set('waMessageId', context.messageId)
  if (context.phone) url.searchParams.set('waPhone', context.phone)
  if (context.timestamp) url.searchParams.set('waTimestamp', context.timestamp)
  mainWindow.loadURL(url.toString())
  mainWindow.show()
  mainWindow.focus()
})

app.whenReady().then(() => {
  loadCachedCustomers()
  createMainWindow()
  if (smokeTest) runSmokeTest()
})

app.on('second-instance', () => {
  if (!mainWindow) createMainWindow()
  else {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
})

app.on('before-quit', () => { quitting = true })
app.on('window-all-closed', () => app.quit())
