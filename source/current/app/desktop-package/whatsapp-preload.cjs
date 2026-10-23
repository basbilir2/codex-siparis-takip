const { ipcRenderer } = require('electron')
const { attachmentNameFromValues, matchesAlias, projectKey, sourceStampFromValues } = require('./whatsapp-extractor.cjs')

const MENU_ACTION_IDS = [
  'izmirde-reklam-whatsapp-order',
  'izmirde-reklam-whatsapp-quick',
  'izmirde-reklam-whatsapp-customer',
  'izmirde-reklam-whatsapp-cancel',
]

function currentChatName() {
  const header = document.querySelector('#main header')
    || document.querySelector('[role="main"] header')
    || document.querySelector('[data-testid="conversation-header"]')
    || [...document.querySelectorAll('header')].find((candidate) => candidate.querySelector('span[title], [dir="auto"]'))
  if (!header) return ''

  const selectors = [
    '[data-testid="conversation-info-header-chat-title"]',
    'span[dir="auto"][title]',
    'span[title][dir="auto"]',
    'span[title]',
    '[dir="auto"]',
  ]
  for (const selector of selectors) {
    const nodes = [...header.querySelectorAll(selector)]
    for (const node of nodes) {
      const value = String(node.getAttribute?.('title') || node.textContent || '')
        .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
      if (value && value.length <= 120) return value
    }
  }
  return ''
}

function projectTitle(message) {
  if (!message) return ''
  const selected = window.getSelection()?.toString().trim()
  if (selected) return selected.slice(0, 240)

  const values = []
  const add = (value) => {
    const text = String(value || '').trim()
    if (text) values.push(text)
  }
  add(message.getAttribute?.('download'))
  add(message.getAttribute?.('title'))
  add(message.getAttribute?.('aria-label'))
  message.querySelectorAll?.('[download], [title], [aria-label]').forEach((node) => {
    add(node.getAttribute('download'))
    add(node.getAttribute('title'))
    add(node.getAttribute('aria-label'))
  })
  add(message.innerText)

  const attachment = attachmentNameFromValues(values)
  if (attachment) return attachment.slice(0, 240)
  const content = message.querySelector('[data-testid="selectable-text"], .selectable-text, span[dir="ltr"], span[dir="auto"]')
  return String(content?.innerText || content?.textContent || message.innerText || '').trim().slice(0, 240)
}

function messageTimestamp(message) {
  if (!message) return ''
  const values = [message.getAttribute?.('data-pre-plain-text')]
  for (const node of message.querySelectorAll?.('[data-pre-plain-text], [aria-label], [title]') || []) {
    values.push(node.getAttribute('data-pre-plain-text'), node.getAttribute('aria-label'), node.getAttribute('title'))
  }
  return sourceStampFromValues(values)
}

function phoneFromMessageId(messageId) {
  const match = String(messageId || '').match(/(?:^|_)(\d{10,15})@(?:c\.us|s\.whatsapp\.net)(?:_|$)/i)
  return match?.[1] || ''
}

function waitFor(check, timeout = 6000) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const timer = window.setInterval(() => {
      const result = check()
      if (result || Date.now() - startedAt >= timeout) {
        window.clearInterval(timer)
        resolve(result || null)
      }
    }, 120)
  })
}

function replaceEditableText(element, value) {
  element.focus()
  document.execCommand('selectAll', false)
  document.execCommand('insertText', false, value)
  element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }))
}

async function openChat(chat) {
  if (matchesAlias(currentChatName(), chat)) return true
  const findChatTitle = () => [...document.querySelectorAll('span[title], span[dir="auto"], span')]
    .find((node) => {
      if (node.offsetParent === null) return false
      const bounds = node.getBoundingClientRect()
      const inChatList = bounds.left >= 0 && bounds.left < Math.min(620, window.innerWidth * 0.45) && bounds.top > 100
      return inChatList && matchesAlias(node.getAttribute('title') || node.textContent, chat)
    })
  const clickChatTitle = async (titleNode) => {
    if (!titleNode) return false
    let row = titleNode
    for (let candidate = titleNode; candidate && candidate !== document.body; candidate = candidate.parentElement) {
      const bounds = candidate.getBoundingClientRect()
      if (bounds.left < Math.min(620, window.innerWidth * 0.45) && bounds.width >= 240 && bounds.height >= 45 && bounds.height <= 120) {
        row = candidate
        break
      }
    }
    row.click()
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
    if (await waitFor(() => matchesAlias(currentChatName(), chat), 4000)) return true
    const bounds = row.getBoundingClientRect()
    const clicked = await ipcRenderer.invoke('whatsapp-click-point', {
      x: bounds.left + Math.min(bounds.width - 8, Math.max(24, bounds.width * 0.55)),
      y: bounds.top + bounds.height / 2,
    })
    if (!clicked) return false
    return Boolean(await waitFor(() => matchesAlias(currentChatName(), chat), 10000))
  }
  const visibleChat = findChatTitle()
  if (visibleChat && await clickChatTitle(visibleChat)) return true
  const search = [...document.querySelectorAll('[contenteditable="true"][role="textbox"], [contenteditable="true"][data-tab]')]
    .find((node) => !node.closest('#main') && /ara|search/i.test(`${node.getAttribute('aria-label') || ''} ${node.getAttribute('placeholder') || ''} ${node.getAttribute('title') || ''}`))
    || document.querySelector('#side [contenteditable="true"][role="textbox"]')
  if (!search) return false
  replaceEditableText(search, chat)
  const result = await waitFor(findChatTitle, 10000)
  return clickChatTitle(result)
}

