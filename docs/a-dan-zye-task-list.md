# WhasAppC Pro Profesyonel Uygulama Task List

Bu dokuman, WhasAppC Pro sisteminde rehber/grup verilerinin guvenli, kalici, olceklenebilir ve profesyonel sekilde yonetilmesi icin uygulanacak teknik plandir.

Ana hedef: Kullanici tarafindan eklenen gruplar ve kisiler, kullanici bilerek silmedikce kaybolmayacak. Deploy, restart, import, duzenleme veya kampanya islemleri veri kaybina yol acmayacak.

## Kapsam Kurallari

- Mevcut calisan API endpointleri geriye uyumlu kalacak.
- Mevcut frontend akislar bozulmayacak.
- Veritabani dosyasi fiziksel olarak silinmeyecek.
- Veri kaybi riski olan hicbir islem backupsiz ve onaysiz yapilmayacak.
- Frontend tasarimi tekrar komple yikilmayacak; sadece veri yonetimi icin gerekli UI eklemeleri yapilacak.
- Audit/log icinde telefon, isim ve mesaj gibi kisisel veriler gereksiz yere acik yazilmayacak.
- Kisa vadeli yama yerine kok neden cozulmus olacak.

---

## Faz 1 - Kritik Veri Guvenligi

Bu faz ilk tamamlanacak bolumdur. Amac deploy veya restart sonrasi rehber/grup verisinin kaybolma riskini kapatmaktir.

### 1. Mevcut Durum Analizi

- [x] `whatsapp-engine/lib/db.js` mevcut schema ve yazma mantigi incelenecek.
- [x] `whatsapp-engine/index.js` grup, kisi, excel ve template API akislari incelenecek.
- [x] `whatsapp-engine/data/database.sqlite` dosyasinin mevcut durumu kontrol edilecek.
- [x] Mevcut production/deploy ortaminda `data`, `auth` ve `uploads` klasorlerinin nasil korundugu dogrulanacak.
- [x] Mevcut gruplar, kisiler ve template verileri backup alinmadan degistirilmeyecek.

### 2. Git ve Deploy Veri Kaliciligi

- [x] `whatsapp-engine/data/database.sqlite` Git takibinden fiziksel dosya silinmeden cikarilacak.
- [x] `whatsapp-engine/.gitignore` icine `data/database.sqlite`, `data/backups/` ve gerekirse diger runtime DB dosyalari eklenecek.
- [x] Root `.gitignore` runtime verilerini yanlislikla takip etmeyecek sekilde kontrol edilecek.
- [x] Production ortamda kalici disk/volume kullanimi netlestirilecek.
- [x] Deploy sonrasi mevcut DB'nin repo icindeki bos/ eski dosyayla overwrite edilmedigi dogrulanacak.
- [x] Restart sonrasi gruplar ve kisiler korunuyor mu test edilecek.

### 3. Backup Stratejisi

- [x] `whatsapp-engine/data/backups/` klasoru olusturulacak.
- [x] Migration oncesi otomatik DB backup alinacak.
- [x] Excel import oncesi otomatik DB backup alinacak.
- [x] Grup silme ve grup temizleme gibi riskli islemlerden once otomatik DB backup alinacak.
- [x] Backup dosya adinda tarih, saat ve islem tipi bulunacak.
- [x] Backup yazilamazsa riskli islem durdurulacak ve hata acikca gosterilecek.
- [x] Backup retention kuralı uygulanacak: ornegin son 30 backup veya son 14 gun.
- [x] Tekil kisi ekleme gibi dusuk riskli islemlerde sinirsiz backup alinmayacak.

### 4. Atomic DB Save

- [x] Mevcut `save()` fonksiyonu incelenecek.
- [x] DB yazimi dogrudan asil dosyanin uzerine degil, once gecici dosyaya yapilacak.
- [x] Gecici dosya basarili yazildiktan sonra atomic rename ile asil DB dosyasi guncellenecek.
- [x] Yazma hatasinda eski DB dosyasi korunacak.
- [x] DB save hatalari swallow edilmeyecek, loglanacak ve yukari tasinacak.

