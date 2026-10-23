# İZMİRDE REKLAM SİPARİŞ TAKİP — UYGULAMA ŞARTNAMESİ

Bu proje demo değil, gerçek kullanılacak ürün olacaktır.

## 1. Ürün
Baskı merkezinde WhatsApp/manuel gelen işleri kaybetmeden takip etmek için yönetici Windows uygulaması ve müşteri/alt yönetici web paneli.

## 2. Kullanıcılar
- Ana Yönetici
- Alt Yönetici
- Müşteri

## 3. Yönetici ana ekranı
Üst özet: Bekliyor / Üretimde / Hazır / Acil / Bugün teslim.
Ana tablo: Müşteri, Sipariş Adı, Tür, Tarih, Durum, Tahmini Bitiş, Acil, İşlem.
Filtre: durum, müşteri, tür, acil ve arama.

## 4. Müşteri ekranı
Yalnız kendi siparişleri görünür. Sipariş düzenleme, silme veya durum değiştirme yoktur.
Masaüstünde çok işi tek ekranda gösterecek kompakt tablo; telefonda okunaklı kart satırları kullanılır.
Kolonlar: Sipariş ve açıklama, kategori, geliş tarihi, durum, tahmini bitiş ve öncelik.
Arama/filtre: metin, durum, kategori, başlangıç/bitiş tarihi, yeni-eski, A-Z/Z-A ve teslim tarihine göre sıralama.
Butonlar: Aciliyet Talebi / Süreç Bilgisi İste / Not Gönder.

## 4.1. Müşteri ekleme ve davet
Yeni müşteri formunda yalnız müşteri adı, Google e-postası ve aktif/pasif bilgisi istenir.
Telefon/WhatsApp numarası kayıt sırasında sorulmaz; sonradan yalnız yönetici Ayarlar ekranından ekleyebilir.
Müşteri oluşturulduğunda hazır davet mesajı gösterilir; yönetici metni kopyalayabilir veya e-posta taslağı açabilir.
Müşteri bağlantıyı açar, “Google ile devam et” der ve kendisine tanımlanan Google hesabını seçer; ek şifre veya teknik kurulum gerekmez.

## 5. Güvenlik
Sadece UI gizlemek yetmez. Firestore Security Rules zorunludur.
Müşteri başka müşterinin siparişini API seviyesinde de okuyamamalıdır.

## 6. Authentication
Yalnız Google Sign-In.
Drive/Sheets scope yok.
Mock login yok.
Final build'de Test Kullanıcısı / Mock Test ibaresi yok.

## 7. Firebase
Authentication + Firestore + Hosting.
Firebase config eksikse production-ready sayma.
Gerçek iki hesapla test edilmeden devam etme.

## 8. Desktop
Admin için Windows 10/11 x64.
Final EXE geliştirme ortamına bağımlı olmayacak.
Kurulum, kısayol, ikon, kaldırma bulunacak.

## 9. WhatsApp
Chrome uzantısı yalnız WhatsApp Web'de yöneticinin sağ tıkladığı proje başlığını alır.
Menü adı “Projeyi Sipariş Takibe Al”dır.
Tüm sohbet okunmaz ve sipariş otomatik kaydedilmez.
Proje adı, tür, ölçü ve adet onay formunda gösterilir; yönetici düzeltip onayladıktan sonra kayıt oluşur.
Yönetici panelindeki WhatsApp Bağlantıları sekmesi kullanım adımlarını ve kayıtlı WhatsApp görüşme adlarını gösterir.
Görüşme adı kayıtlı müşteriyle eşleşirse sağ-tık menüsü aktif olur. Eşleşmezse seçenek gri ve tıklanamaz; farklı ad Müşteri Ayarları içindeki WhatsApp görüşme adı alanından düzeltilir.

## 9.1. Toplamlar, malzeme ve geçmiş
Yönetici tüm müşterilerin, müşteri ise yalnız kendi siparişlerinin adet, malzeme ve m² toplamlarını ayrı sekmede görür.
Yönetici özel malzeme türleri ekleyebilir.
Yönetici işlemleri geçmişe kaydedilir; silinen sipariş, müşteri ve yöneticiler geri alınabilir.
Sipariş silinince bağlı talepler de siparişle birlikte çöp kutusuna taşınır.

## 10. Tasarım
Oyuncak/demo görünümü yasak.
Modern, estetik SaaS paneli.
Tam ekran admin dashboard.
Responsive müşteri web paneli.
Görünür ürün adı her yerde “İzmirde Reklam Sipariş Takip”; “ST” baş harfleri kullanılmaz.
Türkçe karakterler hatasız.