function highlightMessage(message) {
  message.scrollIntoView({ behavior: 'smooth', block: 'center' })
  const previous = message.style.outline
  message.style.outline = '3px solid #25d366'
  message.style.outlineOffset = '4px'
  window.setTimeout(() => {
    message.style.outline = previous
    message.style.outlineOffset = ''
  }, 3500)
}

function escapeHtml(value) {
  const node = document.createElement('span')
  node.textContent = String(value || '')
  return node.innerHTML
}

function showSourceFallback(source, reason) {
  document.getElementById('izmirde-reklam-source-fallback')?.remove()
  const panel = document.createElement('aside')
  panel.id = 'izmirde-reklam-source-fallback'
  panel.style.cssText = 'position:fixed;right:24px;top:92px;z-index:2147483647;width:min(390px,calc(100vw - 48px));padding:18px 20px;border-radius:14px;background:#10231c;color:#fff;box-shadow:0 16px 48px rgba(0,0,0,.45);font:14px/1.45 Segoe UI,Arial,sans-serif;border:1px solid rgba(37,211,102,.45)'
  const reasonText = reason === 'sync_paused'
    ? 'WhatsApp eski mesajı bu bilgisayara indirmedi.'
    : reason === 'syncing'
      ? 'WhatsApp eski mesajları henüz bu bilgisayara indiriyor.'
      : 'Mesaj balonu bu WhatsApp hesabında bulunamadı.'
  panel.innerHTML = `<button type="button" aria-label="Kapat" style="position:absolute;right:10px;top:8px;border:0;background:transparent;color:#b8c8c0;font-size:22px;cursor:pointer">×</button><strong style="display:block;padding-right:24px;font-size:16px;color:#25d366">Sipariş kaynağı</strong><div style="margin-top:10px;word-break:break-word"><b>Dosya / mesaj:</b> ${escapeHtml(source.title)}</div><div style="margin-top:5px"><b>Görüşme:</b> ${escapeHtml(source.chat)}</div>${source.timestamp ? `<div style="margin-top:5px"><b>Mesaj tarihi:</b> ${escapeHtml(source.timestamp)}</div>` : ''}${source.orderDate ? `<div style="margin-top:5px"><b>Sipariş kayıt tarihi:</b> ${escapeHtml(source.orderDate)}</div>` : ''}<div style="margin-top:12px;color:#d7e1dc">${reasonText} Sipariş kaynağı bilgisi yukarıda saklıdır.</div>`
  panel.querySelector('button')?.addEventListener('click', () => panel.remove())
  document.body.appendChild(panel)
}

function findLoadedMessage({ messageId, title }) {
  if (messageId) {
    const exact = [...document.querySelectorAll('[data-id]')].find((node) => node.getAttribute('data-id') === messageId)
    if (exact) return exact
  }
  const key = projectKey(title)
  if (!key) return null
  return [...document.querySelectorAll('#main [data-id], #main [role="row"]')]
    .find((node) => projectKey(projectTitle(node)) === key) || null
}

async function findMessageByScrolling(source) {
  const loadedMessage = [...document.querySelectorAll('#main [data-id]')].find((node) => node.offsetParent !== null)
  let scrollable = null
  for (let candidate = loadedMessage?.parentElement; candidate && candidate !== document.body; candidate = candidate.parentElement) {
    if (candidate.scrollHeight > candidate.clientHeight + 100 && candidate.clientHeight > 300) {
      scrollable = candidate
      break
    }
  }
  scrollable ||= [...document.querySelectorAll('#main *')]
    .filter((node) => node.scrollHeight > node.clientHeight + 300 && node.clientHeight > 300 && /auto|scroll/.test(getComputedStyle(node).overflowY))
    .sort((left, right) => right.clientHeight - left.clientHeight)[0]
  if (!scrollable) return null
  let stalled = 0
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const message = findLoadedMessage(source)
    if (message) return message
    const previousTop = scrollable.scrollTop
    const previousHeight = scrollable.scrollHeight
    scrollable.scrollTop = previousTop - Math.max(500, scrollable.clientHeight * 0.85)
    scrollable.dispatchEvent(new Event('scroll', { bubbles: true }))
    await new Promise((resolve) => window.setTimeout(resolve, 450))
    if (scrollable.scrollTop === previousTop && scrollable.scrollHeight === previousHeight) stalled += 1
    else stalled = 0
    if (stalled >= 3) break
  }
  return findLoadedMessage(source)
}

