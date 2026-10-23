# İZMİRDE REKLAM SİPARİŞ TAKİP — GELİŞTİRME KURALLARI

Bu proje gerçek kullanım içindir. Ana ürün bağlamı `SIPARIS_TAKIP_MASTER_CONTEXT.json`, kabul koşulları `ACCEPTANCE_TESTS.md` dosyasıdır.

## Mutlak kurallar

- Mock giriş, test kullanıcısı, hardcoded rol veya sahte veri production çıktısına giremez.
- Authentication yalnızca gerçek Firebase Google Sign-In ile çalışır.
- Veriler gerçek Cloud Firestore'da tutulur; müşteri izolasyonu Firestore Security Rules ile sağlanır.
- `customerPrivate` ve `orderPrivate` müşteri tarafından okunamaz.
- WhatsApp Web aktarımı yalnız kullanıcının sağ tıkladığı proje başlığını onay formuna taşır; sohbet geçmişi okunmaz, otomatik kayıt yapılmaz.
- Drive/Sheets scope'u, ayrı backend veya ücretli yeni servis eklenmez.
- Windows ürünü Antigravity, Node.js veya geliştirme ortamı olmadan çalışan kurulum EXE'si olarak teslim edilir.
- Test edilmeyen özellik çalışıyor diye raporlanmaz.

## Çalışma sırası

1. İlgili kodu ve testleri incele.
2. En küçük güvenli değişikliği yap.
3. `npm run lint`, `npm run test:unit`, Firestore Rules emülatör testleri ve `npm run build` çalıştır.
4. Canlı Firebase Hosting'de iki gerçek hesapla owner/customer akışını test et.
5. Final kurucuyu gerçek Windows'ta kur, aç, kapat/aç ve kaldır.

## Final çıktı

`C:\siparis-takip\release\IzmirdeReklam-SiparisTakip-Kurulum.exe`

Kritik kabul testlerinden biri geçmezse ürün release-ready sayılmaz.