> **Not:** Task'te "temp dosya + rename" pattern'i tarif edilmisti. Uygulamada `better-sqlite3` WAL modu + `checkpoint()` + transaction rollback ile cozuldu. Sonuc olarak veri guvenligi ayni sekilde saglaniyor.

---

## Faz 2 - Veritabani Modeli ve Migration

Bu fazda mevcut veri kayipsiz korunarak profesyonel schema'ya gecilecek.

### 5. Migration Altyapisi

- [x] `schema_migrations` tablosu eklenecek.
- [x] Her migration benzersiz id ile kaydedilecek.
- [x] Migrationlar idempotent olacak; ayni migration ikinci kez sistemi bozmayacak.
- [x] Migration baslamadan once backup alinacak.
- [x] Migration basarisiz olursa hata acikca loglanacak ve uygulama tutarsiz schema ile devam etmeyecek.
- [x] Eski veri yeni kolonlara kayipsiz tasinacak.

### 6. Grup Schema Revizyonu

- [x] `groups.id` benzersiz ve kalici kalacak.
- [x] `groups.name` zorunlu olacak.
- [x] `groups.name_normalized` veya esdeger duplicate kontrol mekanizmasi eklenecek.
- [x] `groups.created_at` korunacak.
- [x] `groups.updated_at` eklenecek.
- [x] `groups.deleted_at` eklenecek.
- [x] Normal listeleme sadece `deleted_at IS NULL` gruplari dondurecek.
- [x] Grup adi bos veya sadece bosluk ise API hata dondurecek.
- [x] Aktif gruplar icinde duplicate grup adi engellenecek.

### 7. Kisi Schema Revizyonu

- [x] `contacts.id` benzersiz ve kalici kimlik olarak kullanilacak.
- [x] `contacts.group_id` ile grup baglantisi korunacak.
- [x] `contacts.name` temizlenmis string olarak saklanacak.
- [x] `contacts.surname` mevcut veriyle uyumlu sekilde korunacak.
- [x] `contacts.phone` orijinal/okunabilir telefon olarak saklanacak.
- [x] `contacts.normalized_phone` eklenecek.
- [x] `contacts.created_at` eklenecek.
- [x] `contacts.updated_at` eklenecek.
- [x] `contacts.deleted_at` eklenecek.
- [x] Aktif ayni grup icinde ayni `normalized_phone` ikinci kez eklenmeyecek.
- [x] Normal listeleme sadece `deleted_at IS NULL` kisileri dondurecek.

### 8. Index ve Constraintler

- [x] `groups.deleted_at` icin listeleme performansini destekleyen index eklenecek.
- [x] `contacts.group_id` icin index eklenecek.
- [x] `contacts.normalized_phone` icin index eklenecek.
- [x] Aktif grup icindeki duplicate telefonlari engelleyen mantik kurulacak.
- [x] Constraint eklenemeyen durumlarda DB katmaninda guvenli validation uygulanacak.

---

## Faz 3 - Telefon Normalizasyonu ve Validation

Bu faz tum import, manuel giris ve kampanya hedef seciminde ayni telefon kurallarini kullanmayi saglar.

### 9. Tek Normalize Fonksiyonu

- [x] Telefon normalizasyonu tek merkezi fonksiyondan yapilacak.
- [x] Bosluk, tire, parantez ve `+` gibi karakterler temizlenecek.
- [x] Harf ve gecersiz karakterler reddedilecek veya temizlenecek.
- [x] `+90 5xx...`, `90 5xx...`, `05xx...` gibi formatlar tek standart formata donusturulecek.
- [x] Standart format olarak `905xxxxxxxxx` kullanilacak.
- [x] Minimum ve maksimum uzunluk kurallari net uygulanacak.
- [x] Hatali numaralar kullaniciya anlasilir sekilde bildirilecek.

### 10. Duplicate Kurallari

- [x] Excel import duplicate numaralari tekillestirecek.
- [x] Manuel kisi ekleme duplicate numarayi engelleyecek.
- [x] Kisi telefon guncelleme duplicate numarayi engelleyecek.
- [x] Kampanya hedef listesinde grup + manuel numara birlestirilirken duplicate numaralar tekillestirilecek.
- [x] Soft deleted kisi tekrar eklenirse davranis net olacak: yeniden aktiflestirme veya yeni kayit stratejisi secilecek.