async function searchCurrentChat(title) {
  const visibleSearchInputs = () => [...document.querySelectorAll('[contenteditable="true"][role="textbox"], input')]
    .filter((node) => node.offsetParent !== null && /ara|search/i.test(`${node.getAttribute('aria-label') || ''} ${node.getAttribute('placeholder') || ''}`))
  const existingInputs = new Set(visibleSearchInputs())
  const searchButton = [...document.querySelectorAll('#main button, #main [role="button"]')]
    .find((node) => ['ara', 'search'].includes(String(node.getAttribute('aria-label') || node.getAttribute('title') || '').trim().toLocaleLowerCase('tr-TR')))
  if (!searchButton) return { message: null, reason: 'search_unavailable' }
  searchButton.click()
  const input = await waitFor(() => visibleSearchInputs().find((node) => !existingInputs.has(node)))
  if (!input) return { message: null, reason: 'search_unavailable' }
  if (input.isContentEditable) replaceEditableText(input, title)
  else {
    input.focus()
    input.value = title
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const key = projectKey(title)
  const result = await waitFor(() => {
    const match = [...document.querySelectorAll('[data-id], [role="listitem"], [role="row"], [data-testid*="search-result"]')]
      .find((node) => {
        if (node.offsetParent === null) return false
        const values = [node.textContent, node.getAttribute?.('aria-label'), node.getAttribute?.('title')]
        node.querySelectorAll?.('[title], [aria-label]').forEach((child) => {
          values.push(child.getAttribute('title'), child.getAttribute('aria-label'))
        })
        return projectKey(values.filter(Boolean).join(' ')).includes(key)
      })
    if (match) return { match }
    if (/Senkronizasyon duraklatıldı|Synchronization paused/i.test(document.body.innerText)) return { reason: 'sync_paused' }
    if (/Eski mesajlar senkronize ediliyor|Syncing older messages/i.test(document.body.innerText)) return { reason: 'syncing' }
    return null
  }, 20000)
  if (!result?.match) {
    return { message: null, reason: result?.reason || 'not_found' }
  }
  result.match.click()
  const message = await waitFor(() => findLoadedMessage({ title }), 10000)
  return { message, reason: message ? '' : 'not_found' }
}

function injectMenuAction(result) {
  let attempt = 0
  const timer = window.setInterval(() => {
    attempt += 1
    MENU_ACTION_IDS.forEach((id) => document.getElementById(id)?.remove())
    const replyButton = [...document.querySelectorAll('button[role="menuitem"]')]
      .find((button) => ['Cevapla', 'Reply'].includes(button.getAttribute('aria-label')) && button.offsetParent !== null)
    if (!replyButton) {
      if (attempt >= 20) window.clearInterval(timer)
      return
    }

    window.clearInterval(timer)
    const originalLabel = replyButton.getAttribute('aria-label') || 'Cevapla'
    const nativeDownloadButton = [...document.querySelectorAll('button[role="menuitem"]')]
      .find((button) => /^(indir|download)$/i.test(String(button.getAttribute('aria-label') || button.textContent || '').trim()))
    const startLocalDownload = (payload, nextAction) => {
      if (nativeDownloadButton && payload) {
        ipcRenderer.send('whatsapp-stage-source-download', payload)
        nativeDownloadButton.click()
      }
      window.setTimeout(nextAction, nativeDownloadButton ? 350 : 0)
    }
    const addAction = ({ id, label, enabled = true, muted = false, onClick }) => {
      const button = replyButton.cloneNode(true)
      button.id = id
      button.setAttribute('aria-label', label)
      button.querySelectorAll('span').forEach((span) => {
        if (span.textContent?.trim() === originalLabel) span.textContent = label
      })
      button.disabled = !enabled
      button.setAttribute('aria-disabled', String(!enabled))
      if (!enabled || muted) {
        button.style.opacity = '0.48'
        button.style.cursor = enabled ? 'pointer' : 'not-allowed'
      }
      button.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        onClick?.()
      })
      replyButton.parentElement?.appendChild(button)
    }

    addAction({
      id: MENU_ACTION_IDS[0],
      label: result.order?.enabled ? 'Projeyi Sipariş Takibe Al' : 'Projeyi Sipariş Takibe Al — kayıtlı müşteri değil',
      enabled: Boolean(result.order?.enabled),
      onClick: () => result.order?.payload && startLocalDownload(result.order.payload, () => ipcRenderer.send('whatsapp-open-project', result.order.payload)),
    })
    addAction({
      id: MENU_ACTION_IDS[1],
      label: result.quick?.enabled ? 'Hızlı Takip Siparişi Oluştur' : 'Hızlı Takip Siparişi — kayıtlı müşteri',
      enabled: Boolean(result.quick?.enabled),
      onClick: () => result.quick?.payload && startLocalDownload(result.quick.payload, () => ipcRenderer.send('whatsapp-add-quick-order', result.quick.payload)),
    })
    addAction({
      id: MENU_ACTION_IDS[2],
      label: result.customer?.enabled ? 'Müşteri Olarak Ekle' : 'Müşteri Olarak Ekle — zaten kayıtlı',
      enabled: Boolean(result.customer?.enabled),
      onClick: () => result.customer?.payload && ipcRenderer.send('whatsapp-add-customer', result.customer.payload),
    })
    addAction({
      id: MENU_ACTION_IDS[3],
      label: result.cancel?.enabled ? 'Projeyi İptal Et' : 'Projeyi İptal Et — kayıtlı proje bulunamadı',
      muted: !result.cancel?.enabled,
      onClick: () => {
        if (result.cancel?.enabled && result.cancel.payload) ipcRenderer.send('whatsapp-cancel-project', result.cancel.payload)
        else window.alert(result.cancel?.reason || 'Bu proje Sipariş Takip’te kayıtlı değil. Hiçbir kayıt değiştirilmedi.')
      },
    })
  }, 50)
}

