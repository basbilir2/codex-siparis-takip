const ATTACHMENT_EXTENSION = '(?:pdf|ai|cdr|eps|svg|psd|png|jpe?g|tiff?|webp|zip|rar|docx?|xlsx?)'
const ATTACHMENT_NAME = new RegExp(`([^\\\\/:*?"<>|\\r\\n]{1,180}\\.${ATTACHMENT_EXTENSION})(?=$|[\\s)\\]}>])`, 'i')

function normalize(value = '') {
  return String(value)
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .trim()
    .toLocaleLowerCase('tr-TR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

function matchesAlias(chat, alias) {
  const normalizedChat = normalize(chat).replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  const normalizedAlias = normalize(alias).replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  if (!normalizedChat || !normalizedAlias) return false
  if (normalizedChat === normalizedAlias) return true

  const chatDigits = normalizedChat.replace(/\D/g, '')
  const aliasDigits = normalizedAlias.replace(/\D/g, '')
  if (chatDigits.length >= 10 && aliasDigits.length >= 10) return chatDigits.slice(-10) === aliasDigits.slice(-10)

  const chatTokens = normalizedChat.split(/\s+/).filter(Boolean)
  const aliasTokens = normalizedAlias.split(/\s+/).filter(Boolean)
  const tokenKey = (tokens) => [...tokens].sort().join('|')
  if (chatTokens.length >= 2 && tokenKey(chatTokens) === tokenKey(aliasTokens)) return true
  return chatTokens.length >= 2 && chatTokens.every((token) => aliasTokens.includes(token))
}

function attachmentNameFromValues(values = []) {
  for (const value of values) {
    const candidate = String(value || '').replace(/[\u200e\u200f\u202a-\u202e]/g, '').trim()
    if (!candidate) continue
    const match = candidate.match(ATTACHMENT_NAME)
    if (match) return match[1].trim()
  }
  return ''
}

function projectKey(value = '') {
  return normalize(value)
    .replace(/\.(?:pdf|ai|cdr|eps|svg|psd|png|jpe?g|tiff?|webp|zip|rar|docx?|xlsx?)$/i, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function sourceStampFromValues(values = []) {
  for (const value of values) {
    const candidate = String(value || '').replace(/[\u200e\u200f\u202a-\u202e]/g, '').trim()
    if (!candidate) continue
    const bracketed = candidate.match(/\[(\d{1,2}:\d{2})(?::\d{2})?\s*,\s*(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})\]/)
    if (bracketed) return `${bracketed[2]} ${bracketed[1]}`
    const dated = candidate.match(/\b(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})\s+(\d{1,2}:\d{2})(?::\d{2})?\b/)
    if (dated) return `${dated[1]} ${dated[2]}`
  }
  return ''
}

module.exports = { attachmentNameFromValues, matchesAlias, normalize, projectKey, sourceStampFromValues }