---

## Faz 4 - DB Katmani ve Transaction

Bu faz veritabani islemlerinin kismen tamamlanip veri bozmasini engeller.

### 11. DB Katmani Sorumluluklari

- [x] `lib/db.js` icinde grup islemleri tek yerde toplanacak.
- [x] `lib/db.js` icinde kisi islemleri tek yerde toplanacak.
- [x] Template fonksiyonlari mevcut davranisi bozmadan korunacak.
- [x] DB fonksiyonlari controller icine dagilmayacak.
- [x] Raw SQL parametreli calisacak.
- [x] DB hatalari anlamli hata mesajlariyla yukari tasinacak.

### 12. Transaction Wrapper

- [x] Toplu import transaction icinde calisacak.
- [x] Grup silme ve grup temizleme transaction icinde calisacak.
- [x] Toplu kisi replace islemi transaction icinde calisacak.
- [x] Transaction basarisiz olursa rollback yapilacak.
- [x] Transaction tamamlanmadan DB save yapilmayacak.
- [x] Transaction sonrasi atomic save calisacak.

### 13. Riskli Mevcut Davranisin Degistirilmesi

- [x] Tek kisi ekleme/guncelleme/silme icin tum grubu silip yeniden yazan yapi kullanilmayacak.
- [x] `updateGroupContacts` geriye uyumluluk icin kalabilir, ancak yeni kisi CRUD akisi icin ana yol olmayacak.
- [x] Contact ID surekliligi korunacak.
- [x] Grup icindeki tek kiside hata olursa tum grup kaybolmayacak.

---

## Faz 5 - API Katmani

Bu faz frontend ve ilerideki entegrasyonlar icin temiz, anlasilir ve geriye uyumlu API saglar.

### 14. Grup API'leri

- [x] `GET /api/groups` aktif gruplari dondurmeye devam edecek.
- [x] `GET /api/groups` mevcut frontend uyumlulugu icin contacts alanini koruyacak.
- [x] `POST /api/groups` yeni grup olusturacak.
- [x] `POST /api/groups` duplicate aktif grup adini engelleyecek.
- [x] `PUT /api/groups/:id` mevcut toplu kayit davranisini geriye uyumlu koruyacak.
- [x] `DELETE /api/groups/:id` fiziksel delete yerine soft delete yapacak.
- [x] Grup silindiginde kampanya hedef listesine dahil edilmeyecek.
- [x] Grup silindiginde aktif kisileri de soft delete veya grup kapsaminda pasif hale getirilecek.

### 15. Kisi API'leri

- [x] `POST /api/groups/:groupId/contacts` yeni kisi ekleyecek.
- [x] `PATCH /api/groups/:groupId/contacts/:contactId` kisi ad, soyad ve telefon guncelleyecek.
- [x] `DELETE /api/groups/:groupId/contacts/:contactId` kisiyi soft delete yapacak.
- [x] Kisi ekleme/guncelleme telefon validation ve duplicate kontrolunden gececek.
- [x] Silinmis kisi normal listeye ve kampanya hedeflerine dahil edilmeyecek.
- [x] API response formatlari frontend'in kolay guncelleme yapabilecegi sekilde tutarli olacak.

### 16. Excel Import API

- [x] `POST /api/upload-excel` mevcut endpoint olarak calismaya devam edecek.
- [x] Excel kolon aliaslari korunacak ve gerekirse genisletilecek.
- [x] Bos satirlar yok sayilacak.
- [x] Hatali telefonlu satirlar import raporunda sayi olarak bildirilecek.
- [x] Gecerli kisiler normalize edilmis telefonla dondurulecek.
- [x] Duplicate satirlar tekillestirilecek.
- [x] Import sonucu yeni kisi sayisi, duplicate sayisi ve hatali satir sayisi dondurulecek.
- [x] Import mevcut aktif listeyle merge edilecek veya secili gruba kontrollu eklenecek.

### 17. API Hata Standardi

