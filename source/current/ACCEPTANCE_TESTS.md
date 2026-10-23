# ACCEPTANCE TESTS

Antigravity bu testleri sırayla yapmalı ve TEST_REPORT.md üretmelidir.

## AUTH
- [ ] Gerçek Google hesabıyla login.
- [ ] Hardcoded/mock kullanıcı production build'de yok.
- [ ] Access kaydı olmayan hesap unauthorized ekranı görür.
- [ ] Pasif hesap erişemez.

## ROLE
- [ ] Owner admin ekranını görür.
- [ ] Admin admin ekranını görür.
- [ ] Customer müşteri ekranını görür.
- [ ] Customer admin menülerini göremez.

## FIRESTORE SECURITY
- [ ] Customer A kendi siparişini okuyabilir.
- [ ] Customer A, Customer B siparişini okuyamaz.
- [ ] Customer sipariş create/update/delete yapamaz.
- [ ] CustomerPrivate ve OrderPrivate customer tarafından okunamaz.
- [ ] Customer yalnız kendi adına request oluşturabilir.
- [ ] Owner/Admin sipariş CRUD yapabilir.

## ORDER FLOW
- [ ] Müşteri eklenir.
- [ ] Sipariş eklenir.
- [ ] Bekliyor varsayılan gelir.
- [ ] Durum değişir.
- [ ] Tahmini bitiş kaydolur.
- [ ] Acil işaretlenir.
- [ ] Filtre ve arama çalışır.

## CUSTOMER FLOW
- [ ] Yalnız kendi siparişleri görünür.
- [ ] Sipariş düzenleme, silme ve durum değiştirme seçenekleri görünmez ve kurallarla engellenir.
- [ ] Aciliyet talebi gönderilir.
- [ ] Süreç bilgisi talebi gönderilir.
- [ ] Not gönderilir.
- [ ] Owner talebi görür.
- [ ] Metin, durum, kategori, tarih ve sıralama filtreleri çalışır.
- [ ] Yönetici müşteriyi yalnız ad ve Google e-postasıyla ekleyebilir; telefon sadece Ayarlar ekranındadır.
- [ ] Davet mesajı kopyalanabilir ve e-posta taslağı hazırlanabilir.
- [ ] Siparişi olmayan müşteri onaydan sonra müşteri kaydı ve giriş yetkisiyle birlikte silinebilir.
- [ ] Siparişi bulunan müşteri, bağlı siparişler silinmeden silinemez.
- [ ] Ana yönetici eklenen yöneticiyi silebilir; kendi hesabını silemez.

## WEB
- [ ] Firebase Hosting canlı.
- [ ] web.app adresinden Google login.
- [ ] Telefon responsive.
- [ ] Türkçe karakterler doğru.

## WINDOWS
- [ ] Gerçek Windows'ta login.
- [ ] Uygulama kapanıp açılır.
- [ ] Firebase veri okuma/yazma.
- [ ] DPI doğru.
- [ ] Installer çalışır.
- [ ] Kısayol/ikon oluşur.
- [ ] Program Ekle/Kaldır kaydı vardır.
- [ ] Uninstall çalışır.
- [ ] Antigravity kapalıyken çalışır.

Tüm kritik maddeler PASS olmadan FINAL veya TAMAMLANDI yazma.
