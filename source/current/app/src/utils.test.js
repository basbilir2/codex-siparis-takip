import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { calculateSalePrice, calculateSizedMaterialPrice, convertCurrency, customerTransferId, extractCustomerDraftFromWorkbook, extractOrderDraftsFromWorkbook, filterCustomerOrders, filterOrders, findCustomerImportRows, findInactiveOrders, findRedundantCustomerBackups, mapCustomerImportRows, matchesCustomerChat, materialCostPerM2, materialPriceInTry, normalizeEmail, orderAreaM2, orderFinance, parseMeasurementCell, parseProjectTitle, summarizeByMaterial, summarizeFinance, summarizeFinanceByCustomer, summarizeOrders, toDateInput } from './utils'

const require = createRequire(import.meta.url)
const desktopExtractor = require('../desktop-package/whatsapp-extractor.cjs')
const desktopOAuth = require('../desktop-package/desktop-oauth.cjs')

describe('sipariş yardımcıları', () => {
  it('e-postayı güvenli doküman kimliğine dönüştürür', () => {
    expect(normalizeEmail('  TEST@Example.COM ')).toBe('test@example.com')
    expect(customerTransferId('müşteri-1', ' YONETICI@Example.com ')).toBe('müşteri-1__yonetici@example.com')
  })

  it('Excel ve CSV müşteri satırlarını doğrular', () => {
    const result = mapCustomerImportRows([
      ['Müşteri adı', 'E-posta', 'WhatsApp adı'],
      ['AnonPerson_0005', 'AnonPerson_0002@example.com', 'AnonPerson_0005'],
      ['Eksik E-posta', '', 'Eksik'],
      ['Tekrar', 'AnonPerson_0002@example.com', 'Tekrar'],
      ['Kayıtlı', 'kayitli@example.com', 'Kayıtlı'],
    ], ['kayitli@example.com'])
    expect(result.valid).toHaveLength(1)
    expect(result.valid[0]).toMatchObject({ displayName: 'AnonPerson_0005', email: 'AnonPerson_0002@example.com' })
    expect(result.invalid.map((row) => row.reason)).toEqual([
      'Geçerli bir Google e-postası girilmemiş.',
      'Bu e-posta dosyada birden fazla kez bulunuyor.',
      'Bu e-posta sistemde zaten kayıtlı.',
    ])
  })

  it('yeni Excel okuyucusunun çok sayfalı sonucunda müşteri tablosunu bulur', () => {
    const rows = findCustomerImportRows([
      { sheet: 'Kapak', data: [['Müşteri listesi']] },
      { sheet: 'Müşteriler', data: [['Rapor'], ['Müşteri adı', 'E-posta'], ['AnonPerson_0006', 'arya@example.com']] },
    ])
    expect(rows).toEqual([['Müşteri adı', 'E-posta'], ['AnonPerson_0006', 'arya@example.com']])
  })

  it('cari Excel dosyasından müşteriyi bulur ve eksik e-postayı düzenlemeye bırakır', () => {
    expect(extractCustomerDraftFromWorkbook([
      { sheet: 'Cari_Bilgileri', data: [['ÜNVAN', 'AnonPerson_0006'], ['YETKİLİ AD SOYAD', null], ['E-POSTA', null]] },
    ])).toEqual({ displayName: 'AnonPerson_0006', email: '', whatsappName: 'AnonPerson_0006' })
  })

  it('cari Excel satışlarını Tarih, Grup, Açıklama ve Miktar alanlarından siparişe çevirir', () => {
    const drafts = extractOrderDraftsFromWorkbook([{ sheet: 'Cari', data: [
      ['AnonPerson_0006'],
      ['Tarih', 'Hareket', 'Grup', 'Açıklama', 'Miktar', 'Adet', 'Birim Fiyat'],
      [new Date('2026-04-13T00:00:00Z'), 'Satış', 'Folyo', 'Vitrin baskısı', 1.83, 4, 130],
      [new Date('2026-04-14T00:00:00Z'), 'Tahsilat', 'TAHSİLAT', '', 1, 1, 1],
      ['', 'Satış', 'Pleksi', '', '', 1, 400],
    ] }])
    expect(drafts).toHaveLength(2)
    expect(drafts[0]).toMatchObject({ rowNumber: 3, material: 'Folyo', name: 'Vitrin baskısı', areaM2: 1.83 })
    expect(drafts[1]).toMatchObject({ rowNumber: 5, material: 'Pleksi', name: '', areaM2: null, receivedAt: null })
  })

  it('Tarih, İsim, Malzeme ve Ölçü başlıklarını tanır; cm ölçüsünü en ve boya ayırır', () => {
    const drafts = extractOrderDraftsFromWorkbook([
      ['Tarih', 'İsim', 'Malzeme', 'Ölçü'],
      [new Date('2026-08-14T00:00:00Z'), 'Siyah pleksi', 'Siyah Pleksi', '205cm*135cm'],
      [new Date('2026-08-15T00:00:00Z'), 'UV örnek', 'UV Baskı', 2.4],
    ])
    expect(drafts[0]).toMatchObject({ name: 'Siyah pleksi', material: 'Siyah Pleksi', widthCm: 205, heightCm: 135, areaM2: null })
    expect(drafts[1]).toMatchObject({ name: 'UV örnek', material: 'UV Baskı', widthCm: null, heightCm: null, areaM2: 2.4 })
    expect(parseMeasurementCell('20 × 30 cm')).toEqual({ widthCm: 20, heightCm: 30, areaM2: null })
  })

  it('Excel miktarından gelen açık m² değerini ölçü hesabından önce kullanır', () => {
    expect(orderAreaM2({ areaM2: 1.83, widthCm: 100, heightCm: 100, quantity: 4 })).toBe(1.83)
  })

  it('özet kartlarını hesaplar', () => {
    const today = toDateInput(new Date())
    const orders = [
      { status: 'Bekliyor', urgent: true, estimatedCompletion: today },
      { status: 'Üretimde', urgent: false },
      { status: 'Hazır', urgent: true },
    ]
    expect(summarizeOrders(orders)).toEqual({ waiting: 1, production: 1, ready: 1, urgent: 2, dueToday: 1 })
  })

  it('arama ve filtreleri birlikte uygular', () => {
    const orders = [
      { id: 'a', customerId: 'c1', name: 'Mavi Pleksi', type: 'Pleksi', status: 'Bekliyor', urgent: true },
      { id: 'b', customerId: 'c2', name: 'Vitrin Folyo', type: 'Folyo Baskı', status: 'Üretimde', urgent: false },
    ]
    const customers = { c1: { displayName: 'Acme' }, c2: { displayName: 'Beta' } }
    expect(filterOrders(orders, { search: 'acme', urgent: 'urgent' }, customers).map((item) => item.id)).toEqual(['a'])
  })

  it('müşteri siparişlerini kategori, tarih ve harfe göre süzer', () => {
    const orders = [
      { id: 'z', name: 'Zemin Pleksi', type: 'Pleksi', status: 'Bekliyor', receivedAt: '2026-08-08' },
      { id: 'a', name: 'Askı Pleksi', type: 'Pleksi', status: 'Üretimde', receivedAt: '2026-08-09' },
      { id: 'f', name: 'Folyo Vitrin', type: 'Folyo Baskı', status: 'Bekliyor', receivedAt: '2026-07-01' },
    ]
    expect(filterCustomerOrders(orders, { type: 'Pleksi', from: '2026-08-01', sort: 'name-asc' }).map((item) => item.id)).toEqual(['a', 'z'])
    expect(filterCustomerOrders(orders, { search: 'vitrin' }).map((item) => item.id)).toEqual(['f'])
  })

  it('teslim edilenleri alta, en son teslim edileni teslim edilenlerin üstüne alır', () => {
    const orders = [
      { id: 'done-old', name: 'Eski teslim', status: 'Teslim Edildi', deliveredAt: '2026-08-10' },
      { id: 'active', name: 'Aktif', status: 'Bekliyor', receivedAt: '2026-08-01' },
      { id: 'done-new', name: 'Yeni teslim', status: 'Teslim Edildi', deliveredAt: '2026-08-14' },
    ]
    expect(filterCustomerOrders(orders, { sort: 'newest' }).map((item) => item.id)).toEqual(['active', 'done-new', 'done-old'])
  })

  it('üç gün hareket görmeyen açık siparişleri uyarır', () => {
    const orders = [
      { id: 'stale', status: 'Üretimde', statusChangedAt: '2026-08-10T12:00:00Z' },
      { id: 'fresh', status: 'Bekliyor', statusChangedAt: '2026-08-14T12:00:00Z' },
      { id: 'done', status: 'Teslim Edildi', statusChangedAt: '2026-08-01T12:00:00Z' },
    ]
    expect(findInactiveOrders(orders, { enabled: true, daysWithoutMovement: 3 }, new Date('2026-08-15T13:00:00Z')).map((item) => item.id)).toEqual(['stale'])
    expect(findInactiveOrders(orders, { enabled: false }, new Date('2026-08-15T13:00:00Z'))).toEqual([])
  })

  it('WhatsApp proje başlığından ölçü, tür ve adedi çıkarır', () => {
    expect(parseProjectTitle('Karşıyaka tabela | Pleksi | 120x80 cm | 3 adet')).toEqual({
      name: 'Karşıyaka tabela | Pleksi | 120x80 cm | 3 adet',
      type: 'Pleksi',
      widthCm: '120',
      heightCm: '80',
      quantity: '3',
    })
  })

  it('ek dosya adındaki proje bilgisini uzantısız çıkarır', () => {
    expect(parseProjectTitle('AnonPerson_0002 davetiye - DTF Baskı - 100x70 cm - 2 adet.pdf')).toEqual({
      name: 'AnonPerson_0002 davetiye - DTF Baskı - 100x70 cm - 2 adet',
      type: 'DTF Baskı',
      widthCm: '100',
      heightCm: '70',
      quantity: '2',
    })
  })

  it('WhatsApp görüşmesini kayıtlı AnonPerson_0002 müşterisiyle eşleştirir', () => {
    const customer = { displayName: 'AnonPerson_0005 - AnonPerson_0010', whatsappName: 'AnonPerson_0005' }
    expect(matchesCustomerChat(customer, 'AnonPerson_0005')).toBe(true)
    expect(matchesCustomerChat(customer, 'Kayıtsız Kişi')).toBe(false)
    expect(desktopExtractor.matchesAlias('AnonPerson_0005', 'AnonPerson_0005 - AnonPerson_0010')).toBe(true)
    expect(desktopExtractor.matchesAlias('\u200eBetül\u00a0Hanım\u200f', 'AnonPerson_0005 - AnonPerson_0010')).toBe(true)
  })

  it('masaüstü WhatsApp aktarımı son ekin dosya adını okur', () => {
    expect(desktopExtractor.attachmentNameFromValues([
      'PDF\nsıla - yaşar.pdf\n1 sayfa • PDF • 1 MB\nbunuda yarın alacaklarımla basabilirmiyiz',
    ])).toBe('sıla - yaşar.pdf')
    expect(desktopExtractor.projectKey('Sıla - Yaşar.PDF')).toBe(desktopExtractor.projectKey('sıla yaşar'))
    expect(desktopExtractor.sourceStampFromValues(['[13:27, 31.08.2026] AnonPerson_0005: '])).toBe('31.08.2026 13:27')
  })

  it('WhatsApp sağ tık menüsünde müşteri ekleme sipariş seçeneğinin hemen altındadır', () => {
    const source = readFileSync(new URL('../desktop-package/whatsapp-preload.cjs', import.meta.url), 'utf8')
    const orderIndex = source.indexOf("label: result.order?.enabled")
    const customerIndex = source.indexOf("label: result.customer?.enabled")
    const cancelIndex = source.indexOf("label: result.cancel?.enabled")
    expect(orderIndex).toBeGreaterThan(-1)
    expect(orderIndex).toBeLessThan(customerIndex)
    expect(customerIndex).toBeLessThan(cancelIndex)
  })

  it('masaüstü Google girişini sistem tarayıcısı ve PKCE ile hazırlar', () => {
    const url = new URL(desktopOAuth.buildAuthorizationUrl({
      clientId: 'desktop-client.apps.googleusercontent.com',
      redirectUri: 'http://127.0.0.1:41234/oauth2callback',
      state: 'guvenli-durum',
      challenge: 'pkce-challenge',
    }))
    expect(url.hostname).toBe('accounts.google.com')
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:41234/oauth2callback')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')).toBe('guvenli-durum')
  })

  it('masaüstü Google kodunu gizli anahtar göndermeden değiştirir', async () => {
    let sentBody = null
    const tokens = await desktopOAuth.exchangeAuthorizationCode({
      clientId: 'desktop-client.apps.googleusercontent.com',
      redirectUri: 'http://127.0.0.1:41234/oauth2callback',
      code: 'authorization-code',
      verifier: 'pkce-verifier',
      fetchImpl: async (_url, options) => {
        sentBody = new URLSearchParams(options.body)
        return { ok: true, json: async () => ({ access_token: 'access-token' }) }
      },
    })
    expect(tokens.accessToken).toBe('access-token')
    expect(sentBody.get('code_verifier')).toBe('pkce-verifier')
    expect(sentBody.has('client_secret')).toBe(false)
  })

  it('Google masaüstü istemci anahtarını token değişimine ekler', async () => {
    let sentBody = null
    await desktopOAuth.exchangeAuthorizationCode({
      clientId: 'desktop-client.apps.googleusercontent.com',
      clientSecret: 'desktop-public-secret',
      redirectUri: 'http://127.0.0.1:41234/oauth2callback',
      code: 'authorization-code',
      verifier: 'pkce-verifier',
      fetchImpl: async (_url, options) => {
        sentBody = new URLSearchParams(options.body)
        return { ok: true, json: async () => ({ access_token: 'access-token' }) }
      },
    })
    expect(sentBody.get('client_secret')).toBe('desktop-public-secret')
  })

  it('malzeme toplamlarını adet ve metrekare olarak hesaplar', () => {
    const rows = summarizeByMaterial([
      { type: 'Pleksi', material: 'Şeffaf Pleksi', widthCm: 100, heightCm: 50, quantity: 2 },
      { type: 'Pleksi', material: 'Şeffaf Pleksi', widthCm: 50, heightCm: 50, quantity: 1 },
    ])
    expect(rows[0]).toMatchObject({ material: 'Şeffaf Pleksi', orderCount: 2, quantity: 3, areaM2: 1.25 })
  })

  it('maliyetten hedef kâr oranıyla satış fiyatını hesaplar', () => {
    expect(calculateSalePrice(1000, 35)).toBe(1350)
    expect(orderFinance({ financeEnabled: true, costAmount: 1000, profitRate: 35 }))
      .toMatchObject({ sale: 1350, profit: 350 })
  })

  it('plaka ölçüsü ve alış fiyatından cm bazlı maliyet ile satış fiyatını hesaplar', () => {
    const costPerM2 = materialCostPerM2(205, 135, 3200)
    expect(costPerM2).toBeCloseTo(1156.2782, 4)
    expect(calculateSizedMaterialPrice(20, 30, 1, costPerM2, 30)).toEqual({ areaM2: 0.06, cost: 69.38, sale: 90.19, profit: 20.81 })
  })

  it('TL ve dövizli malzeme fiyatını kayıt gününün kuruyla TL olarak hesaplar', () => {
    expect(materialPriceInTry(3200, 'TRY')).toBe(3200)
    expect(materialPriceInTry(100, 'USD', 40.25)).toBe(4025)
    expect(materialPriceInTry(75, 'EUR', 47.5)).toBe(3562.5)
    expect(materialPriceInTry(100, 'USD', 0)).toBe(0)
  })

  it('farklı alış para birimlerini seçilen sistem para birimine çevirir', () => {
    const rates = { USD: 40, EUR: 50, GBP: 60 }
    expect(convertCurrency(5, 'USD', 'TRY', rates)).toBe(200)
    expect(convertCurrency(200, 'TRY', 'EUR', rates)).toBe(4)
    expect(convertCurrency(10, 'GBP', 'USD', rates)).toBe(15)
    expect(convertCurrency(10, 'USD', 'EUR', {})).toBeNull()
  })

  it('malzemenin m² maliyetinden sipariş fiyatını otomatik hesaplar', () => {
    const order = { material: '3 mm Pleksi', widthCm: 100, heightCm: 50, quantity: 2 }
    const materials = [{ name: '3 mm Pleksi', costPerM2: 400, profitRate: 25, active: true }]
    expect(orderFinance({}, order, materials)).toMatchObject({
      enabled: true,
      source: 'material',
      areaM2: 1,
      unitCost: 400,
      cost: 400,
      sale: 500,
      profit: 100,
    })
  })

  it('dövizli malzemede alış ve satış tarihinin kurlarını ayrı ayrı sabitler', () => {
    const order = { material: 'Dolar Pleksi', widthCm: 100, heightCm: 100, quantity: 1 }
    const materials = [{ name: 'Dolar Pleksi', calculationType: 'area', sheetWidthCm: 100, sheetHeightCm: 100, unitPrice: 100, currency: 'USD', profitRate: 25 }]
    expect(orderFinance({ pricingContext: { purchaseExchangeRate: 32, saleExchangeRate: 40 } }, order, materials)).toMatchObject({
      enabled: true,
      currency: 'USD',
      purchaseExchangeRate: 32,
      saleExchangeRate: 40,
      cost: 3200,
      sale: 5000,
      profit: 1800,
    })
  })

  it('dakika ile hesaplanan malzemede yalnız süreyi kullanır', () => {
    const order = { material: 'Tasarım', calculationQuantity: 90 }
    const materials = [{ name: 'Tasarım', calculationType: 'minute', unitPrice: 5, currency: 'TRY', profitRate: 20 }]
    expect(orderFinance({}, order, materials)).toMatchObject({ calculationType: 'minute', calculationQuantity: 90, unitLabel: 'dakika', cost: 450, sale: 540, profit: 90 })
  })

  it('aynı malzemede ölçü, dakika ve sabit işlem ücretini birlikte toplar', () => {
    const order = { material: 'CNC baskı ve kesim', widthCm: 100, heightCm: 50, quantity: 1, calculationValues: { minute: 20 } }
    const materials = [{ name: 'CNC baskı ve kesim', inputFields: ['area', 'minute', 'fixed'], priceComponents: { area: { sheetWidthCm: 100, sheetHeightCm: 100, unitPrice: 200 }, minute: { unitPrice: 5 }, fixed: { unitPrice: 50 } }, currency: 'TRY', profitRate: 20 }]
    expect(orderFinance({}, order, materials)).toMatchObject({ enabled: true, calculationType: 'combined', unitLabel: 'karma', cost: 250, sale: 300, profit: 50 })
  })

  it('tek siparişte seçilen malzeme ve hizmeti birlikte fiyatlandırır', () => {
    const order = { material: '5 mm Pleksi + UV Baskı', componentMaterialIds: ['pleksi-5', 'uv'], widthCm: 100, heightCm: 100, quantity: 1 }
    const materials = [
      { id: 'pleksi-5', name: 'Pleksi · 5 mm', itemType: 'material', inputFields: ['area'], priceComponents: { area: { sheetWidthCm: 100, sheetHeightCm: 100, unitPrice: 100 } }, currency: 'TRY', profitRate: 20 },
      { id: 'uv', name: 'Baskı · UV Baskı', itemType: 'service', inputFields: ['fixed'], priceComponents: { fixed: { unitPrice: 50 } }, currency: 'TRY', profitRate: 50 },
    ]
    expect(orderFinance({}, order, materials)).toMatchObject({ enabled: true, calculationType: 'combined', cost: 150, sale: 195, profit: 45 })
  })

  it('m² hizmet fiyatını cm ölçülerinden otomatik hesaplar', () => {
    const order = { material: 'UV Baskı', widthCm: 100, heightCm: 50, quantity: 2 }
    const materials = [{ name: 'UV Baskı', itemType: 'service', inputFields: ['area'], inputDefinitions: [{ key: 'area', label: 'Baskı alanı', unit: 'm²' }], priceComponents: { area: { unitPrice: 80, priceMode: 'perUnit' } }, currency: 'TRY', profitRate: 25 }]
    expect(orderFinance({}, order, materials)).toMatchObject({ enabled: true, areaM2: 1, cost: 80, sale: 100, profit: 20 })
  })

  it('fiyatı olmayan hizmet malzeme fiyatını engellemez', () => {
    const order = { material: 'Pleksi + Montaj', componentMaterialIds: ['pleksi', 'montaj'], widthCm: 100, heightCm: 100, quantity: 1 }
    const materials = [
      { id: 'pleksi', name: 'Pleksi', itemType: 'material', inputFields: ['area'], priceComponents: { area: { sheetWidthCm: 100, sheetHeightCm: 100, unitPrice: 100, priceMode: 'sheet' } }, currency: 'TRY', profitRate: 20 },
      { id: 'montaj', name: 'Montaj', itemType: 'service', inputFields: ['fixed'], priceComponents: { fixed: { unitPrice: null, priceMode: 'perUnit' } }, currency: 'TRY', profitRate: 0 },
    ]
    expect(orderFinance({}, order, materials)).toMatchObject({ enabled: true, cost: 100, sale: 120, unpricedComponents: ['Montaj'] })
  })

  it('fiyatı olmayan hizmete siparişe özel satış bedeli ekler', () => {
    const order = { material: 'Pleksi + Montaj', componentMaterialIds: ['pleksi', 'montaj'], widthCm: 100, heightCm: 100, quantity: 1 }
    const materials = [
      { id: 'pleksi', name: 'Pleksi', itemType: 'material', inputFields: ['area'], priceComponents: { area: { sheetWidthCm: 100, sheetHeightCm: 100, unitPrice: 100, priceMode: 'sheet' } }, currency: 'TRY', profitRate: 20 },
      { id: 'montaj', name: 'Montaj', itemType: 'service', inputFields: ['fixed'], priceComponents: { fixed: { unitPrice: null, priceMode: 'perUnit' } }, currency: 'TRY', profitRate: 0 },
    ]
    expect(orderFinance({ servicePriceOverrides: { montaj: 350 } }, order, materials)).toMatchObject({ enabled: true, cost: 100, sale: 470, profit: 370, unpricedComponents: [] })
  })

  it('döviz kurunu para birimi haritasından otomatik seçer', () => {
    const order = { material: 'Dolar Pleksi', widthCm: 100, heightCm: 100, quantity: 1 }
    const materials = [{ name: 'Dolar Pleksi', inputFields: ['area'], priceComponents: { area: { sheetWidthCm: 100, sheetHeightCm: 100, unitPrice: 100, priceMode: 'sheet' } }, currency: 'USD', profitRate: 25 }]
    expect(orderFinance({ pricingContext: { purchaseExchangeRates: { USD: 32 }, saleExchangeRates: { USD: 40 } } }, order, materials)).toMatchObject({ enabled: true, purchaseExchangeRate: 32, saleExchangeRate: 40, cost: 3200, sale: 5000 })
  })

  it('kullanıcının eklediği özel hesap alanını fiyatlandırır', () => {
    const order = { material: 'Kesim · Özel', calculationValues: { custom_tur: 4 } }
    const materials = [{ name: 'Kesim · Özel', inputFields: ['custom_tur'], customInputs: [{ id: 'custom_tur', label: 'Kesim turu', unit: 'tur' }], priceComponents: { custom_tur: { unitPrice: 25 } }, currency: 'TRY', profitRate: 20 }]
    expect(orderFinance({}, order, materials)).toMatchObject({ enabled: true, calculationType: 'custom_tur', calculationQuantity: 4, unitLabel: 'tur', cost: 100, sale: 120 })
  })

  it('özel alanları boş fiyatlı malzemeyi kayda uygun bırakır ama otomatik fiyat üretmez', () => {
    const order = { material: 'Özel ürün', calculationValues: { custom: 3 } }
    const materials = [{ name: 'Özel ürün', inputFields: ['custom'], customUnit: 'metre', priceComponents: { custom: { unitPrice: null } }, currency: 'TRY', profitRate: 20 }]
    expect(orderFinance({}, order, materials)).toMatchObject({ enabled: false, calculationType: 'custom', calculationQuantity: 0, unitLabel: 'karma' })
  })

  it('siparişe özel elle fiyat malzeme fiyatının önüne geçer', () => {
    const order = { material: 'Pleksi', widthCm: 100, heightCm: 100, quantity: 1 }
    const materials = [{ name: 'Pleksi', costPerM2: 400, profitRate: 25 }]
    expect(orderFinance({ financeEnabled: true, costAmount: 700, profitRate: 10 }, order, materials))
      .toMatchObject({ source: 'manual', cost: 700, sale: 770, profit: 70 })
  })

  it('sipariş oluşturulurken alınan otomatik fiyat görüntüsünü sonradan değişen malzeme fiyatından korur', () => {
    const privateData = { automaticPriceSnapshot: { costAmount: 100, saleAmount: 130, profitRate: 30, areaM2: 0.5, costPerM2: 200 } }
    const changedMaterials = [{ name: 'Pleksi', costPerM2: 900, profitRate: 80 }]
    expect(orderFinance(privateData, { material: 'Pleksi', widthCm: 100, heightCm: 50 }, changedMaterials))
      .toMatchObject({ source: 'material', cost: 100, sale: 130, profit: 30, areaM2: 0.5, unitCost: 200 })
  })

  it('dövizli eski siparişi en güncel kurla yeniden hesaplar', () => {
    const order = { material: 'Dolar Pleksi', widthCm: 100, heightCm: 100, quantity: 1 }
    const materials = [{ name: 'Dolar Pleksi', inputFields: ['area'], priceComponents: { area: { sheetWidthCm: 100, sheetHeightCm: 100, unitPrice: 5, priceMode: 'sheet' } }, currency: 'USD', profitRate: 20 }]
    const privateData = { automaticPriceSnapshot: { costAmount: 150, saleAmount: 180, profitRate: 20, currency: 'USD', purchaseExchangeRate: 30, saleExchangeRate: 30, areaM2: 1, costPerM2: 150 } }
    expect(orderFinance(privateData, order, materials, { currentExchangeRates: { TRY: 1, USD: 42 } }))
      .toMatchObject({ enabled: true, currency: 'USD', purchaseExchangeRate: 42, saleExchangeRate: 42, areaM2: 1, cost: 210, sale: 252, profit: 42 })
  })

  it('eski malzeme yazımını ana başlık ve model adından tanır', () => {
    const order = { material: 'Dekota 5mm', widthCm: 100, heightCm: 50, quantity: 1 }
    const materials = [{ name: 'Dekota · 5 mm', groupName: 'Dekota', variantName: '5mm', costPerM2: 100, profitRate: 30, currency: 'TRY' }]
    expect(orderFinance({}, order, materials, { currentExchangeRates: { TRY: 1 } }))
      .toMatchObject({ enabled: true, areaM2: 0.5, cost: 50, sale: 65 })
  })

  it('fiyat kaydı olmayan eski siparişte güncel kur hesabı hata vermez', () => {
    expect(orderFinance({ automaticPriceSnapshot: null }, { material: 'Bilinmeyen', widthCm: 50, heightCm: 30 }, [], { currentExchangeRates: { TRY: 1, USD: 42 } }))
      .toMatchObject({ enabled: false, areaM2: 0.15, sale: 0 })
  })

  it('finans toplamını fiyatlı siparişlerden çıkarır, fiyatı eksik siparişleri müşteri hacminde korur', () => {
    const orders = [{ id: 'a', customerId: 'c1' }, { id: 'b', customerId: 'c1' }, { id: 'c', customerId: 'c2' }]
    const privateMap = {
      a: { financeEnabled: true, costAmount: 100, profitRate: 50, saleAmount: 150, paidAmount: 50 },
      b: { financeEnabled: false },
      c: { financeEnabled: true, costAmount: 200, profitRate: 25, saleAmount: 250, paidAmount: 250 },
    }
    expect(summarizeFinance(orders, privateMap)).toEqual({ orderCount: 2, missingPriceCount: 1, cost: 300, sale: 400, profit: 100 })
    expect(summarizeFinanceByCustomer(orders, privateMap, { c1: { displayName: 'A' }, c2: { displayName: 'B' } }))
      .toMatchObject([{ customerId: 'c2', orderCount: 1, pricedOrderCount: 1, sale: 250 }, { customerId: 'c1', orderCount: 2, pricedOrderCount: 1, sale: 150 }])
  })

  it('otomatik musteri yedeginde ayni donemin tekrarlarini ve suresi dolanlari temizler', () => {
    const now = new Date('2026-08-14T20:00:00Z').getTime()
    const backups = [
      { id: 'latest-a', customerId: 'a', createdBy: 'owner@example.com', createdAt: new Date('2026-08-14T19:00:00Z') },
      { id: 'duplicate-a', customerId: 'a', createdBy: 'owner@example.com', createdAt: new Date('2026-08-14T18:00:00Z') },
      { id: 'latest-b', customerId: 'b', createdBy: 'owner@example.com', createdAt: new Date('2026-08-14T19:00:00Z') },
      { id: 'expired-a', customerId: 'a', createdBy: 'owner@example.com', createdAt: new Date('2026-04-01T10:00:00Z') },
      { id: 'other-admin', customerId: 'a', createdBy: 'admin@example.com', createdAt: new Date('2026-08-14T18:00:00Z') },
    ]
    expect(findRedundantCustomerBackups(backups, 'owner@example.com', 7, 90, now).map((item) => item.id).sort())
      .toEqual(['duplicate-a', 'expired-a'])
  })

})