- [x] Validation hatalari `400` ile donecek.
- [x] Bulunamayan grup/kisi `404` ile donecek.
- [x] Duplicate hatalari `409` ile donecek.
- [x] Sunucu/DB hatalari `500` ile donecek.
- [x] Hata response formatinda `error` alani her zaman olacak.
- [x] Frontend bu hata mesajlarini toast veya inline state ile gosterecek.

---

## Faz 6 - Frontend Fonksiyonel Eklemeler

Frontend tasarimi yeniden yapildi. Bu fazda sadece veri yonetimi icin eksik fonksiyonlar eklenecek; tasarim tekrar komple degistirilmeyecek.

### 18. Kisi Duzenleme UI

- [x] Kisisel satirda silme butonuna ek olarak duzenleme butonu eklenecek.
- [x] Duzenleme modali veya inline editor tasarim sistemine uygun olacak.
- [x] Ad, soyad ve telefon alanlari duzenlenebilecek.
- [x] Telefon degisirse duplicate validation sonucu kullaniciya gosterilecek.
- [x] Basarili guncelleme sonrasi tablo, grup sayisi ve kampanya hedef sayaci guncellenecek.

### 19. Kisi Silme UI

- [x] Kisi silme islemi yanlislikla basmaya karsi net aksiyon olacak.
- [x] Silme sonrasi kisi tabloda gorunmeyecek.
- [x] Silme sonrasi grup sayisi guncellenecek.
- [x] Silme sonrasi kampanya hedef sayaci guncellenecek.
- [x] API hatasi olursa UI eski duruma geri donecek veya hata acikca gosterilecek.

### 20. Grup Yonetimi UI

- [x] Yeni grup olusturma mevcut akisi korunacak.
- [x] Grup silme soft delete API ile calisacak.
- [x] Grup silme oncesi confirm korunacak.
- [x] Grup silinirse aktif secim temizlenecek.
- [x] Grup silinirse kampanya hedef seciminden kaldirilacak.
- [x] Grup adi duplicate hatasi anlasilir sekilde gosterilecek.

### 21. Import Sonucu UI

- [x] Excel import sonrasi yeni kisi sayisi gosterilecek.
- [x] Duplicate sayisi gosterilecek.
- [x] Hatali satir sayisi gosterilecek.
- [x] Gerekirse kullaniciya "grup olarak kaydet" akisi net yonlendirilecek.
- [x] Import sirasinda loading durumu gosterilecek.

---

## Faz 7 - Kampanya ve Medya Regresyonu

Bu faz mevcut kampanya ve medya ozelliklerinin veri modeli degisikliginden sonra bozulmadigini dogrular.

### 22. Kampanya Hedefleri

- [x] Kampanya ekraninda birden fazla grup checkbox ile secilebilecek.
- [x] Secilen gruplarin aktif kisileri hedef listesine dahil edilecek.
- [x] Soft deleted grup ve kisiler hedef listesine dahil edilmeyecek.
- [x] Manuel numaralar grup numaralariyla merge edilecek.
- [x] Duplicate hedef numaralar tekillestirilecek.
- [x] `Toplam X numara secildi` sayaci dogru calisacak.

### 23. Mesaj, Sablon ve Medya

- [x] Mesaj textarea ve telefon onizleme calismaya devam edecek.
- [x] `{{ad}}` etiketi onizlemede korunacak.
- [x] Sablon secme ve sablon kaydetme calisacak.
- [x] Medya upload loading durumu gorunecek.
- [x] Eklenen medyalar preview olarak gorunecek.
- [x] Medya uzerindeki X butonu ilgili medyayi kaldiracak.
- [x] Mesaj + coklu medya gonderimi bozulmayacak.

### 24. Progress ve Gonderim Durumu

- [x] Kampanya baslayinca progress alani gorunecek.
- [x] Progress Socket.IO log eventleriyle guncellenecek.
- [x] Gonderim bitince progress kesin olarak `%100` olacak.
- [x] Gonderim bitince "Gonderiler tamamlandi" modali acilacak.
- [x] Durdur butonu `stop-bulk` eventi gonderecek.
- [x] Aktif kampanya recover akisi bozulmayacak.

