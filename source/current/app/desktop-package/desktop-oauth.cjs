const crypto = require('crypto')
const http = require('http')

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'

function base64Url(value) {
  return Buffer.from(value).toString('base64url')
}

function createPkce() {
  const verifier = base64Url(crypto.randomBytes(48))
  const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

function buildAuthorizationUrl({ clientId, redirectUri, state, challenge }) {
  const url = new URL(GOOGLE_AUTH_URL)
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', 'openid email profile')
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('prompt', 'select_account')
  return url.toString()
}

async function exchangeAuthorizationCode({ clientId, clientSecret, redirectUri, code, verifier, fetchImpl = fetch }) {
  const body = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    code,
    code_verifier: verifier,
    grant_type: 'authorization_code',
  })
  if (clientSecret) body.set('client_secret', clientSecret)
  const response = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const data = await response.json()
  if (!response.ok || (!data.id_token && !data.access_token)) {
    throw new Error(data.error_description || data.error || 'Google giriş bilgisi alınamadı.')
  }
  return { idToken: data.id_token || null, accessToken: data.access_token || null }
}

function responsePage(title, message, success) {
  const color = success ? '#14804a' : '#c13445'
  return `<!doctype html><html lang="tr"><meta charset="utf-8"><title>${title}</title><style>body{font-family:Arial,sans-serif;background:#f4f6fb;color:#172033;display:grid;place-items:center;min-height:100vh;margin:0}.card{background:#fff;border-radius:20px;box-shadow:0 18px 55px #1d2b4930;max-width:520px;padding:42px;text-align:center}.dot{background:${color};border-radius:50%;height:18px;margin:0 auto 20px;width:18px}h1{font-size:28px;margin:0 0 12px}p{color:#69728a;line-height:1.55;margin:0}</style><div class="card"><div class="dot"></div><h1>${title}</h1><p>${message}</p></div><script>setTimeout(()=>window.close(),1200)</script></html>`
}

function startDesktopGoogleLogin({ clientId, clientSecret, openExternal, fetchImpl = fetch, timeoutMs = 180000 }) {
  return new Promise((resolve, reject) => {
    const { verifier, challenge } = createPkce()
    const state = base64Url(crypto.randomBytes(32))
    let redirectUri = ''
    let settled = false
    let timer = null

    const server = http.createServer(async (request, response) => {
      if (!redirectUri || request.method !== 'GET') {
        response.writeHead(404).end()
        return
      }
      const callback = new URL(request.url, redirectUri)
      if (callback.pathname !== '/oauth2callback') {
        response.writeHead(404).end()
        return
      }
      if (callback.searchParams.get('state') !== state) {
        response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
        response.end(responsePage('Giriş tamamlanamadı', 'Güvenlik doğrulaması başarısız oldu. Uygulamaya dönüp yeniden deneyin.', false))
        finish(new Error('Google giriş güvenlik doğrulaması başarısız oldu.'))
        return
      }
      const oauthError = callback.searchParams.get('error')
      const code = callback.searchParams.get('code')
      if (oauthError || !code) {
        response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
        response.end(responsePage('Giriş iptal edildi', 'Uygulamaya dönüp yeniden deneyebilirsiniz.', false))
        finish(new Error(oauthError === 'access_denied' ? 'Google girişi iptal edildi.' : 'Google giriş kodu alınamadı.'))
        return
      }
      try {
        const tokens = await exchangeAuthorizationCode({ clientId, clientSecret, redirectUri, code, verifier, fetchImpl })
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        response.end(responsePage('Giriş tamamlandı', 'Bu pencereyi kapatıp İzmirde Reklam Sipariş Takip uygulamasına dönebilirsiniz.', true))
        finish(null, tokens)
      } catch (error) {
        response.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' })
        response.end(responsePage('Giriş tamamlanamadı', 'Uygulamaya dönüp yeniden deneyin.', false))
        finish(error)
      }
    })

    function finish(error, value) {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      server.close(() => {})
      if (error) reject(error)
      else resolve(value)
    }

    server.on('error', (error) => finish(error))
    server.listen(0, '127.0.0.1', async () => {
      const address = server.address()
      redirectUri = `http://127.0.0.1:${address.port}/oauth2callback`
      const authorizationUrl = buildAuthorizationUrl({ clientId, redirectUri, state, challenge })
      try {
        await openExternal(authorizationUrl)
      } catch (error) {
        finish(error)
      }
    })
    timer = setTimeout(() => finish(new Error('Google giriş süresi doldu. Yeniden deneyin.')), timeoutMs)
  })
}

module.exports = {
  buildAuthorizationUrl,
  createPkce,
  exchangeAuthorizationCode,
  startDesktopGoogleLogin,
}
