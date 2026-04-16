1. Bu Sistem Hangi Teknolojileri Kullanıyor?
Dosyalardaki izlere ve mimari kurallara baktığımızda sistemin teknoloji yığını (Tech Stack) şu şekildedir:

Backend (Sunucu & API):
Node.js: Ana motor whatsapp-engine klasörü altında çalışıyor (index.js, lib/db.js).
Socket.IO: Kampanya gönderim sürecindeki (progress bar) canlı logları ve %100 tamamlanma durumunu frontend'e anlık aktarmak için.
Python (Opsiyonel/Arka Plan): .gitignore dosyasındaki venv, __pycache__ gibi izler, sistemde veri işleme, yapay zeka ajanları (Antigravity Agent) veya arka plan işçileri (workers/reconciliation) için Python kullanıldığını gösteriyor.
Veritabanı ve Önbellek:
SQLite: Sistemin mevcut veritabanı data/database.sqlite üzerinde çalışıyor. Ancak basit bir kullanım yerine; veri kaybını önlemek için Atomic Save (önce geçici dosyaya yazıp sonra rename etme) ve Migration altyapısı ile güçlendirilmiş.
Redis: Ajan hafıza dosyalarında (hata.md) çoklu kiracı (multi-tenant) izolasyonu ve cache key'leri (tenant:{id}:*) için kullanıldığı belirtilmiş.
Frontend (Kullanıcı Arayüzü):
Vite: Hızlı derleme aracı olarak kullanılıyor (.gitignore içinde dist-ssr ve Node izleri). Büyük ihtimalle React veya Vue.js ile yapılandırılmış.
Özel Tasarım Sistemi (CSS/Design Tokens): "Sovereign Interface" adında, Material Design "Surface" katmanlarını ve Glassmorphism (cam efekti) kullanan, Tailwind benzeri bir token yapısına sahip.
Test ve Kalite Kontrol:
Playwright: E2E (Uçtan uca) UI testleri ve regresyon testleri için (playwright-report klasörü).
Entegrasyonlar:
WhatsApp Business API (WABA) / BSP: Resmi Meta/WhatsApp bulut API'si veya Business Solution Provider (İşletme Çözüm Sağlayıcı) entegrasyonu.
2. Bu Sistem Ne Yapar, Amacı Nedir?
Sistemin Amacı: Kurumsal firmalar için tasarlanmış, "WhatsApp İzinli Müşteri Mesajlaşma (Dispatch) Üssüdür". Sistemin en büyük kuralı; standart, rahatsız edici bir "SPAM aracı" olmamaktır. Sadece izinli (opt-in) müşterilere, Meta tarafından onaylanmış şablonlar aracılığıyla data-driven (veri odaklı) kampanyalar çıkılmasını sağlar.

Temel İşlevleri (Yaptıkları):

Kişi ve Grup Yönetimi: Kullanıcıların numaralarını gruplar halinde kalıcı olarak saklar. Excel'den toplu içe aktarım (import) yapabilir.
Telefon Normalizasyonu (Veri Temizliği): Girilen farklı telefon numarası formatlarını (örn: 05.., +90.., 905..) tek bir formata (905xxxxxxxxx) çevirerek mükerrer (duplicate) kayıtları engeller.
Kampanya ve Şablon Gönderimi: Hedef kitleye (gruplara) metin veya çoklu medya (resim/video) içeren şablon mesajları toplu halde ve güvenli bir şekilde gönderir.
Rıza (Consent) Yönetimi: Sistemin kalbinde "Consent-Driven" (Rıza odaklı) bir yapı vardır. Kişinin izin durumu (opt-in) yoksa sistem ona mesaj göndermeyi reddeder.
Gerçek Zamanlı Takip: Kampanya başlatıldığında hangi numaranın başarılı, hangisinin başarısız olduğunu canlı (Socket.IO ile) raporlar.
Kayıp Durum Uzlaşması (Reconciliation): Eğer WhatsApp sunucularından mesajın iletildiğine dair "webhook (bildirim)" gelmezse, arka plandaki sistem bizzat gidip WhatsApp'a "Bu mesaja ne oldu?" diye sorar ve veritabanını günceller.
3. Backend ve Frontend Yapısı Nasıl İnşa Edilmiş?
Backend (Sunucu) Mimarisi
Backend sıradan bir CRUD (Oluştur, Oku, Güncelle, Sil) uygulamasından ziyade hataya yer vermeyen, kalıcı ve güvenli (Resilient) bir mimariyle tasarlanmış:

Atomic ve Transactional Veritabanı: lib/db.js üzerinden yönetilen veritabanı işlemlerinde veriler doğrudan dosya üzerine yazılmaz. Önce geçici kopyaya (temp) yazılır, başarılı olursa ana dosya güncellenir (Atomic Save). Çoklu eklemelerde Transaction kullanılır; ortada hata çıkarsa her şey geri alınır (Rollback).
İzolasyon ve Multi-Tenant (Çoklu Kiracı): Sistem birden fazla müşteriye hizmet verecek şekilde tasarlanmış (SaaS). Veritabanı sorguları kesinlikle tenant_id filtresi (Row Level Security - RLS) ile çalışır.
Güvenli API Katmanı: Tüm işlemler /api/groups, /api/upload-excel gibi RESTful endpointler üzerinden yürür. Hata kodları standartlaştırılmıştır (Örn: Validasyon hatası 400, Duplicate hatası 409 döner).
Webhook & Idempotency: WhatsApp'tan gelen yanıtlar (teslim edildi/okundu) sisteme düşer. Ağ hatasından dolayı aynı bildirim iki kere gelirse, sistem bunu id (webhook_id) üzerinden tanır ve veritabanını bozmadan (Replay Attack koruması) atlar.
Frontend (Kullanıcı Arayüzü) Mimarisi
Frontend tamamen "The Sovereign Interface" (Egemen Arayüz) felsefesiyle, üst düzey yöneticiler için bir "dijital komuta merkezi" hissiyatında inşa edilmiştir:

"No-Line" (Çizgisiz) Kuralı: Arayüzde bölümleri ayırmak için asla 1px solid (düz) çizgiler kullanılmaz. Bunun yerine Materyal tasarımın "Yüzey Katmanları" (Surface-lowest, surface-low, surface-highest) ve renk tonu geçişleri ile derinlik sağlanır.
Asimetrik ve Ferah Düzen (White Space): Klasik "kutu kutu" sıkışık SaaS panelleri yerine geniş boşluklar ve okumayı kolaylaştıran asimetrik düzenler kullanılır.
Cam Efekti ve Gradient: Premium özellikler veya aksiyon butonlarında (Glassmorphism) %70 şeffaflık, blurlu arka planlar ve yumuşak (Slate Blue'dan Emerald'a) renk geçişleri bulunur.
İkili Tipografi: Başlıklar için otoriter ve geometrik olan Manrope fontu, tablolar ve küçük okumalar (mesaj detayları) için ise son derece okunaklı olan Inter fontu tercih edilmiştir.
Sıkı Kontrat Bağlantısı: Frontend, Backend ile kafasına göre konuşamaz. registry.md üzerinde belirlenen API Kontratları (Contracts) baz alınarak, tipler ve beklenen veri formatları (payload) sıkı sıkıya birbirine bağlanmıştır.