# Yeniden kurma

1. Bu depoyu ayrı bir klasöre klonlayın. `source` altındaki gerekli sürüm kopyasını seçin; farklı projeleri veya sürümleri üst üste yazmayın.
2. [BAGIMLILIKLAR.json](reconstruction/BAGIMLILIKLAR.json) içindeki framework ve sürümlere uygun araçları kurun. Var olan kilit dosyalarını kullanın.
3. [EKSİKLER.md](EKSIKLER.md) içindeki harici model, boş veri şablonu ve kurucu payload adımlarını tamamlayın. Gizli değerleri aşağıdaki ortam değişkenleri/yerel konfigürasyon üzerinden yeni ortamda sağlayın.
4. Aşağıdaki komutlar manifestlerden türetilmiştir; bu arşivleme sırasında çalıştırılmış ve başarılı olmuş sayılmaz. Dağıtım/deploy komutları canlı kaynakları etkileyebilir; kaynak incelemesi tamamlanmadan çalıştırmayın.
5. İlgili mevcut testleri çalıştırın; ardından boş kullanıcı verisiyle başlatma, kapat/aç ve hedef platform kurulumunu doğrulayın.

## Manifestlerden alınan komutlar

### source/current/app/desktop-package/package.json

Bu dosyanın klasöründe çalıştırılır.

```text
npm ci

```

### source/current/app/package.json

Bu dosyanın klasöründe çalıştırılır.

```text
npm ci
npm run dev    # vite
npm run build    # vite build
npm run lint    # oxlint
npm run test    # npm run test:unit
npm run test:unit    # vitest run src/utils.test.js
npm run test:rules    # vitest run tests/firestore.rules.test.js
npm run test:rules:emulator    # firebase emulators:exec --project demo-siparis-takip --only firestore "npm run test:rules"
npm run preview    # vite preview
npm run electron:dev    # electron .
npm run electron:build    # npm run build && electron-builder --projectDir desktop-package --win nsis
npm run deploy:production    # npm run build && firebase deploy --only hosting --project siparis-takip-70e85
```

## Ortam değişkenleri

Kaynakta otomatik çıkarılabilen ortam değişkeni yok. Yerel konfigürasyon gereksinimleri kaynakta ayrıca incelenmelidir.

## Kurucu payload

.NET Setup projeleri `Payload/*.exe` gömüyorsa önce ana uygulamayı publish edin, üretilen dosyayı `.csproj` içinde yazan tam Payload adına kopyalayın, ardından Setup projesini publish edin. Kaynak uygulamanın lisans ve mevcut kurulum kuralları korunur.
