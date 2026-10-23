# siparis-takip — mimari

Firebase Authentication/Firestore kullanan React ve Electron sipariş takip uygulaması.

## İşleyiş

React arayüzü → Firebase Google oturumu → Firestore veri modeli ve güvenlik kuralları. Electron main/preload ve WhatsApp köprüsü masaüstü katmanını oluşturur. Hosting ve kurulum paketleme ayrı adımlardır.

## Kaynak ve sürüm ayrımı

`source/` altındaki ayrı kopyalar birleştirilmedi. `current`, `development`, `versions-and-development`, `archive-snapshots` ve `embedded-snapshots` mevcut olduğunda farklı dönemleri temsil eder. Klasör adı tek başına sürüm doğrulaması değildir; sürüm manifestleri esas alınır.

## Bileşen haritası

- [desktop-oauth.cjs](source/current/app/desktop-package/desktop-oauth.cjs)
- [main.cjs](source/current/app/desktop-package/main.cjs)
- [preload.cjs](source/current/app/desktop-package/preload.cjs)
- [whatsapp-extractor.cjs](source/current/app/desktop-package/whatsapp-extractor.cjs)
- [whatsapp-preload.cjs](source/current/app/desktop-package/whatsapp-preload.cjs)
- [index-B-3K4pjC.js](source/current/app/dist/assets/index-B-3K4pjC.js)
- [main.cjs](source/current/app/main.cjs)
- [guard-production-deploy.mjs](source/current/app/scripts/guard-production-deploy.mjs)
- [App.jsx](source/current/app/src/App.jsx)
- [firebase.js](source/current/app/src/firebase.js)
- [main.jsx](source/current/app/src/main.jsx)
- [utils.js](source/current/app/src/utils.js)
- [utils.test.js](source/current/app/src/utils.test.js)
- [firestore.rules.test.js](source/current/app/tests/firestore.rules.test.js)
- [vite.config.js](source/current/app/vite.config.js)

## Teknik belgeler

- [ACCEPTANCE_TESTS.md](source/current/ACCEPTANCE_TESTS.md)
- [AGENTS.md](source/current/AGENTS.md)
- [ANTIGRAVITY_START.txt](source/current/ANTIGRAVITY_START.txt)
- [KURULUM-KISA.txt](source/current/KURULUM-KISA.txt)
- [PRODUCT_SPEC.md](source/current/PRODUCT_SPEC.md)
- [TEST_REPORT.md](source/current/TEST_REPORT.md)
- [README.md](source/current/app/README.md)
- [TEST_REPORT.md](source/current/app/TEST_REPORT.md)