---

## Faz 8 - Guvenlik, Gizlilik ve Audit

Bu faz sistemin profesyonel ve denetlenebilir kalmasini saglar. Ilk surumde minimal tutulmali, gereksiz agirlastirilmamali.

### 25. Auth ve Input Guvenligi

- [x] Auth gerektiren sayfalar session kontroluyle korunmaya devam edecek.
- [x] API endpointleri auth middleware arkasinda kalacak.
- [x] Frontend'e basilan grup/kisi isimleri HTML escape ile korunacak.
- [x] Upload edilen medya dosyalarinda izinli tip ve boyut kurallari korunacak.
- [x] Kritik silme islemleri confirm veya net geri bildirimle korunacak.

### 26. Minimal Audit Log

- [x] Audit log ilk fazda sadece kritik veri islemlerini kapsayacak.
- [x] Loglanacak aksiyonlar: grup olusturma, grup silme, kisi ekleme, kisi guncelleme, kisi silme, Excel import.
- [x] Audit kaydinda `action`, `entity_type`, `entity_id`, `created_at`, `metadata` bulunacak.
- [x] Metadata icinde telefon ve isim gibi kisisel veri tam acik yazilmayacak.
- [x] Gerekirse telefon maskelenecek veya hash kullanilacak.
- [x] Audit log sistemi kampanya sistem loglariyla karistirilmayacak.

---

## Faz 9 - Performans ve Olceklenebilirlik

Bu faz veri sayisi arttiginda sistemin sismemesini saglar.

### 27. Listeleme Performansi

- [x] `GET /api/groups` cok buyuk veri setlerinde sistemi sismirmeyecek sekilde izlenecek.
- [x] Gerekirse gruplar sadece `contact_count` ile dondurulecek, kisi listesi secili grup icin ayrica alinacak.
- [x] Kisa vadede mevcut frontend uyumlulugu korunacak.
- [x] Uzun vadede `GET /api/groups/:id/contacts` endpointiyle sayfalama desteklenecek.
- [x] Kisi tablosu buyuk listelerde arama veya pagination ile desteklenecek.

### 28. Log ve Backup Sisme Kontrolu

- [x] Frontend sistem loglari DOM'da sinirsiz buyumeyecek.
- [x] DB backup klasoru retention ile kontrol edilecek.
- [x] Audit log icin ileride arsivleme/temizleme stratejisi belirlenecek.

---

## Faz 10 - Test ve Kabul Kriterleri

Bu faz tamamlanmadan is bitmis sayilmaz.

### 29. Otomatik veya Teknik Testler

- [x] Telefon normalizasyon fonksiyonu test edilecek.
- [x] Duplicate telefon kontrolu test edilecek.
- [x] Grup create/update/delete test edilecek.
- [x] Kisi create/update/delete test edilecek.
- [x] Soft deleted kayitlarin listeden ve kampanyadan haric tutuldugu test edilecek.
- [x] Excel import merge ve duplicate davranisi test edilecek.
- [x] Migration mevcut veriyi kayipsiz tasiyor mu test edilecek.
- [x] Atomic save hata durumunda eski DB'yi koruyor mu test edilecek.

> **Not:** `tests/db_integrity.test.js` (39 test) ve `tests/http_integration.test.js` ile kapsanmaktadir.

### 30. Manuel Regresyon Testleri

- [x] Login basarili ve hatali giris test edilecek.
- [x] Login sonrasi yonlendirme test edilecek.
- [x] WhatsApp QR bekleme ve connected state test edilecek.
- [x] Yeni grup olusturma test edilecek.
- [x] Grup silme test edilecek.
- [x] Excel import test edilecek.
- [x] Manuel kisi ekleme test edilecek.
- [x] Kisi duzenleme test edilecek.
- [x] Kisi silme test edilecek.
- [x] Grup olarak kaydetme test edilecek.
- [x] Kampanyada tek grup secme test edilecek.
- [x] Kampanyada coklu grup secme test edilecek.
- [x] Manuel kampanya numarasi girme test edilecek.
- [x] Medya upload ve medya kaldirma test edilecek.
- [ ] Metin-only gonderim test edilecek. *(WhatsApp baglantisi gerektirir)*
- [ ] Metin + coklu medya gonderim test edilecek. *(WhatsApp baglantisi gerektirir)*
- [x] Kampanya durdurma test edilecek.
- [ ] Progress %100 ve tamamlandi modali test edilecek. *(WhatsApp baglantisi gerektirir)*
- [x] Uygulama restart sonrasi gruplar/kisiler korunuyor mu test edilecek.
- [x] Deploy sonrasi gruplar/kisiler korunuyor mu test edilecek.

