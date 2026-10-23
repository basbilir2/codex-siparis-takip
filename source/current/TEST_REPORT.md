# İzmirde Reklam Sipariş Takip 1.9.18 — Son Test Raporu

Tarih: 21 Ağustos 2026  
Canlı adres: https://PRIVATE_VALUE_011

## Sonuç

- Kod denetimi: başarılı.
- Birim ve hesap testleri: 42/42 başarılı.
- Firestore güvenlik testleri: 9/9 başarılı.
- Üretim derlemesi, Firebase Hosting ve Firestore Rules yayını: başarılı.
- Teslim edilen siparişler aktif işlerin altına taşınıyor; teslim edilenler kendi içinde son teslim edilene göre sıralanıyor.
- Yaklaşan teslim ve hareketsiz sipariş uyarıları Ayarlar sayfasından açılıp kapatılabiliyor.
- WhatsApp, yedek/dışa aktar, geçmiş ve çöp kutusu tek Ayarlar merkezinde toplandı.
- Çöp kutusuna tarih, ad ve kayıt türü sıralamaları eklendi.
- Sipariş adına tıklanınca ayrıntı penceresi açılıyor.
- Yönetici sipariş satırındaki finans ikonuyla maliyet, satış ve kazancı açıp tekrar gizleyebiliyor.
- Yönetici sipariş finans satırında toplam m² ve toplam fiyat gösterimi doğrulandı.
- Dövizli malzemelerin güncel USD/EUR/GBP kuruyla seçilen sistem para birimine çevrilmesi doğrulandı.
- Hızlı takip müşterisi, kişiye özel şifresiz bağlantı, WhatsApp hızlı sipariş akışı ve bağlantı izolasyonu eklendi.
- Hareketsizlik uyarısından sipariş filtresine geçiş, müşteri bağlantısı, malzeme kopyalama ve mm özelliği eklendi.
- Günlük otomatik kur varsayılan yapıldı; manuel kur yalnız kullanıcı özellikle açarsa devreye giriyor.
- Dövizli malzemelerin alış fiyatı güncel kurla dinamik olarak yeniden hesaplanıp sistem para biriminde gösteriliyor; TL malzemeler etkilenmiyor.
- Eksik fiyat hesabında malzeme eşleşmesi, alış fiyatı, kur veya ölçüden hangisinin eksik olduğu açıkça gösteriliyor.
- Müşteri panelinden sipariş talebi oluşturma, yönetici uyarısı ve talebi siparişe dönüştürme akışı eklendi.
- Müşteri bazında ortalama fiyat görünürlüğünü açıp kapatma ayarı eklendi.
- Müşteri bazında izinli malzeme/hizmet kataloğu, yönetici aç/kapat ayarı ve mevcut müşterilere otomatik başlangıç listesi eklendi.
- Müşteri sipariş formunun serbest metin yerine yalnız izinli malzeme ve hizmetleri gösterdiği canlı müşteri hesabında doğrulandı.
- Yetkisiz katalog kimliğiyle sipariş talebi Firestore Rules tarafından engelleniyor.
- Müşteri bazında “Sipariş ekle” izni eklendi; izin kapalıyken düğmenin canlı müşteri panelinde görünmediği doğrulandı.
- İzin kapalıyken doğrudan yeni sipariş talebi gönderme girişimi Firestore Rules tarafından engelleniyor.
- Canlı yayın ve kurulu Windows uygulamasının 1.9.18 açılışı doğrulandı.

## Teslim

`C:\siparis-takip\release\IzmirdeReklam-SiparisTakip-Kurulum.exe`

SHA-256: `A4A5A50E303A2691860737EC86B9094AB4836342BA486165F84564AA7CE03773`

Release klasöründe yalnız son kurulum dosyası bırakıldı; geçici derleme çıktıları Geri Dönüşüm Kutusu'na taşındı.
