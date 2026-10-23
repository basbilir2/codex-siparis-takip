export const ORDER_STATUSES = ['Bekliyor', 'Üretimde', 'Hazır', 'Teslim Edildi', 'İptal Edildi']
export const ORDER_TYPES = ['Pleksi', 'UV Baskı', 'Folyo Baskı', 'DTF Baskı', 'Diğer']

export function normalizeText(value = '') {
  return String(value)
    .trim()
    .toLocaleLowerCase('tr-TR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

export function matchesCustomerChat(customer = {}, chat = '') {
  const normalizedChat = normalizeText(chat).replace(/[^a-z0-9çğıöşü]+/g, ' ').trim()
  if (!normalizedChat) return false
  return [customer.displayName, customer.whatsappName].filter(Boolean).some((alias) => {
    const normalizedAlias = normalizeText(alias).replace(/[^a-z0-9çğıöşü]+/g, ' ').trim()
    if (!normalizedAlias) return false
    if (normalizedChat === normalizedAlias) return true
    const chatDigits = normalizedChat.replace(/\D/g, '')
    const aliasDigits = normalizedAlias.replace(/\D/g, '')
    if (chatDigits.length >= 10 && aliasDigits.length >= 10) return chatDigits.slice(-10) === aliasDigits.slice(-10)
    const chatTokens = normalizedChat.split(/\s+/).filter(Boolean)
    const aliasTokens = normalizedAlias.split(/\s+/).filter(Boolean)
    return chatTokens.length >= 2 && chatTokens.every((token) => aliasTokens.includes(token))
  })
}

export function parseProjectTitle(value = '', knownTypes = ORDER_TYPES) {
  const rawTitle = String(value).replace(/\s+/g, ' ').trim().slice(0, 240)
  const title = rawTitle.replace(/\.(?:pdf|ai|cdr|eps|svg|psd|png|jpe?g|tiff?|webp|zip|rar|docx?|xlsx?)$/i, '').trim()
  const size = title.match(/(\d+(?:[.,]\d+)?)\s*[x×*]\s*(\d+(?:[.,]\d+)?)\s*(mm|cm|m)?/i)
  const quantity = title.match(/(?:^|\s)(\d+)\s*(?:adet|ad\.?)(?:\s|$)/i)
  const normalizedTitle = normalizeText(title)
  const type = knownTypes.find((item) => normalizedTitle.includes(normalizeText(item))) || 'Diğer'
  let widthCm = ''
  let heightCm = ''
  if (size) {
    const unit = (size[3] || 'cm').toLocaleLowerCase('tr-TR')
    const multiplier = unit === 'mm' ? 0.1 : unit === 'm' ? 100 : 1
    widthCm = String(Number(size[1].replace(',', '.')) * multiplier)
    heightCm = String(Number(size[2].replace(',', '.')) * multiplier)
  }
  return { name: title, type, widthCm, heightCm, quantity: quantity?.[1] || '1' }
}

export function orderAreaM2(order = {}) {
  const explicitArea = Number(order.areaM2)
  if (Number.isFinite(explicitArea) && explicitArea > 0) return explicitArea
  const width = Number(order.widthCm) || 0
  const height = Number(order.heightCm) || 0
  const quantity = Math.max(1, Number(order.quantity) || 1)
  return width * height * quantity / 10000
}

export function calculateSalePrice(costAmount, profitRate) {
  const cost = Math.max(0, Number(costAmount) || 0)
  const rate = Math.max(0, Number(profitRate) || 0)
  return Math.round(cost * (1 + rate / 100) * 100) / 100
}

export function materialPriceInTry(amount, currency = 'TRY', exchangeRate = 1) {
  const price = Math.max(0, Number(amount) || 0)
  const normalizedCurrency = String(currency || 'TRY').trim().toUpperCase()
  if (normalizedCurrency === 'TRY') return price
  const rate = Math.max(0, Number(exchangeRate) || 0)
  return rate > 0 ? Math.round(price * rate * 10000) / 10000 : 0
}

export function convertCurrency(amount, fromCurrency = 'TRY', toCurrency = 'TRY', exchangeRates = {}) {
  const value = Number(amount)
  if (!Number.isFinite(value)) return null
  const from = String(fromCurrency || 'TRY').trim().toUpperCase()
  const to = String(toCurrency || 'TRY').trim().toUpperCase()
  if (from === to) return roundMoney(value)
  const fromRate = from === 'TRY' ? 1 : Math.max(0, Number(exchangeRates?.[from]) || 0)
  const toRate = to === 'TRY' ? 1 : Math.max(0, Number(exchangeRates?.[to]) || 0)
  if (fromRate <= 0 || toRate <= 0) return null
  return roundMoney(value * fromRate / toRate)
}

export function materialUsage(order = {}, calculationType = 'area') {
  const type = String(calculationType || 'area')
  if (type === 'minute' || type === 'weight') return Math.max(0, Number(order.calculationQuantity) || 0)
  if (type === 'quantity') return Math.max(0, Number(order.calculationQuantity ?? order.quantity) || 0)
  return orderAreaM2(order)
}

export function materialUnitPrice(material = {}) {
  const type = String(material.calculationType || 'area')
  if (type !== 'area') return Math.max(0, Number(material.unitPrice ?? material.sheetCost) || 0)
  const width = Math.max(0, Number(material.sheetWidthCm) || 0)
  const height = Math.max(0, Number(material.sheetHeightCm) || 0)
  const price = Math.max(0, Number(material.unitPrice ?? material.sheetCost) || 0)
  const areaM2 = width * height / 10000
  if (areaM2 > 0 && price > 0) return Math.round(price / areaM2 * 10000) / 10000
  return material.currency === 'TRY' || !material.currency ? Math.max(0, Number(material.costPerM2) || 0) : 0
}

export function materialCostPerM2(widthCm, heightCm, totalCost) {
  const width = Math.max(0, Number(widthCm) || 0)
  const height = Math.max(0, Number(heightCm) || 0)
  const cost = Math.max(0, Number(totalCost) || 0)
  const areaM2 = width * height / 10000
  return areaM2 > 0 && cost > 0 ? Math.round(cost / areaM2 * 10000) / 10000 : 0
}

export function calculateSizedMaterialPrice(widthCm, heightCm, quantity, costPerM2, profitRate) {
  const areaM2 = orderAreaM2({ widthCm, heightCm, quantity })
  const cost = Math.round(areaM2 * Math.max(0, Number(costPerM2) || 0) * 100) / 100
  const sale = calculateSalePrice(cost, profitRate)
  return { areaM2, cost, sale, profit: Math.round((sale - cost) * 100) / 100 }
}

export function parseMeasurementCell(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return { widthCm: null, heightCm: null, areaM2: null }
  const dimension = raw.match(/(\d+(?:[.,]\d+)?)\s*(mm|cm|m)?\s*[x×*]\s*(\d+(?:[.,]\d+)?)\s*(mm|cm|m)?/i)
  if (dimension) {
    const firstUnit = (dimension[2] || dimension[4] || 'cm').toLocaleLowerCase('tr-TR')
    const secondUnit = (dimension[4] || dimension[2] || 'cm').toLocaleLowerCase('tr-TR')
    const multiplier = (unit) => unit === 'mm' ? 0.1 : unit === 'm' ? 100 : 1
    const widthCm = Number(dimension[1].replace(',', '.')) * multiplier(firstUnit)
    const heightCm = Number(dimension[3].replace(',', '.')) * multiplier(secondUnit)
    return { widthCm, heightCm, areaM2: null }
  }
  const parsedArea = Number(raw.replace(/\s*m(?:²|2)?\s*$/i, '').replace(',', '.'))
  return { widthCm: null, heightCm: null, areaM2: Number.isFinite(parsedArea) && parsedArea > 0 ? parsedArea : null }
}

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100
}

function configuredMaterialFields(material = {}) {
  const allowed = new Set(['area', 'minute', 'weight', 'quantity', 'fixed', 'thickness', 'custom'])
  const customKeys = new Set((Array.isArray(material.customInputs) ? material.customInputs : []).map((item) => item.id))
  const fields = Array.isArray(material.inputFields) ? material.inputFields.filter((key) => allowed.has(key) || customKeys.has(key)) : []
  return fields.length ? [...new Set(fields)] : [allowed.has(material.calculationType) ? material.calculationType : 'area']
}

function isSquareMeterUnit(unit = '') {
  return ['m²', 'm2', 'metrekare'].includes(normalizeText(unit).replace(/\s+/g, ''))
}

function componentUsage(order = {}, key, material = {}) {
  if (key === 'area') return isSquareMeterUnit(componentUnit(key, material)) ? orderAreaM2(order) : Math.max(0, Number(order.calculationValues?.area ?? order.calculationQuantity) || 0)
  if (key === 'fixed') return 1
  if (key === 'quantity') return Math.max(0, Number(order.calculationValues?.quantity ?? order.calculationQuantity ?? order.quantity) || 0)
  return Math.max(0, Number(order.calculationValues?.[key] ?? (order.calculationType === key ? order.calculationQuantity : 0)) || 0)
}

function componentUnit(key, material = {}) {
  const configured = (Array.isArray(material.inputDefinitions) ? material.inputDefinitions : []).find((item) => item.key === key)?.unit
  if (configured) return configured
  if (key === 'area') return 'm²'
  if (key === 'minute') return 'dakika'
  if (key === 'weight') return 'kg'
  if (key === 'quantity') return 'adet'
  if (key === 'fixed') return 'işlem'
  if (key === 'thickness') return 'mm'
  return (Array.isArray(material.customInputs) ? material.customInputs : []).find((item) => item.id === key)?.unit || material.customUnit || 'birim'
}

function pricingRate(pricing = {}, currency = 'TRY', phase = 'purchase') {
  if (currency === 'TRY') return 1
  const map = phase === 'sale' ? pricing.saleExchangeRates : pricing.purchaseExchangeRates
  const single = phase === 'sale' ? pricing.saleExchangeRate : pricing.purchaseExchangeRate
  return Math.max(0, Number(map?.[currency] ?? single) || 0)
}

function materialMatchesOrder(material = {}, orderMaterial = '') {
  const compact = (value) => normalizeText(value).replace(/[^a-z0-9çğıöşü]+/g, '')
  const target = compact(orderMaterial)
  if (!target) return false
  return [
    material.name,
    `${material.groupName || ''} ${material.variantName || ''}`,
    `${material.variantName || ''} ${material.groupName || ''}`,
  ].some((alias) => compact(alias) === target)
}

function calculateOrderFinance(privateData = {}, order = {}, materials = []) {
  let source = 'manual'
  let cost = 0
  let rate = 0
  let sale = 0
  let areaM2 = orderAreaM2(order)
  let unitCost = 0
  let calculationType = 'area'
  let calculationQuantity = areaM2
  let unitLabel = 'm²'
  let currency = 'TRY'
  let purchaseExchangeRate = 1
  let saleExchangeRate = 1
  let components = []
  let unpricedComponents = []

  if (privateData.financeEnabled) {
    cost = Math.max(0, Number(privateData.costAmount) || 0)
    rate = Math.max(0, Number(privateData.profitRate) || 0)
    sale = Math.max(0, Number(privateData.saleAmount) || calculateSalePrice(cost, rate))
  } else if (privateData.automaticPriceSnapshot && Number(privateData.automaticPriceSnapshot.saleAmount) > 0) {
    const snapshot = privateData.automaticPriceSnapshot
    source = 'material'
    cost = Math.max(0, Number(snapshot.costAmount) || 0)
    rate = Math.max(0, Number(snapshot.profitRate) || 0)
    sale = Math.max(0, Number(snapshot.saleAmount) || calculateSalePrice(cost, rate))
    areaM2 = Math.max(0, Number(snapshot.areaM2) || areaM2)
    unitCost = Math.max(0, Number(snapshot.costPerM2) || 0)
    calculationType = snapshot.calculationType || 'area'
    calculationQuantity = Math.max(0, Number(snapshot.calculationQuantity) || areaM2)
    unitLabel = snapshot.unitLabel || (calculationType === 'minute' ? 'dakika' : calculationType === 'weight' ? 'kg' : calculationType === 'quantity' ? 'adet' : 'm²')
    currency = snapshot.currency || 'TRY'
    purchaseExchangeRate = Math.max(0, Number(snapshot.purchaseExchangeRate) || (currency === 'TRY' ? 1 : 0))
    saleExchangeRate = Math.max(0, Number(snapshot.saleExchangeRate) || purchaseExchangeRate)
    if (Array.isArray(snapshot.components)) components = snapshot.components
    if (Array.isArray(snapshot.unpricedComponents)) unpricedComponents = snapshot.unpricedComponents
  } else {
    const material = materials.find((item) => item.active !== false && materialMatchesOrder(item, order.material || order.type))
    const componentIds = Array.isArray(order.componentMaterialIds) && order.componentMaterialIds.length > 0
      ? order.componentMaterialIds
      : material?.kind === 'composite' && Array.isArray(material.componentMaterialIds) ? material.componentMaterialIds : []
    if (componentIds.length) {
      const children = componentIds.map((id) => materials.find((item) => item.id === id && item.active !== false && item.kind !== 'composite')).filter(Boolean)
      const servicePriceOverrides = privateData.servicePriceOverrides || {}
      const childResults = children.map((child) => {
        const hasServiceOverride = child.itemType === 'service' && Object.prototype.hasOwnProperty.call(servicePriceOverrides, child.id) && servicePriceOverrides[child.id] !== null && servicePriceOverrides[child.id] !== '' && Number.isFinite(Number(servicePriceOverrides[child.id])) && Number(servicePriceOverrides[child.id]) >= 0
        if (!hasServiceOverride) return { child, finance: calculateOrderFinance({ pricingContext: privateData.pricingContext || {} }, { ...order, material: child.name, componentMaterialIds: [] }, materials) }
        const serviceSale = roundMoney(Number(servicePriceOverrides[child.id]))
        return { child, finance: { enabled: true, source: 'service-override', cost: 0, rate: 0, sale: serviceSale, profit: serviceSale, areaM2: 0, unitCost: 0, calculationType: 'fixed', calculationQuantity: 1, unitLabel: 'işlem', currency: 'TRY', purchaseExchangeRate: 1, saleExchangeRate: 1, components: [{ key: 'service-override', label: 'Projeye özel hizmet bedeli', unit: 'işlem', quantity: 1, sourceUnitPrice: 0, sourceAmount: 0, cost: 0, saleBase: serviceSale }] } }
      })
      const pricedChildResults = childResults.filter((entry) => entry.finance.enabled)
      if (children.length !== componentIds.length || pricedChildResults.length === 0) {
        return { enabled: false, source: 'none', cost: 0, rate: 0, sale: 0, profit: 0, areaM2, unitCost: 0, calculationType: 'combined', calculationQuantity: 0, unitLabel: 'karma', currency: 'TRY', purchaseExchangeRate: 1, saleExchangeRate: 1, components: childResults.flatMap(({ child, finance }) => (finance.components || []).map((entry) => ({ ...entry, sourceName: child.name, sourceType: child.itemType || 'material' }))) }
      }
      cost = roundMoney(pricedChildResults.reduce((sum, entry) => sum + entry.finance.cost, 0))
      sale = roundMoney(pricedChildResults.reduce((sum, entry) => sum + entry.finance.sale, 0))
      components = pricedChildResults.flatMap(({ child, finance }) => (finance.components || [{ quantity: finance.calculationQuantity, unit: finance.unitLabel }]).map((entry) => ({ ...entry, sourceName: child.name, sourceType: child.itemType || 'material' })))
      const only = pricedChildResults.length === 1 ? pricedChildResults[0].finance : null
      const unpricedComponents = childResults.filter((entry) => !entry.finance.enabled).map((entry) => entry.child.name)
      return { enabled: true, source: 'material', cost, rate: cost > 0 ? Math.round(((sale - cost) / cost) * 10000) / 100 : 0, sale, profit: roundMoney(sale - cost), areaM2, unitCost: only?.unitCost || 0, calculationType: only?.calculationType || 'combined', calculationQuantity: only?.calculationQuantity ?? components.reduce((sum, entry) => sum + (Number(entry.quantity) || 0), 0), unitLabel: only?.unitLabel || 'karma', currency: only?.currency || 'TRY', purchaseExchangeRate: only?.purchaseExchangeRate || 1, saleExchangeRate: only?.saleExchangeRate || 1, components, unpricedComponents }
    }
    const configuredFields = configuredMaterialFields(material)
    if (material?.priceComponents && configuredFields.length) {
      currency = String(material.currency || 'TRY').toUpperCase()
      const pricing = privateData.pricingContext || {}
      purchaseExchangeRate = pricingRate(pricing, currency, 'purchase')
      saleExchangeRate = pricingRate(pricing, currency, 'sale')
      rate = Math.max(0, Number(material.profitRate) || 0)
      components = configuredFields.map((key) => {
        const config = material.priceComponents?.[key] || {}
        const quantity = componentUsage(order, key, material)
        const sourceUnitPrice = key === 'area' && material.itemType !== 'service' && config.priceMode !== 'perUnit' ? materialCostPerM2(config.sheetWidthCm ?? material.sheetWidthCm, config.sheetHeightCm ?? material.sheetHeightCm, config.unitPrice) : Math.max(0, Number(config.unitPrice) || 0)
        const custom = (Array.isArray(material.customInputs) ? material.customInputs : []).find((item) => item.id === key)
        const configured = (Array.isArray(material.inputDefinitions) ? material.inputDefinitions : []).find((item) => item.key === key)
        return { key, label: configured?.label || custom?.label || (key === 'custom' ? material.customFieldLabel || 'Özel miktar' : key === 'fixed' ? 'Sabit işlem' : key === 'minute' ? 'Süre' : key === 'weight' ? 'Ağırlık' : key === 'quantity' ? 'Adet' : 'Ölçü'), unit: componentUnit(key, material), quantity, sourceUnitPrice, sourceAmount: roundMoney(quantity * sourceUnitPrice) }
      }).filter((component) => component.quantity > 0 && component.sourceUnitPrice > 0)
      const sourceAmount = components.reduce((sum, component) => sum + component.sourceAmount, 0)
      calculationType = configuredFields.length > 1 ? 'combined' : configuredFields[0]
      calculationQuantity = components.length === 1 ? components[0].quantity : components.reduce((sum, component) => sum + component.quantity, 0)
      unitLabel = components.length === 1 ? components[0].unit : 'karma'
      areaM2 = configuredFields.includes('area') && isSquareMeterUnit(componentUnit('area', material)) ? componentUsage(order, 'area', material) : 0
      unitCost = components.length === 1 ? roundMoney(components[0].sourceUnitPrice * purchaseExchangeRate) : 0
      if (sourceAmount <= 0 || purchaseExchangeRate <= 0 || saleExchangeRate <= 0) return { enabled: false, source: 'none', cost: 0, rate, sale: 0, profit: 0, areaM2, unitCost, calculationType, calculationQuantity, unitLabel, currency, purchaseExchangeRate, saleExchangeRate, components }
      source = 'material'
      cost = roundMoney(sourceAmount * purchaseExchangeRate)
      sale = calculateSalePrice(sourceAmount * saleExchangeRate, rate)
      components = components.map((component) => ({ ...component, cost: roundMoney(component.sourceAmount * purchaseExchangeRate), saleBase: roundMoney(component.sourceAmount * saleExchangeRate) }))
      return { enabled: true, source, cost, rate, sale: roundMoney(sale), profit: roundMoney(sale - cost), areaM2, unitCost, calculationType, calculationQuantity, unitLabel, currency, purchaseExchangeRate, saleExchangeRate, components }
    }
    calculationType = material?.calculationType || 'area'
    unitLabel = calculationType === 'minute' ? 'dakika' : calculationType === 'weight' ? 'kg' : calculationType === 'quantity' ? 'adet' : 'm²'
    calculationQuantity = materialUsage(order, calculationType)
    areaM2 = calculationType === 'area' ? calculationQuantity : 0
    currency = String(material?.currency || 'TRY').toUpperCase()
    const sourceUnitPrice = materialUnitPrice(material)
    const pricing = privateData.pricingContext || {}
    purchaseExchangeRate = pricingRate(pricing, currency, 'purchase')
    saleExchangeRate = pricingRate(pricing, currency, 'sale')
    unitCost = roundMoney(sourceUnitPrice * purchaseExchangeRate)
    rate = Math.max(0, Number(material?.profitRate) || 0)
    if (!material || sourceUnitPrice <= 0 || calculationQuantity <= 0 || purchaseExchangeRate <= 0 || saleExchangeRate <= 0) {
      return { enabled: false, source: 'none', cost: 0, rate: 0, sale: 0, profit: 0, areaM2, unitCost: 0, calculationType, calculationQuantity, unitLabel, currency, purchaseExchangeRate, saleExchangeRate }
    }
    source = 'material'
    cost = roundMoney(calculationQuantity * sourceUnitPrice * purchaseExchangeRate)
    sale = calculateSalePrice(calculationQuantity * sourceUnitPrice * saleExchangeRate, rate)
  }

  return {
    enabled: true,
    source,
    cost: roundMoney(cost),
    rate,
    sale: roundMoney(sale),
    profit: roundMoney(sale - cost),
    areaM2,
    unitCost,
    calculationType,
    calculationQuantity,
    unitLabel,
    currency,
    purchaseExchangeRate,
    saleExchangeRate,
    components,
    unpricedComponents,
  }
}

function revalueAutomaticSnapshot(snapshot = {}, currentExchangeRates = {}) {
  if (!snapshot || !(Number(snapshot.saleAmount) > 0)) return null
  const currency = String(snapshot.currency || 'TRY').toUpperCase()
  const rate = Math.max(0, Number(snapshot.profitRate) || 0)
  const previousPurchaseRate = currency === 'TRY' ? 1 : Math.max(0, Number(snapshot.purchaseExchangeRate) || 0)
  const previousSaleRate = currency === 'TRY' ? 1 : Math.max(0, Number(snapshot.saleExchangeRate) || previousPurchaseRate)
  const currentRate = currency === 'TRY' ? 1 : Math.max(0, Number(currentExchangeRates?.[currency]) || 0)
  if (currentRate <= 0 || previousPurchaseRate <= 0 || previousSaleRate <= 0) return null
  const sourceCost = Math.max(0, Number(snapshot.sourceCostAmount) || (Number(snapshot.costAmount) || 0) / previousPurchaseRate)
  const previousSale = Math.max(0, Number(snapshot.saleAmount) || 0)
  const sourceSaleBase = Math.max(0, Number(snapshot.sourceSaleBaseAmount) || previousSale / (1 + rate / 100) / previousSaleRate)
  const cost = roundMoney(sourceCost * currentRate)
  const sale = roundMoney(sourceSaleBase * currentRate * (1 + rate / 100))
  return {
    enabled: true,
    source: 'material',
    cost,
    rate,
    sale,
    profit: roundMoney(sale - cost),
    areaM2: Math.max(0, Number(snapshot.areaM2) || 0),
    unitCost: snapshot.costPerM2 ? roundMoney(Number(snapshot.costPerM2) / previousPurchaseRate * currentRate) : 0,
    calculationType: snapshot.calculationType || 'area',
    calculationQuantity: Math.max(0, Number(snapshot.calculationQuantity) || Number(snapshot.areaM2) || 0),
    unitLabel: snapshot.unitLabel || 'm²',
    currency,
    purchaseExchangeRate: currentRate,
    saleExchangeRate: currentRate,
    components: Array.isArray(snapshot.components) ? snapshot.components : [],
    unpricedComponents: Array.isArray(snapshot.unpricedComponents) ? snapshot.unpricedComponents : [],
  }
}

export function orderFinance(privateData = {}, order = {}, materials = [], options = {}) {
  const currentExchangeRates = options.currentExchangeRates
  if (!currentExchangeRates || privateData.financeEnabled) return calculateOrderFinance(privateData, order, materials)
  const pricingContext = { purchaseExchangeRates: currentExchangeRates, saleExchangeRates: currentExchangeRates }
  const recalculated = calculateOrderFinance({ ...privateData, automaticPriceSnapshot: null, pricingContext }, order, materials)
  if (recalculated.enabled) return recalculated
  return revalueAutomaticSnapshot(privateData.automaticPriceSnapshot, currentExchangeRates) || recalculated
}

export function summarizeFinance(orders = [], privateMap = {}, materials = [], options = {}) {
  return orders.reduce((summary, order) => {
    const finance = orderFinance(privateMap[order.id], order, materials, options)
    if (!finance.enabled) {
      summary.missingPriceCount += 1
      return summary
    }
    summary.orderCount += 1
    summary.cost += finance.cost
    summary.sale += finance.sale
    summary.profit += finance.profit
    return summary
  }, { orderCount: 0, missingPriceCount: 0, cost: 0, sale: 0, profit: 0 })
}

export function summarizeFinanceByCustomer(orders = [], privateMap = {}, customerMap = {}, materials = [], options = {}) {
  const groups = new Map()
  orders.forEach((order) => {
    const finance = orderFinance(privateMap[order.id], order, materials, options)
    const customerId = order.customerId || 'unknown'
    const current = groups.get(customerId) || {
      customerId,
      customerName: customerMap[customerId]?.displayName || 'Silinmiş müşteri',
      orderCount: 0,
      pricedOrderCount: 0,
      cost: 0,
      sale: 0,
      profit: 0,
    }
    current.orderCount += 1
    if (finance.enabled) {
      current.pricedOrderCount += 1
      current.cost += finance.cost
      current.sale += finance.sale
      current.profit += finance.profit
    }
    groups.set(customerId, current)
  })
  return [...groups.values()].sort((a, b) => b.sale - a.sale || b.orderCount - a.orderCount || a.customerName.localeCompare(b.customerName, 'tr'))
}

export function summarizeByMaterial(orders = [], privateMap = {}, materials = [], options = {}) {
  const groups = new Map()
  orders.forEach((order) => {
    const material = String(order.material || order.type || 'Belirtilmedi').trim() || 'Belirtilmedi'
    const finance = orderFinance(privateMap[order.id], order, materials, options)
    const current = groups.get(material) || { material, orderCount: 0, pricedOrderCount: 0, quantity: 0, areaM2: 0, cost: 0, sale: 0, profit: 0 }
    current.orderCount += 1
    current.quantity += Math.max(1, Number(order.quantity) || 1)
    current.areaM2 += orderAreaM2(order)
    if (finance.enabled) {
      current.pricedOrderCount += 1
      current.cost += finance.cost
      current.sale += finance.sale
      current.profit += finance.profit
    }
    groups.set(material, current)
  })
  return [...groups.values()].sort((a, b) => b.areaM2 - a.areaM2 || b.orderCount - a.orderCount)
}

export function normalizeEmail(value = '') {
  return String(value).trim().toLowerCase()
}

export function customerTransferId(customerId = '', email = '') {
  return `${String(customerId).trim()}__${normalizeEmail(email)}`
}

const CUSTOMER_IMPORT_HEADERS = {
  displayName: ['musteri adi', 'musteri', 'ad soyad', 'firma', 'firma adi', 'unvan', 'cari adi', 'cari unvani', 'customer', 'name'],
  email: ['google e posta', 'google eposta', 'e posta', 'eposta', 'email', 'mail'],
  whatsappName: ['whatsapp gorusme adi', 'whatsapp adi', 'whatsapp', 'gorusme adi'],
}

function normalizeImportHeader(value) {
  return normalizeText(value).replace(/ı/g, 'i').replace(/[^a-z0-9çğıöşü]+/g, ' ').trim()
}

function importColumnIndexes(row = []) {
  const headers = Array.isArray(row) ? row.map(normalizeImportHeader) : []
  return Object.fromEntries(Object.entries(CUSTOMER_IMPORT_HEADERS).map(([key, aliases]) => [key, headers.findIndex((header) => aliases.includes(header))]))
}

function workbookSheets(source = []) {
  if (!Array.isArray(source)) return []
  if (source.some((entry) => entry && Array.isArray(entry.data))) return source.filter((entry) => Array.isArray(entry?.data))
  return [{ sheet: '', data: source }]
}

export function findCustomerImportRows(source = []) {
  for (const { data } of workbookSheets(source)) {
    const scanLimit = Math.min(data.length, 25)
    for (let index = 0; index < scanLimit; index += 1) {
      const indexes = importColumnIndexes(data[index])
      if (indexes.displayName >= 0 && indexes.email >= 0) return data.slice(index)
    }
  }
  return []
}

export function extractCustomerDraftFromWorkbook(source = []) {
  for (const { data } of workbookSheets(source)) {
    let displayName = ''
    let email = ''
    let whatsappName = ''
    data.slice(0, 50).forEach((row) => {
      if (!Array.isArray(row)) return
      const key = normalizeImportHeader(row[0])
      const value = String(row[1] ?? '').trim()
      if (!displayName && CUSTOMER_IMPORT_HEADERS.displayName.includes(key)) displayName = value
      if (!email && CUSTOMER_IMPORT_HEADERS.email.includes(key)) email = normalizeEmail(value)
      if (!whatsappName && CUSTOMER_IMPORT_HEADERS.whatsappName.includes(key)) whatsappName = value
    })
    if (displayName) return { displayName: displayName.slice(0, 120), email, whatsappName: (whatsappName || displayName).slice(0, 120) }
  }
  return null
}

export function extractOrderDraftsFromWorkbook(source = []) {
  const aliases = {
    receivedAt: ['tarih', 'date'],
    movement: ['hareket', 'islem', 'islem turu'],
    material: ['grup', 'malzeme', 'mazleme', 'urun grubu'],
    name: ['aciklama', 'proje', 'proje adi', 'siparis', 'siparis adi', 'urun', 'isim'],
    measurement: ['miktar', 'm2', 'metrekare', 'alan', 'alan m2', 'olcu', 'olcu m2'],
  }
  for (const { data } of workbookSheets(source)) {
    const scanLimit = Math.min(data.length, 25)
    for (let headerIndex = 0; headerIndex < scanLimit; headerIndex += 1) {
      const headers = Array.isArray(data[headerIndex]) ? data[headerIndex].map(normalizeImportHeader) : []
      const indexes = Object.fromEntries(Object.entries(aliases).map(([key, names]) => [key, headers.findIndex((header) => names.includes(header))]))
      if ([indexes.receivedAt, indexes.material, indexes.name, indexes.measurement].some((index) => index < 0)) continue
      const drafts = []
      data.slice(headerIndex + 1).forEach((row, offset) => {
        if (!Array.isArray(row)) return
        const movement = indexes.movement >= 0 ? normalizeImportHeader(row[indexes.movement]) : ''
        if (movement && movement !== 'satis') return
        const material = String(row[indexes.material] ?? '').trim().slice(0, 80)
        if (material && !/[a-z0-9çğıöşü]/i.test(normalizeText(material))) return
        const name = String(row[indexes.name] ?? '').trim().slice(0, 240)
        const measurement = parseMeasurementCell(row[indexes.measurement])
        const rawDate = row[indexes.receivedAt]
        let receivedAt = toDate(rawDate)
        if (typeof rawDate === 'number' && rawDate > 20000 && rawDate < 100000) receivedAt = new Date(Date.UTC(1899, 11, 30) + rawDate * 86400000)
        if (!receivedAt && !material && !name && measurement.areaM2 === null && !measurement.widthCm) return
        drafts.push({ rowNumber: headerIndex + offset + 2, receivedAt, material, name, ...measurement })
      })
      return drafts
    }
  }
  return []
}

export function mapCustomerImportRows(rows = [], existingEmails = []) {
  if (!Array.isArray(rows) || rows.length < 2) return { valid: [], invalid: [] }
  const indexes = importColumnIndexes(rows[0])
  const known = new Set(existingEmails.map(normalizeEmail).filter(Boolean))
  const seen = new Set()
  const valid = []
  const invalid = []
  rows.slice(1).forEach((row, offset) => {
    const rowNumber = offset + 2
    const displayName = String(indexes.displayName >= 0 ? row[indexes.displayName] ?? '' : '').trim().slice(0, 120)
    const email = normalizeEmail(indexes.email >= 0 ? row[indexes.email] ?? '' : '')
    const whatsappName = String(indexes.whatsappName >= 0 ? row[indexes.whatsappName] ?? '' : '').trim().slice(0, 120) || displayName
    if (!displayName && !email && !whatsappName) return
    let reason = ''
    if (indexes.displayName < 0 || indexes.email < 0) reason = 'Müşteri adı veya e-posta sütunu bulunamadı.'
    else if (!displayName) reason = 'Müşteri adı eksik.'
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) reason = 'Geçerli bir Google e-postası girilmemiş.'
    else if (known.has(email)) reason = 'Bu e-posta sistemde zaten kayıtlı.'
    else if (seen.has(email)) reason = 'Bu e-posta dosyada birden fazla kez bulunuyor.'
    if (reason) invalid.push({ rowNumber, displayName, email, whatsappName, reason })
    else {
      seen.add(email)
      valid.push({ rowNumber, displayName, email, whatsappName })
    }
  })
  return { valid, invalid }
}

