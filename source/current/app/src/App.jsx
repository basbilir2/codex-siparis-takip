import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import Papa from 'papaparse'
import readXlsxFile from 'read-excel-file/browser'
import { onAuthStateChanged } from 'firebase/auth'
import {
  Timestamp,
  addDoc,
  collection,
  doc,
  getDoc,
  onSnapshot,
  query,
  serverTimestamp,
  where,
  writeBatch,
} from 'firebase/firestore'
import { auth, completeGoogleRedirect, db, loginWithGoogle, logout } from './firebase'
import {
  ORDER_STATUSES,
  ORDER_TYPES,
  calculateSalePrice,
  convertCurrency,
  customerTransferId,
  filterCustomerOrders,
  filterOrders,
  findCustomerImportRows,
  formatDate,
  formatDateTime,
  friendlyError,
  extractCustomerDraftFromWorkbook,
  extractOrderDraftsFromWorkbook,
  findRedundantCustomerBackups,
  findInactiveOrders,
  matchesCustomerChat,
  mapCustomerImportRows,
  materialCostPerM2,
  normalizeEmail,
  normalizeText,
  orderAreaM2,
  orderFinance,
  parseProjectTitle,
  summarizeByMaterial,
  summarizeFinance,
  summarizeFinanceByCustomer,
  summarizeOrders,
  toDate,
  toDateInput,
  todayInput,
} from './utils'
import './App.css'

const EMPTY_FILTERS = { search: '', status: '', customerId: '', type: '', urgent: '' }
const RETAIL_CUSTOMER_FILTER = '__retail__'
const CUSTOMER_APP_URL = 'https://PRIVATE_VALUE_011'
const TRACKING_URL = (token) => `${CUSTOMER_APP_URL}/?takip=${encodeURIComponent(token)}`
const DEFAULT_MATERIALS = ['Pleksi', 'Folyo', 'Dekota', 'Kompozit', 'Branda', 'Kâğıt']
const CURRENCY_OPTIONS = [
  { value: 'TRY', label: 'Türk lirası (₺)', symbol: '₺' },
  { value: 'USD', label: 'Dolar ($)', symbol: '$' },
  { value: 'EUR', label: 'Euro (€)', symbol: '€' },
  { value: 'GBP', label: 'Sterlin (£)', symbol: '£' },
]
const MATERIAL_CALCULATION_TYPES = [
  { value: 'area', label: 'Ölçü (m²)', unit: 'm²', help: 'En ve boy ölçüsünden hesaplanır.' },
  { value: 'minute', label: 'Süre (dakika)', unit: 'dakika', help: 'Kullanılan dakika üzerinden hesaplanır.' },
  { value: 'weight', label: 'Ağırlık (kg)', unit: 'kg', help: 'Kullanılan kilogram üzerinden hesaplanır.' },
  { value: 'quantity', label: 'Adet', unit: 'adet', help: 'Ürün adedi üzerinden hesaplanır.' },
  { value: 'fixed', label: 'Sabit işlem ücreti', unit: 'işlem', help: 'Siparişe bir kez sabit ücret eklenir.' },
  { value: 'thickness', label: 'Kalınlık (mm)', unit: 'mm', help: 'Pleksi, dekota gibi malzemelerin kalınlığını kaydeder.', nonPriced: true },
  { value: 'custom', label: 'Özel birim', unit: 'birim', help: 'İsmini ve birimini siz belirlersiniz.' },
]

function newTrackingToken() {
  return `${crypto.randomUUID().replaceAll('-', '')}${Math.random().toString(36).slice(2, 10)}`
}

function publicOrderData(payload = {}) {
  return {
    name: payload.name || 'Sipariş', type: payload.type || 'Diğer', material: payload.material || '',
    widthCm: payload.widthCm || null, heightCm: payload.heightCm || null, areaM2: payload.areaM2 || null,
    quantity: payload.quantity || null, calculationType: payload.calculationType || null,
    calculationQuantity: payload.calculationQuantity || null, calculationValues: payload.calculationValues || {},
    inputDefinitions: payload.inputDefinitions || [], receivedAt: payload.receivedAt || null,
    estimatedCompletion: payload.estimatedCompletion || null, status: payload.status || 'Bekliyor',
    urgent: Boolean(payload.urgent), description: payload.description || '', updatedAt: serverTimestamp(),
  }
}

function syncPublicOrder(batch, orderId, payload, customers = [], previousCustomerId = '') {
  const nextCustomer = customers.find((customer) => customer.id === payload.customerId)
  const previousCustomer = customers.find((customer) => customer.id === previousCustomerId)
  if (previousCustomer?.quickTracking && previousCustomer.trackingToken && previousCustomer.id !== nextCustomer?.id) {
    batch.delete(doc(db, 'publicTracking', previousCustomer.trackingToken, 'orders', orderId))
  }
  if (nextCustomer?.quickTracking && nextCustomer.trackingToken) {
    batch.set(doc(db, 'publicTracking', nextCustomer.trackingToken, 'orders', orderId), publicOrderData(payload), { merge: true })
  }
}

function materialFields(material = {}) {
  const valid = new Set(MATERIAL_CALCULATION_TYPES.map((item) => item.value))
  const customKeys = new Set((material.customInputs || []).map((item) => item.id))
  const fields = Array.isArray(material.inputFields) ? material.inputFields.filter((item) => valid.has(item) || customKeys.has(item)) : []
  return fields.length ? [...new Set(fields)] : [valid.has(material.calculationType) ? material.calculationType : 'area']
}

function fieldMeta(key, material = {}) {
  const base = materialType(key)
  const configured = (material.inputDefinitions || []).find((item) => item.key === key)
  const custom = (material.customInputs || []).find((item) => item.id === key)
  if (custom) return { value: key, label: configured?.label || custom.label || 'Özel miktar', unit: configured?.unit || custom.unit || 'birim', help: configured?.help || custom.help || 'İşinize özel miktar alanı.' }
  if (configured) return { ...base, label: configured.label || base.label, unit: configured.unit || base.unit, help: configured.help || base.help }
  return key === 'custom' ? { ...base, label: material.customFieldLabel || 'Özel miktar', unit: material.customUnit || 'birim' } : base
}

function isSquareMeterUnit(unit = '') {
  return ['m²', 'm2', 'metrekare'].includes(normalizeText(unit).replace(/\s+/g, ''))
}

function componentDisplayName(material = {}) {
  if (material.itemType === 'service') return material.variantName || material.name || 'Hizmet'
  if (material.variantName && material.groupName) return `${material.variantName} ${material.groupName}`
  return material.name || 'Malzeme'
}

function materialGroupsForSelect(entries = []) {
  const groups = new Map()
  entries.forEach((entry) => {
    const name = entry.groupName || (entry.itemType === 'service' ? 'Diğer hizmetler' : 'Diğer malzemeler')
    groups.set(name, [...(groups.get(name) || []), entry])
  })
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b, 'tr'))
}