window.addEventListener('contextmenu', async (event) => {
  const message = event.target.closest('[data-id], [role="row"]')
  const title = projectTitle(message)
  const chat = currentChatName().slice(0, 120)
  const messageId = message?.getAttribute?.('data-id') || ''
  const phone = phoneFromMessageId(messageId)
  const timestamp = messageTimestamp(message)
  const result = await ipcRenderer.invoke('whatsapp-project-context', { title, chat, messageId, phone, timestamp })
  injectMenuAction(result)
}, true)

ipcRenderer.on('whatsapp-show-source', async (_event, value) => {
  const source = { title: String(value?.title || '').trim(), chat: String(value?.chat || '').trim(), messageId: String(value?.messageId || '').trim(), phone: String(value?.phone || '').replace(/\D/g, ''), timestamp: String(value?.timestamp || '').trim(), orderDate: String(value?.orderDate || '').trim(), phoneOpened: value?.phoneOpened === true }
  const appReady = await waitFor(() => document.querySelector('#side, #pane-side, [data-testid="chat-list"]'), 30000)
  const chatReady = Boolean(appReady) && (matchesAlias(currentChatName(), source.chat) || await openChat(source.chat))
  if (appReady && !chatReady && source.phone && !source.phoneOpened) {
    ipcRenderer.send('whatsapp-open-phone-source', source)
    return
  }
  if (!source.title || !source.chat) {
    window.alert('Siparişin WhatsApp kaynak bilgisi eksik.')
    return
  }
  if (!chatReady) {
    showSourceFallback(source, appReady ? 'chat_not_opened' : 'not_loaded')
    return
  }
  let message = findLoadedMessage(source) || await findMessageByScrolling(source)
  let searchReason = ''
  if (!message) {
    const result = await searchCurrentChat(source.title)
    message = result.message
    searchReason = result.reason
  }
  if (message) highlightMessage(message)
  else showSourceFallback(source, searchReason)
})

function downloadButtonForMessage(message) {
  if (!message) return null
  const direct = message.querySelector('[aria-label*="indir" i], [title*="indir" i], [aria-label*="download" i], [title*="download" i], a[download]')
  if (direct) return direct.closest('button, [role="button"], a') || direct
  const icon = message.querySelector('[data-icon="download"], [data-icon="download-alt"], [data-testid*="download"]')
  return icon?.closest('button, [role="button"], a') || null
}

ipcRenderer.on('whatsapp-download-source', async (_event, value) => {
  const source = { title: String(value?.title || '').trim(), chat: String(value?.chat || '').trim(), messageId: String(value?.messageId || '').trim(), managerEmail: String(value?.managerEmail || '').trim(), timestamp: String(value?.timestamp || '').trim() }
  let message = findLoadedMessage(source)
  if (!message && matchesAlias(currentChatName(), source.chat)) message = await findMessageByScrolling(source)
  if (!message) {
    ipcRenderer.send('whatsapp-source-download-failed', source)
    return
  }
  message.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, view: window }))
  message.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, view: window }))
  await new Promise((resolve) => window.setTimeout(resolve, 350))
  const downloadButton = downloadButtonForMessage(message)
  if (!downloadButton) {
    ipcRenderer.send('whatsapp-source-download-failed', source)
    return
  }
  downloadButton.click()
})