export function toDate(value) {
  if (!value) return null
  if (value instanceof Date) return value
  if (typeof value.toDate === 'function') return value.toDate()
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

export function findRedundantCustomerBackups(backups = [], createdBy = '', intervalDays = 7, retentionDays = 90, now = Date.now()) {
  const intervalMs = Math.max(1, Number(intervalDays) || 7) * 86400000
  const retentionMs = Math.max(1, Number(retentionDays) || 90) * 86400000
  const seenPeriods = new Set()
  const redundant = []
  backups
    .filter((item) => item.createdBy === createdBy)
    .map((item) => ({ item, createdAt: toDate(item.createdAt) }))
    .filter((entry) => entry.createdAt)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .forEach(({ item, createdAt }) => {
      const periodKey = `${item.customerId || 'unknown'}:${Math.floor(createdAt.getTime() / intervalMs)}`
      if (now - createdAt.getTime() > retentionMs || seenPeriods.has(periodKey)) redundant.push(item)
      else seenPeriods.add(periodKey)
    })
  return redundant
}

export function toDateInput(value) {
  const date = toDate(value)
  if (!date) return ''
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000)
  return local.toISOString().slice(0, 10)
}

export function formatDate(value, fallback = 'Belirtilmedi') {
  const date = toDate(value)
  if (!date) return fallback
  return new Intl.DateTimeFormat('tr-TR', { day: '2-digit', month: 'short', year: 'numeric' }).format(date)
}

