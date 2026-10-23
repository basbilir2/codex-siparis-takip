import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing'
import { collection, deleteDoc, doc, getDoc, getDocs, query, setDoc, updateDoc, where, writeBatch } from 'firebase/firestore'

let testEnv

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: 'demo-siparis-takip',
    firestore: { host: '127.0.0.1', port: 8080, rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') },
  })
})

afterAll(async () => testEnv.cleanup())
beforeEach(async () => testEnv.clearFirestore())

async function seed() {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore()
    await Promise.all([
      setDoc(doc(db, 'access', 'owner@example.com'), { email: 'owner@example.com', role: 'owner', active: true }),
      setDoc(doc(db, 'access', 'admin1@example.com'), { email: 'admin1@example.com', role: 'admin', active: true }),
      setDoc(doc(db, 'access', 'admin2@example.com'), { email: 'admin2@example.com', role: 'admin', active: true }),
      setDoc(doc(db, 'access', 'alice@example.com'), { email: 'alice@example.com', role: 'customer', active: true, customerId: 'alice', managerEmail: 'admin1@example.com' }),
      setDoc(doc(db, 'access', 'bob@example.com'), { email: 'bob@example.com', role: 'customer', active: true, customerId: 'bob', managerEmail: 'admin2@example.com' }),
      setDoc(doc(db, 'access', 'inactive@example.com'), { email: 'inactive@example.com', role: 'customer', active: false, customerId: 'inactive', managerEmail: 'admin1@example.com' }),
      setDoc(doc(db, 'customers', 'alice'), { displayName: 'Alice', email: 'alice@example.com', assignedAdminEmail: 'admin1@example.com', canCreateOrderRequests: true, allowedMaterialIds: ['pleksi'], allowedServiceIds: ['uv'], customerOrderCatalog: [{ id: 'pleksi', name: 'Pleksi', itemType: 'material' }, { id: 'uv', name: 'UV Baskı', itemType: 'service' }], active: true }),
      setDoc(doc(db, 'customers', 'bob'), { displayName: 'Bob', email: 'bob@example.com', assignedAdminEmail: 'admin2@example.com', active: true }),
      setDoc(doc(db, 'orders', 'alice-order'), { customerId: 'alice', managerEmail: 'admin1@example.com', name: 'Alice siparişi', status: 'Bekliyor' }),
      setDoc(doc(db, 'orders', 'bob-order'), { customerId: 'bob', managerEmail: 'admin2@example.com', name: 'Bob siparişi', status: 'Bekliyor' }),
      setDoc(doc(db, 'orderPrivate', 'alice-order'), { managerEmail: 'admin1@example.com', internalNote: 'gizli' }),
      setDoc(doc(db, 'customerPrivate', 'alice'), { managerEmail: 'admin1@example.com', whatsappNumber: '+90' }),
      setDoc(doc(db, 'requests', 'alice-request'), { customerId: 'alice', orderId: 'alice-order', managerEmail: 'admin1@example.com', type: 'note', status: 'open' }),
      setDoc(doc(db, 'publicTracking', 'secret-token'), { displayName: 'Hızlı müşteri', active: true }),
      setDoc(doc(db, 'publicTracking', 'secret-token', 'orders', 'quick-order'), { name: 'Hızlı sipariş', status: 'Bekliyor' }),
    ])
  })
}

function context(email) {
  return testEnv.authenticatedContext(`${email}-uid`, { email }).firestore()
}

