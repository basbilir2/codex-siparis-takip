# İzmirde Reklam Sipariş Takip

Firebase Authentication ve Firestore kullanan canlı sipariş takip uygulaması.

- Yönetici: müşterileri, yöneticileri, siparişleri ve talepleri yönetir.
- Müşteri: yalnızca kendi siparişlerini görür ve sipariş hakkında talep gönderir.
- Güncellemeler iki tarafta da canlı görünür.
- Windows kurulum paketi canlı uygulamayı varsayılan tarayıcıda açar.

Canlı uygulama: https://PRIVATE_VALUE_011

Son kurulum paketi: `C:\siparis-takip\release\IzmirdeReklam-SiparisTakip-Kurulum.exe`

## Doğrulama

```powershell
npm.cmd run lint
npm.cmd run test:unit
npm.cmd run build
```

Firestore güvenlik kuralları testi için Java 21 ve Firebase emülatörü gerekir.