export function formatDateTime(value) {
  const date = toDate(value)
  if (!date) return '—'
  return new Intl.DateTimeFormat('tr-TR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

export function todayInput() {
  return toDateInput(new Date())
}

export function summarizeOrders(orders = []) {
  const today = todayInput()
  return {
    waiting: orders.filter((order) => order.status === 'Bekliyor').length,
    production: orders.filter((order) => order.status === 'Üretimde').length,
    ready: orders.filter((order) => order.status === 'Hazır').length,
    urgent: orders.filter((order) => Boolean(order.urgent)).length,
    dueToday: orders.filter((order) => toDateInput(order.estimatedCompletion) === today).length,
  }
}

export function filterOrders(orders = [], filters = {}, customerMap = {}) {
  const search = String(filters.search || '').trim().toLocaleLowerCase('tr-TR')
  return orders.filter((order) => {
    if (filters.status && order.status !== filters.status) return false
    if (filters.customerId && order.customerId !== filters.customerId) return false
    if (filters.type && order.type !== filters.type) return false
    if (filters.urgent === 'urgent' && !order.urgent) return false
    if (filters.urgent === 'normal' && order.urgent) return false
    if (!search) return true
    const haystack = [order.name, order.type, order.description, customerMap[order.customerId]?.displayName]
      .filter(Boolean)
      .join(' ')
      .toLocaleLowerCase('tr-TR')
    return haystack.includes(search)
  })
}

export function filterCustomerOrders(orders = [], filters = {}) {
  const search = String(filters.search || '').trim().toLocaleLowerCase('tr-TR')
  const from = filters.from || ''
  const to = filters.to || ''
  const filtered = orders.filter((order) => {
    if (filters.status && order.status !== filters.status) return false
    if (filters.type && order.type !== filters.type) return false
    const receivedAt = toDateInput(order.receivedAt)
    if (from && (!receivedAt || receivedAt < from)) return false
    if (to && (!receivedAt || receivedAt > to)) return false
    if (!search) return true
    return [order.name, order.type, order.status, order.description]
      .filter(Boolean)
      .join(' ')
      .toLocaleLowerCase('tr-TR')
      .includes(search)
  })

  const collator = new Intl.Collator('tr-TR', { sensitivity: 'base' })
  const dateValue = (order) => toDate(order.receivedAt)?.getTime() || toDate(order.createdAt)?.getTime() || 0
  const dueValue = (order) => toDate(order.estimatedCompletion)?.getTime() || Number.MAX_SAFE_INTEGER
  return [...filtered].sort((a, b) => {
    const aDelivered = a.status === 'Teslim Edildi'
    const bDelivered = b.status === 'Teslim Edildi'
    if (aDelivered !== bDelivered) return aDelivered ? 1 : -1
    if (aDelivered && bDelivered) {
      const deliveredValue = (order) => toDate(order.deliveredAt || order.statusChangedAt || order.updatedAt || order.receivedAt)?.getTime() || 0
      return deliveredValue(b) - deliveredValue(a)
    }
    if (filters.sort === 'oldest') return dateValue(a) - dateValue(b)
    if (filters.sort === 'name-asc') return collator.compare(a.name || '', b.name || '')
    if (filters.sort === 'name-desc') return collator.compare(b.name || '', a.name || '')
    if (filters.sort === 'due') return dueValue(a) - dueValue(b)
    return dateValue(b) - dateValue(a)
  })
}

export function findInactiveOrders(orders = [], settings = {}, now = new Date()) {
  if (!settings.enabled) return []
  const limit = Math.max(1, Number(settings.daysWithoutMovement) || 3)
  const nowTime = toDate(now)?.getTime() || Date.now()
  return orders.map((order) => {
    if (['Teslim Edildi', 'İptal Edildi'].includes(order.status)) return null
    const lastMovement = toDate(order.statusChangedAt || order.updatedAt || order.createdAt || order.receivedAt)
    if (!lastMovement) return null
    const inactiveDays = Math.floor((nowTime - lastMovement.getTime()) / 86400000)
    return inactiveDays >= limit ? { ...order, inactiveDays } : null
  }).filter(Boolean).sort((a, b) => b.inactiveDays - a.inactiveDays)
}

export function friendlyError(error) {
  const code = error?.code || ''
  if (code.includes('popup-closed-by-user')) return 'Giriş penceresi kapatıldı. Lütfen yeniden deneyin.'
  if (code.includes('popup-blocked')) return 'Google giriş penceresi engellendi. Tarayıcıda açılır pencerelere izin verin.'
  if (code.includes('permission-denied')) return 'Bu işlem için yetkiniz bulunmuyor.'
  if (code.includes('unavailable')) return 'Bağlantı kurulamadı. İnternet bağlantınızı kontrol edin.'
  return 'İşlem tamamlanamadı. Lütfen yeniden deneyin.'
}