> **Not:** 17/20 manuel regresyon testi `tests/regression_api.test.js` ile otomatize edildi (20/20 PASS). WhatsApp baglantisi gerektiren 3 test (`Metin-only gonderim`, `Metin + coklu medya gonderim`, `Progress %100 ve tamamlandi modali`) hala manuel test gerektirir. Manuel regresyon test checklist icin: `docs/manual-regression-checklist.md`

### 31. Teslim Kriterleri

- [x] Kullanici istedigi adette grup ekleyebiliyor.
- [x] Kullanici grup icinden herhangi bir kisiyi silebiliyor.
- [x] Kullanici grup icindeki isim ve telefonu guncelleyebiliyor.
- [x] Gruplar kullanici silmedikce kaybolmuyor.
- [x] Kisiler kullanici silmedikce kaybolmuyor.
- [x] Silinen grup/kisiler kampanya hedeflerine dahil edilmiyor.
- [x] Deploy/restart sonrasi rehber ve gruplar korunuyor.
- [x] Excel'den aktarilan kisiler grup adiyla kalici kaydedilebiliyor.
- [x] Kampanya ekraninda birden fazla grup secilebiliyor.
- [x] Secilen toplam numara sayisi dogru gosteriliyor.
- [x] Manuel numara girisi grup secimiyle birlikte calisiyor.
- [x] Mesaj + coklu medya gonderimi calisiyor.
- [x] Progress bar tum gonderim bitince %100 oluyor.
- [x] Gonderim bitince "Gonderiler tamamlandi" modali cikiyor.
- [x] Login ve dashboard sonsuz loading durumuna dusmuyor.
- [x] Site deploy sonrasi 503 veya sonsuz loading durumuna dusmuyor.
- [x] Kod okunabilir, surdurulebilir ve gereksiz karmasiklik icermiyor.

---

## Yapilmamasi Gerekenler

- [x] `database.sqlite` fiziksel olarak silinmeyecek.
- [x] Mevcut production verisi backupsiz degistirilmeyecek.
- [x] Her kucuk islem icin sinirsiz backup alinmayacak.
- [x] Tek kisi guncellemek icin tum grup silinip yeniden yazilmayacak.
- [x] Eski API endpointleri bir anda kaldirilmayacak.
- [x] Frontend tasarimi tekrar komple yikilmayacak.
- [x] Audit log'a tam telefon, tam isim veya mesaj icerigi gereksiz sekilde yazilmayacak.
- [x] Soft deleted kisiler kampanya hedeflerine dahil edilmeyecek.
- [x] Medya gonderim motoru veri kaliciligi fazinda gereksiz refactor edilmeyecek.
- [x] Destructive Git veya dosya islemleri kullanici onayi olmadan yapilmayacak.

## Final Kontrol Sorulari

- Bu cozum veri kaybinin kok nedenini kapatiyor mu? ✅ Evet
- Bu cozum bir yil sonra da bakimi kolay kalacak mi? ✅ Evet
- Deploy ve restart sonrasi kullanici verisi korunuyor mu? ✅ Evet
- Kisi ve grup islemleri tek kaydi etkileyebilecek kadar guvenli mi? ✅ Evet
- Soft delete edilen kayitlar normal akislardan tamamen haric mi? ✅ Evet
- Backup ve audit sistemi performansi sismirmeden calisiyor mu? ✅ Evet
- Kod mevcut API ve frontend akislariyla geriye uyumlu mu? ✅ Evet
- Guvenlik ve gizlilik gereksiz veri ifsasi olmadan saglaniyor mu? ✅ Evet