function newCustomInput() {
  return { id: `custom_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, label: '', unit: '' }
}

function materialType(type) {
  return MATERIAL_CALCULATION_TYPES.find((item) => item.value === type) || MATERIAL_CALCULATION_TYPES[0]
}

function downloadTextFile(fileName, content, type) {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

function exportSafe(value) {
  if (value === null || value === undefined) return value
  if (typeof value?.toDate === 'function') return value.toDate().toISOString()
  if (Array.isArray(value)) return value.map(exportSafe)
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, exportSafe(item)]))
  return value
}

function activityData(actor, action, entityType, entityId, label, details = {}) {
  return {
    actorEmail: normalizeEmail(actor?.email),
    actorName: actor?.displayName || actor?.email || 'Yönetici',
    action,
    entityType,
    entityId,
    label,
    details,
    managerEmail: normalizeEmail(details.managerEmail || actor?.email),
    createdAt: serverTimestamp(),
  }
}

function addActivityToBatch(batch, actor, action, entityType, entityId, label, details) {
  batch.set(doc(collection(db, 'activities')), activityData(actor, action, entityType, entityId, label, details))
}

function sortNewest(items) {
  return [...items].sort((a, b) => (toDate(b.createdAt)?.getTime() || 0) - (toDate(a.createdAt)?.getTime() || 0))
}

function sortOrdersNewest(items) {
  return [...items].sort((a, b) => {
    const aDelivered = a.status === 'Teslim Edildi'
    const bDelivered = b.status === 'Teslim Edildi'
    if (aDelivered !== bDelivered) return aDelivered ? 1 : -1
    if (aDelivered && bDelivered) {
      const bDeliveredTime = toDate(b.deliveredAt || b.statusChangedAt || b.updatedAt || b.receivedAt)?.getTime() || 0
      const aDeliveredTime = toDate(a.deliveredAt || a.statusChangedAt || a.updatedAt || a.receivedAt)?.getTime() || 0
      return bDeliveredTime - aDeliveredTime
    }
    const bTime = toDate(b.receivedAt || b.createdAt)?.getTime() || 0
    const aTime = toDate(a.receivedAt || a.createdAt)?.getTime() || 0
    return bTime - aTime || (toDate(b.createdAt)?.getTime() || 0) - (toDate(a.createdAt)?.getTime() || 0)
  })
}

function upcomingDeliveries(orders = [], settings = {}) {
  if (!settings.enabled) return []
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const limit = Math.max(0, Number(settings.daysBefore) || 0)
  return orders.map((order) => {
    const due = toDate(order.estimatedCompletion)
    if (!due || ['Teslim Edildi', 'İptal Edildi'].includes(order.status)) return null
    due.setHours(0, 0, 0, 0)
    const daysLeft = Math.ceil((due.getTime() - today.getTime()) / 86400000)
    return daysLeft >= 0 && daysLeft <= limit ? { ...order, daysLeft } : null
  }).filter(Boolean).sort((a, b) => a.daysLeft - b.daysLeft)
}

function formatCurrency(value, currency = 'TRY') {
  return new Intl.NumberFormat('tr-TR', { style: 'currency', currency, maximumFractionDigits: 2 }).format(Number(value) || 0)
}

function currentExchangeRateMap(exchangeRates = []) {
  const latest = exchangeRates[0] || {}
  return { TRY: 1, USD: Number(latest.USD) || 0, EUR: Number(latest.EUR) || 0, GBP: Number(latest.GBP) || 0 }
}

function formatSystemCurrency(valueInTry, financeSettings = {}, currentRates = {}) {
  const currency = String(financeSettings.systemCurrency || 'TRY').toUpperCase()
  const converted = convertCurrency(valueInTry, 'TRY', currency, currentRates)
  return converted === null ? 'Kur eksik' : formatCurrency(converted, currency)
}

function formatOrderMeasurement(order) {
  const parts = []
  const area = orderAreaM2(order)
  if (area) parts.push(`${area.toLocaleString('tr-TR', { maximumFractionDigits: 2 })} m²`)
  const labels = { minute: 'dakika', weight: 'kg', quantity: 'adet', custom: order.customUnit || 'birim', ...Object.fromEntries((order.inputDefinitions || []).map((item) => [item.key, item.unit || 'birim'])) }
  Object.entries(order.calculationValues || {}).forEach(([key, value]) => { if (Number(value) > 0) parts.push(`${Number(value).toLocaleString('tr-TR', { maximumFractionDigits: 3 })} ${labels[key] || key}`) })
  if (parts.length) return parts.join(' · ')
  const calculation = materialType(order.calculationType)
  if (calculation.value !== 'area' && Number(order.calculationQuantity) > 0) return `${Number(order.calculationQuantity).toLocaleString('tr-TR', { maximumFractionDigits: 3 })} ${calculation.unit}`
  if (order.widthCm && order.heightCm) return `${order.widthCm} × ${order.heightCm} cm`
  return '—'
}

function Icon({ name, size = 20 }) {
  const paths = {
    back: 'M19 12H5M12 19l-7-7 7-7',
    orders: 'M4 5h16M4 12h16M4 19h10',
    customers: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
    admins: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10ZM9 12l2 2 4-4',
    requests: 'M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v8Z',
    reports: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
    finance: 'M12 2v20M17 6.5c0-1.4-2.2-2.5-5-2.5S7 5.1 7 6.5 9.2 9 12 9s5 1.1 5 2.5-2.2 2.5-5 2.5-5-1.1-5-2.5',
    materials: 'm12 2 9 5-9 5-9-5 9-5Zm-9 10 9 5 9-5M3 17l9 5 9-5',
    history: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2',
    whatsapp: 'M20 11.5a8 8 0 0 1-11.8 7L3 20l1.5-5.1A8 8 0 1 1 20 11.5ZM8.5 7.5c.5 3 2.5 5 5.5 6',
    restore: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5',
    plus: 'M12 5v14M5 12h14',
    logout: 'M10 17l5-5-5-5M15 12H3M21 19V5a2 2 0 0 0-2-2h-6',
    search: 'm21 21-4.35-4.35M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',
    edit: 'M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5Z',
    settings: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.12 2.12-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.04 1.56V20h-3v-.08a1.7 1.7 0 0 0-1.04-1.56 1.7 1.7 0 0 0-1.88.34l-.06.06-2.12-2.12.06-.06A1.7 1.7 0 0 0 7 14.7a1.7 1.7 0 0 0-1.56-1.04H5v-3h.08A1.7 1.7 0 0 0 6.64 9.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.12-2.12.06.06a1.7 1.7 0 0 0 1.88.34A1.7 1.7 0 0 0 11.34 4.4V4h3v.08a1.7 1.7 0 0 0 1.04 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.12 2.12-.06.06a1.7 1.7 0 0 0-.34 1.88 1.7 1.7 0 0 0 1.56 1.04H21v3h-.08A1.7 1.7 0 0 0 19.4 15Z',
    mail: 'M4 5h16v14H4V5Zm0 2 8 6 8-6',
    copy: 'M8 8h11v11H8V8Zm-3 8H4V4h12v1',
    trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v5M14 11v5',
    list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
    grid: 'M4 4h6v6H4V4Zm10 0h6v6h-6V4ZM4 14h6v6H4v-6Zm10 0h6v6h-6v-6Z',
    close: 'M18 6 6 18M6 6l12 12',
    check: 'm5 12 4 4L19 6',
    backup: 'M12 3v12M7 10l5 5 5-5M4 19h16',
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[name] || paths.orders} />
    </svg>
  )
}

function Brand({ compact = false }) {
  return (
    <div className={`brand ${compact ? 'brand-compact' : ''}`}>
      <div className="brand-symbol" aria-hidden="true"><i /><i /><i /></div>
      <div><strong>İzmirde Reklam Sipariş Takip</strong><span>Sipariş yönetimi</span></div>
    </div>
  )
}

function LoadingScreen() {
  return <main className="center-screen"><div className="loader" /><p>Güvenli bağlantı kuruluyor…</p></main>
}

function LoginScreen({ error, busy, onLogin }) {
  return (
    <main className="login-page">
      <section className="login-visual" aria-hidden="true">
        <Brand />
        <div className="visual-copy">
          <span className="eyebrow">Baskı merkezi operasyonu</span>
          <h1>Her sipariş,<br />tam zamanında.</h1>
          <p>Siparişleri, müşterileri ve üretim durumlarını tek bir güvenli merkezden yönetin.</p>
          <div className="visual-stats"><span><b>5</b> durum adımı</span><span><b>Canlı</b> güncellemeler</span></div>
        </div>
        <div className="visual-orb orb-one" /><div className="visual-orb orb-two" />
      </section>
      <section className="login-panel">
        <div className="login-card">
          <Brand compact />
          <span className="eyebrow">Güvenli giriş</span>
          <h2>Siparişlerinize hoş geldiniz</h2>
          <p>Size tanımlanan Google hesabıyla devam edin.</p>
          <button className="google-button" type="button" onClick={onLogin} disabled={busy}>
            <span className="google-g">G</span>{busy ? 'Giriş yapılıyor…' : 'Google ile devam et'}
          </button>
          {error && <div className="alert alert-error" role="alert">{error}</div>}
          <small>Yalnızca sipariş takibi için gerekli profil bilginiz kullanılır.</small>
        </div>
      </section>
    </main>
  )
}

function AccessDenied({ user, reason }) {
  return (
    <main className="center-screen denied-screen">
      <Brand />
      <div className="denied-icon">!</div>
      <h1>Erişim tanımlı değil</h1>
      <p>{reason || 'Bu hesap için aktif bir yetki kaydı bulunamadı.'}</p>
      <span className="account-pill">{user?.email}</span>
      <button className="button secondary" type="button" onClick={logout}>Farklı hesapla giriş yap</button>
    </main>
  )
}

function PublicTrackingPage({ token }) {
  const [customer, setCustomer] = useState(null)
  const [orders, setOrders] = useState([])
  const [error, setError] = useState('')
  useEffect(() => {
    const customerRef = doc(db, 'publicTracking', token)
    const stopCustomer = onSnapshot(customerRef, (snapshot) => {
      if (!snapshot.exists() || snapshot.data().active === false) setError('Bu takip bağlantısı geçerli değil.')
      else setCustomer(snapshot.data())
    }, () => setError('Takip bilgisi açılamadı.'))
    const stopOrders = onSnapshot(collection(db, 'publicTracking', token, 'orders'), (snapshot) => {
      setOrders(sortOrdersNewest(snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))))
    }, () => setError('Siparişler açılamadı.'))
    return () => { stopCustomer(); stopOrders() }
  }, [token])
  if (error) return <main className="center-screen denied-screen"><Brand /><div className="denied-icon">!</div><h1>Takip bağlantısı açılamadı</h1><p>{error}</p></main>
  if (!customer) return <LoadingScreen />
  return <main className="public-tracking-page"><header className="customer-header"><Brand /><div className="customer-account"><div><strong>{customer.displayName}</strong><span>Şifresiz sipariş takibi</span></div></div></header><section className="customer-orders"><div className="customer-intro"><div><span className="eyebrow">Sipariş takip bağlantısı</span><h1>{customer.displayName}</h1><p>Bu sayfada yalnızca bu bağlantıya ait siparişlerin durumu görünür.</p></div><div><strong>{orders.length}</strong><span>sipariş</span></div></div><div className="customer-orders-panel">{orders.length > 0 ? <div className="customer-table-wrap"><table className="customer-table"><thead><tr><th>Sipariş</th><th>Malzeme + Hizmet</th><th>Ölçü</th><th>Durum</th><th>Tahmini bitiş</th></tr></thead><tbody>{orders.map((order) => <tr key={order.id}><td data-label="Sipariş"><strong>{order.name}</strong><span className="cell-note">{order.description || 'Açıklama yok'}</span></td><td data-label="Malzeme + Hizmet">{order.material || order.type || 'Belirtilmedi'}</td><td data-label="Ölçü">{formatOrderMeasurement(order)}</td><td data-label="Durum"><StatusBadge status={order.status} /></td><td data-label="Tahmini bitiş">{formatDate(order.estimatedCompletion)}</td></tr>)}</tbody></table></div> : <EmptyState title="Henüz sipariş yok" text="Sipariş eklendiğinde burada görünecek." />}</div></section></main>
}

function AuthenticatedApp() {
  const [user, setUser] = useState(null)
  const [access, setAccess] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loginBusy, setLoginBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const importParams = new URLSearchParams(window.location.search)
    if (importParams.get('waTitle') || importParams.get('waAction')) {
      sessionStorage.setItem('whatsappImport', JSON.stringify({ action: importParams.get('waAction') || 'order', orderId: importParams.get('waOrderId') || '', title: importParams.get('waTitle') || '', chat: importParams.get('waChat') || '', messageId: importParams.get('waMessageId') || '', phone: importParams.get('waPhone') || '', timestamp: importParams.get('waTimestamp') || '', customerId: importParams.get('waCustomerId') || '', source: 'whatsapp' }))
      window.history.replaceState({}, '', `${window.location.pathname}${window.location.hash}`)
    }
    completeGoogleRedirect().catch((err) => {
      setError(friendlyError(err))
      setLoginBusy(false)
    })
    return onAuthStateChanged(auth, async (currentUser) => {
      setLoading(true)
      setUser(currentUser)
      setAccess(null)
      setError('')
      if (currentUser?.email) {
        try {
          const snapshot = await getDoc(doc(db, 'access', normalizeEmail(currentUser.email)))
          if (snapshot.exists()) setAccess({ id: snapshot.id, ...snapshot.data() })
          else setAccess({ role: 'unauthorized', active: false })
        } catch (err) {
          setError(friendlyError(err))
          setAccess({ role: 'error', active: false })
        }
      }
      setLoading(false)
      setLoginBusy(false)
    })
  }, [])

  async function handleLogin() {
    setError('')
    setLoginBusy(true)
    try {
      await loginWithGoogle()
    } catch (err) {
      setError(friendlyError(err))
      setLoginBusy(false)
    }
  }

  if (loading) return <LoadingScreen />
  if (!user) return <LoginScreen error={error} busy={loginBusy} onLogin={handleLogin} />
  if (!access || access.active === false || !['owner', 'admin', 'customer'].includes(access.role)) {
    const reason = access?.active === false && access?.role !== 'unauthorized' ? 'Hesabınız pasif durumda. Yöneticinizle iletişime geçin.' : error
    return <AccessDenied user={user} reason={reason} />
  }
  if (access.role === 'customer') return <CustomerDashboard user={user} access={access} />
  return <AdminDashboard user={user} access={access} />
}

function App() {
  const trackingToken = new URLSearchParams(window.location.search).get('takip')?.trim()
  return trackingToken ? <PublicTrackingPage token={trackingToken} /> : <AuthenticatedApp />
}

function Sidebar({ active, setActive, isOwner, pendingCount, user }) {
  const items = [
    ['customers', 'Müşteriler'],
    ['orders', 'Siparişler'],
    ['reports', 'Toplamlar ve Finans'],
    ['materials', 'Malzeme ve Hizmet'],
    ...(isOwner ? [['admins', 'Yöneticiler']] : []),
    ['requests', 'Talepler'],
    ['settings', 'Ayarlar'],
  ]
  return (
    <aside className="sidebar">
      <Brand />
      <nav aria-label="Ana menü">
        {items.map(([key, label]) => (
          <button key={key} type="button" className={active === key ? 'nav-item active' : 'nav-item'} onClick={() => setActive(key)}>
            <Icon name={key} /><span>{label}</span>{key === 'requests' && pendingCount > 0 && <b className="nav-badge">{pendingCount}</b>}
          </button>
        ))}
      </nav>
      <div className="sidebar-user">
        <div className="avatar">{(user.displayName || user.email || 'K').slice(0, 1).toLocaleUpperCase('tr-TR')}</div>
        <div><strong>{user.displayName || 'Kullanıcı'}</strong><span>{user.email}</span></div>
        <button type="button" title="Çıkış yap" aria-label="Çıkış yap" onClick={logout}><Icon name="logout" /></button>
      </div>
    </aside>
  )
}

function AdminDashboard({ user, access }) {
  const [active, setActive] = useState('customers')
  const [orderCustomerFilter, setOrderCustomerFilter] = useState('')
  const [attentionOrderIds, setAttentionOrderIds] = useState([])
  const [orders, setOrders] = useState([])
  const [customers, setCustomers] = useState([])
  const [accessList, setAccessList] = useState([])
  const [requests, setRequests] = useState([])
  const [materials, setMaterials] = useState([])
  const [materialGroups, setMaterialGroups] = useState([])
  const [materialTemplates, setMaterialTemplates] = useState([])
  const [exchangeRates, setExchangeRates] = useState([])
  const [exchangeRatesLoaded, setExchangeRatesLoaded] = useState(false)
  const [financeSettings, setFinanceSettings] = useState({ systemCurrency: 'TRY' })
  const [financeSettingsLoaded, setFinanceSettingsLoaded] = useState(false)
  const [deliverySettings, setDeliverySettings] = useState({ enabled: true, daysBefore: 3 })
  const [inactivitySettings, setInactivitySettings] = useState({ enabled: true, daysWithoutMovement: 3 })
  const [backupSettings, setBackupSettings] = useState({ loaded: false, enabled: true, intervalDays: 7, retentionDays: 90 })
  const [customerBackups, setCustomerBackups] = useState([])
  const [backupBusy, setBackupBusy] = useState(false)
  const backupRunRef = useRef({ running: false, lastCreatedAt: 0, deletingIds: new Set() })
  const automaticRateRef = useRef('')
  const customerPriceSyncRef = useRef('')
  const customerCatalogSyncRef = useRef('')
  const [orderPrivateMap, setOrderPrivateMap] = useState({})
  const [customerPrivateMap, setCustomerPrivateMap] = useState({})
  const [activities, setActivities] = useState([])
  const [trash, setTrash] = useState([])
  const [transfers, setTransfers] = useState([])
  const [migrationBusy, setMigrationBusy] = useState(false)
  const [dataError, setDataError] = useState('')
  const [modal, setModal] = useState(null)
  const [toast, setToast] = useState('')
  const isOwner = access.role === 'owner'
  const staffEmail = normalizeEmail(user.email)

  useEffect(() => {
    window.siparisTakip?.syncCurrentManager?.(staffEmail)
  }, [staffEmail])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    let stored = null
    try { stored = JSON.parse(sessionStorage.getItem('whatsappImport') || 'null') } catch { stored = null }
    const action = params.get('waAction') || stored?.action || 'order'
    const title = params.get('waTitle') || stored?.title || ''
    const chat = params.get('waChat') || stored?.chat || ''
    const messageId = params.get('waMessageId') || stored?.messageId || ''
    const phone = params.get('waPhone') || stored?.phone || ''
    const timestamp = params.get('waTimestamp') || stored?.timestamp || ''
    const customerId = params.get('waCustomerId') || stored?.customerId || ''
    const orderId = params.get('waOrderId') || stored?.orderId || ''
    if (!title && !chat && !orderId) return
    if (action === 'customer' || action === 'quick') {
      setActive('customers')
      setModal({ type: 'customer', prefill: { displayName: chat, whatsappName: chat, quickTracking: action === 'quick', nextOrderTitle: action === 'quick' ? title : '', nextOrderMessageId: action === 'quick' ? messageId : '', nextOrderPhone: action === 'quick' ? phone : '', nextOrderTimestamp: action === 'quick' ? timestamp : '' } })
    } else if (action === 'cancel') {
      setActive('orders')
      setModal({ type: 'cancel', orderId, title })
    } else {
      setActive('orders')
      setModal({ type: 'order', prefill: { title, chat, messageId, phone, timestamp, customerId, source: 'whatsapp' } })
    }
    sessionStorage.removeItem('whatsappImport')
    window.history.replaceState({}, '', `${window.location.pathname}${window.location.hash}`)
  }, [])

  useEffect(() => {
    const onError = (err) => setDataError(friendlyError(err))
    const scoped = (name, field = 'managerEmail') => isOwner ? collection(db, name) : query(collection(db, name), where(field, '==', staffEmail))
    const unsubscribers = [
      onSnapshot(scoped('orders'), (snap) => setOrders(sortOrdersNewest(snap.docs.map((item) => ({ id: item.id, ...item.data() })))), onError),
      onSnapshot(scoped('customers', 'assignedAdminEmail'), (snap) => setCustomers(snap.docs.map((item) => ({ id: item.id, ...item.data() })).sort((a, b) => a.displayName.localeCompare(b.displayName, 'tr'))), onError),
      ...(isOwner ? [onSnapshot(collection(db, 'access'), (snap) => setAccessList(snap.docs.map((item) => ({ id: item.id, ...item.data() }))), onError)] : []),
      onSnapshot(scoped('requests'), (snap) => setRequests(sortNewest(snap.docs.map((item) => ({ id: item.id, ...item.data() })))), onError),
      onSnapshot(collection(db, 'materials'), (snap) => setMaterials(snap.docs.map((item) => ({ id: item.id, ...item.data() })).sort((a, b) => a.name.localeCompare(b.name, 'tr'))), onError),
      onSnapshot(collection(db, 'materialGroups'), (snap) => setMaterialGroups(snap.docs.map((item) => ({ id: item.id, ...item.data() })).sort((a, b) => a.name.localeCompare(b.name, 'tr'))), onError),
      onSnapshot(collection(db, 'materialTemplates'), (snap) => setMaterialTemplates(snap.docs.map((item) => ({ id: item.id, ...item.data() })).sort((a, b) => a.name.localeCompare(b.name, 'tr'))), onError),
      onSnapshot(collection(db, 'exchangeRates'), (snap) => { setExchangeRates(snap.docs.map((item) => ({ id: item.id, ...item.data() })).sort((a, b) => b.id.localeCompare(a.id))); setExchangeRatesLoaded(true) }, onError),
      onSnapshot(doc(db, 'settings', 'financeDisplay'), (snap) => { setFinanceSettings(snap.exists() ? { systemCurrency: 'TRY', manualRateEnabled: false, ...snap.data() } : { systemCurrency: 'TRY', manualRateEnabled: false }); setFinanceSettingsLoaded(true) }, onError),
      onSnapshot(doc(db, 'settings', 'deliveryReminders'), (snap) => setDeliverySettings(snap.exists() ? { enabled: true, daysBefore: 3, ...snap.data() } : { enabled: true, daysBefore: 3 }), onError),
      onSnapshot(doc(db, 'settings', 'orderInactivity'), (snap) => setInactivitySettings(snap.exists() ? { enabled: true, daysWithoutMovement: 3, ...snap.data() } : { enabled: true, daysWithoutMovement: 3 }), onError),
      onSnapshot(doc(db, 'backupSettings', staffEmail), (snap) => setBackupSettings({ loaded: true, enabled: true, intervalDays: 7, retentionDays: 90, ...(snap.exists() ? snap.data() : {}) }), onError),
      onSnapshot(isOwner ? collection(db, 'customerBackups') : query(collection(db, 'customerBackups'), where('managerEmail', '==', staffEmail)), (snap) => setCustomerBackups(sortNewest(snap.docs.map((item) => ({ id: item.id, ...item.data() })))), onError),
      onSnapshot(scoped('orderPrivate'), (snap) => setOrderPrivateMap(Object.fromEntries(snap.docs.map((item) => [item.id, item.data()]))), onError),
      onSnapshot(scoped('customerPrivate'), (snap) => setCustomerPrivateMap(Object.fromEntries(snap.docs.map((item) => [item.id, item.data()]))), onError),
      ...(isOwner ? [
        onSnapshot(collection(db, 'activities'), (snap) => setActivities(sortNewest(snap.docs.map((item) => ({ id: item.id, ...item.data() }))).slice(0, 150)), onError),
        onSnapshot(collection(db, 'trash'), (snap) => setTrash(sortNewest(snap.docs.map((item) => ({ id: item.id, ...item.data() })))), onError),
      ] : []),
      onSnapshot(isOwner ? collection(db, 'customerTransfers') : query(collection(db, 'customerTransfers'), where('toEmail', '==', staffEmail)), (snap) => setTransfers(sortNewest(snap.docs.map((item) => ({ id: item.id, ...item.data() })))), onError),
    ]
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe())
  }, [isOwner, staffEmail])

  useEffect(() => {
    if (!customers.length || !materials.length) return
    const safeCatalog = materials.filter((entry) => entry.active !== false && entry.kind !== 'composite').map((entry) => ({ id: entry.id, name: entry.name, label: componentDisplayName(entry), itemType: entry.itemType === 'service' ? 'service' : 'material' }))
    const defaultMaterialIds = safeCatalog.filter((entry) => entry.itemType === 'material').map((entry) => entry.id)
    const defaultServiceIds = safeCatalog.filter((entry) => entry.itemType === 'service').map((entry) => entry.id)
    const updates = customers.map((customer) => {
      const allowedMaterialIds = Array.isArray(customer.allowedMaterialIds) ? customer.allowedMaterialIds : defaultMaterialIds
      const allowedServiceIds = Array.isArray(customer.allowedServiceIds) ? customer.allowedServiceIds : defaultServiceIds
      const customerOrderCatalog = safeCatalog.filter((entry) => (entry.itemType === 'service' ? allowedServiceIds : allowedMaterialIds).includes(entry.id))
      const changed = !Array.isArray(customer.allowedMaterialIds) || !Array.isArray(customer.allowedServiceIds) || JSON.stringify(customer.customerOrderCatalog || []) !== JSON.stringify(customerOrderCatalog)
      return changed ? { customer, allowedMaterialIds, allowedServiceIds, customerOrderCatalog } : null
    }).filter(Boolean)
    const signature = updates.map(({ customer, customerOrderCatalog }) => `${customer.id}:${JSON.stringify(customerOrderCatalog)}`).sort().join('|')
    if (!signature || customerCatalogSyncRef.current === signature) return
    customerCatalogSyncRef.current = signature
    ;(async () => {
      for (let index = 0; index < updates.length; index += 350) {
        const batch = writeBatch(db)
        updates.slice(index, index + 350).forEach(({ customer, allowedMaterialIds, allowedServiceIds, customerOrderCatalog }) => batch.set(doc(db, 'customers', customer.id), { allowedMaterialIds, allowedServiceIds, customerOrderCatalog, updatedAt: serverTimestamp() }, { merge: true }))
        await batch.commit()
      }
    })().catch(() => { customerCatalogSyncRef.current = '' })
  }, [customers, materials])

  useEffect(() => {
    const today = todayInput()
    const todayRate = exchangeRates.find((item) => item.id === today)
    const automaticComplete = todayRate?.source === 'automatic' && Number(todayRate.USD) > 0 && Number(todayRate.EUR) > 0 && Number(todayRate.GBP) > 0
    if (!exchangeRatesLoaded || !financeSettingsLoaded || financeSettings.manualRateEnabled || automaticComplete || automaticRateRef.current === today) return
    automaticRateRef.current = today
    fetch('https://api.frankfurter.dev/v2/rates?base=TRY&quotes=USD,EUR,GBP')
      .then((response) => { if (!response.ok) throw new Error('rate-fetch'); return response.json() })
      .then(async (rows) => {
        const values = Object.fromEntries((Array.isArray(rows) ? rows : []).map((row) => [row.quote, Number(row.rate) > 0 ? Math.round((1 / Number(row.rate)) * 10000) / 10000 : null]))
        if (!values.USD && !values.EUR && !values.GBP) throw new Error('rate-empty')
        const batch = writeBatch(db)
        batch.set(doc(db, 'exchangeRates', today), { date: today, USD: values.USD || null, EUR: values.EUR || null, GBP: values.GBP || null, source: 'automatic', providerDate: rows[0]?.date || today, updatedAt: serverTimestamp(), updatedBy: staffEmail }, { merge: true })
        await batch.commit()
      })
      .catch(() => {})
  }, [exchangeRates, exchangeRatesLoaded, financeSettings, financeSettingsLoaded, staffEmail])

  useEffect(() => {
    if (!exchangeRatesLoaded || !orders.length || !materials.length) return
    const currentRates = currentExchangeRateMap(exchangeRates)
    const updates = orders.map((order) => ({ order, finance: orderFinance(orderPrivateMap[order.id], order, materials, { currentExchangeRates: currentRates }) }))
      .filter(({ order, finance }) => finance.enabled && Math.abs((Number(order.customerPriceAmount) || 0) - finance.sale) >= 0.01)
    const signature = updates.map(({ order, finance }) => `${order.id}:${finance.sale}`).sort().join('|')
    if (!signature || customerPriceSyncRef.current === signature) return
    customerPriceSyncRef.current = signature
    ;(async () => {
      for (let index = 0; index < updates.length; index += 350) {
        const batch = writeBatch(db)
        updates.slice(index, index + 350).forEach(({ order, finance }) => batch.set(doc(db, 'orders', order.id), { customerPriceAmount: finance.sale, currentRateDate: exchangeRates[0]?.id || null }, { merge: true }))
        await batch.commit()
      }
    })().catch(() => { customerPriceSyncRef.current = '' })
  }, [exchangeRates, exchangeRatesLoaded, materials, orderPrivateMap, orders])

  useEffect(() => {
    if (!isOwner || migrationBusy || accessList.length === 0) return
    const customerById = Object.fromEntries(customers.map((customer) => [customer.id, customer]))
    const orderById = Object.fromEntries(orders.map((order) => [order.id, order]))
    const writes = []
    customers.forEach((customer) => {
      const assigned = normalizeEmail(customer.assignedAdminEmail || customer.createdBy || staffEmail)
      if (!customer.assignedAdminEmail || !customer.createdBy) writes.push((batch) => batch.set(doc(db, 'customers', customer.id), { assignedAdminEmail: assigned, createdBy: normalizeEmail(customer.createdBy || staffEmail), updatedAt: serverTimestamp() }, { merge: true }))
    })
    accessList.filter((entry) => entry.role === 'customer' && entry.customerId).forEach((entry) => {
      const assigned = normalizeEmail(customerById[entry.customerId]?.assignedAdminEmail || customerById[entry.customerId]?.createdBy || staffEmail)
      if (!entry.managerEmail) writes.push((batch) => batch.set(doc(db, 'access', entry.id), { managerEmail: assigned, updatedAt: serverTimestamp() }, { merge: true }))
    })
    orders.forEach((order) => {
      const assigned = normalizeEmail(order.managerEmail || customerById[order.customerId]?.assignedAdminEmail || customerById[order.customerId]?.createdBy || staffEmail)
      if (!order.managerEmail) writes.push((batch) => batch.set(doc(db, 'orders', order.id), { managerEmail: assigned, updatedAt: serverTimestamp() }, { merge: true }))
    })
    Object.entries(orderPrivateMap).forEach(([id, privateData]) => {
      const assigned = normalizeEmail(privateData.managerEmail || orderById[id]?.managerEmail || customerById[orderById[id]?.customerId]?.assignedAdminEmail || staffEmail)
      if (!privateData.managerEmail) writes.push((batch) => batch.set(doc(db, 'orderPrivate', id), { managerEmail: assigned, updatedAt: serverTimestamp() }, { merge: true }))
    })
    requests.forEach((request) => {
      const assigned = normalizeEmail(request.managerEmail || customerById[request.customerId]?.assignedAdminEmail || staffEmail)
      if (!request.managerEmail) writes.push((batch) => batch.set(doc(db, 'requests', request.id), { managerEmail: assigned, updatedAt: serverTimestamp() }, { merge: true }))
    })
    activities.forEach((item) => { if (!item.managerEmail) writes.push((batch) => batch.set(doc(db, 'activities', item.id), { managerEmail: normalizeEmail(item.actorEmail || staffEmail) }, { merge: true })) })
    trash.forEach((item) => { if (!item.managerEmail) writes.push((batch) => batch.set(doc(db, 'trash', item.id), { managerEmail: normalizeEmail(item.deletedBy || staffEmail) }, { merge: true })) })
    if (!writes.length) return
    setMigrationBusy(true)
    ;(async () => {
      for (let index = 0; index < writes.length; index += 300) {
        const batch = writeBatch(db)
        writes.slice(index, index + 300).forEach((write) => write(batch))
        await batch.commit()
      }
    })().catch((err) => setDataError(friendlyError(err))).finally(() => setMigrationBusy(false))
  }, [isOwner, migrationBusy, accessList, customers, orders, requests, orderPrivateMap, activities, trash, staffEmail])

  useEffect(() => {
    const customerAliases = customers.map((customer) => ({ id: customer.id, displayName: customer.displayName, quickTracking: Boolean(customer.quickTracking), aliases: [customer.displayName, customer.whatsappName].filter(Boolean) }))
    window.postMessage({
      type: 'IZMIRDE_REKLAM_CUSTOMERS',
      customers: customerAliases,
    }, window.location.origin)
    window.siparisTakip?.syncCustomers?.(customerAliases)
  }, [customers])

  useEffect(() => {
    window.siparisTakip?.syncOrders?.(orders.map((order) => ({ id: order.id, customerId: order.customerId, name: order.name, status: order.status })))
  }, [orders])

  useEffect(() => {
    if (!backupSettings.loaded || backupBusy) return
    const expired = findRedundantCustomerBackups(customerBackups, staffEmail, backupSettings.intervalDays, backupSettings.retentionDays)
      .filter((item) => !backupRunRef.current.deletingIds.has(item.id))
    const last = toDate(backupSettings.lastBackupAt)
    const lastCreatedAt = Math.max(last?.getTime() || 0, backupRunRef.current.lastCreatedAt || 0)
    const due = backupSettings.enabled && customers.length > 0 && (!lastCreatedAt || Date.now() - lastCreatedAt >= Math.max(1, Number(backupSettings.intervalDays) || 7) * 86400000)
    if (!expired.length && !due) return
    runCustomerBackup({ createNew: due, expired, silent: true }).catch((error) => setDataError(friendlyError(error)))
    // Persisted schedule state and the synchronous ref lock prevent duplicate runs between snapshots.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [backupSettings, backupBusy, customerBackups, customers, staffEmail])

  async function runCustomerBackup({ createNew = true, expired = [], silent = false } = {}) {
    if (backupRunRef.current.running) return
    backupRunRef.current.running = true
    const deleteIds = expired.map((entry) => entry.id)
    deleteIds.forEach((id) => backupRunRef.current.deletingIds.add(id))
    setBackupBusy(true)
    try {
      const expiryDate = new Date(Date.now() + Math.max(1, Number(backupSettings.retentionDays) || 90) * 86400000)
      const writes = []
      expired.forEach((entry) => writes.push((batch) => batch.delete(doc(db, 'customerBackups', entry.id))))
      if (createNew) customers.forEach((customer) => {
        const backupRef = doc(collection(db, 'customerBackups'))
        const { id, ...customerData } = customer
        writes.push((batch) => batch.set(backupRef, { customerId: id, managerEmail: normalizeEmail(customer.assignedAdminEmail || staffEmail), customerData, createdBy: staffEmail, createdAt: serverTimestamp(), expiresAt: Timestamp.fromDate(expiryDate) }))
      })
      for (let index = 0; index < writes.length; index += 350) {
        const batch = writeBatch(db)
        writes.slice(index, index + 350).forEach((write) => write(batch))
        if (createNew && index + 350 >= writes.length) batch.set(doc(db, 'backupSettings', staffEmail), { enabled: backupSettings.enabled, intervalDays: Math.max(1, Number(backupSettings.intervalDays) || 7), retentionDays: Math.max(1, Number(backupSettings.retentionDays) || 90), lastBackupAt: serverTimestamp(), updatedAt: serverTimestamp() }, { merge: true })
        await batch.commit()
      }
      if (createNew) backupRunRef.current.lastCreatedAt = Date.now()
      if (!silent) notify(createNew ? `${customers.length} müşteri güvenli olarak yedeklendi.` : 'Süresi dolan yedekler temizlendi.')
    } catch (error) {
      deleteIds.forEach((id) => backupRunRef.current.deletingIds.delete(id))
      throw error
    } finally {
      backupRunRef.current.running = false
      setBackupBusy(false)
    }
  }

  function notify(message) {
    setToast(message)
    window.setTimeout(() => setToast(''), 2600)
  }

  const customerMap = useMemo(() => Object.fromEntries(customers.map((customer) => [customer.id, customer])), [customers])
  const orderMap = useMemo(() => Object.fromEntries(orders.map((order) => [order.id, order])), [orders])
  const pendingCount = requests.filter((request) => request.status !== 'closed').length
  const dueSoon = useMemo(() => upcomingDeliveries(orders, deliverySettings), [orders, deliverySettings])
  const inactiveOrders = useMemo(() => findInactiveOrders(orders, inactivitySettings), [orders, inactivitySettings])
  function changeSection(section) {
    if (section === 'orders') { setOrderCustomerFilter(''); setAttentionOrderIds([]) }
    setActive(section)
  }
  function openCustomerOrders(customerId) {
    setOrderCustomerFilter(customerId)
    setAttentionOrderIds([])
    setActive('orders')
  }
  function openInactiveOrders() {
    setOrderCustomerFilter('')
    setAttentionOrderIds(inactiveOrders.map((order) => order.id))
    setActive('orders')
  }

  return (
    <div className="app-shell">
      <Sidebar active={active} setActive={changeSection} isOwner={isOwner} pendingCount={pendingCount} user={user} />
      <main className="workspace">
        {dataError && <div className="alert alert-error top-alert">{dataError}</div>}
        {dueSoon.length > 0 && <div className="delivery-warning"><Icon name="history" size={19} /><div><strong>{dueSoon.length} teslim tarihi yaklaşıyor</strong><span>{dueSoon.slice(0, 3).map((order) => `${order.name}: ${order.daysLeft === 0 ? 'bugün' : `${order.daysLeft} gün`}`).join(' · ')}</span></div></div>}
        {inactiveOrders.length > 0 && <button className="inactivity-warning warning-button" type="button" onClick={openInactiveOrders}><Icon name="history" size={19} /><div><strong>{inactiveOrders.length} sipariş uzun süredir hareket görmedi</strong><span>{inactiveOrders.slice(0, 3).map((order) => `${order.name}: ${order.inactiveDays} gün`).join(' · ')}</span></div><b>Göster</b></button>}
        {active === 'orders' && <OrdersView orders={orders} requests={requests} customers={customers} customerMap={customerMap} customerPrivateMap={customerPrivateMap} privateMap={orderPrivateMap} materials={materials} exchangeRates={exchangeRates} financeSettings={financeSettings} initialCustomerId={orderCustomerFilter} attentionOrderIds={attentionOrderIds} onClearAttention={() => setAttentionOrderIds([])} actor={user} onCreate={() => setModal({ type: 'order' })} onEdit={(item) => setModal({ type: 'order', item })} onOpenCustomer={openCustomerOrders} notify={notify} />}
        {active === 'reports' && <AdminOverviewView orders={orders} privateMap={orderPrivateMap} customerMap={customerMap} materials={materials} exchangeRates={exchangeRates} financeSettings={financeSettings} onEdit={(item) => setModal({ type: 'order', item })} />}
        {active === 'customers' && <CustomersView customers={customers} orders={orders} requests={requests} accessList={accessList} transfers={transfers} actor={user} isOwner={isOwner} onCreate={() => setModal({ type: 'customer' })} onImport={() => setModal({ type: 'customerImport' })} onTransfer={(customer) => setModal({ type: 'transfer', customer })} onEdit={(item) => setModal({ type: 'customer', item })} onInvite={(customer) => setModal(customer.quickTracking ? { type: 'trackingLink', customer } : { type: 'invite', customer })} onOpenOrders={openCustomerOrders} notify={notify} />}
        {active === 'materials' && <MaterialsView materials={materials} materialGroups={materialGroups} materialTemplates={materialTemplates} exchangeRates={exchangeRates} orders={orders} actor={user} notify={notify} />}
        {active === 'admins' && isOwner && <AdminsView accessList={accessList} currentEmail={user.email} actor={user} onCreate={() => setModal({ type: 'admin' })} onEdit={(item) => setModal({ type: 'admin', item })} onInvite={(admin) => setModal({ type: 'adminInvite', admin })} notify={notify} />}
        {active === 'requests' && <RequestsView requests={requests} customerMap={customerMap} orderMap={orderMap} actor={user} onCreateOrder={(request) => setModal({ type: 'order', prefill: { title: request.name, material: request.material, materialId: request.materialId, service: request.service, serviceId: request.serviceId, description: request.message, customerId: request.customerId, requestId: request.id, source: 'customer-panel' } })} notify={notify} />}
        {active === 'settings' && <SettingsView customers={customers} orders={orders} requests={requests} materials={materials} materialGroups={materialGroups} materialTemplates={materialTemplates} exchangeRates={exchangeRates} financeSettings={financeSettings} privateMap={orderPrivateMap} accessList={accessList} transfers={transfers} activities={activities} trash={trash} actor={user} isOwner={isOwner} deliverySettings={deliverySettings} inactivitySettings={inactivitySettings} backupSettings={backupSettings} customerBackups={customerBackups} backupBusy={backupBusy} onRunBackup={() => runCustomerBackup({ createNew: true, expired: [], silent: false })} notify={notify} />}
      </main>
      {modal?.type === 'order' && <OrderModal item={modal.item} prefill={modal.prefill} customers={modal.prefill?.customer && !customers.some((entry) => entry.id === modal.prefill.customer.id) ? [...customers, modal.prefill.customer] : customers} materials={materials} exchangeRates={exchangeRates} financeSettings={financeSettings} actor={user} onClose={() => setModal(null)} onSaved={() => { setModal(null); notify('Sipariş kaydedildi.') }} />}
      {modal?.type === 'customer' && <CustomerModal item={modal.item} prefill={modal.prefill} materials={materials} actor={user} isOwner={isOwner} admins={accessList.filter((entry) => entry.role === 'admin' && entry.active !== false)} onClose={() => setModal(null)} onSaved={(customer, isNew) => { if (isNew && modal.prefill?.nextOrderTitle) setModal({ type: 'order', prefill: { title: modal.prefill.nextOrderTitle, chat: customer.whatsappName, messageId: modal.prefill.nextOrderMessageId || '', phone: modal.prefill.nextOrderPhone || '', timestamp: modal.prefill.nextOrderTimestamp || '', customerId: customer.id, customer, source: 'whatsapp' } }); else setModal(isNew ? (customer.quickTracking ? { type: 'trackingLink', customer } : { type: 'invite', customer }) : null); notify(isNew ? (customer.quickTracking ? 'Hızlı takip müşterisi oluşturuldu.' : 'Müşteri oluşturuldu. Davet hazır.') : 'Müşteri ayarları kaydedildi.') }} />}
      {modal?.type === 'customerImport' && <CustomerImportModal customers={customers} materials={materials} exchangeRates={exchangeRates} admins={accessList.filter((entry) => entry.role === 'admin' && entry.active !== false)} actor={user} isOwner={isOwner} onClose={() => setModal(null)} onSaved={({ customerCount = 0, orderCount = 0 }) => { setModal(null); notify(orderCount ? `${orderCount} sipariş${customerCount ? ' ve 1 müşteri' : ''} eklendi.` : `${customerCount} müşteri eklendi.`) }} />}
      {modal?.type === 'transfer' && <CustomerTransferModal customer={modal.customer} admins={accessList.filter((entry) => entry.role === 'admin' && entry.active !== false)} orders={orders} requests={requests} actor={user} onClose={() => setModal(null)} onSaved={() => { setModal(null); notify('Müşteri yöneticiye gönderildi.') }} />}
      {modal?.type === 'cancel' && <CancelOrderModal order={orderMap[modal.orderId]} customer={customerMap[orderMap[modal.orderId]?.customerId]} title={modal.title} actor={user} onClose={() => setModal(null)} onSaved={() => { setModal(null); notify('Proje iptal edildi.') }} />}
      {modal?.type === 'invite' && <InvitationModal customer={modal.customer} onClose={() => setModal(null)} notify={notify} />}
      {modal?.type === 'trackingLink' && <TrackingLinkModal customer={modal.customer} onClose={() => setModal(null)} notify={notify} />}
      {modal?.type === 'admin' && <AdminModal item={modal.item} accessList={accessList} currentEmail={user.email} actor={user} onClose={() => setModal(null)} onSaved={(admin, isNew) => { setModal(isNew ? { type: 'adminInvite', admin } : null); notify(isNew ? 'Yönetici oluşturuldu. Davet hazır.' : 'Yönetici kaydedildi.') }} />}
      {modal?.type === 'adminInvite' && <AdminInvitationModal admin={modal.admin} onClose={() => setModal(null)} notify={notify} />}
      {toast && <div className="toast"><Icon name="check" />{toast}</div>}
    </div>
  )
}

function PageHeader({ eyebrow, title, description, actionLabel, onAction, actions }) {
  return (
    <header className="page-header">
      <div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>
      {actions || (actionLabel && <button className="button primary" type="button" onClick={onAction}><Icon name="plus" />{actionLabel}</button>)}
    </header>
  )
}

function ViewToggle({ value, onChange }) {
  return <div className="view-toggle" role="group" aria-label="Görünüm seçimi">
    <button className={value === 'list' ? 'active' : ''} type="button" onClick={() => onChange('list')}><Icon name="list" size={16} />Liste</button>
    <button className={value === 'grid' ? 'active' : ''} type="button" onClick={() => onChange('grid')}><Icon name="grid" size={16} />Izgara</button>
  </div>
}

function financeMissingMessage(order, materials = [], currentRates = {}) {
  const compact = (value) => normalizeText(value).replace(/[^a-z0-9çğıöşü]+/g, '')
  const target = compact(order.material || order.type)
  const matched = (order.componentMaterialIds || []).map((id) => materials.find((item) => item.id === id)).filter(Boolean)
  if (!matched.length && target) matched.push(...materials.filter((material) => [material.name, `${material.groupName || ''} ${material.variantName || ''}`, `${material.variantName || ''} ${material.groupName || ''}`].some((name) => compact(name) === target)))
  if (!matched.length) return `“${order.material || order.type || 'Bu malzeme'}” Malzeme ve Hizmet kayıtlarıyla eşleşmiyor.`
  const withoutPrice = matched.filter((material) => !materialFields(material).some((key) => Number(material.priceComponents?.[key]?.unitPrice ?? material.unitPrice ?? material.sheetCost ?? material.costPerM2) > 0))
  if (withoutPrice.length) return `${withoutPrice.map((item) => item.name).join(', ')} için alış fiyatı tanımlı değil. Malzeme ve Hizmet → Düzenle bölümünden TL/USD/EUR fiyatını bir kez girin.`
  const missingRate = matched.map((item) => String(item.currency || 'TRY').toUpperCase()).find((currency) => currency !== 'TRY' && !(Number(currentRates[currency]) > 0))
  if (missingRate) return `${missingRate} güncel kuru henüz alınamadı. İnternet bağlantısını kontrol edin; kur otomatik gelecektir.`
  return 'Bu siparişte fiyat hesabı için gereken ölçü veya miktar eksik.'
}

function OrderFinanceInline({ order, privateData, materials, exchangeRates = [], financeSettings = {} }) {
  const currentRates = currentExchangeRateMap(exchangeRates)
  let finance
  try {
    finance = orderFinance(privateData, order, materials, { currentExchangeRates: currentRates })
  } catch (error) {
    return <div className="order-finance-inline empty" aria-label={`Finans hesaplama hatası: ${error instanceof Error ? error.message : 'Bilinmeyen hata'}`}><div><span>Toplam alan</span><strong>{orderAreaM2(order) > 0 ? `${orderAreaM2(order).toLocaleString('tr-TR', { maximumFractionDigits: 4 })} m²` : '—'}</strong></div><div><span>Toplam fiyat</span><strong>Hesaplanamadı</strong></div><small>Malzeme fiyat ayarını kontrol edin.</small></div>
  }
  const area = orderAreaM2(order) || finance.areaM2 || 0
  if (!finance.enabled) return <div className="order-finance-inline empty"><div><span>Toplam alan</span><strong>{area > 0 ? `${area.toLocaleString('tr-TR', { maximumFractionDigits: 4 })} m²` : '—'}</strong></div><div><span>Toplam fiyat</span><strong>Hesaplanmadı</strong></div><small>{financeMissingMessage(order, materials, currentRates)}</small></div>
  const margin = finance.sale > 0 ? (finance.profit / finance.sale) * 100 : 0
  return <div className="order-finance-inline"><div><span>Toplam alan</span><strong>{area > 0 ? `${area.toLocaleString('tr-TR', { maximumFractionDigits: 4 })} m²` : '—'}</strong></div><div><span>Ort. birim maliyet</span><strong>{finance.unitCost > 0 ? `${formatSystemCurrency(finance.unitCost, financeSettings, currentRates)} / ${finance.unitLabel}` : '—'}</strong></div><div><span>Toplam ort. maliyet</span><strong>{formatSystemCurrency(finance.cost, financeSettings, currentRates)}</strong></div><div><span>Toplam fiyat</span><strong>{formatSystemCurrency(finance.sale, financeSettings, currentRates)}</strong></div><div><span>Kazanç</span><strong>{formatSystemCurrency(finance.profit, financeSettings, currentRates)}</strong></div><div><span>Kazanç oranı</span><strong>%{margin.toLocaleString('tr-TR', { maximumFractionDigits: 1 })}</strong></div>{finance.currency !== 'TRY' && <small>{finance.currency} fiyatı, kayıtlı en güncel kurla yeniden hesaplandı{exchangeRates[0]?.id ? ` (${formatDate(new Date(`${exchangeRates[0].id}T12:00:00`))})` : ''}.</small>}{finance.unpricedComponents?.length > 0 && <small>{finance.unpricedComponents.join(', ')} için fiyat tanımlı değil.</small>}</div>
}

function OrderDetailsModal({ order, customer, privateData, materials = [], exchangeRates = [], financeSettings = {}, showFinance = false, onClose }) {
  return <Modal title={order.name || 'Sipariş detayları'} description={`${customer?.displayName || 'Müşteri'} · ${order.status || 'Durum belirtilmedi'}`} onClose={onClose}>
    <div className="order-detail-grid">
      <div><span>Müşteri</span><strong>{customer?.displayName || 'Silinmiş müşteri'}</strong></div><div><span>Durum</span><StatusBadge status={order.status} /></div>
      <div><span>Malzeme + hizmet</span><strong>{order.material || order.type || 'Belirtilmedi'}</strong></div><div><span>Ölçü / miktar</span><strong>{formatOrderMeasurement(order)}</strong></div>
      <div><span>Geliş tarihi</span><strong>{formatDate(order.receivedAt)}</strong></div><div><span>Tahmini bitiş</span><strong>{formatDate(order.estimatedCompletion)}</strong></div>
      <div className="span-2"><span>Açıklama</span><strong>{order.description || 'Açıklama eklenmedi.'}</strong></div>
    </div>
    {showFinance && <OrderFinanceInline order={order} privateData={privateData} materials={materials} exchangeRates={exchangeRates} financeSettings={financeSettings} />}
  </Modal>
}

function OrdersView({ orders, requests, customers, customerMap, customerPrivateMap = {}, privateMap = {}, materials = [], exchangeRates = [], financeSettings = {}, initialCustomerId = '', attentionOrderIds = [], onClearAttention, actor, onCreate, onEdit, onOpenCustomer, notify }) {
  const [filters, setFilters] = useState({ ...EMPTY_FILTERS, customerId: initialCustomerId })
  const [viewMode, setViewMode] = useState('list')
  const [selectedIds, setSelectedIds] = useState([])
  const [detailOrder, setDetailOrder] = useState(null)
  const [expandedFinanceIds, setExpandedFinanceIds] = useState([])
  const [bulkBusy, setBulkBusy] = useState(false)
  const [statusBusyIds, setStatusBusyIds] = useState([])
  useEffect(() => setFilters((current) => ({ ...current, customerId: initialCustomerId })), [initialCustomerId])
  const summary = useMemo(() => summarizeOrders(orders), [orders])
  const attentionSet = useMemo(() => new Set(attentionOrderIds), [attentionOrderIds])
  const retailCustomerIds = useMemo(() => new Set(customers.filter((customer) => customer.quickTracking).map((customer) => customer.id)), [customers])
  const filtered = useMemo(() => {
    const retailOnly = filters.customerId === RETAIL_CUSTOMER_FILTER
    const baseFilters = retailOnly ? { ...filters, customerId: '' } : filters
    return filterOrders(orders, baseFilters, customerMap)
      .filter((order) => !retailOnly || retailCustomerIds.has(order.customerId))
      .filter((order) => !attentionSet.size || attentionSet.has(order.id))
  }, [orders, filters, customerMap, retailCustomerIds, attentionSet])
  const orderServices = useMemo(() => [...new Set(orders.map((order) => order.type).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'tr')), [orders])
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])
  const allVisibleSelected = filtered.length > 0 && filtered.every((order) => selectedSet.has(order.id))
  useEffect(() => {
    const visibleIds = new Set(filtered.map((order) => order.id))
    setSelectedIds((current) => current.filter((id) => visibleIds.has(id)))
  }, [filtered])
  const cards = [
    ['Bekliyor', summary.waiting, 'amber'], ['Üretimde', summary.production, 'blue'], ['Hazır', summary.ready, 'green'], ['Acil', summary.urgent, 'red'], ['Bugün teslim', summary.dueToday, 'violet'],
  ]

  async function moveOrderToTrash(order) {
    const privateSnapshot = await getDoc(doc(db, 'orderPrivate', order.id))
    const relatedRequests = requests.filter((request) => request.orderId === order.id)
    const orderData = { ...order }
    delete orderData.id
    const trashRef = doc(collection(db, 'trash'))
    const batch = writeBatch(db)
    batch.set(trashRef, {
      entityType: 'order',
      originalId: order.id,
      label: order.name || 'İsim girilmedi',
      orderData,
      privateData: privateSnapshot.exists() ? privateSnapshot.data() : null,
      requestsData: relatedRequests.map(({ id, ...data }) => ({ id, data })),
      deletedBy: normalizeEmail(actor.email),
      managerEmail: normalizeEmail(order.managerEmail || actor.email),
      deletedAt: serverTimestamp(),
      createdAt: serverTimestamp(),
    })
    batch.delete(doc(db, 'orders', order.id))
    batch.delete(doc(db, 'orderPrivate', order.id))
    const trackingCustomer = customerMap[order.customerId]
    if (trackingCustomer?.quickTracking && trackingCustomer.trackingToken) batch.delete(doc(db, 'publicTracking', trackingCustomer.trackingToken, 'orders', order.id))
    relatedRequests.forEach((request) => batch.delete(doc(db, 'requests', request.id)))
    addActivityToBatch(batch, actor, 'deleted', 'order', order.id, order.name || 'İsim girilmedi', { managerEmail: order.managerEmail })
    await batch.commit()
  }

  async function removeOrder(order) {
    if (!window.confirm(`“${order.name || 'İsim girilmedi'}” siparişini çöp kutusuna taşımak istiyor musunuz?`)) return
    await moveOrderToTrash(order)
    setSelectedIds((current) => current.filter((id) => id !== order.id))
    notify('Sipariş çöp kutusuna taşındı.')
  }

  function toggleOrder(orderId) {
    setSelectedIds((current) => current.includes(orderId) ? current.filter((id) => id !== orderId) : [...current, orderId])
  }

  function toggleAllVisible() {
    setSelectedIds(allVisibleSelected ? [] : filtered.map((order) => order.id))
  }

  function toggleFinance(orderId) {
    setExpandedFinanceIds((current) => current.includes(orderId) ? current.filter((id) => id !== orderId) : [...current, orderId])
  }

  async function changeOrderStatus(order, status) {
    if (!status || status === order.status || statusBusyIds.includes(order.id)) return
    setStatusBusyIds((current) => [...current, order.id])
    try {
      const update = {
        status,
        statusChangedAt: serverTimestamp(),
        deliveredAt: status === 'Teslim Edildi' ? serverTimestamp() : null,
        updatedAt: serverTimestamp(),
        updatedBy: normalizeEmail(actor.email),
      }
      const batch = writeBatch(db)
      batch.set(doc(db, 'orders', order.id), update, { merge: true })
      syncPublicOrder(batch, order.id, { ...order, ...update }, customers, order.customerId)
      addActivityToBatch(batch, actor, 'status_changed', 'order', order.id, order.name || 'Sipariş', { previousStatus: order.status, status, managerEmail: order.managerEmail })
      await batch.commit()
      notify(`Sipariş durumu “${status}” olarak güncellendi.`)
    } catch {
      notify('Sipariş durumu güncellenemedi.')
    } finally {
      setStatusBusyIds((current) => current.filter((id) => id !== order.id))
    }
  }

  function showOrderContextMenu(event, order) {
    const source = privateMap[order.id]
    if (source?.source !== 'whatsapp' || !source.sourceChat || !source.sourceTitle || !window.siparisTakip?.showOrderContextMenu) return
    event.preventDefault()
    const customer = customerMap[order.customerId]
    window.siparisTakip.showOrderContextMenu({ chat: source.sourceChat, title: source.sourceTitle, messageId: source.sourceMessageId || '', phone: source.sourcePhone || customerPrivateMap[order.customerId]?.whatsappNumber || '', timestamp: source.sourceTimestamp || '', orderDate: formatDate(order.receivedAt, ''), managerEmail: normalizeEmail(actor.email), customerId: order.customerId, customerName: customer?.displayName || '', quickTracking: Boolean(customer?.quickTracking) })
  }

  async function removeSelectedOrders() {
    const selectedOrders = filtered.filter((order) => selectedSet.has(order.id))
    if (!selectedOrders.length || !window.confirm(`${selectedOrders.length} sipariş çöp kutusuna taşınsın mı? Bu işlem Geçmiş sayfasından geri alınabilir.`)) return
    setBulkBusy(true)
    const removedIds = []
    const failedIds = []
    for (let index = 0; index < selectedOrders.length; index += 5) {
      const group = selectedOrders.slice(index, index + 5)
      const results = await Promise.allSettled(group.map((order) => moveOrderToTrash(order)))
      results.forEach((result, resultIndex) => (result.status === 'fulfilled' ? removedIds : failedIds).push(group[resultIndex].id))
    }
    setSelectedIds(failedIds)
    setBulkBusy(false)
    if (failedIds.length) notify(`${removedIds.length} sipariş silindi, ${failedIds.length} sipariş silinemedi.`)
    else notify(`${removedIds.length} sipariş çöp kutusuna taşındı.`)
  }

  return (
    <section>
      <PageHeader eyebrow="Operasyon" title="Siparişler" description="Tüm işleri, teslim tarihlerini ve üretim durumlarını yönetin." actionLabel="Yeni sipariş" onAction={onCreate} />
      <div className="summary-grid">{cards.map(([label, value, tone]) => <article className={`summary-card tone-${tone}`} key={label}><span>{label}</span><strong>{value}</strong><i /></article>)}</div>
      {attentionSet.size > 0 && <div className="active-attention-filter"><span>Yalnızca uzun süredir hareket görmeyen siparişler gösteriliyor.</span><button type="button" onClick={onClearAttention}>Tüm siparişleri göster</button></div>}
      <div className="panel">
        <div className="filter-bar">
          <label className="search-field"><Icon name="search" size={18} /><input aria-label="Sipariş ara" placeholder="Sipariş veya müşteri ara…" value={filters.search} onChange={(event) => setFilters({ ...filters, search: event.target.value })} /></label>
          <select aria-label="Durum filtresi" value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value })}><option value="">Tüm durumlar</option>{ORDER_STATUSES.map((item) => <option key={item}>{item}</option>)}</select>
          <select aria-label="Müşteri filtresi" value={filters.customerId} onChange={(event) => setFilters({ ...filters, customerId: event.target.value })}><option value="">Tüm müşteriler</option>{retailCustomerIds.size > 0 && <option value={RETAIL_CUSTOMER_FILTER}>Perakende</option>}{customers.filter((item) => !item.quickTracking).map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select>
          <select aria-label="Hizmet filtresi" value={filters.type} onChange={(event) => setFilters({ ...filters, type: event.target.value })}><option value="">Tüm hizmetler</option>{orderServices.map((item) => <option key={item}>{item}</option>)}</select>
          <select aria-label="Aciliyet filtresi" value={filters.urgent} onChange={(event) => setFilters({ ...filters, urgent: event.target.value })}><option value="">Tüm öncelikler</option><option value="urgent">Acil</option><option value="normal">Normal</option></select>
        </div>
        <div className="result-toolbar"><div className="bulk-selection"><label><input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} disabled={!filtered.length || bulkBusy} />Tüm görünenleri seç</label><span><b>{selectedIds.length}</b> seçili</span>{selectedIds.length > 0 && <><button className="clear-selection" type="button" onClick={() => setSelectedIds([])} disabled={bulkBusy}>Seçimi temizle</button><button className="button danger compact bulk-delete" type="button" onClick={() => removeSelectedOrders().catch(() => { setBulkBusy(false); notify('Toplu silme tamamlanamadı.') })} disabled={bulkBusy}><Icon name="trash" size={16} />{bulkBusy ? 'Siliniyor…' : `${selectedIds.length} siparişi sil`}</button></>}</div><ViewToggle value={viewMode} onChange={setViewMode} /></div>
        {viewMode === 'list' ? <div className="table-wrap">
          <table className="admin-orders-table"><thead><tr><th className="select-column" aria-label="Seç" /><th>Müşteri</th><th>Sipariş</th><th>Hizmet / Malzeme</th><th>Geliş</th><th>Durum</th><th>Tahmini bitiş</th><th>Öncelik</th><th aria-label="İşlemler" /></tr></thead>
            <tbody>{filtered.map((order) => <Fragment key={order.id}>
              <tr className={selectedSet.has(order.id) ? 'selected-order' : ''} onContextMenu={(event) => showOrderContextMenu(event, order)}>
                <td className="select-column"><input type="checkbox" aria-label={`${order.name || 'İsimsiz sipariş'} seç`} checked={selectedSet.has(order.id)} onChange={() => toggleOrder(order.id)} disabled={bulkBusy} /></td>
                <td><button className="customer-order-link" type="button" onClick={() => onOpenCustomer(customerMap[order.customerId]?.quickTracking ? RETAIL_CUSTOMER_FILTER : order.customerId)}>{customerMap[order.customerId]?.quickTracking ? 'Perakende' : customerMap[order.customerId]?.displayName || 'Silinmiş müşteri'}</button></td>
                <td><button className="order-name-button" type="button" onClick={() => setDetailOrder(order)}><strong>{order.name || 'İsim girilmedi'}</strong><span className="cell-note">{order.description || 'Açıklama yok'}</span></button></td>
                <td>{order.type}<span className="cell-note">{order.material || 'Malzeme belirtilmedi'}{orderAreaM2(order) ? ` · ${orderAreaM2(order).toLocaleString('tr-TR', { maximumFractionDigits: 2 })} m²` : order.widthCm && order.heightCm ? ` · ${order.widthCm}×${order.heightCm} cm` : ''}{order.quantity ? ` · ${order.quantity} adet` : ''}</span></td><td>{formatDate(order.receivedAt)}</td><td><InlineStatusSelect order={order} busy={statusBusyIds.includes(order.id)} onChange={(status) => changeOrderStatus(order, status)} /></td><td>{formatDate(order.estimatedCompletion)}</td>
                <td>{order.urgent ? <span className="urgent-pill">Acil</span> : <span className="muted">Normal</span>}</td>
                <td><div className="row-actions"><button className={expandedFinanceIds.includes(order.id) ? 'active-action' : ''} type="button" title="Maliyet ve kazancı göster/gizle" aria-label="Maliyet ve kazancı göster veya gizle" onClick={() => toggleFinance(order.id)}><Icon name="finance" size={17} /></button><button type="button" aria-label="Siparişi düzenle" onClick={() => onEdit(order)}><Icon name="edit" size={17} /></button><button className="danger-icon" type="button" aria-label="Siparişi sil" onClick={() => removeOrder(order).catch(() => notify('Sipariş silinemedi.'))}><Icon name="trash" size={17} /></button></div></td>
              </tr>
              {expandedFinanceIds.includes(order.id) && <tr className="order-finance-row"><td colSpan="9"><OrderFinanceInline order={order} privateData={privateMap[order.id]} materials={materials} exchangeRates={exchangeRates} financeSettings={financeSettings} /></td></tr>}
            </Fragment>)}</tbody>
          </table>
          {filtered.length === 0 && <EmptyState title="Sipariş bulunamadı" text={orders.length ? 'Filtreleri değiştirerek yeniden deneyin.' : 'İlk siparişinizi ekleyerek başlayın.'} action={!orders.length ? onCreate : null} />}
        </div> : <div className="admin-order-grid">
          {filtered.map((order) => <article className={`admin-order-card ${selectedSet.has(order.id) ? 'selected-order' : ''}`} key={order.id} onContextMenu={(event) => showOrderContextMenu(event, order)}>
            <div className="admin-order-card-head"><label className="card-select"><input type="checkbox" aria-label={`${order.name || 'İsimsiz sipariş'} seç`} checked={selectedSet.has(order.id)} onChange={() => toggleOrder(order.id)} disabled={bulkBusy} /><span /></label><div><button className="customer-order-link" type="button" onClick={() => onOpenCustomer(customerMap[order.customerId]?.quickTracking ? RETAIL_CUSTOMER_FILTER : order.customerId)}>{customerMap[order.customerId]?.quickTracking ? 'Perakende' : customerMap[order.customerId]?.displayName || 'Silinmiş müşteri'}</button><button className="order-name-button" type="button" onClick={() => setDetailOrder(order)}><h3>{order.name || 'İsim girilmedi'}</h3></button></div><InlineStatusSelect order={order} busy={statusBusyIds.includes(order.id)} onChange={(status) => changeOrderStatus(order, status)} /></div>
            <div className="order-card-product"><span>Malzeme + Hizmet</span><strong>{order.material || 'Belirtilmedi'}</strong></div>
            {order.description && <p>{order.description}</p>}
            <dl><div><dt>Hizmet</dt><dd>{order.type || 'Belirtilmedi'}</dd></div><div><dt>Geliş</dt><dd>{formatDate(order.receivedAt)}<small>Bitiş: {formatDate(order.estimatedCompletion)}</small></dd></div><div><dt>Ölçü / Miktar</dt><dd>{formatOrderMeasurement(order)}<small>{order.quantity ? `${order.quantity} adet` : 'Adet girilmedi'}</small></dd></div></dl>
            {expandedFinanceIds.includes(order.id) && <OrderFinanceInline order={order} privateData={privateMap[order.id]} materials={materials} exchangeRates={exchangeRates} financeSettings={financeSettings} />}
            <div className="admin-order-card-actions">{order.urgent ? <span className="urgent-pill">Acil</span> : <span className="muted">Normal öncelik</span>}<div className="row-actions"><button className={expandedFinanceIds.includes(order.id) ? 'active-action' : ''} type="button" title="Maliyet ve kazancı göster/gizle" aria-label="Maliyet ve kazancı göster veya gizle" onClick={() => toggleFinance(order.id)}><Icon name="finance" size={17} /></button><button type="button" aria-label="Siparişi düzenle" onClick={() => onEdit(order)}><Icon name="edit" size={17} /></button><button className="danger-icon" type="button" aria-label="Siparişi sil" onClick={() => removeOrder(order).catch(() => notify('Sipariş silinemedi.'))}><Icon name="trash" size={17} /></button></div></div>
          </article>)}
          {filtered.length === 0 && <EmptyState title="Sipariş bulunamadı" text={orders.length ? 'Filtreleri değiştirerek yeniden deneyin.' : 'İlk siparişinizi ekleyerek başlayın.'} action={!orders.length ? onCreate : null} />}
        </div>}
      </div>
      {detailOrder && <OrderDetailsModal order={detailOrder} customer={customerMap[detailOrder.customerId]} privateData={privateMap[detailOrder.id]} materials={materials} exchangeRates={exchangeRates} financeSettings={financeSettings} showFinance onClose={() => setDetailOrder(null)} />}
    </section>
  )
}

function StatusBadge({ status }) {
  const className = statusTone(status)
  return <span className={`status status-${className}`}><i />{status}</span>
}

function statusTone(status) {
  return { Bekliyor: 'amber', Üretimde: 'blue', Hazır: 'green', 'Teslim Edildi': 'green', 'İptal Edildi': 'red' }[status] || 'slate'
}

function orderStatusTone(order) {
  if (!['Teslim Edildi', 'İptal Edildi'].includes(order.status)) {
    const due = toDate(order.estimatedCompletion)
    const today = new Date(); today.setHours(0, 0, 0, 0)
    if (due && due.getTime() < today.getTime()) return 'red'
  }
  return statusTone(order.status)
}

function InlineStatusSelect({ order, busy, onChange }) {
  const overdue = orderStatusTone(order) === 'red' && order.status !== 'İptal Edildi'
  return <span className={`inline-status-control tone-${orderStatusTone(order)}`} title={overdue ? 'Teslim tarihi geçti' : ''}><i aria-hidden="true" /><select className="inline-status-select" aria-label={`${order.name || 'Sipariş'} durumunu değiştir`} value={order.status} disabled={busy} onChange={(event) => onChange(event.target.value)}>{ORDER_STATUSES.map((status) => <option key={status}>{status}</option>)}</select></span>
}

function CustomersView({ customers, orders, requests, accessList, transfers, actor, isOwner, onCreate, onImport, onTransfer, onEdit, onInvite, onOpenOrders, notify }) {
  const [viewMode, setViewMode] = useState('list')
  const [customerSearch, setCustomerSearch] = useState('')
  const [sortBy, setSortBy] = useState('order-count')
  const [showRetailPeople, setShowRetailPeople] = useState(false)
  const pendingTransfers = transfers.filter((transfer) => transfer.status === 'pending' && transfer.toEmail === normalizeEmail(actor.email))
  const customerRows = useMemo(() => {
    const search = normalizeText(customerSearch)
    return customers.map((customer) => {
      const customerOrders = orders.filter((order) => order.customerId === customer.id)
      const latestOrder = customerOrders.reduce((latest, order) => {
        const current = toDate(order.receivedAt || order.createdAt)
        return current && (!latest || current.getTime() > latest.getTime()) ? current : latest
      }, null)
      return {
        customer,
        activeOrders: customerOrders.filter((order) => !['Teslim Edildi', 'İptal Edildi'].includes(order.status)).length,
        totalOrders: customerOrders.length,
        latestOrder,
        latestOrderTime: latestOrder?.getTime() || 0,
      }
    }).filter(({ customer }) => !search || normalizeText(`${customer.quickTracking ? 'Perakende' : ''} ${customer.displayName} ${customer.email || ''} ${customer.whatsappName || ''}`).includes(search)).sort((a, b) => {
      if (sortBy === 'name') return String(a.customer.displayName).localeCompare(String(b.customer.displayName), 'tr')
      if (sortBy === 'order-count') return b.totalOrders - a.totalOrders || b.latestOrderTime - a.latestOrderTime
      if (sortBy === 'active-count') return b.activeOrders - a.activeOrders || b.latestOrderTime - a.latestOrderTime
      return b.latestOrderTime - a.latestOrderTime || String(a.customer.displayName).localeCompare(String(b.customer.displayName), 'tr')
    })
  }, [customers, orders, customerSearch, sortBy])
  const quickRows = customerRows.filter(({ customer }) => customer.quickTracking)
  const standardRows = customerRows.filter(({ customer }) => !customer.quickTracking)
  const retailSummary = quickRows.length ? {
    people: quickRows.length,
    activeOrders: quickRows.reduce((sum, row) => sum + row.activeOrders, 0),
    totalOrders: quickRows.reduce((sum, row) => sum + row.totalOrders, 0),
    latestOrder: quickRows.reduce((latest, row) => row.latestOrder && (!latest || row.latestOrder.getTime() > latest.getTime()) ? row.latestOrder : latest, null),
  } : null

  async function acceptTransfer(transfer) {
    if (!window.confirm(`“${transfer.customerName}” müşterisini listenize kabul etmek istiyor musunuz?`)) return
    const managerEmail = normalizeEmail(actor.email)
    const batch = writeBatch(db)
    batch.set(doc(db, 'customers', transfer.customerId), { assignedAdminEmail: managerEmail, updatedAt: serverTimestamp(), updatedBy: managerEmail }, { merge: true })
    batch.set(doc(db, 'access', normalizeEmail(transfer.customerEmail)), { managerEmail, updatedAt: serverTimestamp() }, { merge: true })
    ;(transfer.orderIds || []).forEach((id) => {
      batch.set(doc(db, 'orders', id), { managerEmail, updatedAt: serverTimestamp(), updatedBy: managerEmail }, { merge: true })
      batch.set(doc(db, 'orderPrivate', id), { managerEmail, updatedAt: serverTimestamp(), updatedBy: managerEmail }, { merge: true })
    })
    ;(transfer.requestIds || []).forEach((id) => batch.set(doc(db, 'requests', id), { managerEmail, updatedAt: serverTimestamp() }, { merge: true }))
    batch.set(doc(db, 'customerTransfers', transfer.id), { status: 'accepted', acceptedAt: serverTimestamp(), updatedAt: serverTimestamp() }, { merge: true })
    addActivityToBatch(batch, actor, 'accepted', 'customer', transfer.customerId, transfer.customerName, { managerEmail })
    await batch.commit()
    notify('Müşteri listenize eklendi.')
  }

  async function removeCustomer(customer) {
    const relatedOrders = orders.filter((order) => order.customerId === customer.id)
    if (relatedOrders.length) {
      notify(`Bu müşteriye bağlı ${relatedOrders.length} sipariş var. Önce bu siparişleri silin.`)
      return
    }
    if (!window.confirm(`“${customer.displayName}” müşterisini ve giriş yetkisini çöp kutusuna taşımak istiyor musunuz?`)) return
    const relatedAccess = customer.quickTracking ? [] : isOwner ? accessList.filter((item) => item.role === 'customer' && item.customerId === customer.id) : [{ id: normalizeEmail(customer.email) }]
    const relatedRequests = requests.filter((request) => request.customerId === customer.id)
    const privateSnapshot = await getDoc(doc(db, 'customerPrivate', customer.id))
    const customerData = { ...customer }
    delete customerData.id
    const trashRef = doc(collection(db, 'trash'))
    const batch = writeBatch(db)
    batch.set(trashRef, {
      entityType: 'customer',
      originalId: customer.id,
      label: customer.displayName,
      customerData,
      privateData: privateSnapshot.exists() ? privateSnapshot.data() : null,
      accessData: relatedAccess.map(({ id, ...data }) => ({ id, data })),
      requestsData: relatedRequests.map(({ id, ...data }) => ({ id, data })),
      deletedBy: normalizeEmail(actor.email),
      managerEmail: normalizeEmail(customer.assignedAdminEmail || actor.email),
      deletedAt: serverTimestamp(),
      createdAt: serverTimestamp(),
    })
    batch.delete(doc(db, 'customers', customer.id))
    batch.delete(doc(db, 'customerPrivate', customer.id))
    if (customer.quickTracking && customer.trackingToken) batch.delete(doc(db, 'publicTracking', customer.trackingToken))
    relatedAccess.forEach((item) => batch.delete(doc(db, 'access', item.id)))
    relatedRequests.forEach((request) => batch.delete(doc(db, 'requests', request.id)))
    addActivityToBatch(batch, actor, 'deleted', 'customer', customer.id, customer.displayName, { managerEmail: customer.assignedAdminEmail })
    await batch.commit()
    notify('Müşteri çöp kutusuna taşındı.')
  }

  return (
    <section>
      <PageHeader eyebrow="İlişkiler" title="Müşteriler" description={isOwner ? 'Tüm müşterileri görün, içe aktarın veya bir yöneticiye gönderin.' : 'Yalnızca sizin eklediğiniz ve size gönderilen müşteriler görünür.'} actions={<div className="header-actions"><button className="button secondary" type="button" onClick={onImport}>Excel / CSV yükle</button><button className="button primary" type="button" onClick={onCreate}><Icon name="plus" />Müşteri ekle</button></div>} />
      {!isOwner && pendingTransfers.length > 0 && <div className="panel incoming-panel"><h2>Ana yöneticiden gelen müşteriler</h2>{pendingTransfers.map((transfer) => <div className="incoming-row" key={transfer.id}><div><strong>{transfer.customerName}</strong><span>{transfer.fromName || transfer.fromEmail} gönderdi</span></div><button className="button primary compact" type="button" onClick={() => acceptTransfer(transfer).catch((error) => notify(friendlyError(error)))}>Müşteriyi kabul et</button></div>)}</div>}
      <div className="customer-view-toolbar panel"><label className="search-field"><Icon name="search" size={18} /><input aria-label="Müşteri ara" placeholder="Müşteri veya e-posta ara…" value={customerSearch} onChange={(event) => setCustomerSearch(event.target.value)} /></label><select aria-label="Müşteri sıralaması" value={sortBy} onChange={(event) => setSortBy(event.target.value)}><option value="order-count">En çok sipariş (varsayılan)</option><option value="last-order">Son sipariş tarihi</option><option value="active-count">En çok aktif sipariş</option><option value="name">Ada göre A-Z</option></select><ViewToggle value={viewMode} onChange={setViewMode} /></div>
      {showRetailPeople && retailSummary && <div className="panel quick-customer-panel"><div className="quick-customer-heading"><div><span className="eyebrow">Perakende</span><h2>Kişi ve takip bağlantıları</h2></div><button className="button secondary compact" type="button" onClick={() => setShowRetailPeople(false)}>Kapat</button></div><div className="quick-customer-list">{quickRows.map(({ customer, activeOrders, totalOrders }) => <article key={customer.id}><button type="button" onClick={() => onOpenOrders(customer.id)}><strong>{customer.displayName}</strong><span>{activeOrders} aktif · {totalOrders} toplam</span></button><div className="row-actions"><button type="button" title="Takip bağlantısı" onClick={() => onInvite(customer)}><Icon name="copy" size={16} /></button><button type="button" title="Düzenle" onClick={() => onEdit(customer)}><Icon name="edit" size={16} /></button><button className="danger-icon" type="button" title="Sil" onClick={() => removeCustomer(customer).catch((error) => notify(friendlyError(error)))}><Icon name="trash" size={16} /></button></div></article>)}</div></div>}
      {viewMode === 'grid' ? <div className="card-grid customer-grid">
        {retailSummary && <article className="entity-card retail-customer-card"><button className="customer-open" type="button" onClick={() => onOpenOrders(RETAIL_CUSTOMER_FILTER)} aria-label="Perakende siparişlerini aç"><div className="entity-head"><div className="avatar large">P</div><span className="state-on">Toplu</span></div><h3>Perakende</h3><p>Kayıtlı müşteri hesabı olmayan işler</p><div className="entity-meta"><span><b>{retailSummary.activeOrders}</b> aktif sipariş</span><span>{retailSummary.totalOrders} toplam · {retailSummary.people} kişi</span></div></button><div className="entity-actions"><button className="button secondary compact" type="button" onClick={() => setShowRetailPeople((value) => !value)}><Icon name="copy" size={16} />Bağlantılar</button></div></article>}
        {standardRows.map(({ customer, activeOrders, totalOrders, latestOrder }) => <article className="entity-card" key={customer.id}>
          <button className="customer-open" type="button" onClick={() => onOpenOrders(customer.id)} aria-label={`${customer.displayName} siparişlerini aç`}>
            <div className="entity-head"><div className="avatar large">{customer.displayName?.slice(0, 1).toLocaleUpperCase('tr-TR')}</div><span className={customer.active === false ? 'state-off' : 'state-on'}>{customer.active === false ? 'Pasif' : 'Aktif'}</span></div>
            <h3>{customer.displayName}</h3><p>{customer.quickTracking ? 'Hızlı takip bağlantısı' : customer.email}</p>
            <div className="entity-meta"><span><b>{activeOrders}</b> aktif sipariş</span><span>{totalOrders} toplam · Son: {latestOrder ? formatDate(latestOrder) : 'Yok'}</span></div>
          </button>
          <div className="entity-actions"><button className="button primary compact" type="button" onClick={() => onInvite(customer)}><Icon name={customer.quickTracking ? 'copy' : 'mail'} size={16} />{customer.quickTracking ? 'Takip bağlantısı' : 'Davet gönder'}</button>{isOwner && <button className="button secondary compact" type="button" onClick={() => onTransfer(customer)}>Yöneticiye gönder</button>}<button className="button secondary compact" type="button" onClick={() => onEdit(customer)}><Icon name="settings" size={16} />Ayarlar</button><button className="button danger compact entity-delete" type="button" onClick={() => removeCustomer(customer).catch((error) => notify(`Müşteri silinemedi: ${friendlyError(error)}`))}><Icon name="trash" size={16} />Müşteriyi sil</button></div>
        </article>)}
        {customerRows.length === 0 && <EmptyState title="Müşteri bulunamadı" text={customers.length ? 'Arama ifadesini değiştirin.' : 'Sipariş oluşturabilmek için ilk müşteriyi ekleyin.'} action={!customers.length ? onCreate : null} />}
      </div> : <div className="customer-list panel">
        {retailSummary && <article className="customer-list-item retail-customer-row"><button className="customer-list-open" type="button" onClick={() => onOpenOrders(RETAIL_CUSTOMER_FILTER)} aria-label="Perakende siparişlerini aç"><div className="avatar">P</div><div className="customer-list-name"><strong>Perakende</strong><span>{retailSummary.people} kayıtlı hesapsız kişi</span></div><div className="customer-list-stat"><b>{retailSummary.activeOrders}</b><span>aktif</span></div><div className="customer-list-stat"><b>{retailSummary.totalOrders}</b><span>toplam</span></div><div className="customer-list-date"><span>Son sipariş</span><b>{retailSummary.latestOrder ? formatDate(retailSummary.latestOrder) : 'Henüz yok'}</b></div><span className="state-on">Toplu</span></button><div className="customer-list-actions"><button type="button" title="Perakende bağlantıları" aria-label="Perakende bağlantılarını göster" onClick={() => setShowRetailPeople((value) => !value)}><Icon name="copy" size={17} /></button></div></article>}
        {standardRows.map(({ customer, activeOrders, totalOrders, latestOrder }) => <article className="customer-list-item" key={customer.id}>
          <button className="customer-list-open" type="button" onClick={() => onOpenOrders(customer.id)} aria-label={`${customer.displayName} siparişlerini aç`}><div className="avatar">{customer.displayName?.slice(0, 1).toLocaleUpperCase('tr-TR')}</div><div className="customer-list-name"><strong>{customer.displayName}</strong><span>{customer.quickTracking ? 'Hızlı takip bağlantısı' : customer.email}</span></div><div className="customer-list-stat"><b>{activeOrders}</b><span>aktif</span></div><div className="customer-list-stat"><b>{totalOrders}</b><span>toplam</span></div><div className="customer-list-date"><span>Son sipariş</span><b>{latestOrder ? formatDate(latestOrder) : 'Henüz yok'}</b></div><span className={customer.active === false ? 'state-off' : 'state-on'}>{customer.active === false ? 'Pasif' : 'Aktif'}</span></button>
          <div className="customer-list-actions"><button type="button" title={customer.quickTracking ? 'Takip bağlantısı' : 'Davet gönder'} aria-label={customer.quickTracking ? 'Takip bağlantısı' : 'Davet gönder'} onClick={() => onInvite(customer)}><Icon name={customer.quickTracking ? 'copy' : 'mail'} size={17} /></button>{isOwner && <button type="button" title="Yöneticiye gönder" aria-label="Yöneticiye gönder" onClick={() => onTransfer(customer)}><Icon name="admins" size={17} /></button>}<button type="button" title="Ayarlar" aria-label="Müşteriyi düzenle" onClick={() => onEdit(customer)}><Icon name="settings" size={17} /></button><button className="danger-icon" type="button" title="Sil" aria-label="Müşteriyi sil" onClick={() => removeCustomer(customer).catch((error) => notify(`Müşteri silinemedi: ${friendlyError(error)}`))}><Icon name="trash" size={17} /></button></div>
        </article>)}
        {customerRows.length === 0 && <EmptyState title="Müşteri bulunamadı" text={customers.length ? 'Arama ifadesini değiştirin.' : 'Sipariş oluşturabilmek için ilk müşteriyi ekleyin.'} action={!customers.length ? onCreate : null} />}
      </div>}
    </section>
  )
}

function AdminsView({ accessList, currentEmail, actor, onCreate, onEdit, onInvite, notify }) {
  const admins = accessList.filter((item) => ['owner', 'admin'].includes(item.role))
  const normalizedCurrentEmail = normalizeEmail(currentEmail)
  async function removeAdmin(admin) {
    if (normalizedCurrentEmail === admin.id) {
      notify('Giriş yaptığınız kendi yönetici hesabınızı silemezsiniz.')
      return
    }
    if (admin.role === 'owner') {
      notify('Ana yönetici doğrudan silinemez. Önce rolünü Yönetici yapın.')
      return
    }
    if (!window.confirm(`“${admin.displayName || admin.email || admin.id}” yöneticisini çöp kutusuna taşımak istiyor musunuz?`)) return
    const adminData = { ...admin }
    delete adminData.id
    const trashRef = doc(collection(db, 'trash'))
    const batch = writeBatch(db)
    batch.set(trashRef, { entityType: 'admin', originalId: admin.id, label: admin.displayName || admin.email || admin.id, accessData: adminData, deletedBy: normalizeEmail(actor.email), deletedAt: serverTimestamp(), createdAt: serverTimestamp() })
    batch.delete(doc(db, 'access', admin.id))
    addActivityToBatch(batch, actor, 'deleted', 'admin', admin.id, admin.displayName || admin.email || admin.id)
    await batch.commit()
    notify('Yönetici çöp kutusuna taşındı.')
  }
  return (
    <section>
      <PageHeader eyebrow="Yetkilendirme" title="Yöneticiler" description="Yönetim paneline erişebilen ekip üyelerini belirleyin." actionLabel="Yönetici ekle" onAction={onCreate} />
      <div className="panel table-wrap"><table><thead><tr><th>Ad</th><th>Google hesabı</th><th>Rol</th><th>Durum</th><th /></tr></thead><tbody>
        {admins.map((admin) => <tr key={admin.id}><td><strong>{admin.displayName || 'İsimsiz'}</strong>{normalizedCurrentEmail === admin.id && <span className="you-label">Siz</span>}</td><td>{admin.email || admin.id}</td><td>{admin.role === 'owner' ? 'Ana Yönetici' : 'Yönetici'}</td><td><span className={admin.active === false ? 'state-off' : 'state-on'}>{admin.active === false ? 'Pasif' : 'Aktif'}</span></td><td><div className="row-actions"><button type="button" aria-label="Davet gönder" title="Davet gönder" onClick={() => onInvite(admin)}><Icon name="mail" size={17} /></button><button type="button" aria-label="Yöneticiyi düzenle" onClick={() => onEdit(admin)}><Icon name="edit" size={17} /></button><button className="danger-icon" type="button" aria-label="Yöneticiyi sil" onClick={() => removeAdmin(admin).catch((error) => notify(`Yönetici silinemedi: ${friendlyError(error)}`))}><Icon name="trash" size={17} /></button></div></td></tr>)}
      </tbody></table></div>
    </section>
  )
}

function RequestsView({ requests, customerMap, orderMap, actor, onCreateOrder, notify }) {
  async function toggle(request) {
    const batch = writeBatch(db)
    const status = request.status === 'closed' ? 'open' : 'closed'
    batch.update(doc(db, 'requests', request.id), { status, updatedAt: serverTimestamp() })
    addActivityToBatch(batch, actor, status === 'closed' ? 'closed' : 'reopened', 'request', request.id, request.message || 'Müşteri talebi')
    await batch.commit()
    notify(request.status === 'closed' ? 'Talep yeniden açıldı.' : 'Talep kapatıldı.')
  }
  const labels = { urgent: 'Aciliyet talebi', process_info: 'Süreç bilgisi', note: 'Müşteri notu', new_order: 'Yeni sipariş talebi' }
  return (
    <section>
      <PageHeader eyebrow="İletişim" title="Müşteri talepleri" description="Müşterilerden gelen istekleri takip edin ve sonuçlandırın." />
      <div className="request-list">{requests.map((request) => <article className={request.status === 'closed' ? 'request-card request-closed' : 'request-card'} key={request.id}>
        <div className="request-icon"><Icon name="requests" /></div><div className="request-body"><div><span className="request-type">{labels[request.type] || request.type}</span><time>{formatDateTime(request.createdAt)}</time></div><h3>{customerMap[request.customerId]?.displayName || 'Müşteri'} · {request.type === 'new_order' ? request.name || 'Yeni sipariş' : orderMap[request.orderId]?.name || 'Sipariş'}</h3><p>{request.type === 'new_order' ? `${[request.material, request.service].filter(Boolean).join(' + ') || 'Malzeme veya hizmet belirtilmedi'}${request.measurement ? ` · ${request.measurement}` : ''}${request.message ? ` · ${request.message}` : ''}` : request.message || 'Mesaj eklenmedi.'}</p></div>
        <div className="request-actions">{request.type === 'new_order' && request.status !== 'closed' && <button className="button primary compact" type="button" onClick={() => onCreateOrder(request)}>Siparişe dönüştür</button>}<button className="button secondary compact" type="button" onClick={() => toggle(request).catch(() => notify('Talep güncellenemedi.'))}>{request.status === 'closed' ? 'Yeniden aç' : 'Kapat'}</button></div>
      </article>)}{requests.length === 0 && <EmptyState title="Yeni talep yok" text="Müşteri talepleri burada görünecek." />}</div>
    </section>
  )
}

function WhatsAppView({ customers, embedded = false }) {
  const desktop = Boolean(window.siparisTakip?.desktop)
  function openWhatsApp() {
    window.siparisTakip?.openWhatsApp?.()
  }
  return <section className={embedded ? 'settings-embedded' : ''}>
    {!embedded && <PageHeader eyebrow="Aktarım" title="WhatsApp bağlantıları" description="WhatsApp görüşmelerini müşterilerle sade ve güvenli biçimde eşleştirin." />}
    <div className="whatsapp-guide">
      <article><strong>1</strong><div><h3>WhatsApp’ı açın</h3><p>İlk kullanımda QR kodu bir kez okutmanız yeterlidir.</p></div></article>
      <article><strong>2</strong><div><h3>Mesaja veya eke sağ tıklayın</h3><p>Kayıtlı müşteriyi siparişe alabilir; diğer kişiler için Hızlı Takip Siparişi veya Müşteri Olarak Ekle seçebilirsiniz.</p></div></article>
      <article><strong>3</strong><div><h3>Kontrol edip onaylayın</h3><p>Yeni sipariş ve iptal işlemleri siz onaylamadan kaydedilmez.</p></div></article>
    </div>
    <div className="whatsapp-actions">{desktop ? <button className="button primary" type="button" onClick={openWhatsApp}>WhatsApp’ı aç / bağla</button> : <p className="simple-help">WhatsApp sipariş aktarımı kurulu Windows uygulamasında kullanılabilir.</p>}</div>
    <div className="panel report-panel"><h2>Kayıtlı WhatsApp adları</h2><div className="table-wrap"><table><thead><tr><th>Müşteri</th><th>WhatsApp görüşme adı</th></tr></thead><tbody>
      {customers.map((customer) => <tr key={customer.id}><td><strong>{customer.displayName}</strong></td><td>{customer.whatsappName || customer.displayName}</td></tr>)}
    </tbody></table>{customers.length === 0 && <p className="simple-help whatsapp-empty">Önce bir müşteri ekleyin.</p>}</div><p className="simple-help whatsapp-empty">WhatsApp'taki ad farklıysa Müşteriler → Ayarlar bölümünden görüşme adını düzeltin.</p></div>
  </section>
}

function SettingsView({ customers, orders, requests, materials, materialGroups, materialTemplates, exchangeRates, financeSettings, privateMap, accessList, transfers, activities, trash, actor, isOwner, deliverySettings, inactivitySettings, backupSettings, customerBackups, backupBusy, onRunBackup, notify }) {
  const [section, setSection] = useState('alerts')
  const [alertForm, setAlertForm] = useState({ deliveryEnabled: true, daysBefore: 3, inactivityEnabled: true, daysWithoutMovement: 3 })
  const [currencyForm, setCurrencyForm] = useState({ systemCurrency: 'TRY', manualRateEnabled: false, USD: '', EUR: '', GBP: '' })
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    setAlertForm({
      deliveryEnabled: deliverySettings?.enabled !== false,
      daysBefore: Math.max(0, Number(deliverySettings?.daysBefore) || 3),
      inactivityEnabled: inactivitySettings?.enabled !== false,
      daysWithoutMovement: Math.max(1, Number(inactivitySettings?.daysWithoutMovement) || 3),
    })
  }, [deliverySettings, inactivitySettings])
  useEffect(() => {
    const latest = exchangeRates[0] || {}
    setCurrencyForm({ systemCurrency: financeSettings?.systemCurrency || 'TRY', manualRateEnabled: Boolean(financeSettings?.manualRateEnabled), USD: latest.USD ?? '', EUR: latest.EUR ?? '', GBP: latest.GBP ?? '' })
  }, [exchangeRates, financeSettings])

  async function saveAlerts(event) {
    event.preventDefault()
    setBusy(true)
    try {
      const batch = writeBatch(db)
      batch.set(doc(db, 'settings', 'deliveryReminders'), { enabled: alertForm.deliveryEnabled, daysBefore: Math.max(0, Math.min(30, Number(alertForm.daysBefore) || 0)), updatedAt: serverTimestamp(), updatedBy: normalizeEmail(actor.email) }, { merge: true })
      batch.set(doc(db, 'settings', 'orderInactivity'), { enabled: alertForm.inactivityEnabled, daysWithoutMovement: Math.max(1, Math.min(30, Number(alertForm.daysWithoutMovement) || 3)), updatedAt: serverTimestamp(), updatedBy: normalizeEmail(actor.email) }, { merge: true })
      addActivityToBatch(batch, actor, 'updated', 'settings', 'orderWarnings', 'Sipariş uyarıları')
      await batch.commit()
      notify('Uyarı ayarları kaydedildi.')
    } catch (error) { notify(friendlyError(error)) } finally { setBusy(false) }
  }

  async function saveCurrencySettings(event) {
    event.preventDefault()
    const systemCurrency = String(currencyForm.systemCurrency || 'TRY').toUpperCase()
    const rates = { USD: Math.max(0, Number(currencyForm.USD) || 0), EUR: Math.max(0, Number(currencyForm.EUR) || 0), GBP: Math.max(0, Number(currencyForm.GBP) || 0) }
    if (currencyForm.manualRateEnabled && systemCurrency !== 'TRY' && !rates[systemCurrency]) { notify(`${systemCurrency} için manuel kur girin.`); return }
    setBusy(true)
    try {
      const today = todayInput()
      const batch = writeBatch(db)
      batch.set(doc(db, 'settings', 'financeDisplay'), { systemCurrency, manualRateEnabled: currencyForm.manualRateEnabled, updatedAt: serverTimestamp(), updatedBy: normalizeEmail(actor.email) }, { merge: true })
      if (currencyForm.manualRateEnabled) batch.set(doc(db, 'exchangeRates', today), { date: today, USD: rates.USD || null, EUR: rates.EUR || null, GBP: rates.GBP || null, source: 'manual', updatedAt: serverTimestamp(), updatedBy: normalizeEmail(actor.email) }, { merge: true })
      addActivityToBatch(batch, actor, 'updated', 'settings', 'financeDisplay', 'Para birimi ve güncel kur')
      await batch.commit()
      notify(currencyForm.manualRateEnabled ? 'Manuel kur kaydedildi.' : 'Otomatik kur kullanılıyor.')
    } catch (error) { notify(friendlyError(error)) } finally { setBusy(false) }
  }

  const sections = [
    ['currency', 'Para birimi ve kur', 'finance'],
    ['alerts', 'Uyarılar', 'history'],
    ['whatsapp', 'WhatsApp', 'whatsapp'],
    ['backup', 'Yedek ve dışa aktar', 'backup'],
    ...(isOwner ? [['history', 'Geçmiş ve çöp kutusu', 'trash']] : []),
  ]
  return <section>
    <PageHeader eyebrow="Yönetim" title="Ayarlar" description="Para birimini, güncel kurları, uyarıları, WhatsApp bağlantısını ve yedekleri yönetin." />
    <div className="settings-tabs" role="tablist" aria-label="Ayar bölümleri">{sections.map(([key, label, icon]) => <button className={section === key ? 'active' : ''} type="button" role="tab" aria-selected={section === key} key={key} onClick={() => setSection(key)}><Icon name={icon} size={17} />{label}</button>)}</div>
    {section === 'currency' && <form className="panel currency-settings-card" onSubmit={saveCurrencySettings}>
      <div className="currency-settings-intro"><span className="eyebrow">Finans görünümü</span><h2>Sistem para birimi ve güncel kurlar</h2><p>Varsayılan olarak güncel kur internetten otomatik alınır. Malzemenin USD/EUR alış fiyatı bir kez tanımlanır; TL sonucu her gün yeniden hesaplanır.</p></div>
      <label>Sistem para birimi<select value={currencyForm.systemCurrency} onChange={(event) => setCurrencyForm({ ...currencyForm, systemCurrency: event.target.value })}>{CURRENCY_OPTIONS.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}</select></label>
      <label className="span-2 switch-row"><input type="checkbox" checked={currencyForm.manualRateEnabled} onChange={(event) => setCurrencyForm({ ...currencyForm, manualRateEnabled: event.target.checked })} /><span><b>Manuel kur kullan</b><small>Kapalıyken hiçbir kur girmeniz gerekmez.</small></span></label>
      {CURRENCY_OPTIONS.filter((item) => item.value !== 'TRY').map((item) => <label key={item.value}>1 {item.value} kaç TL<input min="0" step="0.0001" type="number" value={currencyForm[item.value]} disabled={!currencyForm.manualRateEnabled} onChange={(event) => setCurrencyForm({ ...currencyForm, [item.value]: event.target.value })} placeholder="Otomatik alınacak" /></label>)}
      <div className="currency-settings-footer"><span>Son kur: {exchangeRates[0]?.id ? formatDate(new Date(`${exchangeRates[0].id}T12:00:00`)) : 'Yükleniyor'} · {financeSettings.manualRateEnabled ? 'Manuel' : 'Otomatik'}</span><button className="button primary" type="submit" disabled={busy}>{busy ? 'Kaydediliyor…' : 'Ayarı kaydet'}</button></div>
    </form>}
    {section === 'alerts' && <form className="settings-alerts-grid" onSubmit={saveAlerts}>
      <article className="panel settings-alert-card"><div><span className="eyebrow">Teslim tarihi</span><h2>Yaklaşan teslim uyarısı</h2><p>Yönetici ve müşteri, teslim tarihi yaklaşan açık siparişleri görür.</p></div><label className="switch-row"><input type="checkbox" checked={alertForm.deliveryEnabled} onChange={(event) => setAlertForm({ ...alertForm, deliveryEnabled: event.target.checked })} /><span><b>Uyarı açık</b><small>İstediğiniz zaman kapatabilirsiniz.</small></span></label><label>Kaç gün önce<input type="number" min="0" max="30" step="1" value={alertForm.daysBefore} disabled={!alertForm.deliveryEnabled} onChange={(event) => setAlertForm({ ...alertForm, daysBefore: event.target.value })} /></label></article>
      <article className="panel settings-alert-card"><div><span className="eyebrow">Unutulan işler</span><h2>Hareketsizlik uyarısı</h2><p>Bekliyor, üretimde veya hazır durumundaki sipariş uzun süre değişmezse yöneticiyi uyarır.</p></div><label className="switch-row"><input type="checkbox" checked={alertForm.inactivityEnabled} onChange={(event) => setAlertForm({ ...alertForm, inactivityEnabled: event.target.checked })} /><span><b>Uyarı açık</b><small>Durum değişince süre yeniden başlar.</small></span></label><label>Kaç gün hareketsiz kalınca<input type="number" min="1" max="30" step="1" value={alertForm.daysWithoutMovement} disabled={!alertForm.inactivityEnabled} onChange={(event) => setAlertForm({ ...alertForm, daysWithoutMovement: event.target.value })} /></label></article>
      <div className="settings-save-row"><button className="button primary" type="submit" disabled={busy}>{busy ? 'Kaydediliyor…' : 'Uyarı ayarlarını kaydet'}</button></div>
    </form>}
    {section === 'whatsapp' && <WhatsAppView customers={customers} embedded />}
    {section === 'backup' && <BackupView customers={customers} orders={orders} requests={requests} materials={materials} materialGroups={materialGroups} materialTemplates={materialTemplates} exchangeRates={exchangeRates} financeSettings={financeSettings} privateMap={privateMap} accessList={accessList} transfers={transfers} actor={actor} isOwner={isOwner} backupSettings={backupSettings} customerBackups={customerBackups} backupBusy={backupBusy} onRunBackup={onRunBackup} notify={notify} embedded />}
    {section === 'history' && isOwner && <HistoryView activities={activities} trash={trash} actor={actor} isOwner={isOwner} notify={notify} embedded />}
  </section>
}

function ReportsView({ orders, customerMap = {}, showCustomer = false }) {
  const rows = useMemo(() => summarizeByMaterial(orders), [orders])
  const totalQuantity = rows.reduce((sum, row) => sum + row.quantity, 0)
  const totalArea = rows.reduce((sum, row) => sum + row.areaM2, 0)
  return <section>
    <PageHeader eyebrow="Rapor" title="Genel Toplam" description="Tüm geçmişi adet, malzeme ve metrekare olarak görün." />
    <div className="report-summary">
      <article><span>Toplam sipariş</span><strong>{orders.length}</strong></article>
      <article><span>Toplam ürün</span><strong>{totalQuantity}</strong></article>
      <article><span>Toplam alan</span><strong>{totalArea.toLocaleString('tr-TR', { maximumFractionDigits: 2 })} m²</strong></article>
      <article><span>Teslim edilen</span><strong>{orders.filter((order) => order.status === 'Teslim Edildi').length}</strong></article>
    </div>
    <div className="panel report-panel"><h2>Malzemeye göre</h2><div className="table-wrap"><table><thead><tr><th>Malzeme</th><th>Sipariş</th><th>Ürün adedi</th><th>Toplam m²</th></tr></thead><tbody>
      {rows.map((row) => <tr key={row.material}><td><strong>{row.material}</strong></td><td>{row.orderCount}</td><td>{row.quantity}</td><td>{row.areaM2.toLocaleString('tr-TR', { maximumFractionDigits: 2 })} m²</td></tr>)}
    </tbody></table>{rows.length === 0 && <EmptyState title="Henüz toplam yok" text="Ölçü ve malzeme girilen siparişler burada toplanır." />}</div></div>
    <div className="panel report-panel"><h2>Tüm sipariş geçmişi</h2><div className="table-wrap"><table><thead><tr>{showCustomer && <th>Müşteri</th>}<th>Proje</th><th>Tür / Malzeme</th><th>Ölçü</th><th>Adet</th><th>Alan</th><th>Durum</th></tr></thead><tbody>
      {orders.map((order) => <tr key={order.id}>{showCustomer && <td>{customerMap[order.customerId]?.displayName || 'Müşteri'}</td>}<td><strong>{order.name || 'İsim girilmedi'}</strong></td><td>{order.type}<span className="cell-note">{order.material || 'Belirtilmedi'}</span></td><td>{order.widthCm && order.heightCm ? `${order.widthCm}×${order.heightCm} cm` : '—'}</td><td>{order.quantity || '—'}</td><td>{orderAreaM2(order) ? `${orderAreaM2(order).toLocaleString('tr-TR', { maximumFractionDigits: 2 })} m²` : '—'}</td><td><StatusBadge status={order.status} /></td></tr>)}
    </tbody></table></div></div>
  </section>
}

function AdminOverviewView({ orders, privateMap, customerMap, materials, exchangeRates = [], financeSettings = {}, onEdit }) {
  const [customerId, setCustomerId] = useState('')
  const currentRates = useMemo(() => currentExchangeRateMap(exchangeRates), [exchangeRates])
  const financeOptions = useMemo(() => ({ currentExchangeRates: currentRates }), [currentRates])
  const summary = useMemo(() => summarizeFinance(orders, privateMap, materials, financeOptions), [orders, privateMap, materials, financeOptions])
  const materialRows = useMemo(() => summarizeByMaterial(orders, privateMap, materials, financeOptions), [orders, privateMap, materials, financeOptions])
  const totalQuantity = materialRows.reduce((sum, row) => sum + row.quantity, 0)
  const totalArea = materialRows.reduce((sum, row) => sum + row.areaM2, 0)
  const customerRows = useMemo(() => summarizeFinanceByCustomer(orders, privateMap, customerMap, materials, financeOptions), [orders, privateMap, customerMap, materials, financeOptions])
  const rows = useMemo(() => orders.filter((order) => !customerId || order.customerId === customerId).map((order) => ({ order, finance: orderFinance(privateMap[order.id], order, materials, financeOptions) })), [orders, privateMap, materials, customerId, financeOptions])
  const moneyOrBlank = (hasPrice, value) => hasPrice ? formatSystemCurrency(value, financeSettings, currentRates) : '—'
  return <section>
    <PageHeader eyebrow="Yönetici özel" title="Toplamlar ve Finans" description="İş hacmini, malzemeleri, ortalama maliyeti, satışı ve kazancı tek sade sayfada görün." />
    <div className="overview-section-title"><h2>İş özeti</h2><span>Tüm siparişler</span></div>
    <div className="report-summary">
      <article><span>Toplam sipariş</span><strong>{orders.length}</strong></article>
      <article><span>Toplam ürün</span><strong>{totalQuantity}</strong></article>
      <article><span>Toplam alan</span><strong>{totalArea.toLocaleString('tr-TR', { maximumFractionDigits: 2 })} m²</strong></article>
      <article><span>Teslim edilen</span><strong>{orders.filter((order) => order.status === 'Teslim Edildi').length}</strong></article>
    </div>
    <div className="panel report-panel"><h2>Malzeme ve hizmete göre kullanım ve kazanç</h2><div className="table-wrap"><table><thead><tr><th>Malzeme + Hizmet</th><th>Sipariş</th><th>Ürün adedi</th><th>Toplam m²</th><th>Ort. maliyet</th><th>Satış</th><th>Kazanç</th></tr></thead><tbody>{materialRows.map((row) => <tr key={row.material}><td><strong>{row.material}</strong>{row.pricedOrderCount < row.orderCount && <span className="cell-note">{row.pricedOrderCount}/{row.orderCount} sipariş fiyatlı</span>}</td><td>{row.orderCount}</td><td>{row.quantity}</td><td>{row.areaM2.toLocaleString('tr-TR', { maximumFractionDigits: 2 })} m²</td><td>{moneyOrBlank(row.pricedOrderCount > 0, row.cost)}</td><td>{moneyOrBlank(row.pricedOrderCount > 0, row.sale)}</td><td><strong>{moneyOrBlank(row.pricedOrderCount > 0, row.profit)}</strong></td></tr>)}</tbody></table>{materialRows.length === 0 && <EmptyState title="Henüz toplam yok" text="Siparişler eklendikçe kullanım ve kazanç bilgileri burada görünür." />}</div></div>
    <div className="overview-section-title"><h2>Finans özeti</h2><span>Yalnızca yöneticiler görür</span></div>
    <div className="report-summary finance-summary">
      <article><span>Toplam satış</span><strong>{formatSystemCurrency(summary.sale, financeSettings, currentRates)}</strong><small>{summary.orderCount} fiyatlı sipariş</small></article>
      <article><span>Toplam ort. maliyet</span><strong>{formatSystemCurrency(summary.cost, financeSettings, currentRates)}</strong></article>
      <article><span>Toplam kazanç</span><strong>{formatSystemCurrency(summary.profit, financeSettings, currentRates)}</strong></article>
      <article><span>Fiyatı eksik</span><strong>{summary.missingPriceCount}</strong><small>sipariş tabloda gösteriliyor</small></article>
    </div>
    <div className="panel report-panel"><h2>Müşteri hacmi ve kazanç</h2><div className="table-wrap"><table><thead><tr><th>Müşteri</th><th>Sipariş</th><th>Fiyatlı sipariş</th><th>Ort. maliyet</th><th>Satış</th><th>Kazanç</th></tr></thead><tbody>
      {customerRows.map((row) => <tr key={row.customerId}><td><strong>{row.customerName}</strong></td><td>{row.orderCount}</td><td>{row.pricedOrderCount}</td><td>{moneyOrBlank(row.pricedOrderCount > 0, row.cost)}</td><td>{moneyOrBlank(row.pricedOrderCount > 0, row.sale)}</td><td><strong>{moneyOrBlank(row.pricedOrderCount > 0, row.profit)}</strong></td></tr>)}
    </tbody></table>{customerRows.length === 0 && <EmptyState title="Henüz sipariş yok" text="Siparişler eklendikçe müşteri hacmi burada görünür." />}</div></div>
    <div className="finance-filters">
      <select aria-label="Finans müşteri filtresi" value={customerId} onChange={(event) => setCustomerId(event.target.value)}><option value="">Tüm müşteriler</option>{customerRows.map((row) => <option key={row.customerId} value={row.customerId}>{row.customerName}</option>)}</select>
    </div>
    <div className="panel report-panel"><h2>Sipariş bazında</h2><div className="table-wrap"><table><thead><tr><th>Müşteri / Proje</th><th>Malzeme + Hizmet / Ölçü</th><th>Ort. birim maliyet</th><th>Ort. maliyet</th><th>Hedef kâr</th><th>Satış</th><th>Kazanç</th><th aria-label="İşlemler" /></tr></thead><tbody>
      {rows.map(({ order, finance }) => <tr key={order.id}><td><strong>{customerMap[order.customerId]?.displayName || 'Müşteri'}</strong><span className="cell-note">{order.name || 'İsim girilmedi'}</span></td><td>{order.material || order.type || 'Belirtilmedi'}<span className="cell-note">{formatOrderMeasurement(order)}{finance.source === 'material' ? ' · güncel hesap' : ''}</span></td><td>{finance.enabled ? finance.source === 'material' ? `${formatSystemCurrency(finance.unitCost, financeSettings, currentRates)} / ${finance.unitLabel}` : 'Özel fiyat' : '—'}</td><td>{moneyOrBlank(finance.enabled, finance.cost)}</td><td>{finance.enabled ? `%${finance.rate}` : '—'}</td><td>{moneyOrBlank(finance.enabled, finance.sale)}</td><td><strong>{moneyOrBlank(finance.enabled, finance.profit)}</strong></td><td><div className="row-actions"><button type="button" aria-label="Finans bilgisini düzenle" onClick={() => onEdit(order)}><Icon name="edit" size={17} /></button></div></td></tr>)}
    </tbody></table>{rows.length === 0 && <p className="simple-help finance-empty">Filtreye uygun sipariş bulunamadı.</p>}</div></div>
  </section>
}

function BackupView({ customers, orders, requests, materials, materialGroups, materialTemplates, exchangeRates, financeSettings, privateMap, accessList, transfers, actor, isOwner, backupSettings, customerBackups, backupBusy, onRunBackup, notify, embedded = false }) {
  const stamp = todayInput()
  const [scheduleForm, setScheduleForm] = useState({ enabled: true, intervalDays: 7, retentionDays: 90 })
  useEffect(() => { setScheduleForm({ enabled: backupSettings.enabled !== false, intervalDays: Number(backupSettings.intervalDays) || 7, retentionDays: Number(backupSettings.retentionDays) || 90 }) }, [backupSettings])
  async function saveBackupSettings(event) {
    event.preventDefault()
    try {
      const batch = writeBatch(db)
      batch.set(doc(db, 'backupSettings', normalizeEmail(actor.email)), { enabled: scheduleForm.enabled, intervalDays: Math.max(1, Math.min(365, Number(scheduleForm.intervalDays) || 7)), retentionDays: Math.max(1, Math.min(3650, Number(scheduleForm.retentionDays) || 90)), updatedAt: serverTimestamp() }, { merge: true })
      addActivityToBatch(batch, actor, 'updated', 'backupSettings', normalizeEmail(actor.email), 'Otomatik müşteri yedeği')
      await batch.commit()
      notify('Otomatik yedekleme ayarı kaydedildi.')
    } catch (error) { notify(friendlyError(error)) }
  }
  function downloadBackup() {
    const backup = exportSafe({
      format: 'izmirde-reklam-siparis-takip-backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      exportedBy: normalizeEmail(actor.email),
      scope: isOwner ? 'owner-full' : 'manager-own-records',
      customers,
      orders,
      orderPrivate: privateMap,
      requests,
      materials,
      materialGroups,
      materialTemplates,
      exchangeRates,
      financeSettings,
      administrators: isOwner ? accessList.filter((item) => item.role === 'owner' || item.role === 'admin') : [],
      customerTransfers: transfers,
    })
    downloadTextFile(`siparis-takip-yedek-${stamp}.json`, JSON.stringify(backup, null, 2), 'application/json;charset=utf-8')
    notify('JSON yedeği indirmeye hazırlandı.')
  }
  function downloadOrders() {
    const customerMap = Object.fromEntries(customers.map((customer) => [customer.id, customer]))
    const rows = orders.map((order) => {
      const finance = orderFinance(privateMap[order.id], order, materials)
      return {
        Tarih: toDateInput(order.receivedAt),
        Müşteri: customerMap[order.customerId]?.displayName || '',
        Sipariş: order.name || '',
        Malzeme: order.material || order.type || '',
        Hesaplama: materialType(finance.calculationType).label,
        Miktar: finance.calculationQuantity || '',
        Birim: finance.unitLabel || '',
        En_cm: order.widthCm || '',
        Boy_cm: order.heightCm || '',
        Durum: order.status || '',
        Ort_Maliyet_TL: finance.enabled ? finance.cost : '',
        Satış_TL: finance.enabled ? finance.sale : '',
        Kazanç_TL: finance.enabled ? finance.profit : '',
      }
    })
    downloadTextFile(`siparisler-${stamp}.csv`, `\ufeff${Papa.unparse(rows, { delimiter: ';' })}`, 'text/csv;charset=utf-8')
    notify('Sipariş CSV dosyası indirmeye hazırlandı.')
  }
  function downloadCustomers() {
    const rows = customers.map((customer) => ({ Müşteri: customer.displayName || '', 'E-posta': customer.email || '', 'WhatsApp adı': customer.whatsappName || '', Yönetici: customer.assignedAdminEmail || '', Durum: customer.active === false ? 'Pasif' : 'Aktif' }))
    downloadTextFile(`musteriler-${stamp}.csv`, `\ufeff${Papa.unparse(rows, { delimiter: ';' })}`, 'text/csv;charset=utf-8')
    notify('Müşteri CSV dosyası indirmeye hazırlandı.')
  }
  function downloadMaterials() {
    const rows = materials.map((material) => ({ Tür: material.kind === 'composite' ? 'Birleşik ürün' : material.itemType === 'service' ? 'Hizmet' : 'Malzeme', 'Ana başlık': material.groupName || '', 'Model / seçenek': material.variantName || '', Kayıt: material.name || '', Bileşenler: (material.componentMaterialIds || []).map((id) => materials.find((item) => item.id === id)?.name).filter(Boolean).join(' + '), Şablon: material.templateName || '', Hesaplama: materialFields(material).map((key) => fieldMeta(key, material).label).join(' + '), 'Birim fiyatlar': Object.entries(material.priceComponents || {}).map(([key, value]) => `${fieldMeta(key, material).unit}: ${value?.unitPrice ?? ''}`).join(' | ') || (material.unitPrice ?? material.sheetCost ?? ''), 'Para birimi': material.currency || 'TRY', 'Hedef kâr %': material.profitRate || '' }))
    downloadTextFile(`malzemeler-${stamp}.csv`, `\ufeff${Papa.unparse(rows, { delimiter: ';' })}`, 'text/csv;charset=utf-8')
    notify('Malzeme CSV dosyası indirmeye hazırlandı.')
  }
  return <section className={embedded ? 'settings-embedded' : ''}>
    {!embedded && <PageHeader eyebrow="Güvenli kopya" title="Yedek ve Dışa Aktar" description={isOwner ? 'Tüm sistem verilerini yedekleyin veya Excel uyumlu tablolar indirin.' : 'Yalnızca size bağlı müşteri ve siparişleri dışa aktarabilirsiniz.'} />}
    <form className="panel backup-schedule" onSubmit={saveBackupSettings}><div><span className="eyebrow">Otomatik koruma</span><h2>Müşteri bilgisi yedekleri</h2><p>{isOwner ? 'Tüm müşterileriniz' : 'Size bağlı müşterileriniz'} belirlediğiniz aralıkla saklanır; süresi dolan eski kopyalar temizlenir.</p></div><label className="switch-row"><input type="checkbox" checked={scheduleForm.enabled} onChange={(event) => setScheduleForm({ ...scheduleForm, enabled: event.target.checked })} /><span><b>Otomatik yedek açık</b><small>Uygulama açıkken zamanı gelince çalışır.</small></span></label><label>Kaç günde bir<select value={scheduleForm.intervalDays} onChange={(event) => setScheduleForm({ ...scheduleForm, intervalDays: event.target.value })}><option value="1">Her gün</option><option value="7">7 günde bir</option><option value="15">15 günde bir</option><option value="30">30 günde bir</option></select></label><label>Ne kadar saklansın<select value={scheduleForm.retentionDays} onChange={(event) => setScheduleForm({ ...scheduleForm, retentionDays: event.target.value })}><option value="30">30 gün</option><option value="90">90 gün</option><option value="180">180 gün</option><option value="365">1 yıl</option></select></label><div className="backup-schedule-actions"><button className="button secondary" type="submit">Ayarı kaydet</button><button className="button primary" type="button" disabled={backupBusy || customers.length === 0} onClick={onRunBackup}>{backupBusy ? 'Yedekleniyor…' : 'Şimdi yedekle'}</button></div><small className="backup-status">{customerBackups.length} kayıtlı müşteri kopyası · Son yedek: {backupSettings.lastBackupAt ? formatDateTime(backupSettings.lastBackupAt) : 'Henüz alınmadı'}</small></form>
    <div className="backup-grid">
      <article className="panel backup-card"><Icon name="backup" size={26} /><div><h2>Güvenli sistem yedeği</h2><p>Sonradan arşivlemek için tüm erişebildiğiniz kayıtları tek JSON dosyasında indirir.</p></div><button className="button primary" type="button" onClick={downloadBackup}>Yedeği indir</button></article>
      <article className="panel backup-card"><Icon name="orders" size={26} /><div><h2>Siparişler</h2><p>Tarih, müşteri, malzeme, maliyet, satış ve kazanç bilgilerini dışa aktarır.</p></div><button className="button secondary" type="button" onClick={downloadOrders}>CSV indir</button></article>
      <article className="panel backup-card"><Icon name="customers" size={26} /><div><h2>Müşteriler</h2><p>Müşteri ve sorumlu yönetici listesini Excel uyumlu biçimde indirir.</p></div><button className="button secondary" type="button" onClick={downloadCustomers}>CSV indir</button></article>
      <article className="panel backup-card"><Icon name="materials" size={26} /><div><h2>Malzemeler</h2><p>Hesaplama biçimi, kaynak fiyatı, para birimi ve hedef kâr ayarlarını indirir.</p></div><button className="button secondary" type="button" onClick={downloadMaterials}>CSV indir</button></article>
    </div>
    <p className="simple-help">JSON yedeğinde müşteri ve yöneticiye gösterilmeyen özel finans bilgileri bulunabilir. Dosyayı güvenli bir yerde saklayın.</p>
  </section>
}

function MaterialsView({ materials, exchangeRates, orders, actor, notify }) {
  const emptyPrices = { area: '', minute: '', weight: '', quantity: '', fixed: '', custom: '' }
  const emptyForm = {
    id: '', itemType: 'material', name: '', inputFields: [], inputDefinitions: [], customInputs: [],
    serviceSelectionEnabled: false, allowedServiceIds: [], sheetWidthCm: '', sheetHeightCm: '',
    prices: emptyPrices, currency: 'TRY', profitRate: '',
  }
  const [form, setForm] = useState(emptyForm)
  const [mode, setMode] = useState('')
  const [showFeaturePicker, setShowFeaturePicker] = useState(false)
  const [rateForm, setRateForm] = useState({ date: todayInput(), USD: '', EUR: '', GBP: '' })
  const [busy, setBusy] = useState(false)
  const currencySymbol = CURRENCY_OPTIONS.find((item) => item.value === form.currency)?.symbol || form.currency
  const latestRateMap = useMemo(() => currentExchangeRateMap(exchangeRates), [exchangeRates])
  const serviceOptions = useMemo(() => materials.filter((item) => item.id !== form.id && item.itemType === 'service' && item.active !== false && item.kind !== 'composite'), [materials, form.id])

  useEffect(() => {
    const saved = exchangeRates.find((item) => item.id === rateForm.date)
    setRateForm((current) => ({ ...current, USD: saved?.USD ?? '', EUR: saved?.EUR ?? '', GBP: saved?.GBP ?? '' }))
  }, [exchangeRates, rateForm.date])

  function addFeature(key) {
    if (key === 'service-selection') {
      setForm((current) => ({ ...current, serviceSelectionEnabled: true }))
      setShowFeaturePicker(false)
      return
    }
    if (key === 'custom') {
      const input = { ...newCustomInput(), label: 'Yeni özellik', unit: 'birim' }
      setForm((current) => ({
        ...current,
        inputFields: [...current.inputFields, input.id],
        inputDefinitions: [...current.inputDefinitions, { key: input.id, label: input.label, unit: input.unit }],
        customInputs: [...current.customInputs, input],
        prices: { ...current.prices, [input.id]: '' },
      }))
      setShowFeaturePicker(false)
      return
    }
    if (form.inputFields.includes(key)) {
      notify('Bu özellik zaten ekli.')
      return
    }
    const meta = materialType(key)
    setForm((current) => ({
      ...current,
      inputFields: [...current.inputFields, key],
      inputDefinitions: [...current.inputDefinitions, { key, label: meta.label, unit: meta.unit }],
    }))
    setShowFeaturePicker(false)
  }

  function updateFeature(key, patch) {
    setForm((current) => ({
      ...current,
      inputDefinitions: current.inputDefinitions.map((item) => item.key === key ? { ...item, ...patch } : item),
      customInputs: current.customInputs.map((item) => item.id === key ? { ...item, label: patch.label ?? item.label, unit: patch.unit ?? item.unit } : item),
    }))
  }

  function removeFeature(key) {
    setForm((current) => {
      const prices = { ...current.prices }
      delete prices[key]
      return {
        ...current,
        inputFields: current.inputFields.filter((item) => item !== key),
        inputDefinitions: current.inputDefinitions.filter((item) => item.key !== key),
        customInputs: current.customInputs.filter((item) => item.id !== key),
        prices,
        ...(key === 'area' ? { sheetWidthCm: '', sheetHeightCm: '' } : {}),
      }
    })
  }

  function toggleService(serviceId) {
    setForm((current) => ({
      ...current,
      allowedServiceIds: current.allowedServiceIds.includes(serviceId)
        ? current.allowedServiceIds.filter((id) => id !== serviceId)
        : [...current.allowedServiceIds, serviceId],
    }))
  }

  async function saveMaterial(event) {
    event.preventDefault()
    const cleanName = form.name.trim()
    const duplicate = materials.some((item) => item.id !== form.id && normalizeText(item.name) === normalizeText(cleanName))
    if (!cleanName || duplicate) {
      notify(duplicate ? 'Bu adla bir kayıt zaten var.' : `${form.itemType === 'service' ? 'Hizmet' : 'Malzeme'} adını girin.`)
      return
    }
    setBusy(true)
    try {
      const isEdit = Boolean(form.id)
      const materialRef = isEdit ? doc(db, 'materials', form.id) : doc(collection(db, 'materials'))
      const inputFields = [...new Set(form.inputFields)]
      const definitions = inputFields.map((key) => {
        const configured = form.inputDefinitions.find((item) => item.key === key)
        const meta = fieldMeta(key, form)
        return { key, label: (configured?.label || meta.label).trim(), unit: (configured?.unit || meta.unit).trim() }
      })
      const customInputs = form.customInputs.filter((item) => inputFields.includes(item.id)).map((item) => {
        const configured = definitions.find((definition) => definition.key === item.id)
        return { id: item.id, label: configured?.label || item.label || 'Özel özellik', unit: configured?.unit || item.unit || 'birim' }
      })
      const areaUsesSquareMeters = isSquareMeterUnit(definitions.find((item) => item.key === 'area')?.unit || 'm²')
      const priceComponents = Object.fromEntries(inputFields.map((key) => [key, {
        unitPrice: Number(form.prices[key]) > 0 ? Number(form.prices[key]) : null,
        priceMode: key === 'area' && form.itemType !== 'service' && areaUsesSquareMeters ? 'sheet' : 'perUnit',
        ...(key === 'area' && form.itemType !== 'service' && areaUsesSquareMeters ? { sheetWidthCm: Number(form.sheetWidthCm) > 0 ? Number(form.sheetWidthCm) : null, sheetHeightCm: Number(form.sheetHeightCm) > 0 ? Number(form.sheetHeightCm) : null } : {}),
      }]))
      const primaryType = inputFields[0] || 'fixed'
      const primaryPrice = Number(form.prices[primaryType]) > 0 ? Number(form.prices[primaryType]) : null
      const sourceAreaCost = materialCostPerM2(form.sheetWidthCm, form.sheetHeightCm, form.prices.area)
      const batch = writeBatch(db)
      batch.set(materialRef, {
        name: cleanName, kind: 'variant', itemType: form.itemType === 'service' ? 'service' : 'material',
        groupId: null, groupName: '', variantName: cleanName, componentMaterialIds: [],
        templateId: null, templateName: 'Özel özellikler', inputFields, inputDefinitions: definitions, customInputs,
        serviceSelectionEnabled: form.itemType !== 'service' && form.serviceSelectionEnabled,
        allowedServiceIds: form.itemType !== 'service' && form.serviceSelectionEnabled ? form.allowedServiceIds : [],
        priceComponents, calculationType: inputFields.length > 1 ? 'combined' : primaryType,
        unitLabel: inputFields.length > 1 ? 'karma' : fieldMeta(primaryType, { ...form, inputDefinitions: definitions, customInputs }).unit,
        sheetWidthCm: inputFields.includes('area') && areaUsesSquareMeters && Number(form.sheetWidthCm) > 0 ? Number(form.sheetWidthCm) : null,
        sheetHeightCm: inputFields.includes('area') && areaUsesSquareMeters && Number(form.sheetHeightCm) > 0 ? Number(form.sheetHeightCm) : null,
        unitPrice: primaryPrice, sheetCost: primaryPrice, currency: form.currency, exchangeRate: null, sheetCostTry: null,
        costPerM2: form.currency === 'TRY' && inputFields.includes('area') && areaUsesSquareMeters ? (form.itemType === 'service' ? primaryPrice : sourceAreaCost > 0 ? sourceAreaCost : null) : null,
        profitRate: Math.max(0, Number(form.profitRate) || 0), active: true, updatedAt: serverTimestamp(),
        ...(isEdit ? {} : { createdAt: serverTimestamp() }),
      }, { merge: true })
      addActivityToBatch(batch, actor, isEdit ? 'updated' : 'created', 'material', materialRef.id, cleanName)
      await batch.commit()
      setForm(emptyForm)
      setShowFeaturePicker(false)
      setMode('')
      notify(isEdit ? 'Malzeme güncellendi.' : form.itemType === 'service' ? 'Hizmet eklendi.' : 'Malzeme eklendi.')
    } catch (error) {
      notify(friendlyError(error))
    } finally {
      setBusy(false)
    }
  }

  function editMaterial(material) {
    const inputFields = materialFields(material)
    const legacyType = material.calculationType || inputFields[0]
    const legacyM2Price = legacyType === 'area' && (material.currency || 'TRY') === 'TRY' && !material.sheetWidthCm && !material.sheetHeightCm ? material.costPerM2 : null
    const customInputs = material.customInputs || []
    const inputDefinitions = inputFields.map((key) => {
      const saved = (material.inputDefinitions || []).find((item) => item.key === key)
      const meta = fieldMeta(key, material)
      return { key, label: saved?.label || meta.label, unit: saved?.unit || meta.unit }
    })
    const prices = { ...emptyPrices, ...Object.fromEntries(customInputs.map((item) => [item.id, ''])) }
    inputFields.forEach((key) => {
      prices[key] = material.priceComponents?.[key]?.unitPrice ?? (key === legacyType ? material.unitPrice ?? material.sheetCost ?? legacyM2Price ?? '' : '')
    })
    const legacyServiceIds = material.kind === 'composite' ? (material.componentMaterialIds || []).filter((id) => materials.find((entry) => entry.id === id)?.itemType === 'service') : []
    setForm({
      ...emptyForm, id: material.id, itemType: material.itemType === 'service' ? 'service' : 'material', name: material.name || '',
      inputFields, inputDefinitions, customInputs,
      serviceSelectionEnabled: Boolean(material.serviceSelectionEnabled || material.allowedServiceIds?.length || legacyServiceIds.length),
      allowedServiceIds: material.allowedServiceIds || legacyServiceIds,
      sheetWidthCm: material.priceComponents?.area?.sheetWidthCm ?? material.sheetWidthCm ?? (legacyM2Price ? 100 : ''),
      sheetHeightCm: material.priceComponents?.area?.sheetHeightCm ?? material.sheetHeightCm ?? (legacyM2Price ? 100 : ''),
      prices, currency: material.currency || 'TRY', profitRate: material.profitRate ?? '',
    })
    setShowFeaturePicker(false)
    setMode('add')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  function copyMaterial(material) {
    editMaterial({ ...material, id: '', name: `${material.name} kopya` })
    notify('Kopya hazır. Adını ve özelliklerini kontrol edip kaydedin.')
  }

  async function removeMaterial(material) {
    const used = orders.filter((order) => normalizeText(order.material) === normalizeText(material.name) || (order.componentMaterialIds || []).includes(material.id)).length
    if (!window.confirm('“' + material.name + '” listeden kaldırılsın mı?' + (used ? ' ' + used + ' eski siparişin kaydı korunacak.' : ''))) return
    const batch = writeBatch(db)
    batch.delete(doc(db, 'materials', material.id))
    addActivityToBatch(batch, actor, 'deleted', 'material', material.id, material.name)
    await batch.commit()
    notify('Kayıt listeden kaldırıldı.')
  }

  async function saveRates(event) {
    event.preventDefault()
    const USD = Math.max(0, Number(rateForm.USD) || 0)
    const EUR = Math.max(0, Number(rateForm.EUR) || 0)
    const GBP = Math.max(0, Number(rateForm.GBP) || 0)
    if (!rateForm.date || (!USD && !EUR && !GBP)) { notify('Tarih ile en az bir döviz kuru girin.'); return }
    setBusy(true)
    try {
      const rateRef = doc(db, 'exchangeRates', rateForm.date)
      const batch = writeBatch(db)
      batch.set(rateRef, { date: rateForm.date, USD: USD || null, EUR: EUR || null, GBP: GBP || null, source: 'manual', updatedAt: serverTimestamp(), updatedBy: normalizeEmail(actor.email) }, { merge: true })
      addActivityToBatch(batch, actor, 'updated', 'exchangeRate', rateRef.id, rateForm.date + ' günlük kur')
      await batch.commit()
      notify('Günlük kurlar kaydedildi.')
    } catch (error) { notify(friendlyError(error)) } finally { setBusy(false) }
  }

  function startAdd(itemType = 'material') {
    setForm({ ...emptyForm, itemType })
    setShowFeaturePicker(false)
    setMode('add')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  function goBack() {
    setMode('')
    setForm(emptyForm)
    setShowFeaturePicker(false)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const previewParts = form.inputFields.map((key) => {
    const meta = fieldMeta(key, form)
    if (materialType(key).nonPriced) return `${meta.label}: siparişte seçilir`
    const price = Number(form.prices[key]) || 0
    if (!price) return meta.label + ': fiyat boş'
    if (key === 'area') {
      if (form.itemType === 'service' || !isSquareMeterUnit(meta.unit)) return currencySymbol + price.toLocaleString('tr-TR') + '/' + meta.unit
      const perM2 = materialCostPerM2(form.sheetWidthCm, form.sheetHeightCm, price)
      const sheetArea = Math.max(0, Number(form.sheetWidthCm) || 0) * Math.max(0, Number(form.sheetHeightCm) || 0) / 10000
      const tryPerM2 = form.currency === 'TRY' ? perM2 : perM2 * (latestRateMap[form.currency] || 0)
      return perM2 ? `${sheetArea.toLocaleString('tr-TR', { maximumFractionDigits: 4 })} m² plaka · ${currencySymbol}${perM2.toLocaleString('tr-TR', { maximumFractionDigits: 4 })}/m²${tryPerM2 > 0 && form.currency !== 'TRY' ? ` · güncel ₺${tryPerM2.toLocaleString('tr-TR', { maximumFractionDigits: 2 })}/m²` : ''}` : currencySymbol + price.toLocaleString('tr-TR') + ' plaka'
    }
    return currencySymbol + price.toLocaleString('tr-TR') + '/' + meta.unit
  })
  const visibleMaterials = [...materials].filter((item) => item.active !== false).sort((a, b) => {
    if ((a.itemType === 'service') !== (b.itemType === 'service')) return a.itemType === 'service' ? 1 : -1
    return String(a.name || '').localeCompare(String(b.name || ''), 'tr')
  })

  return <section>
    <PageHeader eyebrow="Tanımlar" title={mode === 'add' ? (form.itemType === 'service' ? (form.id ? 'Hizmeti düzenle' : 'Hizmet ekle') : (form.id ? 'Malzemeyi düzenle' : 'Malzeme ekle')) : mode === 'settings' ? 'Fiyat ve kur ayarları' : 'Malzeme ve Hizmetler'} description={mode === 'add' ? `Önce ${form.itemType === 'service' ? 'hizmet' : 'malzeme'} adını yazın; ardından kullanılacak özellikleri ekleyin.` : mode === 'settings' ? 'Sipariş tarihine göre kullanılacak döviz kurlarını yönetin.' : 'Malzeme ve hizmetleri aynı sade yapıdan ekleyip özelleştirin.'} actions={mode ? <button className="button secondary" type="button" onClick={goBack}><Icon name="back" size={17} />Geri</button> : <div className="header-actions"><button className="button secondary" type="button" onClick={() => setMode('settings')}><Icon name="settings" size={17} />Kur ayarları</button><button className="button secondary" type="button" onClick={() => startAdd('service')}><Icon name="plus" size={17} />Hizmet ekle</button><button className="button primary" type="button" onClick={() => startAdd('material')}><Icon name="plus" size={17} />Malzeme ekle</button></div>} />

    {mode === 'add' && <form className="panel material-simple-form" onSubmit={saveMaterial}>
      <div className="material-name-step"><label>{form.itemType === 'service' ? 'Hizmet adı' : 'Malzeme adı'}<input autoFocus required maxLength="100" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder={form.itemType === 'service' ? 'Örn. UV baskı veya CNC kesim' : 'Örn. 5 mm beyaz pleksi'} /></label></div>
      {form.name.trim() && <>
        <div className="material-feature-builder">
          <div className="material-feature-heading"><div><b>Özellikler</b><small>Yalnız bu {form.itemType === 'service' ? 'hizmet' : 'malzeme'} için gereken alanları ekleyin.</small></div><button className="button secondary compact" type="button" onClick={() => setShowFeaturePicker((current) => !current)}><Icon name="plus" size={16} />Özellik ekle</button></div>
          {showFeaturePicker && <div className="feature-picker">
            {MATERIAL_CALCULATION_TYPES.filter((item) => item.value !== 'custom').map((item) => <button type="button" key={item.value} onClick={() => addFeature(item.value)} disabled={form.inputFields.includes(item.value)}><b>{item.label}</b><span>{item.help}</span></button>)}
            <button type="button" onClick={() => addFeature('custom')}><b>Kendi alanını oluştur</b><span>İstediğiniz ad ve birimle yeni bir giriş alanı ekler.</span></button>
            {form.itemType !== 'service' && <button type="button" onClick={() => addFeature('service-selection')} disabled={form.serviceSelectionEnabled}><b>Hizmet seçimi</b><span>UV baskı veya kesim gibi hizmetleri aynı ürüne bağlar.</span></button>}
          </div>}
          {form.inputFields.length === 0 && !form.serviceSelectionEnabled && <div className="material-feature-empty">Henüz özellik yok. Ölçü, süre, ağırlık, adet veya kendi alanınızı ekleyebilirsiniz.</div>}
          <div className="material-feature-list">
            {form.inputFields.map((key) => {
              const definition = form.inputDefinitions.find((item) => item.key === key) || { key, label: fieldMeta(key, form).label, unit: fieldMeta(key, form).unit }
              return <article className="material-feature-card" key={key}>
                <div className="feature-card-top"><div className="feature-card-fields"><label>Alan adı<input value={definition.label} onChange={(event) => updateFeature(key, { label: event.target.value })} placeholder="Özellik adı" /></label><label>Birim<input value={definition.unit} onChange={(event) => updateFeature(key, { unit: event.target.value })} placeholder="Örn. m², dakika" /></label></div><button className="danger-icon" type="button" aria-label="Özelliği sil" onClick={() => removeFeature(key)}><Icon name="trash" size={17} /></button></div>
                {key === 'area' && form.itemType !== 'service' && isSquareMeterUnit(definition.unit) && <div className="feature-area-size"><label>Plaka eni (cm) <span className="optional-label">isteğe bağlı</span><input min="0" step="0.01" type="number" value={form.sheetWidthCm} onChange={(event) => setForm({ ...form, sheetWidthCm: event.target.value })} placeholder="205" /></label><label>Plaka boyu (cm) <span className="optional-label">isteğe bağlı</span><input min="0" step="0.01" type="number" value={form.sheetHeightCm} onChange={(event) => setForm({ ...form, sheetHeightCm: event.target.value })} placeholder="135" /></label></div>}
                {!materialType(key).nonPriced && <label className="feature-price">{key === 'area' && form.itemType !== 'service' && isSquareMeterUnit(definition.unit) ? 'Plaka fiyatı' : definition.unit + ' fiyatı'} ({currencySymbol}) <span className="optional-label">isteğe bağlı</span><input min="0" step="0.01" type="number" value={form.prices[key] ?? ''} onChange={(event) => setForm({ ...form, prices: { ...form.prices, [key]: event.target.value } })} placeholder="Fiyat yoksa boş bırakın" /></label>}
              </article>
            })}
            {form.serviceSelectionEnabled && <article className="material-feature-card service-feature-card">
              <div className="feature-card-top"><div><b>Hizmet seçimi</b><small>Sipariş girerken bu hizmetler aynı ürün içinde seçilebilir.</small></div><button className="danger-icon" type="button" aria-label="Hizmet seçimini sil" onClick={() => setForm({ ...form, serviceSelectionEnabled: false, allowedServiceIds: [] })}><Icon name="trash" size={17} /></button></div>
              <div className="linked-service-options">{serviceOptions.map((service) => <label className={form.allowedServiceIds.includes(service.id) ? 'selected' : ''} key={service.id}><input type="checkbox" checked={form.allowedServiceIds.includes(service.id)} onChange={() => toggleService(service.id)} /><span>{service.name}</span></label>)}{serviceOptions.length === 0 && <p>Henüz kayıtlı hizmet yok. Seçim boşken siparişe sonradan eklenen hizmetler de kullanılabilir.</p>}</div>
              {serviceOptions.length > 0 && <small className="simple-help">Seçim yapmazsanız kayıtlı tüm hizmetler kullanılabilir.</small>}
            </article>}
          </div>
        </div>
        <div className="material-price-settings"><label>Alış para birimi<select value={form.currency} onChange={(event) => setForm({ ...form, currency: event.target.value })}>{CURRENCY_OPTIONS.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}</select></label><label>Kâr (%) <span className="optional-label">isteğe bağlı</span><input min="0" step="0.01" type="number" value={form.profitRate} onChange={(event) => setForm({ ...form, profitRate: event.target.value })} placeholder="Örn. 35" /></label></div>
        <div className="material-price-preview material-simple-preview"><span>Hesap özeti</span><strong>{form.inputFields.length ? form.inputFields.map((key) => fieldMeta(key, form).label).join(' + ') : 'Fiyat özelliği yok'}</strong><small>{previewParts.length ? previewParts.join(' · ') : 'Fiyatlar daha sonra da eklenebilir.'}{form.serviceSelectionEnabled ? ' · Hizmet seçimi açık' : ''}{form.currency !== 'TRY' ? ' · Sonuçlar en güncel kayıtlı kurla sistem para birimine çevrilir' : ''}</small></div>
        <div className="material-form-actions"><button className="button secondary" type="button" onClick={goBack}>Vazgeç</button><button className="button primary" disabled={busy} type="submit"><Icon name={form.id ? 'check' : 'plus'} size={17} />{form.id ? 'Güncelle' : form.itemType === 'service' ? 'Hizmeti kaydet' : 'Malzemeyi kaydet'}</button></div>
      </>}
    </form>}

    {mode === 'settings' && <div className="material-settings-grid">
      <form className="panel exchange-rate-card" onSubmit={saveRates}><div><span className="eyebrow">Güncel hesap</span><h2>Döviz kurları</h2><p>Sistem hesaplarda en yeni tarihli kur kaydını kullanır. Güncel kur Ayarlar sayfasından da değiştirilebilir.</p></div><label>Tarih<input type="date" value={rateForm.date} onChange={(event) => setRateForm({ ...rateForm, date: event.target.value })} /></label><label>Dolar kuru (₺)<input min="0" step="0.0001" type="number" value={rateForm.USD} onChange={(event) => setRateForm({ ...rateForm, USD: event.target.value })} placeholder="Örn. 40,25" /></label><label>Euro kuru (₺)<input min="0" step="0.0001" type="number" value={rateForm.EUR} onChange={(event) => setRateForm({ ...rateForm, EUR: event.target.value })} placeholder="Örn. 47,50" /></label><label>Sterlin kuru (₺)<input min="0" step="0.0001" type="number" value={rateForm.GBP} onChange={(event) => setRateForm({ ...rateForm, GBP: event.target.value })} placeholder="Örn. 55,00" /></label><button className="button secondary" disabled={busy} type="submit">Kuru kaydet</button><div className="rate-history">{exchangeRates.slice(0, 5).map((item) => <span key={item.id}><b>{formatDate(new Date(item.id + 'T12:00:00'))}</b> USD {item.USD || '—'} · EUR {item.EUR || '—'} · GBP {item.GBP || '—'}</span>)}</div></form>
    </div>}

    {!mode && <div className="panel material-list material-flat-list">
      {visibleMaterials.map((material) => {
        const savedCurrency = material.currency || 'TRY'
        const savedSymbol = CURRENCY_OPTIONS.find((item) => item.value === savedCurrency)?.symbol || savedCurrency
        const fields = Array.isArray(material.inputFields) && material.inputFields.length ? material.inputFields : (material.unitPrice || material.sheetCost || material.costPerM2 ? materialFields(material) : [])
        const priceSummary = fields.length ? fields.map((key) => {
          const meta = fieldMeta(key, material)
          const config = material.priceComponents?.[key] || {}
          const price = config.unitPrice ?? (key === material.calculationType ? material.unitPrice ?? material.sheetCost : null)
          if (!price) return meta.unit + ': boş'
          if (key === 'area' && material.itemType !== 'service' && config.priceMode !== 'perUnit') {
            const perM2 = materialCostPerM2(config.sheetWidthCm ?? material.sheetWidthCm, config.sheetHeightCm ?? material.sheetHeightCm, price)
            const currentTryPerM2 = savedCurrency === 'TRY' ? perM2 : perM2 * (latestRateMap[savedCurrency] || 0)
            return savedSymbol + Number(price).toLocaleString('tr-TR') + ' plaka' + (perM2 ? ' · ' + savedSymbol + perM2.toLocaleString('tr-TR', { maximumFractionDigits: 2 }) + '/m²' : '') + (currentTryPerM2 > 0 && savedCurrency !== 'TRY' ? ` · güncel ₺${currentTryPerM2.toLocaleString('tr-TR', { maximumFractionDigits: 2 })}/m²` : '')
          }
          const currentTryPrice = savedCurrency === 'TRY' ? Number(price) : Number(price) * (latestRateMap[savedCurrency] || 0)
          return savedSymbol + Number(price).toLocaleString('tr-TR') + '/' + meta.unit + (currentTryPrice > 0 && savedCurrency !== 'TRY' ? ` · güncel ₺${currentTryPrice.toLocaleString('tr-TR', { maximumFractionDigits: 2 })}/${meta.unit}` : '')
        }).join(' · ') : 'Fiyat özelliği yok'
        const linkedIds = material.allowedServiceIds || (material.kind === 'composite' ? material.componentMaterialIds || [] : [])
        const linkedServices = linkedIds.map((id) => materials.find((item) => item.id === id)).filter((item) => item?.itemType === 'service').map((item) => item.name)
        const orderCount = orders.filter((order) => normalizeText(order.material || order.type) === normalizeText(material.name) || (order.componentMaterialIds || []).includes(material.id)).length
        return <div key={material.id}><div><strong>{material.name}</strong><span><em className={'type-pill ' + (material.itemType === 'service' ? 'service' : 'material')}>{material.itemType === 'service' ? 'Hizmet' : 'Malzeme'}</em> {fields.length ? fields.map((key) => fieldMeta(key, material).label).join(' + ') : 'Özellik yok'} · {orderCount} sipariş{linkedServices.length ? ' · Hizmetler: ' + linkedServices.join(', ') : ''}</span></div><span className="material-price">{priceSummary} · Kâr %{Number(material.profitRate) || 0}</span><div className="row-actions"><button type="button" aria-label="Malzemeyi kopyala" title="Kopyala" onClick={() => copyMaterial(material)}><Icon name="copy" size={17} /></button><button type="button" aria-label="Kaydı düzenle" onClick={() => editMaterial(material)}><Icon name="edit" size={17} /></button><button className="danger-icon" type="button" aria-label="Kaydı sil" onClick={() => removeMaterial(material).catch((error) => notify(friendlyError(error)))}><Icon name="trash" size={17} /></button></div></div>
      })}
      {visibleMaterials.length === 0 && <div className="material-feature-empty">Henüz malzeme yok. “Malzeme ekle” düğmesiyle başlayın.</div>}
    </div>}
  </section>
}

function HistoryView({ activities, trash, actor, isOwner, notify, embedded = false }) {
  const [selectedTrashIds, setSelectedTrashIds] = useState([])
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [trashSort, setTrashSort] = useState('newest')
  const sortedTrash = useMemo(() => [...trash].sort((a, b) => {
    if (trashSort === 'oldest') return (toDate(a.deletedAt)?.getTime() || 0) - (toDate(b.deletedAt)?.getTime() || 0)
    if (trashSort === 'name') return String(a.label || '').localeCompare(String(b.label || ''), 'tr')
    if (trashSort === 'type') return String(a.entityType || '').localeCompare(String(b.entityType || ''), 'tr') || String(a.label || '').localeCompare(String(b.label || ''), 'tr')
    return (toDate(b.deletedAt)?.getTime() || 0) - (toDate(a.deletedAt)?.getTime() || 0)
  }), [trash, trashSort])
  useEffect(() => { setSelectedTrashIds((current) => current.filter((id) => trash.some((item) => item.id === id))) }, [trash])
  async function restore(item) {
    if (!window.confirm(`“${item.label}” geri yüklensin mi?`)) return
    const batch = writeBatch(db)
    if (item.entityType === 'order') {
      batch.set(doc(db, 'orders', item.originalId), item.orderData)
      if (item.privateData) batch.set(doc(db, 'orderPrivate', item.originalId), item.privateData)
      ;(item.requestsData || []).forEach((entry) => batch.set(doc(db, 'requests', entry.id), entry.data))
    } else if (item.entityType === 'customer') {
      batch.set(doc(db, 'customers', item.originalId), item.customerData)
      if (item.privateData) batch.set(doc(db, 'customerPrivate', item.originalId), item.privateData)
      ;(item.accessData || []).forEach((entry) => batch.set(doc(db, 'access', entry.id), entry.data))
      ;(item.requestsData || []).forEach((entry) => batch.set(doc(db, 'requests', entry.id), entry.data))
    } else if (item.entityType === 'admin') {
      batch.set(doc(db, 'access', item.originalId), item.accessData)
    }
    batch.delete(doc(db, 'trash', item.id))
    addActivityToBatch(batch, actor, 'restored', item.entityType, item.originalId, item.label)
    await batch.commit()
    notify('Kayıt geri yüklendi.')
  }
  async function permanentlyDelete(items) {
    if (!items.length || !window.confirm(items.length === 1 ? `“${items[0].label}” kalıcı olarak silinsin mi? Bu işlem geri alınamaz.` : `${items.length} kayıt kalıcı olarak silinsin mi? Bu işlem geri alınamaz.`)) return
    setDeleteBusy(true)
    try {
      for (let index = 0; index < items.length; index += 400) {
        const group = items.slice(index, index + 400)
        const batch = writeBatch(db)
        group.forEach((item) => batch.delete(doc(db, 'trash', item.id)))
        addActivityToBatch(batch, actor, 'permanentlyDeleted', 'trash', `bulk-${Date.now()}-${index}`, group.length === 1 ? group[0].label : `${group.length} çöp kaydı`)
        await batch.commit()
      }
      setSelectedTrashIds([]); notify(items.length === 1 ? 'Kayıt kalıcı olarak silindi.' : `${items.length} kayıt kalıcı olarak silindi.`)
    } catch (error) { notify(friendlyError(error)) } finally { setDeleteBusy(false) }
  }
  function toggleTrash(id) { setSelectedTrashIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]) }
  const actionLabels = { created: 'Oluşturdu', updated: 'Güncelledi', deleted: 'Sildi', permanentlyDeleted: 'Kalıcı sildi', restored: 'Geri yükledi', closed: 'Talebi kapattı', reopened: 'Talebi açtı' }
  const entityLabels = { order: 'Sipariş', customer: 'Müşteri', admin: 'Yönetici', material: 'Malzeme', request: 'Talep' }
  return <section className={embedded ? 'settings-embedded' : ''}>
    {!embedded && <PageHeader eyebrow="Kayıt" title="Geçmiş" description="Yapılan işlemleri görün ve yanlışlıkla silinenleri geri alın." />}
    <div className="panel history-section"><div className="trash-heading"><h2>Çöp kutusu</h2>{trash.length > 0 && <div className="trash-bulk"><select aria-label="Çöp kutusu sıralaması" value={trashSort} onChange={(event) => setTrashSort(event.target.value)}><option value="newest">En son silinen</option><option value="oldest">En eski silinen</option><option value="name">Ada göre A-Z</option><option value="type">Kayıt türüne göre</option></select><label><input type="checkbox" checked={selectedTrashIds.length === trash.length} onChange={() => setSelectedTrashIds(selectedTrashIds.length === trash.length ? [] : sortedTrash.map((item) => item.id))} />Tümünü seç</label>{selectedTrashIds.length > 0 && <button className="button danger compact" type="button" disabled={deleteBusy} onClick={() => permanentlyDelete(trash.filter((item) => selectedTrashIds.includes(item.id)))}><Icon name="trash" size={16} />{selectedTrashIds.length} kaydı kalıcı sil</button>}</div>}</div><div className="trash-list">{sortedTrash.map((item) => <div key={item.id}><label className="trash-select"><input type="checkbox" checked={selectedTrashIds.includes(item.id)} onChange={() => toggleTrash(item.id)} /><span className="sr-only">Kaydı seç</span></label><div className="trash-info"><strong>{item.label}</strong><span>{entityLabels[item.entityType] || item.entityType} · {formatDateTime(item.deletedAt)}</span></div><div className="trash-actions">{(item.entityType !== 'admin' || isOwner) && <button className="button secondary compact" type="button" onClick={() => restore(item).catch((error) => notify(friendlyError(error)))}><Icon name="restore" size={16} />Geri al</button>}<button className="button danger compact" type="button" disabled={deleteBusy} onClick={() => permanentlyDelete([item])}><Icon name="trash" size={16} />Kalıcı sil</button></div></div>)}{trash.length === 0 && <p className="simple-help">Silinen kayıt yok.</p>}</div></div>
    <div className="panel history-section"><h2>İşlem geçmişi</h2><div className="activity-list">{activities.map((item) => <div key={item.id}><span>{formatDateTime(item.createdAt)}</span><strong>{item.actorName || item.actorEmail}</strong><p>{entityLabels[item.entityType] || item.entityType}: {item.label} · {actionLabels[item.action] || item.action}</p></div>)}{activities.length === 0 && <p className="simple-help">Henüz işlem kaydı yok.</p>}</div></div>
  </section>
}

function EmptyState({ title, text, action }) {
  return <div className="empty-state"><div className="empty-icon"><Icon name="orders" /></div><h3>{title}</h3><p>{text}</p>{action && <button className="button primary compact" type="button" onClick={action}><Icon name="plus" size={17} />Yeni ekle</button>}</div>
}

function Modal({ title, description, onClose, children }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="modal" role="dialog" aria-modal="true" aria-label={title}><header><div><h2>{title}</h2><p>{description}</p></div><button type="button" aria-label="Pencereyi kapat" onClick={onClose}><Icon name="close" /></button></header>{children}</section></div>
}

function OrderModal({ item, prefill, customers, materials, exchangeRates, financeSettings = {}, actor, onClose, onSaved }) {
  const materialOptions = [...new Set([...DEFAULT_MATERIALS, ...materials.map((entry) => entry.name), item?.material].filter(Boolean))]
  const parsed = parseProjectTitle(prefill?.title || '', ORDER_TYPES)
  const parsedMaterial = materialOptions.find((name) => normalizeText(`${prefill?.material || ''} ${prefill?.title || ''}`).includes(normalizeText(name))) || prefill?.material || ''
  const existingComponentIds = item?.componentMaterialIds || []
  const parsedMaterialEntry = materials.find((entry) => entry.id === prefill?.materialId) || materials.find((entry) => normalizeText(entry.name) === normalizeText(item?.material || parsedMaterial))
  const parsedServiceEntry = materials.find((entry) => entry.itemType === 'service' && entry.id === prefill?.serviceId) || materials.find((entry) => entry.itemType === 'service' && normalizeText(`${prefill?.service || ''} ${prefill?.title || ''}`).includes(normalizeText(entry.name)))
  const initialBaseMaterial = materials.find((entry) => existingComponentIds.includes(entry.id) && entry.itemType !== 'service') || (parsedMaterialEntry?.itemType !== 'service' ? parsedMaterialEntry : null)
  const initialServiceIds = [...new Set([...materials.filter((entry) => existingComponentIds.includes(entry.id) && entry.itemType === 'service').map((entry) => entry.id), ...(parsedServiceEntry ? [parsedServiceEntry.id] : [])])]
  const [form, setForm] = useState({
    customerId: item?.customerId || prefill?.customerId || '',
    name: item?.name || parsed.name || '',
    type: item?.type || parsed.type || ORDER_TYPES[0],
    material: item?.material || parsedMaterial,
    materialId: initialBaseMaterial?.id || '',
    serviceIds: initialServiceIds,
    servicePriceOverrides: {},
    widthCm: item?.widthCm || parsed.widthCm || '',
    heightCm: item?.heightCm || parsed.heightCm || '',
    quantity: item ? item.quantity ?? '' : parsed.quantity || 1,
    areaM2: item?.areaM2 ?? '',
    calculationQuantity: item?.calculationQuantity ?? '',
    calculationValues: {
      ...(item?.calculationValues || {}),
      minute: item?.calculationValues?.minute ?? (item?.calculationType === 'minute' ? item?.calculationQuantity ?? '' : ''),
      weight: item?.calculationValues?.weight ?? (item?.calculationType === 'weight' ? item?.calculationQuantity ?? '' : ''),
      quantity: item?.calculationValues?.quantity ?? (item?.calculationType === 'quantity' ? item?.calculationQuantity ?? item?.quantity ?? '' : ''),
      custom: item?.calculationValues?.custom ?? (item?.calculationType === 'custom' ? item?.calculationQuantity ?? '' : ''),
    },
    receivedAt: item ? toDateInput(item.receivedAt) : todayInput(),
    status: item?.status || 'Bekliyor',
    estimatedCompletion: toDateInput(item?.estimatedCompletion),
    urgent: Boolean(item?.urgent),
    description: item?.description || prefill?.description || '',
    internalNote: '',
    financeEnabled: false,
    costAmount: '',
    profitRate: '',
    financialNote: '',
    purchaseDate: item ? toDateInput(item.receivedAt) : todayInput(),
    saleDate: item ? toDateInput(item.receivedAt) : todayInput(),
    purchaseExchangeRate: '',
    saleExchangeRate: '',
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [privateReady, setPrivateReady] = useState(!item)
  const [existingAutomaticSnapshot, setExistingAutomaticSnapshot] = useState(null)
  const baseMaterials = useMemo(() => materials.filter((entry) => entry.kind !== 'composite' && entry.itemType !== 'service' && entry.active !== false), [materials])
  const serviceMaterials = useMemo(() => materials.filter((entry) => entry.kind !== 'composite' && entry.itemType === 'service' && entry.active !== false), [materials])
  const selectedBaseMaterial = useMemo(() => materials.find((entry) => entry.id === form.materialId), [materials, form.materialId])
  const availableServiceMaterials = useMemo(() => {
    const allowed = selectedBaseMaterial?.allowedServiceIds || []
    const restricted = Boolean(selectedBaseMaterial?.serviceSelectionEnabled && allowed.length)
    return serviceMaterials.filter((entry) => form.serviceIds.includes(entry.id) || !restricted || allowed.includes(entry.id))
  }, [form.serviceIds, selectedBaseMaterial, serviceMaterials])
  const canAddService = availableServiceMaterials.some((entry) => !form.serviceIds.includes(entry.id))
  const selectedParts = useMemo(() => [materials.find((entry) => entry.id === form.materialId), ...form.serviceIds.map((id) => materials.find((entry) => entry.id === id))].filter(Boolean), [materials, form.materialId, form.serviceIds])
  const selectedMaterial = useMemo(() => {
    if (selectedParts.length === 1) return selectedParts[0]
    if (selectedParts.length > 1) return { name: selectedParts.map(componentDisplayName).join(' + '), kind: 'composite', inputFields: [...new Set(selectedParts.flatMap((entry) => materialFields(entry)))], inputDefinitions: selectedParts.flatMap((entry) => entry.inputDefinitions || []).filter((entry, index, list) => list.findIndex((item) => item.key === entry.key) === index), customInputs: selectedParts.flatMap((entry) => entry.customInputs || []).filter((entry, index, list) => list.findIndex((item) => item.id === entry.id) === index), currency: selectedParts.every((entry) => (entry.currency || 'TRY') === (selectedParts[0].currency || 'TRY')) ? selectedParts[0].currency || 'TRY' : 'TRY' }
    return materials.find((entry) => normalizeText(entry.name) === normalizeText(form.material))
  }, [materials, selectedParts, form.material])
  const selectedFields = useMemo(() => materialFields(selectedMaterial || { calculationType: item?.calculationType || 'area' }), [selectedMaterial, item?.calculationType])
  const hasMaterialFixedField = useMemo(() => selectedParts.some((entry) => entry.itemType !== 'service' && materialFields(entry).includes('fixed')), [selectedParts])
  const selectedCalculation = fieldMeta(selectedFields[0], selectedMaterial || {})
  const foreignCurrencies = useMemo(() => [...new Set(selectedParts.map((entry) => String(entry.currency || 'TRY').toUpperCase()).filter((currency) => currency !== 'TRY'))], [selectedParts])
  const currentRates = useMemo(() => currentExchangeRateMap(exchangeRates), [exchangeRates])
  const automaticArea = selectedFields.includes('area') && isSquareMeterUnit(fieldMeta('area', selectedMaterial || {}).unit)
  const computedAreaM2 = automaticArea ? orderAreaM2({ widthCm: form.widthCm, heightCm: form.heightCm, quantity: form.quantity, areaM2: null }) : 0
  useEffect(() => {
    if (!prefill?.chat || form.customerId) return
    const chat = normalizeText(prefill.chat)
    const match = customers.find((customer) => matchesCustomerChat(customer, chat))
    if (match) setForm((current) => ({ ...current, customerId: match.id }))
  }, [customers, form.customerId, prefill])
  useEffect(() => {
    if (!item) return undefined
    let mounted = true
    getDoc(doc(db, 'orderPrivate', item.id)).then((snapshot) => {
      if (mounted && snapshot.exists()) {
        const privateData = snapshot.data()
        setExistingAutomaticSnapshot(privateData.automaticPriceSnapshot || null)
        setForm((current) => ({
          ...current,
          internalNote: privateData.internalNote || '',
          financeEnabled: Boolean(privateData.financeEnabled),
          costAmount: privateData.costAmount ?? '',
          profitRate: privateData.profitRate ?? '',
          financialNote: privateData.financialNote || '',
          servicePriceOverrides: privateData.servicePriceOverrides || {},
          purchaseDate: privateData.purchaseDate ? toDateInput(privateData.purchaseDate) : current.purchaseDate,
          saleDate: privateData.saleDate ? toDateInput(privateData.saleDate) : current.saleDate,
          purchaseExchangeRate: privateData.automaticPriceSnapshot?.purchaseExchangeRate ?? privateData.purchaseExchangeRate ?? '',
          saleExchangeRate: privateData.automaticPriceSnapshot?.saleExchangeRate ?? privateData.saleExchangeRate ?? '',
        }))
      }
    }).catch((err) => { if (mounted) setError(friendlyError(err)) }).finally(() => { if (mounted) setPrivateReady(true) })
    return () => { mounted = false }
  }, [item])
  const derivedOrderType = selectedParts.filter((entry) => entry.itemType === 'service').map(componentDisplayName).join(' + ') || item?.type || parsed.type || 'Diğer'
  const automaticFinance = useMemo(() => orderFinance({ pricingContext: { purchaseExchangeRates: currentRates, saleExchangeRates: currentRates }, servicePriceOverrides: form.servicePriceOverrides }, {
    material: form.material,
    componentMaterialIds: selectedParts.map((entry) => entry.id),
    type: derivedOrderType,
    widthCm: form.widthCm,
    heightCm: form.heightCm,
    quantity: form.quantity,
    areaM2: automaticArea ? null : form.areaM2,
    calculationQuantity: form.calculationQuantity,
    calculationValues: form.calculationValues,
    calculationType: selectedCalculation.value,
  }, materials), [form.material, form.widthCm, form.heightCm, form.quantity, form.areaM2, form.calculationQuantity, form.calculationValues, form.servicePriceOverrides, selectedCalculation.value, selectedParts, materials, automaticArea, derivedOrderType, currentRates])
  const manualSale = calculateSalePrice(form.costAmount, form.profitRate)
  const savedAutomaticFinance = useMemo(() => existingAutomaticSnapshot ? orderFinance({ automaticPriceSnapshot: existingAutomaticSnapshot }, item || {}, materials, { currentExchangeRates: currentRates }) : null, [existingAutomaticSnapshot, item, materials, currentRates])
  const effectiveFinance = form.financeEnabled
    ? { enabled: true, source: 'manual', cost: Math.max(0, Number(form.costAmount) || 0), rate: Math.max(0, Number(form.profitRate) || 0), sale: manualSale, profit: manualSale - (Number(form.costAmount) || 0) }
    : automaticFinance.enabled ? automaticFinance : savedAutomaticFinance || automaticFinance
  function change(key, value) { setForm((current) => ({ ...current, [key]: value })) }
  function updateProductSelection(materialId, serviceIds) {
    const base = materials.find((entry) => entry.id === materialId)
    const activeServices = materials.filter((entry) => entry.itemType === 'service' && entry.active !== false)
    const allowed = base?.allowedServiceIds || []
    const restricted = Boolean(base?.serviceSelectionEnabled && allowed.length)
    const permittedServiceIds = serviceIds.filter((id) => activeServices.some((entry) => entry.id === id) && (!restricted || allowed.includes(id)))
    const parts = [base, ...permittedServiceIds.map((id) => materials.find((entry) => entry.id === id))].filter(Boolean)
    setForm((current) => ({ ...current, materialId, serviceIds: permittedServiceIds, material: parts.map(componentDisplayName).join(' + '), calculationQuantity: '', calculationValues: {}, purchaseExchangeRate: '', saleExchangeRate: '' }))
  }
  async function submit(event) {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const saleAmount = form.financeEnabled ? manualSale : null
      const selectedCustomer = customers.find((customer) => customer.id === form.customerId)
      const managerEmail = normalizeEmail(selectedCustomer?.assignedAdminEmail || actor.email)
      const manualQuantityFields = selectedFields.filter((key) => key !== 'fixed' && !(key === 'area' && automaticArea))
      const calculationValues = Object.fromEntries(manualQuantityFields.map((key) => [key, Number(form.calculationValues[key]) > 0 ? Number(form.calculationValues[key]) : null]))
      const calculationQuantity = selectedFields.length === 1 && manualQuantityFields.length === 1 ? calculationValues[manualQuantityFields[0]] : null
      const componentMaterialIds = selectedParts.map((entry) => entry.id)
      const materialLabel = selectedParts.length ? selectedParts.map(componentDisplayName).join(' + ') : form.material.trim()
      const statusChanged = !item || item.status !== form.status
      const statusChangedAt = statusChanged ? serverTimestamp() : item?.statusChangedAt || item?.updatedAt || item?.createdAt || serverTimestamp()
      const deliveredAt = form.status === 'Teslim Edildi' ? (item?.status === 'Teslim Edildi' ? item.deliveredAt || item.statusChangedAt || item.updatedAt || serverTimestamp() : serverTimestamp()) : null
      const payload = { customerId: form.customerId, managerEmail, name: form.name.trim(), type: derivedOrderType, material: materialLabel, componentMaterialIds, calculationType: selectedFields.length > 1 ? 'combined' : selectedFields[0], inputFields: selectedFields, inputDefinitions: selectedFields.map((key) => ({ key, label: fieldMeta(key, selectedMaterial || {}).label, unit: fieldMeta(key, selectedMaterial || {}).unit })), calculationQuantity, calculationValues, widthCm: automaticArea ? Number(form.widthCm) || null : null, heightCm: automaticArea ? Number(form.heightCm) || null : null, quantity: automaticArea ? form.quantity === '' ? null : Math.max(1, Number(form.quantity) || 1) : selectedFields.length === 1 && selectedFields[0] === 'quantity' ? calculationValues.quantity : null, areaM2: automaticArea && computedAreaM2 > 0 ? computedAreaM2 : null, customerPriceAmount: effectiveFinance.enabled ? effectiveFinance.sale : null, receivedAt: form.receivedAt ? Timestamp.fromDate(new Date(`${form.receivedAt}T12:00:00`)) : null, status: form.status, statusChangedAt, deliveredAt, estimatedCompletion: form.estimatedCompletion ? Timestamp.fromDate(new Date(`${form.estimatedCompletion}T12:00:00`)) : null, urgent: form.urgent, description: form.description.trim(), updatedAt: serverTimestamp(), updatedBy: normalizeEmail(actor.email) }
      const calculatedSnapshot = automaticFinance.enabled ? { costAmount: automaticFinance.cost, saleAmount: automaticFinance.sale, profitRate: automaticFinance.rate, areaM2: automaticFinance.areaM2, costPerM2: automaticFinance.unitCost, calculationType: automaticFinance.calculationType, calculationQuantity: automaticFinance.calculationQuantity, unitLabel: automaticFinance.unitLabel, currency: automaticFinance.currency, purchaseExchangeRate: automaticFinance.purchaseExchangeRate, saleExchangeRate: automaticFinance.saleExchangeRate, sourceCostAmount: automaticFinance.currency === 'TRY' ? automaticFinance.cost : automaticFinance.cost / automaticFinance.purchaseExchangeRate, sourceSaleBaseAmount: automaticFinance.currency === 'TRY' ? automaticFinance.sale / (1 + automaticFinance.rate / 100) : automaticFinance.sale / (1 + automaticFinance.rate / 100) / automaticFinance.saleExchangeRate, components: automaticFinance.components || [], unpricedComponents: automaticFinance.unpricedComponents || [] } : null
      const automaticPriceSnapshot = !form.financeEnabled ? calculatedSnapshot || existingAutomaticSnapshot : null
      const servicePriceOverrides = Object.fromEntries(form.serviceIds.filter((id) => form.servicePriceOverrides[id] !== '' && form.servicePriceOverrides[id] !== null && Number.isFinite(Number(form.servicePriceOverrides[id])) && Number(form.servicePriceOverrides[id]) >= 0).map((id) => [id, Number(form.servicePriceOverrides[id])]))
      const privatePayload = { managerEmail, internalNote: form.internalNote.trim(), financeEnabled: form.financeEnabled, costAmount: form.financeEnabled ? Math.max(0, Number(form.costAmount) || 0) : null, profitRate: form.financeEnabled ? Math.max(0, Number(form.profitRate) || 0) : null, saleAmount, servicePriceOverrides, automaticPriceSnapshot, currentRateDate: exchangeRates[0]?.id || null, financialNote: effectiveFinance.enabled ? form.financialNote.trim() : '', updatedAt: serverTimestamp(), updatedBy: normalizeEmail(actor.email) }
      if (item) {
        const batch = writeBatch(db); batch.set(doc(db, 'orders', item.id), payload, { merge: true }); batch.set(doc(db, 'orderPrivate', item.id), privatePayload, { merge: true }); syncPublicOrder(batch, item.id, payload, customers, item.customerId); addActivityToBatch(batch, actor, 'updated', 'order', item.id, payload.name, { managerEmail }); await batch.commit()
      } else {
        const orderRef = doc(collection(db, 'orders')); const batch = writeBatch(db); batch.set(orderRef, { ...payload, createdAt: serverTimestamp(), createdBy: normalizeEmail(actor.email) }); batch.set(doc(db, 'orderPrivate', orderRef.id), { source: prefill?.source || 'manual', sourceChat: prefill?.chat || '', sourceTitle: prefill?.title || '', sourceMessageId: prefill?.messageId || '', sourcePhone: prefill?.phone || '', sourceTimestamp: prefill?.timestamp || '', sourceCustomerName: selectedCustomer?.displayName || '', sourceQuickTracking: Boolean(selectedCustomer?.quickTracking), ...privatePayload, createdAt: serverTimestamp(), createdBy: normalizeEmail(actor.email) }); if (prefill?.requestId) batch.set(doc(db, 'requests', prefill.requestId), { status: 'closed', orderId: orderRef.id, updatedAt: serverTimestamp() }, { merge: true }); syncPublicOrder(batch, orderRef.id, payload, customers); addActivityToBatch(batch, actor, 'created', 'order', orderRef.id, payload.name, { source: prefill?.source || 'manual', managerEmail }); await batch.commit(); if (prefill?.source === 'whatsapp' && prefill.title && window.siparisTakip?.saveWhatsAppSourceFile) window.siparisTakip.saveWhatsAppSourceFile({ chat: prefill.chat || '', title: prefill.title, messageId: prefill.messageId || '', phone: prefill.phone || '', timestamp: prefill.timestamp || '', managerEmail: normalizeEmail(actor.email), customerId: selectedCustomer?.id || '', customerName: selectedCustomer?.displayName || '', quickTracking: Boolean(selectedCustomer?.quickTracking), orderId: orderRef.id }).catch(() => {})
      }
      onSaved()
    } catch (err) { setError(friendlyError(err)); setBusy(false) }
  }
  return <Modal title={prefill ? 'WhatsApp siparişini onayla' : item ? 'Siparişi düzenle' : 'Yeni sipariş'} description={prefill ? 'Başlıktan bulunan bilgileri kontrol edin; gerekirse düzeltip kaydedin.' : 'Üretim ekibinin ve müşterinin göreceği bilgileri girin.'} onClose={onClose}><form onSubmit={submit} className="form-grid">
    {prefill && <div className="import-notice span-2"><strong>Yalnızca seçtiğiniz dosya veya proje adı alındı.</strong><span>{prefill.chat ? `WhatsApp görüşmesi: ${prefill.chat}` : 'Müşteriyi seçin.'}</span></div>}
    {prefill && !form.customerId && <div className="alert alert-error span-2">Bu WhatsApp görüşmesi kayıtlı bir müşteriyle eşleşmedi. Müşterinizse aşağıdan seçin; değilse Vazgeç'e basın. Seçim yapılmadan sipariş kaydedilemez.</div>}
    <label className="span-2">Müşteri<select required value={form.customerId} onChange={(e) => change('customerId', e.target.value)}><option value="">Müşteri seçin</option>{customers.filter((c) => c.active !== false || c.id === item?.customerId).map((c) => <option value={c.id} key={c.id}>{c.displayName}</option>)}</select></label>
    <label className="span-2">Sipariş adı<input required maxLength="240" value={form.name} onChange={(e) => change('name', e.target.value)} placeholder="Örn. Mağaza giriş tabelası" /></label>
    <label>Hizmet<select value="" disabled={!canAddService} onChange={(event) => { if (event.target.value && !form.serviceIds.includes(event.target.value)) updateProductSelection(form.materialId, [...form.serviceIds, event.target.value]) }}><option value="">{serviceMaterials.length ? 'Hizmet seçin (isteğe bağlı)' : 'Önce hizmet ekleyin'}</option>{materialGroupsForSelect(availableServiceMaterials.filter((entry) => !form.serviceIds.includes(entry.id))).map(([groupName, entries]) => <optgroup label={groupName} key={groupName}>{entries.map((entry) => <option value={entry.id} key={entry.id}>{componentDisplayName(entry)}</option>)}</optgroup>)}</select></label>
    <label>Malzeme<select value={form.materialId} onChange={(event) => updateProductSelection(event.target.value, form.serviceIds)}><option value="">Malzeme seçin</option>{materialGroupsForSelect(baseMaterials).map(([groupName, entries]) => <optgroup label={groupName} key={groupName}>{entries.map((entry) => <option value={entry.id} key={entry.id}>{componentDisplayName(entry)}</option>)}</optgroup>)}</select></label>
    {form.serviceIds.length > 0 && <div className="span-2 selected-services"><span>Seçilen hizmetler</span><div>{form.serviceIds.map((id) => { const service = materials.find((entry) => entry.id === id); return service ? <button type="button" key={id} onClick={() => updateProductSelection(form.materialId, form.serviceIds.filter((entryId) => entryId !== id))}>{componentDisplayName(service)} <Icon name="close" size={13} /></button> : null })}</div></div>}
    {form.serviceIds.length > 0 && <section className="span-2 service-order-prices"><div><b>Projeye özel hizmet bedeli</b><small>Hizmet tanımında fiyat olmasa da bu sipariş için satış bedelini girebilirsiniz.</small></div><div>{form.serviceIds.map((id) => { const service = materials.find((entry) => entry.id === id); return service ? <label key={id}>{componentDisplayName(service)} (₺)<input min="0" step="0.01" type="number" value={form.servicePriceOverrides[id] ?? ''} onChange={(event) => setForm((current) => ({ ...current, servicePriceOverrides: { ...current.servicePriceOverrides, [id]: event.target.value } }))} placeholder="Projeye göre girin" /></label> : null })}</div></section>}
    {baseMaterials.length === 0 && serviceMaterials.length === 0 && <label className="span-2">Eski malzeme adı<input list="material-options" maxLength="80" value={form.material} onChange={(event) => change('material', event.target.value)} placeholder="Malzeme adı" /><datalist id="material-options">{materialOptions.map((name) => <option value={name} key={name} />)}</datalist></label>}
    <label>Durum<select value={form.status} onChange={(e) => change('status', e.target.value)}>{ORDER_STATUSES.map((status) => <option key={status}>{status}</option>)}</select></label>
    {automaticArea && <><label>En (cm)<input min="0" step="0.01" type="number" value={form.widthCm} onChange={(e) => change('widthCm', e.target.value)} placeholder="Örn. 205" /></label><label>Boy (cm)<input min="0" step="0.01" type="number" value={form.heightCm} onChange={(e) => change('heightCm', e.target.value)} placeholder="Örn. 135" /></label><label>Ölçü adedi <small>(isteğe bağlı)</small><input min="1" step="1" type="number" value={form.quantity} onChange={(e) => change('quantity', e.target.value)} /></label><div className="area-calculation-preview"><span>Otomatik alan</span><strong>{computedAreaM2 > 0 ? computedAreaM2.toLocaleString('tr-TR', { maximumFractionDigits: 4 }) + ' m²' : '—'}</strong><small>En × boy × adet ÷ 10.000</small></div></>}
    {selectedFields.filter((key) => key !== 'fixed' && !(key === 'area' && automaticArea)).map((key) => { const meta = fieldMeta(key, selectedMaterial || {}); return <label key={key}>{meta.label} ({meta.unit}) <small>(isteğe bağlı)</small><input min="0" step={key === 'quantity' ? '1' : '0.01'} type="number" value={form.calculationValues[key] ?? ''} onChange={(e) => setForm((current) => ({ ...current, calculationValues: { ...current.calculationValues, [key]: e.target.value } }))} placeholder={`${meta.unit} girin`} /></label> })}
    {hasMaterialFixedField && <div className="material-mode-note"><b>Sabit işlem ücreti</b><span>Bu siparişe miktar girmeden bir kez eklenir.</span></div>}
    <label>Geldiği tarih <small>(isteğe bağlı)</small><input type="date" value={form.receivedAt} onChange={(e) => setForm((current) => ({ ...current, receivedAt: e.target.value, purchaseDate: current.purchaseDate === current.receivedAt ? e.target.value : current.purchaseDate, saleDate: current.saleDate === current.receivedAt ? e.target.value : current.saleDate, purchaseExchangeRate: current.purchaseDate === current.receivedAt ? '' : current.purchaseExchangeRate, saleExchangeRate: current.saleDate === current.receivedAt ? '' : current.saleExchangeRate }))} /></label>
    <label>Tahmini bitiş<input type="date" value={form.estimatedCompletion} onChange={(e) => change('estimatedCompletion', e.target.value)} /></label>
    <label className="span-2 switch-row"><input type="checkbox" checked={form.urgent} onChange={(e) => change('urgent', e.target.checked)} /><span><b>Acil sipariş</b><small>Listede öncelikli olarak işaretlenir.</small></span></label>
    <label className="span-2">Müşteri açıklaması<textarea maxLength="600" value={form.description} onChange={(e) => change('description', e.target.value)} placeholder="Müşterinin görebileceği kısa açıklama" /></label>
    <label className="span-2">İç not <small>(yalnızca yöneticiler)</small><textarea maxLength="1000" value={form.internalNote} onChange={(e) => change('internalNote', e.target.value)} placeholder="Üretim ekibi için özel not" /></label>
    <div className="span-2 finance-form">
      <div className="finance-section-title"><b>Finans bilgisi</b><small>Yalnızca yöneticiler görür.</small></div>
      {!form.financeEnabled && selectedMaterial && <div className="material-mode-note"><b>{selectedFields.map((key) => fieldMeta(key, selectedMaterial).label).join(' + ')}</b><span>Malzeme ve hizmette fiyatı bulunan miktarlar birlikte hesaplanır.</span></div>}
      {!form.financeEnabled && foreignCurrencies.length > 0 && <div className="currency-rate-summary current-rate-summary">{foreignCurrencies.map((currency) => <span key={currency}><b>{currency}</b> güncel kur: {currentRates[currency] || 'kur girilmedi'} TL</span>)}<small>Kur Ayarlar → Para birimi ve kur bölümünden değiştirilir.</small></div>}
      {!form.financeEnabled && automaticFinance.enabled && <div className="auto-finance-preview"><span>{form.material || derivedOrderType} · {automaticFinance.components?.length ? automaticFinance.components.map((component) => `${component.quantity.toLocaleString('tr-TR', { maximumFractionDigits: 3 })} ${component.unit}`).join(' + ') : `${automaticFinance.calculationQuantity.toLocaleString('tr-TR', { maximumFractionDigits: 3 })} ${automaticFinance.unitLabel}`}</span><strong>{formatSystemCurrency(automaticFinance.sale, financeSettings, currentRates)}</strong><small>Toplam alan {automaticFinance.areaM2 ? `${automaticFinance.areaM2.toLocaleString('tr-TR', { maximumFractionDigits: 4 })} m²` : '—'} · Gerçek alış maliyeti {formatSystemCurrency(automaticFinance.cost, financeSettings, currentRates)} · Beklenen kazanç {formatSystemCurrency(automaticFinance.profit, financeSettings, currentRates)} (%{automaticFinance.rate}){automaticFinance.currency !== 'TRY' ? ` · Güncel ${automaticFinance.currency} kuru ${automaticFinance.purchaseExchangeRate}` : ''}{automaticFinance.unpricedComponents?.length ? ` · Fiyatı olmayan: ${automaticFinance.unpricedComponents.join(', ')}` : ''}</small></div>}
      {!form.financeEnabled && !automaticFinance.enabled && <p className="finance-hint">{foreignCurrencies.length ? 'Seçilen döviz için güncel kuru Ayarlar sayfasına girin. Fiyatı boş hizmetler siparişi engellemez.' : 'Fiyatı bulunan alanların miktarını girerseniz toplam otomatik hesaplanır. Fiyatı olmayan hizmet ve malzemeler yine kaydedilebilir.'}</p>}
      <label className="switch-row"><input type="checkbox" checked={form.financeEnabled} onChange={(e) => change('financeEnabled', e.target.checked)} /><span><b>Fiyatı elle belirle</b><small>Bu sipariş için malzeme fiyatının yerine özel bir fiyat kullanır.</small></span></label>
      <div className="finance-form-grid">
        {form.financeEnabled && <>
        <label>Toplam ort. maliyet (₺)<input min="0" step="0.01" type="number" value={form.costAmount} onChange={(e) => change('costAmount', e.target.value)} placeholder="0,00" /></label>
        <label>Ort. maliyet üzerine hedef kâr (%)<input min="0" step="0.01" type="number" value={form.profitRate} onChange={(e) => change('profitRate', e.target.value)} placeholder="Örn. 35" /></label>
        <div className="calculated-price"><span>Özel satış fiyatı</span><strong>{formatCurrency(manualSale)}</strong><small>Beklenen kâr: {formatCurrency(manualSale - (Number(form.costAmount) || 0))}</small></div>
        </>}
        {effectiveFinance.enabled && <label className="span-2">Finans notu <small>(isteğe bağlı)</small><textarea maxLength="500" value={form.financialNote} onChange={(e) => change('financialNote', e.target.value)} placeholder="Maliyet veya fiyatla ilgili kısa not" /></label>}
      </div>
    </div>
    {error && <div className="alert alert-error span-2">{error}</div>}<div className="form-actions span-2"><button className="button secondary" type="button" onClick={onClose}>Vazgeç</button><button className="button primary" type="submit" disabled={busy || !privateReady || customers.length === 0}>{busy ? 'Kaydediliyor…' : prefill ? 'Onayla ve siparişe al' : 'Siparişi kaydet'}</button></div>
  </form></Modal>
}

function CancelOrderModal({ order, customer, title, actor, onClose, onSaved }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function cancelOrder() {
    if (!order) return
    setBusy(true); setError('')
    try {
      const batch = writeBatch(db)
      batch.set(doc(db, 'orders', order.id), { status: 'İptal Edildi', statusChangedAt: serverTimestamp(), deliveredAt: null, updatedAt: serverTimestamp(), updatedBy: normalizeEmail(actor.email) }, { merge: true })
      if (customer?.quickTracking && customer.trackingToken) batch.set(doc(db, 'publicTracking', customer.trackingToken, 'orders', order.id), { status: 'İptal Edildi', updatedAt: serverTimestamp() }, { merge: true })
      addActivityToBatch(batch, actor, 'updated', 'order', order.id, order.name, { source: 'whatsapp', status: 'İptal Edildi', managerEmail: order.managerEmail })
      await batch.commit()
      onSaved()
    } catch (err) { setError(friendlyError(err)); setBusy(false) }
  }
  return <Modal title="Projeyi iptal et" description="WhatsApp’tan seçtiğiniz kayıt, onayınız olmadan değiştirilmez." onClose={onClose}><div className="confirm-content">
    {order ? <><div className="cancel-summary"><strong>{order.name}</strong><span>Durumu “İptal Edildi” olarak değiştirilecek.</span></div>{error && <div className="alert alert-error">{error}</div>}<div className="form-actions"><button className="button secondary" type="button" onClick={onClose}>Vazgeç</button><button className="button danger" type="button" disabled={busy} onClick={cancelOrder}>{busy ? 'İptal ediliyor…' : 'Projeyi iptal et'}</button></div></> : <><div className="alert alert-error">“{title || 'Bu proje'}” Sipariş Takip’te bulunamadı. Hiçbir kayıt değiştirilmedi.</div><div className="form-actions"><button className="button secondary" type="button" onClick={onClose}>Kapat</button></div></>}
  </div></Modal>
}

function CustomerCatalogPicker({ catalog, form, setForm }) {
  const groups = [
    ['Malzemeler', 'material', 'allowedMaterialIds'],
    ['Hizmetler', 'service', 'allowedServiceIds'],
  ]
  function toggle(field, id) {
    setForm((current) => ({ ...current, [field]: current[field].includes(id) ? current[field].filter((entry) => entry !== id) : [...current[field], id] }))
  }
  function setAll(field, ids, enabled) {
    setForm((current) => ({ ...current, [field]: enabled ? ids : [] }))
  }
  return <><label className="span-2 switch-row"><input type="checkbox" checked={form.canCreateOrderRequests} onChange={(event) => setForm((current) => ({ ...current, canCreateOrderRequests: event.target.checked }))} /><span><b>Müşteri panelden sipariş ekleyebilsin</b><small>Kapalıysa “Sipariş ekle” düğmesi görünmez ve müşteri yeni malzeme/hizmet talebi gönderemez.</small></span></label><section className="customer-catalog-settings span-2"><div className="customer-catalog-title"><div><b>Müşterinin seçebileceği ürünler</b><small>Müşteri sipariş eklerken yalnızca burada açık olanları görür.</small></div></div><div className="customer-catalog-groups">{groups.map(([title, type, field]) => { const items = catalog.filter((entry) => entry.itemType === type); const allSelected = items.length > 0 && items.every((entry) => form[field].includes(entry.id)); return <fieldset key={type} disabled={!form.canCreateOrderRequests}><legend>{title}</legend><div className="catalog-group-actions"><button type="button" onClick={() => setAll(field, items.map((entry) => entry.id), !allSelected)}>{allSelected ? 'Tümünü kapat' : 'Tümünü aç'}</button><span>{form[field].filter((id) => items.some((entry) => entry.id === id)).length}/{items.length} açık</span></div><div className="catalog-check-list">{items.map((entry) => <label key={entry.id} className={form[field].includes(entry.id) ? 'selected' : ''}><input type="checkbox" checked={form[field].includes(entry.id)} onChange={() => toggle(field, entry.id)} /><span>{entry.label}</span></label>)}{items.length === 0 && <p>Henüz aktif kayıt yok.</p>}</div></fieldset> })}</div></section></>
}

function CustomerModal({ item, prefill, materials = [], actor, isOwner, admins, onClose, onSaved }) {
  const actorEmail = normalizeEmail(actor.email)
  const catalog = useMemo(() => materials
    .filter((entry) => entry.active !== false && entry.kind !== 'composite')
    .map((entry) => ({ id: entry.id, name: entry.name, label: componentDisplayName(entry), itemType: entry.itemType === 'service' ? 'service' : 'material' })), [materials])
  const defaultMaterialIds = catalog.filter((entry) => entry.itemType === 'material').map((entry) => entry.id)
  const defaultServiceIds = catalog.filter((entry) => entry.itemType === 'service').map((entry) => entry.id)
  const [form, setForm] = useState({ displayName: item?.displayName || prefill?.displayName || '', email: item?.email || '', whatsappName: item?.whatsappName || prefill?.whatsappName || item?.displayName || '', assignedAdminEmail: normalizeEmail(item?.assignedAdminEmail || actorEmail), whatsappNumber: '', internalNote: '', active: item?.active !== false, quickTracking: Boolean(item?.quickTracking || prefill?.quickTracking), showCostsToCustomer: item?.showCostsToCustomer !== false, canCreateOrderRequests: item?.canCreateOrderRequests === true, allowedMaterialIds: Array.isArray(item?.allowedMaterialIds) ? item.allowedMaterialIds : defaultMaterialIds, allowedServiceIds: Array.isArray(item?.allowedServiceIds) ? item.allowedServiceIds : defaultServiceIds })
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [phoneReady, setPhoneReady] = useState(!item)
  useEffect(() => {
    if (!item) return undefined
    let mounted = true
    getDoc(doc(db, 'customerPrivate', item.id)).then((snapshot) => {
      if (mounted && snapshot.exists()) setForm((current) => ({ ...current, whatsappNumber: snapshot.data().whatsappNumber || '', internalNote: snapshot.data().internalNote || '' }))
    }).catch((err) => {
      if (mounted) setError(friendlyError(err))
    }).finally(() => {
      if (mounted) setPhoneReady(true)
    })
    return () => { mounted = false }
  }, [item])
  async function submit(event) {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const isNew = !item; const customerRef = item ? doc(db, 'customers', item.id) : doc(collection(db, 'customers')); const email = form.quickTracking ? '' : normalizeEmail(form.email); const managerEmail = isOwner ? normalizeEmail(form.assignedAdminEmail || actorEmail) : actorEmail; const batch = writeBatch(db)
      const trackingToken = form.quickTracking ? item?.trackingToken || newTrackingToken() : ''
      const allowedMaterialIds = form.allowedMaterialIds.filter((id) => catalog.some((entry) => entry.id === id && entry.itemType === 'material'))
      const allowedServiceIds = form.allowedServiceIds.filter((id) => catalog.some((entry) => entry.id === id && entry.itemType === 'service'))
      const customerOrderCatalog = catalog.filter((entry) => (entry.itemType === 'service' ? allowedServiceIds : allowedMaterialIds).includes(entry.id))
      batch.set(customerRef, { displayName: form.displayName.trim(), email, whatsappName: form.whatsappName.trim() || form.displayName.trim(), assignedAdminEmail: managerEmail, quickTracking: form.quickTracking, trackingToken: trackingToken || null, showCostsToCustomer: form.showCostsToCustomer, canCreateOrderRequests: form.canCreateOrderRequests, allowedMaterialIds, allowedServiceIds, customerOrderCatalog, active: form.active, updatedAt: serverTimestamp(), ...(item ? {} : { createdAt: serverTimestamp(), createdBy: actorEmail }) }, { merge: true })
      if (!form.quickTracking) batch.set(doc(db, 'access', email), { email, role: 'customer', customerId: customerRef.id, managerEmail, displayName: form.displayName.trim(), active: form.active, updatedAt: serverTimestamp(), ...(item ? {} : { createdAt: serverTimestamp() }) }, { merge: true })
      if (form.quickTracking) batch.set(doc(db, 'publicTracking', trackingToken), { displayName: form.displayName.trim(), active: form.active, updatedAt: serverTimestamp(), ...(item ? {} : { createdAt: serverTimestamp() }) }, { merge: true })
      if (item) batch.set(doc(db, 'customerPrivate', customerRef.id), { whatsappNumber: form.whatsappNumber.trim(), internalNote: form.internalNote.trim(), managerEmail, updatedAt: serverTimestamp(), updatedBy: actorEmail }, { merge: true })
      if (item?.email && (form.quickTracking || normalizeEmail(item.email) !== email)) batch.set(doc(db, 'access', normalizeEmail(item.email)), { active: false, updatedAt: serverTimestamp() }, { merge: true })
      addActivityToBatch(batch, actor, isNew ? 'created' : 'updated', 'customer', customerRef.id, form.displayName.trim(), { managerEmail })
      await batch.commit(); onSaved({ id: customerRef.id, displayName: form.displayName.trim(), email, whatsappName: form.whatsappName.trim() || form.displayName.trim(), quickTracking: form.quickTracking, trackingToken, active: form.active, assignedAdminEmail: managerEmail }, isNew)
    } catch (err) { setError(friendlyError(err)); setBusy(false) }
  }
  return <Modal title={item ? 'Müşteri ayarları' : 'Yeni müşteri'} description={item ? 'Hesap, iletişim ve erişim ayarlarını yönetin.' : 'Normal hesap veya şifresiz hızlı takip bağlantısı oluşturun.'} onClose={onClose}><form onSubmit={submit} className="form-grid">{!item && <label className="span-2 switch-row quick-customer-switch"><input type="checkbox" checked={form.quickTracking} onChange={(e) => setForm({ ...form, quickTracking: e.target.checked, email: e.target.checked ? '' : form.email })} /><span><b>Hızlı takip müşterisi</b><small>Az sipariş veren kişi için e-posta ve davet gerekmez; yalnız kendi siparişlerini gösteren özel bağlantı oluşur.</small></span></label>}<label className="span-2">Müşteri adı<input required maxLength="120" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value, ...(!item && !prefill ? { whatsappName: e.target.value } : {}) })} /></label>{!form.quickTracking && <label className="span-2">Giriş yapacağı Google e-postası<input required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="user_0016@example.invalid" /><small>Müşteri bağlantıyı açınca bu hesabı seçmelidir.</small></label>}{(item || prefill || form.quickTracking) && <label className="span-2">WhatsApp görüşme adı <small>(WhatsApp'ta üstte nasıl yazıyorsa aynısı)</small><input maxLength="120" value={form.whatsappName} onChange={(e) => setForm({ ...form, whatsappName: e.target.value })} /></label>}{form.quickTracking && <div className="invite-help span-2">Bu kişi diğer hızlı takip müşterileriyle aynı türde görünür; fakat bağlantısı yalnız kendi siparişlerini açar.</div>}{isOwner && !item && <label className="span-2">Sorumlu yönetici<select value={form.assignedAdminEmail} onChange={(event) => setForm({ ...form, assignedAdminEmail: event.target.value })}><option value={actorEmail}>Ben ({actor.displayName || actorEmail})</option>{admins.map((admin) => <option value={admin.id} key={admin.id}>{admin.displayName || admin.id}</option>)}</select></label>}{item && <><label className="span-2">Telefon / WhatsApp <small>(isteğe bağlı, yalnızca yöneticiler görür)</small><input value={form.whatsappNumber} onChange={(e) => setForm({ ...form, whatsappNumber: e.target.value })} placeholder={phoneReady ? '+90 5…' : 'Yükleniyor…'} disabled={!phoneReady} /></label><label className="span-2">İç not <small>(yalnızca yöneticiler)</small><textarea maxLength="1000" value={form.internalNote} onChange={(e) => setForm({ ...form, internalNote: e.target.value })} /></label></>}<label className="span-2 switch-row"><input type="checkbox" checked={form.showCostsToCustomer} onChange={(e) => setForm({ ...form, showCostsToCustomer: e.target.checked })} /><span><b>Müşteri ortalama fiyatları görsün</b><small>Kapalıysa müşterinin panelindeki “Maliyetlerim” sayfası hemen gizlenir.</small></span></label><CustomerCatalogPicker catalog={catalog} form={form} setForm={setForm} /><label className="span-2 switch-row"><input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /><span><b>{form.quickTracking ? 'Takip bağlantısı aktif' : 'Hesap aktif'}</b><small>Pasif olduğunda erişim kapanır.</small></span></label>{error && <div className="alert alert-error span-2">{error}</div>}<div className="form-actions span-2"><button className="button secondary" type="button" onClick={onClose}>Vazgeç</button><button className="button primary" type="submit" disabled={busy || !phoneReady}>{busy ? 'Kaydediliyor…' : item ? 'Ayarları kaydet' : form.quickTracking ? 'Hızlı takibi oluştur' : 'Müşteriyi oluştur'}</button></div></form></Modal>
}

function invitationMessage(customer) {
  return `Merhaba ${customer.displayName},\n\nİzmirde Reklam Sipariş Takip sisteminde siparişlerinizi görmek için aşağıdaki bağlantıyı açın:\n${CUSTOMER_APP_URL}\n\n“Google ile devam et” düğmesine basın ve ${customer.email} hesabını seçin. Başka bir kayıt veya şifre oluşturmanız gerekmez. Yalnızca size tanımlanan siparişleri görebilirsiniz.`
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text)
  const field = document.createElement('textarea')
  field.value = text
  field.style.position = 'fixed'
  field.style.opacity = '0'
  document.body.appendChild(field)
  field.select()
  const copied = document.execCommand('copy')
  field.remove()
  if (!copied) throw new Error('copy-failed')
}

function InvitationModal({ customer, onClose, notify }) {
  const message = invitationMessage(customer)
  const mailHref = `mailto:${customer.email}?subject=${encodeURIComponent('İzmirde Reklam Sipariş Takip davetiniz')}&body=${encodeURIComponent(message)}`
  async function copyInvite() {
    try {
      await copyText(message)
      notify('Davet metni kopyalandı. WhatsApp veya mesaja yapıştırabilirsiniz.')
    } catch {
      notify('Davet kopyalanamadı. Metni seçerek kopyalayın.')
    }
  }
  return <Modal title="Müşteri daveti hazır" description={`${customer.displayName} artık kendi Google hesabıyla giriş yapabilir.`} onClose={onClose}><div className="invite-content"><div className="invite-summary"><Icon name="check" size={18} /><div><strong>Hesap bağlandı</strong><span>{customer.email}</span></div></div><label>Davet mesajı<textarea className="invite-message" readOnly value={message} onFocus={(event) => event.target.select()} /></label><p className="invite-help">Müşteri bağlantıyı açar, “Google ile devam et” der ve yukarıdaki e-posta hesabını seçer. Sistem onu otomatik olarak kendi siparişlerine bağlar.</p><div className="form-actions"><button className="button secondary" type="button" onClick={copyInvite}><Icon name="copy" size={17} />Metni kopyala</button><a className="button primary" href={mailHref}><Icon name="mail" size={17} />E-posta hazırla</a></div></div></Modal>
}

function TrackingLinkModal({ customer, onClose, notify }) {
  const link = TRACKING_URL(customer.trackingToken)
  async function copyLink() {
    try { await copyText(link); notify('Takip bağlantısı kopyalandı.') } catch { notify('Bağlantı kopyalanamadı.') }
  }
  return <Modal title="Özel takip bağlantısı" description={`${customer.displayName} yalnızca kendi siparişlerini bu bağlantıdan görür.`} onClose={onClose}><div className="invite-content"><div className="invite-summary"><Icon name="check" size={18} /><div><strong>E-posta ve giriş gerekmez</strong><span>{customer.displayName}</span></div></div><label>Takip bağlantısı<textarea className="invite-message tracking-link-field" readOnly value={link} onFocus={(event) => event.target.select()} /></label><p className="invite-help">Bu bağlantıyı yalnız ilgili kişiye gönderin. Bağlantıya sahip kişi sipariş durumlarını görebilir.</p><div className="form-actions"><button className="button secondary" type="button" onClick={onClose}>Kapat</button><button className="button primary" type="button" onClick={copyLink}><Icon name="copy" size={17} />Bağlantıyı kopyala</button></div></div></Modal>
}

function CustomerImportModal({ customers, materials, exchangeRates, admins, actor, isOwner, onClose, onSaved }) {
  const actorEmail = normalizeEmail(actor.email)
  const [managerEmail, setManagerEmail] = useState(actorEmail)
  const [fileName, setFileName] = useState('')
  const [result, setResult] = useState({ valid: [], invalid: [] })
  const [singleDraft, setSingleDraft] = useState(null)
  const [ledgerOrders, setLedgerOrders] = useState([])
  const [selectedCustomerId, setSelectedCustomerId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const draftEmail = normalizeEmail(singleDraft?.email)
  const creatingLedgerCustomer = ledgerOrders.length > 0 && selectedCustomerId === '__new__'
  const draftValidation = !singleDraft || (ledgerOrders.length > 0 && !creatingLedgerCustomer) ? '' : !singleDraft.displayName.trim() ? 'Müşteri adını girin.' : !draftEmail ? 'Dosyada Google e-postası yok. Müşterinin giriş yapacağı e-postayı yazın.' : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draftEmail) ? 'Geçerli bir Google e-postası girin.' : customers.some((customer) => normalizeEmail(customer.email) === draftEmail) ? 'Bu e-posta sistemde zaten kayıtlı.' : ''
  const readyRows = result.valid.length ? result.valid : singleDraft && !draftValidation ? [{ rowNumber: 1, displayName: singleDraft.displayName.trim(), email: draftEmail, whatsappName: singleDraft.whatsappName.trim() || singleDraft.displayName.trim() }] : []
  const canSave = ledgerOrders.length > 0 ? Boolean(selectedCustomerId && (!creatingLedgerCustomer || readyRows.length)) : readyRows.length > 0

  async function chooseFile(event) {
    const file = event.target.files?.[0]
    if (!file) return
    setError(''); setFileName(file.name); setSingleDraft(null); setResult({ valid: [], invalid: [] }); setLedgerOrders([]); setSelectedCustomerId('')
    try {
      const lowerName = file.name.toLocaleLowerCase('tr-TR')
      let source
      if (lowerName.endsWith('.csv')) source = Papa.parse(await file.text(), { skipEmptyLines: 'greedy' }).data
      else if (lowerName.endsWith('.xlsx')) source = await readXlsxFile(file)
      else throw new Error('file-type')
      const importedOrders = extractOrderDraftsFromWorkbook(source)
      if (importedOrders.length) {
        const draft = extractCustomerDraftFromWorkbook(source) || { displayName: file.name.replace(/\.(?:xlsx|csv)$/i, ''), email: '', whatsappName: '' }
        const matchedCustomer = customers.find((customer) => (draft.email && normalizeEmail(customer.email) === normalizeEmail(draft.email)) || normalizeText(customer.displayName) === normalizeText(draft.displayName))
        setSingleDraft(draft)
        setLedgerOrders(importedOrders)
        setSelectedCustomerId(matchedCustomer?.id || '__new__')
        return
      }
      const rows = findCustomerImportRows(source)
      if (!rows.length) {
        const draft = extractCustomerDraftFromWorkbook(source)
        if (draft) {
          setSingleDraft(draft)
          return
        }
        throw new Error('headers-not-found')
      }
      const mapped = mapCustomerImportRows(rows, customers.map((customer) => customer.email))
      if (!mapped.valid.length && !mapped.invalid.length) throw new Error('empty-file')
      setResult(mapped)
    } catch (err) {
      setResult({ valid: [], invalid: [] }); setSingleDraft(null); setLedgerOrders([]); setSelectedCustomerId('')
      setError(err.message === 'file-type' ? 'Yalnızca .xlsx veya .csv dosyası seçin.' : err.message === 'headers-not-found' ? 'Sipariş için Tarih, İsim, Malzeme ve Ölçü başlıklarını; müşteri için Müşteri adı ve E-posta başlıklarını kullanın.' : err.message === 'empty-file' ? 'Dosya açıldı ancak eklenebilecek satır bulunamadı.' : 'Dosya açılamadı. Bozuk olmadığını ve .xlsx biçiminde olduğunu kontrol edin.')
    }
  }

  async function saveImport() {
    if (!canSave) return
    setBusy(true); setError('')
    try {
      const assignedAdminEmail = isOwner ? normalizeEmail(managerEmail) : actorEmail
      if (ledgerOrders.length) {
        const existingCustomer = customers.find((customer) => customer.id === selectedCustomerId)
        let customerId = existingCustomer?.id || ''
        let orderManagerEmail = normalizeEmail(existingCustomer?.assignedAdminEmail || assignedAdminEmail)
        let customerCount = 0
        if (!existingCustomer) {
          const row = readyRows[0]
          const customerRef = doc(collection(db, 'customers'))
          customerId = customerRef.id
          customerCount = 1
          const customerBatch = writeBatch(db)
          customerBatch.set(customerRef, { displayName: row.displayName, email: row.email, whatsappName: row.whatsappName, assignedAdminEmail: orderManagerEmail, createdBy: actorEmail, active: true, createdAt: serverTimestamp(), updatedAt: serverTimestamp() })
          customerBatch.set(doc(db, 'access', row.email), { email: row.email, role: 'customer', customerId, managerEmail: orderManagerEmail, displayName: row.displayName, active: true, createdAt: serverTimestamp(), updatedAt: serverTimestamp() })
          addActivityToBatch(customerBatch, actor, 'created', 'customer', customerId, row.displayName, { source: 'spreadsheet', managerEmail: orderManagerEmail })
          await customerBatch.commit()
        }
        for (let index = 0; index < ledgerOrders.length; index += 100) {
          const batch = writeBatch(db)
          const currentRates = currentExchangeRateMap(exchangeRates)
          ledgerOrders.slice(index, index + 100).forEach((row) => {
            const orderRef = doc(collection(db, 'orders'))
            const normalizedMaterial = normalizeText(row.material)
            const type = normalizedMaterial.includes('pleksi') ? 'Pleksi' : normalizedMaterial.includes('uv') ? 'UV Baskı' : normalizedMaterial.includes('folyo') ? 'Folyo Baskı' : normalizedMaterial.includes('dtf') ? 'DTF Baskı' : 'Diğer'
            const materialDefinition = materials.find((entry) => normalizeText(entry.name) === normalizedMaterial)
            const calculation = materialType(materialDefinition?.calculationType)
            const calculationQuantity = calculation.value === 'area' ? null : row.areaM2
            const automaticFinance = orderFinance({ pricingContext: { purchaseExchangeRates: currentRates, saleExchangeRates: currentRates } }, { ...row, type, material: row.material, quantity: 1, calculationQuantity }, materials)
            const automaticPriceSnapshot = automaticFinance.enabled ? { costAmount: automaticFinance.cost, saleAmount: automaticFinance.sale, profitRate: automaticFinance.rate, areaM2: automaticFinance.areaM2, costPerM2: automaticFinance.unitCost, calculationType: automaticFinance.calculationType, calculationQuantity: automaticFinance.calculationQuantity, unitLabel: automaticFinance.unitLabel, currency: automaticFinance.currency, purchaseExchangeRate: automaticFinance.purchaseExchangeRate, saleExchangeRate: automaticFinance.saleExchangeRate, sourceCostAmount: automaticFinance.currency === 'TRY' ? automaticFinance.cost : automaticFinance.cost / automaticFinance.purchaseExchangeRate, sourceSaleBaseAmount: automaticFinance.currency === 'TRY' ? automaticFinance.sale / (1 + automaticFinance.rate / 100) : automaticFinance.sale / (1 + automaticFinance.rate / 100) / automaticFinance.saleExchangeRate } : null
            batch.set(orderRef, { customerId, managerEmail: orderManagerEmail, name: row.name, type, material: row.material, calculationType: calculation.value, calculationQuantity, widthCm: calculation.value === 'area' ? row.widthCm : null, heightCm: calculation.value === 'area' ? row.heightCm : null, quantity: null, areaM2: calculation.value === 'area' ? row.areaM2 : null, customerPriceAmount: automaticFinance.enabled ? automaticFinance.sale : null, receivedAt: row.receivedAt ? Timestamp.fromDate(row.receivedAt) : null, status: 'Bekliyor', statusChangedAt: serverTimestamp(), deliveredAt: null, estimatedCompletion: null, urgent: false, description: '', createdBy: actorEmail, updatedBy: actorEmail, createdAt: serverTimestamp(), updatedAt: serverTimestamp() })
            batch.set(doc(db, 'orderPrivate', orderRef.id), { managerEmail: orderManagerEmail, source: 'spreadsheet', sourceFile: fileName, sourceRow: row.rowNumber, financeEnabled: false, automaticPriceSnapshot, currentRateDate: exchangeRates[0]?.id || null, createdBy: actorEmail, updatedBy: actorEmail, createdAt: serverTimestamp(), updatedAt: serverTimestamp() })
            addActivityToBatch(batch, actor, 'created', 'order', orderRef.id, row.name || 'İsimsiz sipariş', { source: 'spreadsheet', managerEmail: orderManagerEmail })
          })
          await batch.commit()
        }
        onSaved({ customerCount, orderCount: ledgerOrders.length })
        return
      }
      for (let index = 0; index < readyRows.length; index += 100) {
        const batch = writeBatch(db)
        readyRows.slice(index, index + 100).forEach((row) => {
          const customerRef = doc(collection(db, 'customers'))
          batch.set(customerRef, { displayName: row.displayName, email: row.email, whatsappName: row.whatsappName, assignedAdminEmail, createdBy: actorEmail, active: true, createdAt: serverTimestamp(), updatedAt: serverTimestamp() })
          batch.set(doc(db, 'access', row.email), { email: row.email, role: 'customer', customerId: customerRef.id, managerEmail: assignedAdminEmail, displayName: row.displayName, active: true, createdAt: serverTimestamp(), updatedAt: serverTimestamp() })
          addActivityToBatch(batch, actor, 'created', 'customer', customerRef.id, row.displayName, { source: 'spreadsheet', managerEmail: assignedAdminEmail })
        })
        await batch.commit()
      }
      onSaved({ customerCount: readyRows.length, orderCount: 0 })
    } catch (err) { setError(friendlyError(err)); setBusy(false) }
  }

  return <Modal title="Excel / CSV’den müşteri ve sipariş ekle" description="Tarih, İsim, Malzeme ve Ölçü sütunlarını otomatik tanır. Ölçüye 205x135 cm veya 2,40 m² yazabilirsiniz." onClose={onClose}><div className="import-modal">
    <label className="file-picker"><input type="file" accept=".xlsx,.csv" onChange={chooseFile} /><span className="button secondary">Dosya seç</span><b>{fileName || 'Dosya seçilmedi'}</b></label>
    {isOwner && (!ledgerOrders.length || creatingLedgerCustomer) && <label>Sorumlu yönetici<select value={managerEmail} onChange={(event) => setManagerEmail(event.target.value)}><option value={actorEmail}>Ben ({actor.displayName || actorEmail})</option>{admins.map((admin) => <option value={admin.id} key={admin.id}>{admin.displayName || admin.id}</option>)}</select></label>}
    {singleDraft && <div className="import-single-draft"><div className="import-draft-title"><Icon name="check" size={18} /><div><strong>Cari dosyası okundu</strong><span>{ledgerOrders.length ? `${ledgerOrders.length} satış satırı siparişe çevrilecek.` : 'Bulunan müşteri bilgisini kontrol edin.'}</span></div></div>{ledgerOrders.length > 0 && <label className="span-2">Siparişlerin bağlanacağı müşteri<select value={selectedCustomerId} onChange={(event) => setSelectedCustomerId(event.target.value)}><option value="__new__">Yeni müşteri oluştur: {singleDraft.displayName || 'Adsız müşteri'}</option>{customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.displayName}</option>)}</select></label>}{(!ledgerOrders.length || creatingLedgerCustomer) && <><label>Müşteri adı<input maxLength="120" value={singleDraft.displayName} onChange={(event) => setSingleDraft({ ...singleDraft, displayName: event.target.value })} /></label><label>Giriş yapacağı Google e-postası<input type="email" value={singleDraft.email} onChange={(event) => setSingleDraft({ ...singleDraft, email: event.target.value })} placeholder="user_0016@example.invalid" /></label><label>WhatsApp görüşme adı <small>(isteğe bağlı)</small><input maxLength="120" value={singleDraft.whatsappName} onChange={(event) => setSingleDraft({ ...singleDraft, whatsappName: event.target.value })} /></label></>}{draftValidation && <p>{draftValidation}</p>}</div>}
    {ledgerOrders.length > 0 && <div className="panel table-wrap import-preview ledger-preview"><table><thead><tr><th>Satır</th><th>Tarih</th><th>Sipariş adı</th><th>Malzeme</th><th>Ölçü / Alan</th></tr></thead><tbody>{ledgerOrders.slice(0, 12).map((row) => <tr key={row.rowNumber}><td>{row.rowNumber}</td><td>{formatDate(row.receivedAt, '—')}</td><td><strong>{row.name || '—'}</strong></td><td>{row.material || '—'}</td><td>{row.widthCm && row.heightCm ? `${row.widthCm} × ${row.heightCm} cm` : row.areaM2 ? `${row.areaM2.toLocaleString('tr-TR', { maximumFractionDigits: 2 })} m²` : '—'}</td></tr>)}</tbody></table>{ledgerOrders.length > 12 && <p className="simple-help">İlk 12 sipariş gösteriliyor. Toplam {ledgerOrders.length} sipariş eklenecek.</p>}<p className="simple-help">Boş bilgiler boş kalır; siparişe tıklayıp daha sonra tamamlayabilirsiniz.</p></div>}
    {result.valid.length > 0 && <div className="import-result"><div><strong>{result.valid.length}</strong><span>eklenmeye hazır</span></div><div><strong>{result.invalid.length}</strong><span>atlanacak satır</span></div></div>}
    {result.valid.length > 0 && <div className="panel table-wrap import-preview"><table><thead><tr><th>Satır</th><th>Müşteri</th><th>E-posta</th><th>WhatsApp adı</th></tr></thead><tbody>{result.valid.slice(0, 8).map((row) => <tr key={row.rowNumber}><td>{row.rowNumber}</td><td><strong>{row.displayName}</strong></td><td>{row.email}</td><td>{row.whatsappName}</td></tr>)}</tbody></table>{result.valid.length > 8 && <p className="simple-help">İlk 8 kayıt gösteriliyor. Toplam {result.valid.length} kayıt eklenecek.</p>}</div>}
    {result.invalid.length > 0 && <details className="invalid-rows"><summary>{result.invalid.length} satır neden atlanacak?</summary>{result.invalid.slice(0, 10).map((row) => <p key={row.rowNumber}>Satır {row.rowNumber}: {row.reason}</p>)}</details>}
    {error && <div className="alert alert-error">{error}</div>}
    <div className="form-actions"><button className="button secondary" type="button" onClick={onClose}>Vazgeç</button><button className="button primary" type="button" disabled={busy || !canSave} onClick={saveImport}>{busy ? 'Ekleniyor…' : ledgerOrders.length ? `${ledgerOrders.length} siparişi içe aktar` : `${readyRows.length || ''} müşteriyi ekle`}</button></div>
  </div></Modal>
}

function CustomerTransferModal({ customer, admins, orders, requests, actor, onClose, onSaved }) {
  const available = admins.filter((admin) => normalizeEmail(admin.id) !== normalizeEmail(customer.assignedAdminEmail))
  const [toEmail, setToEmail] = useState(available[0]?.id || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function submit(event) {
    event.preventDefault(); setBusy(true); setError('')
    try {
      if (!toEmail) throw new Error('Yönetici seçin.')
      const manager = admins.find((admin) => admin.id === toEmail)
      const relatedOrders = orders.filter((order) => order.customerId === customer.id)
      const relatedRequests = requests.filter((request) => request.customerId === customer.id)
      const transferRef = doc(db, 'customerTransfers', customerTransferId(customer.id, toEmail))
      const batch = writeBatch(db)
      batch.set(transferRef, { customerId: customer.id, customerName: customer.displayName, customerEmail: normalizeEmail(customer.email), fromEmail: normalizeEmail(actor.email), fromName: actor.displayName || actor.email, toEmail: normalizeEmail(toEmail), toName: manager?.displayName || toEmail, orderIds: relatedOrders.map((order) => order.id), requestIds: relatedRequests.map((request) => request.id), status: 'pending', createdAt: serverTimestamp(), updatedAt: serverTimestamp() })
      addActivityToBatch(batch, actor, 'transferred', 'customer', customer.id, customer.displayName, { toEmail })
      await batch.commit(); onSaved()
    } catch (err) { setError(friendlyError(err)); setBusy(false) }
  }
  return <Modal title="Müşteriyi yöneticiye gönder" description="Seçilen yönetici müşteriyi kabul ettiğinde müşteri ve tüm işleri onun listesine geçer." onClose={onClose}><form className="form-grid" onSubmit={submit}><div className="invite-summary span-2"><Icon name="customers" size={18} /><div><strong>{customer.displayName}</strong><span>{customer.email}</span></div></div><label className="span-2">Gönderilecek yönetici<select required value={toEmail} onChange={(event) => setToEmail(event.target.value)}><option value="">Yönetici seçin</option>{available.map((admin) => <option key={admin.id} value={admin.id}>{admin.displayName || admin.id}</option>)}</select></label><p className="simple-help span-2">{orders.filter((order) => order.customerId === customer.id).length} sipariş de müşteriyle birlikte aktarılır.</p>{error && <div className="alert alert-error span-2">{error}</div>}<div className="form-actions span-2"><button className="button secondary" type="button" onClick={onClose}>Vazgeç</button><button className="button primary" disabled={busy || !toEmail} type="submit">{busy ? 'Gönderiliyor…' : 'Yöneticiye gönder'}</button></div></form></Modal>
}

function adminInvitationMessage(admin) {
  return `Merhaba ${admin.displayName || ''},\n\nİzmirde Reklam Sipariş Takip yönetim paneline davet edildiniz:\n${CUSTOMER_APP_URL}\n\n“Google ile devam et” düğmesine basın ve ${admin.email || admin.id} hesabını seçin. Ek kurulum veya şifre oluşturmanız gerekmez.`
}

function AdminInvitationModal({ admin, onClose, notify }) {
  const message = adminInvitationMessage(admin)
  const email = admin.email || admin.id
  const mailHref = `mailto:${email}?subject=${encodeURIComponent('İzmirde Reklam Sipariş Takip yönetici daveti')}&body=${encodeURIComponent(message)}`
  async function copyInvite() { try { await copyText(message); notify('Yönetici daveti kopyalandı.') } catch { notify('Davet kopyalanamadı.') } }
  return <Modal title="Yönetici daveti hazır" description={`${admin.displayName || email} yönetim paneline giriş yapabilir.`} onClose={onClose}><div className="invite-content"><div className="invite-summary"><Icon name="check" size={18} /><div><strong>Yönetici hesabı bağlandı</strong><span>{email}</span></div></div><label>Davet mesajı<textarea className="invite-message" readOnly value={message} onFocus={(event) => event.target.select()} /></label><div className="form-actions"><button className="button secondary" type="button" onClick={copyInvite}><Icon name="copy" size={17} />Metni kopyala</button><a className="button primary" href={mailHref}><Icon name="mail" size={17} />E-posta hazırla</a></div></div></Modal>
}

function AdminModal({ item, accessList, currentEmail, actor, onClose, onSaved }) {
  const [form, setForm] = useState({ displayName: item?.displayName || '', email: item?.email || item?.id || '', role: item?.role || 'admin', active: item?.active !== false })
  const [busy, setBusy] = useState(false); const [error, setError] = useState('')
  async function submit(event) {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const email = normalizeEmail(form.email)
      const isCurrent = item?.id === normalizeEmail(currentEmail)
      const activeOwners = accessList.filter((entry) => entry.role === 'owner' && entry.active !== false)
      if (item?.role === 'owner' && activeOwners.length === 1 && (form.role !== 'owner' || !form.active)) throw new Error('last-owner')
      if (isCurrent && (form.role !== 'owner' || !form.active || email !== item.id)) throw new Error('current-owner')
      const batch = writeBatch(db)
      batch.set(doc(db, 'access', email), { email, role: form.role, displayName: form.displayName.trim(), active: form.active, updatedAt: serverTimestamp(), ...(item ? {} : { createdAt: serverTimestamp() }) }, { merge: true })
      if (item?.id && item.id !== email) batch.set(doc(db, 'access', item.id), { active: false, updatedAt: serverTimestamp() }, { merge: true })
      addActivityToBatch(batch, actor, item ? 'updated' : 'created', 'admin', email, form.displayName.trim())
      await batch.commit()
      onSaved({ id: email, email, displayName: form.displayName.trim(), role: form.role, active: form.active }, !item)
    } catch (err) { setError(err.message === 'last-owner' ? 'Son aktif ana yönetici pasifleştirilemez.' : err.message === 'current-owner' ? 'Kendi ana yönetici rolünüzü, durumunuzu veya e-postanızı değiştiremezsiniz.' : friendlyError(err)); setBusy(false) }
  }
  return <Modal title={item ? 'Yöneticiyi düzenle' : 'Yeni yönetici'} description="Yönetim paneline erişecek Google hesabını tanımlayın." onClose={onClose}><form onSubmit={submit} className="form-grid"><label className="span-2">Ad soyad<input required value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} /></label><label className="span-2">Google e-posta adresi<input required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label><label className="span-2">Rol<select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}><option value="admin">Yönetici</option><option value="owner">Ana Yönetici</option></select></label><label className="span-2 switch-row"><input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /><span><b>Hesap aktif</b><small>Pasif hesap yönetim paneline erişemez.</small></span></label>{error && <div className="alert alert-error span-2">{error}</div>}<div className="form-actions span-2"><button className="button secondary" type="button" onClick={onClose}>Vazgeç</button><button className="button primary" type="submit" disabled={busy}>{busy ? 'Kaydediliyor…' : 'Yöneticiyi kaydet'}</button></div></form></Modal>
}

function CustomerDashboard({ user, access }) {
  const [orders, setOrders] = useState([])
  const [customerSettings, setCustomerSettings] = useState({ showCostsToCustomer: true, canCreateOrderRequests: false, customerOrderCatalog: [] })
  const [deliverySettings, setDeliverySettings] = useState({ enabled: true, daysBefore: 3 })
  const [activeView, setActiveView] = useState('orders')
  const [filters, setFilters] = useState({ search: '', status: '', type: '', from: '', to: '', sort: 'newest' })
  const [showFilters, setShowFilters] = useState(false)
  const [error, setError] = useState('')
  const [requestModal, setRequestModal] = useState(null)
  const [orderRequestModal, setOrderRequestModal] = useState(false)
  const [detailOrder, setDetailOrder] = useState(null)
  const [toast, setToast] = useState('')
  useEffect(() => {
    if (!access.customerId) { setError('Müşteri hesabınız tamamlanmamış. Yöneticinizle iletişime geçin.'); return undefined }
    return onSnapshot(query(collection(db, 'orders'), where('customerId', '==', access.customerId)), (snap) => setOrders(sortOrdersNewest(snap.docs.map((item) => ({ id: item.id, ...item.data() })))), (err) => setError(friendlyError(err)))
  }, [access.customerId])
  useEffect(() => {
    if (!access.customerId) return undefined
    return onSnapshot(doc(db, 'customers', access.customerId), (snapshot) => setCustomerSettings(snapshot.exists() ? { showCostsToCustomer: true, canCreateOrderRequests: false, customerOrderCatalog: [], ...snapshot.data() } : { showCostsToCustomer: true, canCreateOrderRequests: false, customerOrderCatalog: [] }), (err) => setError(friendlyError(err)))
  }, [access.customerId])
  useEffect(() => { if (customerSettings.showCostsToCustomer === false && activeView === 'costs') setActiveView('orders') }, [activeView, customerSettings.showCostsToCustomer])
  useEffect(() => { if (!customerSettings.canCreateOrderRequests && orderRequestModal) setOrderRequestModal(false) }, [customerSettings.canCreateOrderRequests, orderRequestModal])
  useEffect(() => onSnapshot(doc(db, 'settings', 'deliveryReminders'), (snap) => setDeliverySettings(snap.exists() ? { enabled: true, daysBefore: 3, ...snap.data() } : { enabled: true, daysBefore: 3 }), (err) => setError(friendlyError(err))), [])
  const activeOrders = orders.filter((order) => !['Teslim Edildi', 'İptal Edildi'].includes(order.status))
  const dueSoon = useMemo(() => upcomingDeliveries(orders, deliverySettings), [orders, deliverySettings])
  const summary = useMemo(() => summarizeOrders(orders), [orders])
  const visibleOrders = useMemo(() => filterCustomerOrders(orders, filters), [orders, filters])
  const orderServices = useMemo(() => [...new Set(orders.map((order) => order.type).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'tr')), [orders])
  const hasFilters = Boolean(filters.search || filters.status || filters.type || filters.from || filters.to || filters.sort !== 'newest')
  function notify(message) { setToast(message); window.setTimeout(() => setToast(''), 2500) }
  function clearFilters() { setFilters({ search: '', status: '', type: '', from: '', to: '', sort: 'newest' }) }
  return <main className="customer-page">
    <header className="customer-header"><Brand /><div className="customer-account"><div><strong>{access.displayName || user.displayName}</strong><span>{user.email}</span></div><button className="button secondary compact" type="button" onClick={logout}><Icon name="logout" size={17} />Çıkış</button></div></header>
    {error && <div className="alert alert-error">{error}</div>}
    <section className="customer-orders">
      {dueSoon.length > 0 && <div className="delivery-warning"><Icon name="history" size={19} /><div><strong>{dueSoon.length} siparişinizin teslim tarihi yaklaşıyor</strong><span>{dueSoon.slice(0, 3).map((order) => `${order.name}: ${order.daysLeft === 0 ? 'bugün' : `${order.daysLeft} gün`}`).join(' · ')}</span></div></div>}
      <div className="customer-intro"><div><span className="eyebrow">Müşteri paneli</span><h1>Hoş geldiniz, {String(access.displayName || user.displayName || '').split(' ')[0]}</h1><p>Burada yalnızca size tanımlanan siparişler görünür.</p></div><div className="customer-intro-actions"><div><strong>{activeOrders.length}</strong><span>aktif sipariş</span></div>{customerSettings.canCreateOrderRequests && <button className="button primary compact" type="button" onClick={() => setOrderRequestModal(true)}><Icon name="plus" size={16} />Sipariş ekle</button>}</div></div>
      <div className="customer-tabs"><button className={activeView === 'orders' ? 'active' : ''} type="button" onClick={() => setActiveView('orders')}>Siparişlerim</button>{customerSettings.showCostsToCustomer !== false && <button className={activeView === 'costs' ? 'active' : ''} type="button" onClick={() => setActiveView('costs')}>Maliyetlerim</button>}<button className={activeView === 'reports' ? 'active' : ''} type="button" onClick={() => setActiveView('reports')}>Toplamlarım</button></div>
      {activeView === 'orders' ? <>
      <div className="customer-summary-grid">
        {[['Bekliyor', summary.waiting, 'amber'], ['Üretimde', summary.production, 'blue'], ['Hazır', summary.ready, 'green'], ['Acil', summary.urgent, 'red'], ['Bugün teslim', summary.dueToday, 'violet']].map(([label, value, tone]) => <article className={`customer-summary-card tone-${tone}`} key={label}><span>{label}</span><strong>{value}</strong><i /></article>)}
      </div>
      <div className="customer-search-panel">
        <label className="customer-search"><Icon name="search" size={18} /><input aria-label="Siparişlerde ara" placeholder="Sipariş adı veya açıklama ara…" value={filters.search} onChange={(event) => setFilters({ ...filters, search: event.target.value })} /></label>
        <button className={showFilters ? 'button secondary compact filter-toggle active' : 'button secondary compact filter-toggle'} type="button" onClick={() => setShowFilters((current) => !current)}><Icon name="settings" size={16} />Detaylı arama</button>
        {hasFilters && <button className="clear-filters" type="button" onClick={clearFilters}>Temizle</button>}
        {showFilters && <div className="customer-filters">
          <label>Durum<select value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value })}><option value="">Tüm durumlar</option>{ORDER_STATUSES.map((status) => <option key={status}>{status}</option>)}</select></label>
          <label>Hizmet<select value={filters.type} onChange={(event) => setFilters({ ...filters, type: event.target.value })}><option value="">Tüm hizmetler</option>{orderServices.map((type) => <option key={type}>{type}</option>)}</select></label>
          <label>Başlangıç tarihi<input type="date" value={filters.from} onChange={(event) => setFilters({ ...filters, from: event.target.value })} /></label>
          <label>Bitiş tarihi<input type="date" value={filters.to} onChange={(event) => setFilters({ ...filters, to: event.target.value })} /></label>
          <label>Sıralama<select value={filters.sort} onChange={(event) => setFilters({ ...filters, sort: event.target.value })}><option value="newest">En yeni</option><option value="oldest">En eski</option><option value="name-asc">Ada göre A–Z</option><option value="name-desc">Ada göre Z–A</option><option value="due">Teslim tarihine göre</option></select></label>
        </div>}
      </div>
      <div className="customer-orders-panel">
        {visibleOrders.length > 0 && <div className="customer-table-wrap"><table className="customer-table"><thead><tr><th>Sipariş</th><th>Hizmet</th><th>Geliş</th><th>Durum</th><th>Tahmini bitiş</th><th>Öncelik</th><th>İstek gönder</th></tr></thead><tbody>{visibleOrders.map((order) => <tr key={order.id}>
          <td data-label="Sipariş"><button className="order-name-button" type="button" onClick={() => setDetailOrder(order)}><strong>{order.name || 'İsim girilmedi'}</strong><span className="cell-note">{order.description || 'Açıklama yok'}</span></button></td>
          <td data-label="Hizmet">{order.type || 'Belirtilmedi'}</td>
          <td data-label="Geliş">{formatDate(order.receivedAt)}</td>
          <td data-label="Durum"><StatusBadge status={order.status} /></td>
          <td data-label="Tahmini bitiş">{formatDate(order.estimatedCompletion)}</td>
          <td data-label="Öncelik">{order.urgent ? <span className="urgent-pill">Acil</span> : <span className="muted">Normal</span>}</td>
          <td data-label="İstek gönder"><div className="customer-row-actions"><button type="button" onClick={() => setRequestModal({ order, type: 'urgent' })}>Aciliyet</button><button type="button" onClick={() => setRequestModal({ order, type: 'process_info' })}>Süreç bilgisi</button><button type="button" onClick={() => setRequestModal({ order, type: 'note' })}>Not gönder</button></div></td>
        </tr>)}</tbody></table></div>}
        {visibleOrders.length === 0 && <EmptyState title={orders.length ? 'Aramaya uygun sipariş yok' : 'Henüz sipariş yok'} text={orders.length ? 'Filtreleri temizleyerek tüm siparişlerinizi görebilirsiniz.' : 'Yeni siparişiniz oluşturulduğunda burada görünecek.'} />}
      </div>
      </> : activeView === 'costs' ? <CustomerCostsView orders={orders} /> : <ReportsView orders={orders} />}
    </section>
    {detailOrder && <OrderDetailsModal order={detailOrder} customer={{ displayName: access.displayName || user.displayName }} onClose={() => setDetailOrder(null)} />}
    {requestModal && <RequestModal {...requestModal} access={access} onClose={() => setRequestModal(null)} onSaved={() => { setRequestModal(null); notify('Talebiniz gönderildi.') }} />}
    {orderRequestModal && <CustomerOrderRequestModal access={access} catalog={customerSettings.customerOrderCatalog || []} onClose={() => setOrderRequestModal(false)} onSaved={() => { setOrderRequestModal(false); notify('Sipariş talebiniz yöneticiye gönderildi.') }} />}
    {toast && <div className="toast"><Icon name="check" />{toast}</div>}
  </main>
}

function CustomerCostsView({ orders }) {
  const rows = sortOrdersNewest(orders)
  const pricedRows = rows.filter((order) => Number(order.customerPriceAmount) > 0)
  const total = pricedRows.reduce((sum, order) => sum + Number(order.customerPriceAmount), 0)
  const totalArea = rows.reduce((sum, order) => sum + orderAreaM2(order), 0)
  return <section className="customer-costs-view">
    <div className="customer-cost-summary">
      <article><span>Hesaplanan sipariş</span><strong>{pricedRows.length}</strong><small>{rows.length} toplam sipariş</small></article>
      <article><span>Toplam ölçü</span><strong>{totalArea.toLocaleString('tr-TR', { maximumFractionDigits: 2 })} m²</strong><small>Ölçüsü bulunan siparişler</small></article>
      <article className="customer-cost-total"><span>Tahmini toplam ödeme</span><strong>{formatCurrency(total)}</strong><small>Yalnızca fiyatı hesaplanan siparişler</small></article>
    </div>
    <div className="panel customer-cost-panel"><div className="customer-cost-note"><strong>Size özel fiyat özeti</strong><span>Malzemenin alış fiyatı, döviz kuru ve kâr oranı gösterilmez. Dövizli ürünlerin gösterilen TL tutarı güncel kura göre yenilenir.</span></div><div className="table-wrap"><table className="customer-cost-table"><thead><tr><th>Sipariş</th><th>Malzeme + Hizmet</th><th>Ölçü / Miktar</th><th>Adet</th><th>Tarih</th><th>Ort. maliyet</th></tr></thead><tbody>{rows.map((order) => <tr key={order.id}><td data-label="Sipariş"><strong>{order.name || 'İsim girilmedi'}</strong></td><td data-label="Malzeme + Hizmet">{order.material || order.type || 'Belirtilmedi'}</td><td data-label="Ölçü / Miktar">{formatOrderMeasurement(order)}</td><td data-label="Adet">{order.calculationType === 'quantity' ? order.calculationQuantity || '—' : order.quantity || '—'}</td><td data-label="Tarih">{formatDate(order.receivedAt)}</td><td data-label="Ort. maliyet"><strong>{Number(order.customerPriceAmount) > 0 ? formatCurrency(order.customerPriceAmount) : 'Hesaplanmadı'}</strong></td></tr>)}</tbody></table>{rows.length === 0 && <EmptyState title="Henüz maliyet yok" text="Siparişleriniz fiyatlandırıldığında burada görünecek." />}</div></div>
  </section>
}

function CustomerOrderRequestModal({ access, catalog = [], onClose, onSaved }) {
  const materialOptions = catalog.filter((entry) => entry.itemType !== 'service')
  const serviceOptions = catalog.filter((entry) => entry.itemType === 'service')
  const [form, setForm] = useState({ name: '', materialId: '', serviceId: '', measurement: '', message: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function submit(event) {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const material = materialOptions.find((entry) => entry.id === form.materialId)
      const service = serviceOptions.find((entry) => entry.id === form.serviceId)
      if (!material && !service) throw new Error('catalog-selection-required')
      await addDoc(collection(db, 'requests'), { customerId: access.customerId, managerEmail: normalizeEmail(access.managerEmail), orderId: '', type: 'new_order', name: form.name.trim(), materialId: material?.id || '', material: material?.name || '', serviceId: service?.id || '', service: service?.name || '', measurement: form.measurement.trim(), message: form.message.trim(), status: 'open', createdAt: serverTimestamp(), updatedAt: serverTimestamp() })
      onSaved()
    } catch (err) { setError(err.message === 'catalog-selection-required' ? 'En az bir malzeme veya hizmet seçin.' : friendlyError(err)); setBusy(false) }
  }
  return <Modal title="Sipariş ekle" description="Yalnızca yöneticinizin size açtığı malzeme ve hizmetleri seçebilirsiniz." onClose={onClose}><form className="form-grid" onSubmit={submit}><label className="span-2">Sipariş adı<input required maxLength="240" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Örn. Mağaza tabelası" /></label>{catalog.length > 0 ? <><label>Malzeme<select value={form.materialId} onChange={(event) => setForm({ ...form, materialId: event.target.value })}><option value="">Malzeme seçin (isteğe bağlı)</option>{materialOptions.map((entry) => <option value={entry.id} key={entry.id}>{entry.label || entry.name}</option>)}</select></label><label>Hizmet<select value={form.serviceId} onChange={(event) => setForm({ ...form, serviceId: event.target.value })}><option value="">Hizmet seçin (isteğe bağlı)</option>{serviceOptions.map((entry) => <option value={entry.id} key={entry.id}>{entry.label || entry.name}</option>)}</select></label></> : <div className="alert span-2">Yöneticiniz henüz sipariş verebileceğiniz malzeme veya hizmet açmadı.</div>}<label className="span-2">Ölçü / adet <small>(isteğe bağlı)</small><input maxLength="100" value={form.measurement} onChange={(event) => setForm({ ...form, measurement: event.target.value })} placeholder="Örn. 120 × 80 cm, 2 adet" /></label><label className="span-2">Açıklama <small>(isteğe bağlı)</small><textarea maxLength="600" value={form.message} onChange={(event) => setForm({ ...form, message: event.target.value })} /></label>{error && <div className="alert alert-error span-2">{error}</div>}<div className="form-actions span-2"><button className="button secondary" type="button" onClick={onClose}>Vazgeç</button><button className="button primary" type="submit" disabled={busy || catalog.length === 0 || (!form.materialId && !form.serviceId)}>{busy ? 'Gönderiliyor…' : 'Yöneticiye gönder'}</button></div></form></Modal>
}

function RequestModal({ order, type, access, onClose, onSaved }) {
  const labels = { urgent: ['Aciliyet talebi', 'Siparişiniz için aciliyet gerekçenizi iletebilirsiniz.'], process_info: ['Süreç bilgisi iste', 'Ekibimizden güncel üretim bilgisi isteyin.'], note: ['Not gönder', 'Siparişinizle ilgili kısa bir not paylaşın.'] }
  const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('')
  async function submit(event) { event.preventDefault(); setBusy(true); setError(''); try { await addDoc(collection(db, 'requests'), { customerId: access.customerId, managerEmail: normalizeEmail(access.managerEmail), orderId: order.id, type, message: message.trim() || (type === 'urgent' ? 'Siparişimin önceliklendirilmesini rica ediyorum.' : type === 'process_info' ? 'Siparişimin güncel süreci hakkında bilgi rica ediyorum.' : ''), status: 'open', createdAt: serverTimestamp(), updatedAt: serverTimestamp() }); onSaved() } catch (err) { setError(friendlyError(err)); setBusy(false) } }
  return <Modal title={labels[type][0]} description={`${order.name} · ${labels[type][1]}`} onClose={onClose}><form onSubmit={submit} className="form-grid"><label className="span-2">Mesaj {type !== 'note' && <small>(isteğe bağlı)</small>}<textarea required={type === 'note'} maxLength="500" value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Kısa mesajınızı yazın…" /></label>{error && <div className="alert alert-error span-2">{error}</div>}<div className="form-actions span-2"><button className="button secondary" type="button" onClick={onClose}>Vazgeç</button><button className="button primary" type="submit" disabled={busy}>{busy ? 'Gönderiliyor…' : 'Talebi gönder'}</button></div></form></Modal>
}

export default App
