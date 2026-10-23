import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const appRoot = resolve(import.meta.dirname, '..')
const projectRoot = resolve(appRoot, '..')
const authorizationPath = resolve(projectRoot, '.production-deploy-authorization')
const expectedAuthorizationHash = 'd4ea114b4cf523ad0feab69a2690f7d83baf79d85de6f734d7a09f875d063c7e'

function fail(message) {
  console.error(`\nCANLI YAYIN DURDURULDU: ${message}\n`)
  process.exit(1)
}

if (!existsSync(authorizationPath)) {
  fail('Bu çalışma klasörü İzmirde Reklam üretim yayını için yetkili değil. Dijital kopya ayrı bir Firebase projesi kullanmalıdır.')
}

const authorization = readFileSync(authorizationPath, 'utf8').trim()
const authorizationHash = createHash('sha256').update(authorization).digest('hex')
if (authorizationHash !== expectedAuthorizationHash) fail('Üretim yayın yetkisi geçersiz.')

const appPackage = JSON.parse(readFileSync(resolve(appRoot, 'package.json'), 'utf8'))
const desktopPackage = JSON.parse(readFileSync(resolve(appRoot, 'desktop-package', 'package.json'), 'utf8'))
const firebaseRc = JSON.parse(readFileSync(resolve(appRoot, '.firebaserc'), 'utf8'))
const source = readFileSync(resolve(appRoot, 'src', 'App.jsx'), 'utf8')

if (appPackage.name !== 'siparis-takip') fail('Web paket kimliği değiştirilmiş.')
if (desktopPackage.name !== 'izmirde-reklam-siparis-takip-production') fail('Windows paket kimliği üretim kimliğiyle eşleşmiyor.')
if (desktopPackage.build?.appId !== 'com.izmirde.reklam.siparistakip.production') fail('Windows uygulama kimliği üretim kimliğiyle eşleşmiyor.')
if (desktopPackage.build?.productName !== 'İzmirde Reklam Sipariş Takip') fail('Ürün adı değiştirilmiş.')
if (firebaseRc.projects?.default !== 'siparis-takip-70e85') fail('Firebase üretim projesi eşleşmiyor.')
if (!source.includes('İzmirde Reklam Sipariş Takip') || /sipari[sş]\s*takip\s*22/i.test(source)) fail('Arayüz markası üretim sürümü değil.')

console.log('İzmirde Reklam üretim yayın koruması doğrulandı.')