describe('Firestore görev ve müşteri ayrımı', () => {
  it('müşteri yalnız kendi siparişini görür ve özel finans verisini göremez', async () => {
    await seed()
    const db = context('alice@example.com')
    await assertSucceeds(getDoc(doc(db, 'orders', 'alice-order')))
    await assertFails(getDoc(doc(db, 'orders', 'bob-order')))
    await assertFails(getDoc(doc(db, 'orderPrivate', 'alice-order')))
    await assertFails(updateDoc(doc(db, 'orders', 'alice-order'), { status: 'Hazır' }))
    const own = await assertSucceeds(getDocs(query(collection(db, 'orders'), where('customerId', '==', 'alice'))))
    expect(own.size).toBe(1)
    await assertFails(getDocs(collection(db, 'orders')))
  })

  it('müşteri yalnız kendi siparişi için kendi yöneticisine talep gönderir', async () => {
    await seed()
    const db = context('alice@example.com')
    await assertSucceeds(setDoc(doc(db, 'requests', 'new-request'), { customerId: 'alice', orderId: 'alice-order', managerEmail: 'admin1@example.com', type: 'urgent', status: 'open' }))
    await assertSucceeds(setDoc(doc(db, 'requests', 'new-order-request'), { customerId: 'alice', orderId: '', managerEmail: 'admin1@example.com', type: 'new_order', name: 'Yeni tabela', materialId: 'pleksi', material: 'Pleksi', serviceId: 'uv', service: 'UV Baskı', status: 'open' }))
    await assertFails(setDoc(doc(db, 'requests', 'unauthorized-catalog-request'), { customerId: 'alice', orderId: '', managerEmail: 'admin1@example.com', type: 'new_order', name: 'Yetkisiz tabela', materialId: 'dekota', material: 'Dekota', serviceId: '', service: '', status: 'open' }))
    await testEnv.withSecurityRulesDisabled(async (adminContext) => updateDoc(doc(adminContext.firestore(), 'customers', 'alice'), { canCreateOrderRequests: false }))
    await assertFails(setDoc(doc(db, 'requests', 'disabled-order-request'), { customerId: 'alice', orderId: '', managerEmail: 'admin1@example.com', type: 'new_order', name: 'Kapalı talep', materialId: 'pleksi', material: 'Pleksi', serviceId: '', service: '', status: 'open' }))
    await assertFails(setDoc(doc(db, 'requests', 'wrong-manager'), { customerId: 'alice', orderId: 'alice-order', managerEmail: 'admin2@example.com', type: 'urgent', status: 'open' }))
  })

  it('normal yönetici yalnız kendisine atanmış müşteriyi ve işleri görür', async () => {
    await seed()
    const db = context('admin1@example.com')
    await assertSucceeds(getDoc(doc(db, 'customers', 'alice')))
    await assertFails(getDoc(doc(db, 'customers', 'bob')))
    await assertSucceeds(getDoc(doc(db, 'orders', 'alice-order')))
    await assertFails(getDoc(doc(db, 'orders', 'bob-order')))
    await assertSucceeds(getDoc(doc(db, 'orderPrivate', 'alice-order')))
    const ownCustomers = await assertSucceeds(getDocs(query(collection(db, 'customers'), where('assignedAdminEmail', '==', 'admin1@example.com'))))
    expect(ownCustomers.docs.map((entry) => entry.id)).toEqual(['alice'])
    await assertFails(getDocs(collection(db, 'customers')))
    await assertFails(getDocs(collection(db, 'access')))
  })

  it('normal yönetici kendi müşterisini ve siparişini oluşturabilir, başkasına yazamaz', async () => {
    await seed()
    const db = context('admin1@example.com')
    const batch = writeBatch(db)
    batch.set(doc(db, 'customers', 'new-customer'), { displayName: 'Yeni', email: 'new@example.com', assignedAdminEmail: 'admin1@example.com' })
    batch.set(doc(db, 'access', 'new@example.com'), { email: 'new@example.com', role: 'customer', customerId: 'new-customer', managerEmail: 'admin1@example.com', active: true })
    await assertSucceeds(batch.commit())
    await assertSucceeds(setDoc(doc(db, 'orders', 'new-order'), { customerId: 'new-customer', managerEmail: 'admin1@example.com', name: 'Yeni sipariş' }))
    await assertFails(setDoc(doc(db, 'orders', 'rogue-order'), { customerId: 'bob', managerEmail: 'admin1@example.com', name: 'Yetkisiz' }))
  })

  it('ana yönetici tüm müşterileri ve yöneticileri görür; normal yönetici yönetici ayarlayamaz', async () => {
    await seed()
    const ownerDb = context('owner@example.com')
    const adminDb = context('admin1@example.com')
    expect((await assertSucceeds(getDocs(collection(ownerDb, 'customers')))).size).toBe(2)
    expect((await assertSucceeds(getDocs(collection(ownerDb, 'access')))).size).toBe(6)
    await assertSucceeds(setDoc(doc(ownerDb, 'access', 'new-admin@example.com'), { email: 'new-admin@example.com', role: 'admin', active: true }))
    await assertFails(setDoc(doc(adminDb, 'access', 'rogue-admin@example.com'), { email: 'rogue-admin@example.com', role: 'admin', active: true }))
    await assertFails(deleteDoc(doc(adminDb, 'access', 'admin2@example.com')))
  })

  it('ana yöneticinin gönderdiği müşteri alıcı yönetici kabul edince tüm kayıtlarıyla devrolur', async () => {
    await seed()
    const ownerDb = context('owner@example.com')
    const transferId = 'alice__admin2@example.com'
    await assertSucceeds(setDoc(doc(ownerDb, 'customerTransfers', transferId), { customerId: 'alice', customerName: 'Alice', customerEmail: 'alice@example.com', fromEmail: 'owner@example.com', toEmail: 'admin2@example.com', orderIds: ['alice-order'], requestIds: ['alice-request'], status: 'pending' }))
    const admin2Db = context('admin2@example.com')
    await assertSucceeds(getDoc(doc(admin2Db, 'customerTransfers', transferId)))
    const batch = writeBatch(admin2Db)
    batch.update(doc(admin2Db, 'customers', 'alice'), { assignedAdminEmail: 'admin2@example.com' })
    batch.update(doc(admin2Db, 'access', 'alice@example.com'), { managerEmail: 'admin2@example.com' })
    batch.update(doc(admin2Db, 'orders', 'alice-order'), { managerEmail: 'admin2@example.com' })
    batch.update(doc(admin2Db, 'orderPrivate', 'alice-order'), { managerEmail: 'admin2@example.com' })
    batch.update(doc(admin2Db, 'requests', 'alice-request'), { managerEmail: 'admin2@example.com' })
    batch.update(doc(admin2Db, 'customerTransfers', transferId), { status: 'accepted' })
    await assertSucceeds(batch.commit())
    await assertSucceeds(getDoc(doc(admin2Db, 'customers', 'alice')))
    await assertSucceeds(getDoc(doc(admin2Db, 'orders', 'alice-order')))
  })

  it('pasif hesap erişemez ve müşteri malzeme/çöp kutusunu kullanamaz', async () => {
    await seed()
    const inactiveDb = context('inactive@example.com')
    const aliceDb = context('alice@example.com')
    const adminDb = context('admin1@example.com')
    await assertFails(getDoc(doc(inactiveDb, 'orders', 'alice-order')))
    await assertFails(getDoc(doc(aliceDb, 'materials', 'pleksi')))
    await assertSucceeds(setDoc(doc(adminDb, 'exchangeRates', '2026-08-14'), { date: '2026-08-14', USD: 40.25 }))
    await assertFails(getDoc(doc(aliceDb, 'exchangeRates', '2026-08-14')))
    await assertFails(setDoc(doc(aliceDb, 'exchangeRates', '2026-08-14'), { USD: 1 }))
    await assertSucceeds(setDoc(doc(adminDb, 'materialTemplates', 'cnc'), { name: 'CNC', inputFields: ['area', 'minute'] }))
    await assertFails(getDoc(doc(aliceDb, 'materialTemplates', 'cnc')))
    await assertSucceeds(setDoc(doc(adminDb, 'materialGroups', 'baski'), { name: 'Baskı', category: 'service' }))
    await assertFails(getDoc(doc(aliceDb, 'materialGroups', 'baski')))
    await assertSucceeds(setDoc(doc(adminDb, 'settings', 'deliveryReminders'), { enabled: true, daysBefore: 3 }))
    await assertSucceeds(getDoc(doc(aliceDb, 'settings', 'deliveryReminders')))
    await assertFails(setDoc(doc(aliceDb, 'settings', 'deliveryReminders'), { enabled: false }))
    await assertFails(setDoc(doc(aliceDb, 'trash', 'fake'), { managerEmail: 'admin1@example.com' }))
  })

  it('yönetici yalnız kendi yedek ayarını ve kendi müşterisinin yedeğini yönetir', async () => {
    await seed()
    const admin1Db = context('admin1@example.com')
    const admin2Db = context('admin2@example.com')
    const aliceDb = context('alice@example.com')
    await assertSucceeds(setDoc(doc(admin1Db, 'backupSettings', 'admin1@example.com'), { enabled: true, intervalDays: 7, retentionDays: 90 }))
    await assertFails(setDoc(doc(admin1Db, 'backupSettings', 'admin2@example.com'), { enabled: false }))
    await assertSucceeds(setDoc(doc(admin1Db, 'customerBackups', 'alice-backup'), { customerId: 'alice', managerEmail: 'admin1@example.com', customerData: { displayName: 'Alice' } }))
    await assertFails(setDoc(doc(admin2Db, 'customerBackups', 'alice-rogue'), { customerId: 'alice', managerEmail: 'admin2@example.com', customerData: { displayName: 'Alice' } }))
    await assertFails(getDoc(doc(aliceDb, 'customerBackups', 'alice-backup')))
    await assertSucceeds(deleteDoc(doc(admin1Db, 'customerBackups', 'alice-backup')))
  })

  it('özel takip bağlantısı yalnız bilinen anahtardaki sade siparişleri gösterir', async () => {
    await seed()
    const guestDb = testEnv.unauthenticatedContext().firestore()
    await assertSucceeds(getDoc(doc(guestDb, 'publicTracking', 'secret-token')))
    expect((await assertSucceeds(getDocs(collection(guestDb, 'publicTracking', 'secret-token', 'orders')))).size).toBe(1)
    await assertFails(getDocs(collection(guestDb, 'publicTracking')))
    await assertFails(setDoc(doc(guestDb, 'publicTracking', 'secret-token', 'orders', 'rogue'), { name: 'Yetkisiz' }))
  })
})
