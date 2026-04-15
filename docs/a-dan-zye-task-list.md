# WhasAppC Pro Profesyonel Uygulama Task List

Bu dokuman, WhasAppC Pro sisteminde rehber/grup verilerinin guvenli, kalici, olceklenebilir ve profesyonel sekilde yonetilmesi icin uygulanacak teknik plandir.

Ana hedef: Kullanici tarafindan eklenen gruplar ve kisiler, kullanici bilerek silmedikce kaybolmayacak. Deploy, restart, import, duzenleme veya kampanya islemleri veri kaybina yol acmayacak.

## Kapsam Kurallari

- Mevcut calisan API endpointleri geriye uyumlu kalacak.
- Mevcut frontend akislar bozulmayacak.
- Veritabani dosyasi fiziksel olarak silinmeyecek.
- Veri kaybi riski olan hicbir islem backupsiz ve onaysiz yapilmayacak.
- Frontend tasarimi tekrar komple yikilmeyecek; sadece veri yonetimi icin gerekli UI eklemeleri yapilacak.
- Audit/log icinde telefon, isim ve mesaj gibi kisisel veriler gereksiz yere acik yazilmayacak.
- Kisa vadeli yama yerine kok neden cozulmus olacak.

---

## Faz 1 - Kritik Veri Guvenligi

Bu faz ilk tamamlanacak bolumdur. Amac deploy veya restart sonrasi rehber/grup verisinin kaybolma riskini kapatmaktir.

### 1. Mevcut Durum Analizi

- [ ] `whatsapp-engine/lib/db.js` mevcut schema ve yazma mantigi incelenecek.
- [ ] `whatsapp-engine/index.js` grup, kisi, excel ve template API akislari incelenecek.
- [ ] `whatsapp-engine/data/database.sqlite` dosyasinin mevcut durumu kontrol edilecek.
- [ ] Mevcut production/deploy ortaminda `data`, `auth` ve `uploads` klasorlerinin nasil korundugu dogrulanacak.
- [ ] Mevcut gruplar, kisiler ve template verileri backup alinmadan degistirilmeyecek.

### 2. Git ve Deploy Veri Kaliciligi

- [ ] `whatsapp-engine/data/database.sqlite` Git takibinden fiziksel dosya silinmeden cikarilacak.
- [ ] `whatsapp-engine/.gitignore` icine `data/database.sqlite`, `data/backups/` ve gerekirse diger runtime DB dosyalari eklenecek.
- [ ] Root `.gitignore` runtime verilerini yanlislikla takip etmeyecek sekilde kontrol edilecek.
- [ ] Production ortamda kalici disk/volume kullanimi netlestirilecek.
- [ ] Deploy sonrasi mevcut DB'nin repo icindeki bos/ eski dosyayla overwrite edilmedigi dogrulanacak.
- [ ] Restart sonrasi gruplar ve kisiler korunuyor mu test edilecek.

### 3. Backup Stratejisi

- [ ] `whatsapp-engine/data/backups/` klasoru olusturulacak.
- [ ] Migration oncesi otomatik DB backup alinacak.
- [ ] Excel import oncesi otomatik DB backup alinacak.
- [ ] Grup silme ve grup temizleme gibi riskli islemlerden once otomatik DB backup alinacak.
- [ ] Backup dosya adinda tarih, saat ve islem tipi bulunacak.
- [ ] Backup yazilamazsa riskli islem durdurulacak ve hata acikca gosterilecek.
- [ ] Backup retention kuralı uygulanacak: ornegin son 30 backup veya son 14 gun.
- [ ] Tekil kisi ekleme gibi dusuk riskli islemlerde sinirsiz backup alinmayacak.

### 4. Atomic DB Save

- [ ] Mevcut `save()` fonksiyonu incelenecek.
- [ ] DB yazimi dogrudan asil dosyanin uzerine degil, once gecici dosyaya yapilacak.
- [ ] Gecici dosya basarili yazildiktan sonra atomic rename ile asil DB dosyasi guncellenecek.
- [ ] Yazma hatasinda eski DB dosyasi korunacak.
- [ ] DB save hatalari swallow edilmeyecek, loglanacak ve yukari tasinacak.

---

## Faz 2 - Veritabani Modeli ve Migration

Bu fazda mevcut veri kayipsiz korunarak profesyonel schema'ya gecilecek.

### 5. Migration Altyapisi

- [ ] `schema_migrations` tablosu eklenecek.
- [ ] Her migration benzersiz id ile kaydedilecek.
- [ ] Migrationlar idempotent olacak; ayni migration ikinci kez sistemi bozmayacak.
- [ ] Migration baslamadan once backup alinacak.
- [ ] Migration basarisiz olursa hata acikca loglanacak ve uygulama tutarsiz schema ile devam etmeyecek.
- [ ] Eski veri yeni kolonlara kayipsiz tasinacak.

### 6. Grup Schema Revizyonu

- [ ] `groups.id` benzersiz ve kalici kalacak.
- [ ] `groups.name` zorunlu olacak.
- [ ] `groups.name_normalized` veya esdeger duplicate kontrol mekanizmasi eklenecek.
- [ ] `groups.created_at` korunacak.
- [ ] `groups.updated_at` eklenecek.
- [ ] `groups.deleted_at` eklenecek.
- [ ] Normal listeleme sadece `deleted_at IS NULL` gruplari dondurecek.
- [ ] Grup adi bos veya sadece bosluk ise API hata dondurecek.
- [ ] Aktif gruplar icinde duplicate grup adi engellenecek.

### 7. Kisi Schema Revizyonu

- [ ] `contacts.id` benzersiz ve kalici kimlik olarak kullanilacak.
- [ ] `contacts.group_id` ile grup baglantisi korunacak.
- [ ] `contacts.name` temizlenmis string olarak saklanacak.
- [ ] `contacts.surname` mevcut veriyle uyumlu sekilde korunacak.
- [ ] `contacts.phone` orijinal/okunabilir telefon olarak saklanacak.
- [ ] `contacts.normalized_phone` eklenecek.
- [ ] `contacts.created_at` eklenecek.
- [ ] `contacts.updated_at` eklenecek.
- [ ] `contacts.deleted_at` eklenecek.
- [ ] Aktif ayni grup icinde ayni `normalized_phone` ikinci kez eklenmeyecek.
- [ ] Normal listeleme sadece `deleted_at IS NULL` kisileri dondurecek.

### 8. Index ve Constraintler

- [ ] `groups.deleted_at` icin listeleme performansini destekleyen index eklenecek.
- [ ] `contacts.group_id` icin index eklenecek.
- [ ] `contacts.normalized_phone` icin index eklenecek.
- [ ] Aktif grup icindeki duplicate telefonlari engelleyen mantik kurulacak.
- [ ] Constraint eklenemeyen durumlarda DB katmaninda guvenli validation uygulanacak.

---

## Faz 3 - Telefon Normalizasyonu ve Validation

Bu faz tum import, manuel giris ve kampanya hedef seciminde ayni telefon kurallarini kullanmayi saglar.

### 9. Tek Normalize Fonksiyonu

- [ ] Telefon normalizasyonu tek merkezi fonksiyondan yapilacak.
- [ ] Bosluk, tire, parantez ve `+` gibi karakterler temizlenecek.
- [ ] Harf ve gecersiz karakterler reddedilecek veya temizlenecek.
- [ ] `+90 5xx...`, `90 5xx...`, `05xx...` gibi formatlar tek standart formata donusturulecek.
- [ ] Standart format olarak `905xxxxxxxxx` kullanilacak.
- [ ] Minimum ve maksimum uzunluk kurallari net uygulanacak.
- [ ] Hatali numaralar kullaniciya anlasilir sekilde bildirilecek.

### 10. Duplicate Kurallari

- [ ] Excel import duplicate numaralari tekillestirecek.
- [ ] Manuel kisi ekleme duplicate numarayi engelleyecek.
- [ ] Kisi telefon guncelleme duplicate numarayi engelleyecek.
- [ ] Kampanya hedef listesinde grup + manuel numara birlestirilirken duplicate numaralar tekillestirilecek.
- [ ] Soft deleted kisi tekrar eklenirse davranis net olacak: yeniden aktiflestirme veya yeni kayit stratejisi secilecek.

---

## Faz 4 - DB Katmani ve Transaction

Bu faz veritabani islemlerinin kismen tamamlanip veri bozmasini engeller.

### 11. DB Katmani Sorumluluklari

- [ ] `lib/db.js` icinde grup islemleri tek yerde toplanacak.
- [ ] `lib/db.js` icinde kisi islemleri tek yerde toplanacak.
- [ ] Template fonksiyonlari mevcut davranisi bozmadan korunacak.
- [ ] DB fonksiyonlari controller icine dagilmayacak.
- [ ] Raw SQL parametreli calisacak.
- [ ] DB hatalari anlamli hata mesajlariyla yukari tasinacak.

### 12. Transaction Wrapper

- [ ] Toplu import transaction icinde calisacak.
- [ ] Grup silme ve grup temizleme transaction icinde calisacak.
- [ ] Toplu kisi replace islemi transaction icinde calisacak.
- [ ] Transaction basarisiz olursa rollback yapilacak.
- [ ] Transaction tamamlanmadan DB save yapilmayacak.
- [ ] Transaction sonrasi atomic save calisacak.

### 13. Riskli Mevcut Davranisin Degistirilmesi

- [ ] Tek kisi ekleme/guncelleme/silme icin tum grubu silip yeniden yazan yapi kullanilmayacak.
- [ ] `updateGroupContacts` geriye uyumluluk icin kalabilir, ancak yeni kisi CRUD akisi icin ana yol olmayacak.
- [ ] Contact ID surekliligi korunacak.
- [ ] Grup icindeki tek kiside hata olursa tum grup kaybolmayacak.

---

## Faz 5 - API Katmani

Bu faz frontend ve ilerideki entegrasyonlar icin temiz, anlasilir ve geriye uyumlu API saglar.

### 14. Grup API'leri

- [ ] `GET /api/groups` aktif gruplari dondurmeye devam edecek.
- [ ] `GET /api/groups` mevcut frontend uyumlulugu icin contacts alanini koruyacak.
- [ ] `POST /api/groups` yeni grup olusturacak.
- [ ] `POST /api/groups` duplicate aktif grup adini engelleyecek.
- [ ] `PUT /api/groups/:id` mevcut toplu kayit davranisini geriye uyumlu koruyacak.
- [ ] `DELETE /api/groups/:id` fiziksel delete yerine soft delete yapacak.
- [ ] Grup silindiginde kampanya hedef listesine dahil edilmeyecek.
- [ ] Grup silindiginde aktif kisileri de soft delete veya grup kapsaminda pasif hale getirilecek.

### 15. Kisi API'leri

- [ ] `POST /api/groups/:groupId/contacts` yeni kisi ekleyecek.
- [ ] `PATCH /api/groups/:groupId/contacts/:contactId` kisi ad, soyad ve telefon guncelleyecek.
- [ ] `DELETE /api/groups/:groupId/contacts/:contactId` kisiyi soft delete yapacak.
- [ ] Kisi ekleme/guncelleme telefon validation ve duplicate kontrolunden gececek.
- [ ] Silinmis kisi normal listeye ve kampanya hedeflerine dahil edilmeyecek.
- [ ] API response formatlari frontend'in kolay guncelleme yapabilecegi sekilde tutarli olacak.

### 16. Excel Import API

- [ ] `POST /api/upload-excel` mevcut endpoint olarak calismaya devam edecek.
- [ ] Excel kolon aliaslari korunacak ve gerekirse genisletilecek.
- [ ] Bos satirlar yok sayilacak.
- [ ] Hatali telefonlu satirlar import raporunda sayi olarak bildirilecek.
- [ ] Gecerli kisiler normalize edilmis telefonla dondurulecek.
- [ ] Duplicate satirlar tekillestirilecek.
- [ ] Import sonucu yeni kisi sayisi, duplicate sayisi ve hatali satir sayisi dondurulecek.
- [ ] Import mevcut aktif listeyle merge edilecek veya secili gruba kontrollu eklenecek.

### 17. API Hata Standardi

- [ ] Validation hatalari `400` ile donecek.
- [ ] Bulunamayan grup/kisi `404` ile donecek.
- [ ] Duplicate hatalari `409` ile donecek.
- [ ] Sunucu/DB hatalari `500` ile donecek.
- [ ] Hata response formatinda `error` alani her zaman olacak.
- [ ] Frontend bu hata mesajlarini toast veya inline state ile gosterecek.

---

## Faz 6 - Frontend Fonksiyonel Eklemeler

Frontend tasarimi yeniden yapildi. Bu fazda sadece veri yonetimi icin eksik fonksiyonlar eklenecek; tasarim tekrar komple degistirilmeyecek.

### 18. Kisi Duzenleme UI

- [ ] Kisisel satirda silme butonuna ek olarak duzenleme butonu eklenecek.
- [ ] Duzenleme modali veya inline editor tasarim sistemine uygun olacak.
- [ ] Ad, soyad ve telefon alanlari duzenlenebilecek.
- [ ] Telefon degisirse duplicate validation sonucu kullaniciya gosterilecek.
- [ ] Basarili guncelleme sonrasi tablo, grup sayisi ve kampanya hedef sayaci guncellenecek.

### 19. Kisi Silme UI

- [ ] Kisi silme islemi yanlislikla basmaya karsi net aksiyon olacak.
- [ ] Silme sonrasi kisi tabloda gorunmeyecek.
- [ ] Silme sonrasi grup sayisi guncellenecek.
- [ ] Silme sonrasi kampanya hedef sayaci guncellenecek.
- [ ] API hatasi olursa UI eski duruma geri donecek veya hata acikca gosterilecek.

### 20. Grup Yonetimi UI

- [ ] Yeni grup olusturma mevcut akisi korunacak.
- [ ] Grup silme soft delete API ile calisacak.
- [ ] Grup silme oncesi confirm korunacak.
- [ ] Grup silinirse aktif secim temizlenecek.
- [ ] Grup silinirse kampanya hedef seciminden kaldirilacak.
- [ ] Grup adi duplicate hatasi anlasilir sekilde gosterilecek.

### 21. Import Sonucu UI

- [ ] Excel import sonrasi yeni kisi sayisi gosterilecek.
- [ ] Duplicate sayisi gosterilecek.
- [ ] Hatali satir sayisi gosterilecek.
- [ ] Gerekirse kullaniciya "grup olarak kaydet" akisi net yonlendirilecek.
- [ ] Import sirasinda loading durumu gosterilecek.

---

## Faz 7 - Kampanya ve Medya Regresyonu

Bu faz mevcut kampanya ve medya ozelliklerinin veri modeli degisikliginden sonra bozulmadigini dogrular.

### 22. Kampanya Hedefleri

- [ ] Kampanya ekraninda birden fazla grup checkbox ile secilebilecek.
- [ ] Secilen gruplarin aktif kisileri hedef listesine dahil edilecek.
- [ ] Soft deleted grup ve kisiler hedef listesine dahil edilmeyecek.
- [ ] Manuel numaralar grup numaralariyla merge edilecek.
- [ ] Duplicate hedef numaralar tekillestirilecek.
- [ ] `Toplam X numara secildi` sayaci dogru calisacak.

### 23. Mesaj, Sablon ve Medya

- [ ] Mesaj textarea ve telefon onizleme calismaya devam edecek.
- [ ] `{{ad}}` etiketi onizlemede korunacak.
- [ ] Sablon secme ve sablon kaydetme calisacak.
- [ ] Medya upload loading durumu gorunecek.
- [ ] Eklenen medyalar preview olarak gorunecek.
- [ ] Medya uzerindeki X butonu ilgili medyayi kaldiracak.
- [ ] Mesaj + coklu medya gonderimi bozulmayacak.

### 24. Progress ve Gonderim Durumu

- [ ] Kampanya baslayinca progress alani gorunecek.
- [ ] Progress Socket.IO log eventleriyle guncellenecek.
- [ ] Gonderim bitince progress kesin olarak `%100` olacak.
- [ ] Gonderim bitince "Gonderiler tamamlandi" modali acilacak.
- [ ] Durdur butonu `stop-bulk` eventi gonderecek.
- [ ] Aktif kampanya recover akisi bozulmayacak.

---

## Faz 8 - Guvenlik, Gizlilik ve Audit

Bu faz sistemin profesyonel ve denetlenebilir kalmasini saglar. Ilk surumde minimal tutulmali, gereksiz agirlastirilmamali.

### 25. Auth ve Input Guvenligi

- [ ] Auth gerektiren sayfalar session kontroluyle korunmaya devam edecek.
- [ ] API endpointleri auth middleware arkasinda kalacak.
- [ ] Frontend'e basilan grup/kisi isimleri HTML escape ile korunacak.
- [ ] Upload edilen medya dosyalarinda izinli tip ve boyut kurallari korunacak.
- [ ] Kritik silme islemleri confirm veya net geri bildirimle korunacak.

### 26. Minimal Audit Log

- [ ] Audit log ilk fazda sadece kritik veri islemlerini kapsayacak.
- [ ] Loglanacak aksiyonlar: grup olusturma, grup silme, kisi ekleme, kisi guncelleme, kisi silme, Excel import.
- [ ] Audit kaydinda `action`, `entity_type`, `entity_id`, `created_at`, `metadata` bulunacak.
- [ ] Metadata icinde telefon ve isim gibi kisisel veri tam acik yazilmayacak.
- [ ] Gerekirse telefon maskelenecek veya hash kullanilacak.
- [ ] Audit log sistemi kampanya sistem loglariyla karistirilmeyecek.

---

## Faz 9 - Performans ve Olceklenebilirlik

Bu faz veri sayisi arttiginda sistemin sismemesini saglar.

### 27. Listeleme Performansi

- [ ] `GET /api/groups` cok buyuk veri setlerinde sistemi sismirmeyecek sekilde izlenecek.
- [ ] Gerekirse gruplar sadece `contact_count` ile dondurulecek, kisi listesi secili grup icin ayrica alinacak.
- [ ] Kisa vadede mevcut frontend uyumlulugu korunacak.
- [ ] Uzun vadede `GET /api/groups/:id/contacts` endpointiyle sayfalama desteklenecek.
- [ ] Kisi tablosu buyuk listelerde arama veya pagination ile desteklenecek.

### 28. Log ve Backup Sisme Kontrolu

- [ ] Frontend sistem loglari DOM'da sinirsiz buyumeyecek.
- [ ] DB backup klasoru retention ile kontrol edilecek.
- [ ] Audit log icin ileride arsivleme/temizleme stratejisi belirlenecek.

---

## Faz 10 - Test ve Kabul Kriterleri

Bu faz tamamlanmadan is bitmis sayilmaz.

### 29. Otomatik veya Teknik Testler

- [ ] Telefon normalizasyon fonksiyonu test edilecek.
- [ ] Duplicate telefon kontrolu test edilecek.
- [ ] Grup create/update/delete test edilecek.
- [ ] Kisi create/update/delete test edilecek.
- [ ] Soft deleted kayitlarin listeden ve kampanyadan haric tutuldugu test edilecek.
- [ ] Excel import merge ve duplicate davranisi test edilecek.
- [ ] Migration mevcut veriyi kayipsiz tasiyor mu test edilecek.
- [ ] Atomic save hata durumunda eski DB'yi koruyor mu test edilecek.

### 30. Manuel Regresyon Testleri

- [ ] Login basarili ve hatali giris test edilecek.
- [ ] Login sonrasi yonlendirme test edilecek.
- [ ] WhatsApp QR bekleme ve connected state test edilecek.
- [ ] Yeni grup olusturma test edilecek.
- [ ] Grup silme test edilecek.
- [ ] Excel import test edilecek.
- [ ] Manuel kisi ekleme test edilecek.
- [ ] Kisi duzenleme test edilecek.
- [ ] Kisi silme test edilecek.
- [ ] Grup olarak kaydetme test edilecek.
- [ ] Kampanyada tek grup secme test edilecek.
- [ ] Kampanyada coklu grup secme test edilecek.
- [ ] Manuel kampanya numarasi girme test edilecek.
- [ ] Medya upload ve medya kaldirma test edilecek.
- [ ] Metin-only gonderim test edilecek.
- [ ] Metin + coklu medya gonderim test edilecek.
- [ ] Kampanya durdurma test edilecek.
- [ ] Progress %100 ve tamamlandi modali test edilecek.
- [ ] Uygulama restart sonrasi gruplar/kisiler korunuyor mu test edilecek.
- [ ] Deploy sonrasi gruplar/kisiler korunuyor mu test edilecek.

### 31. Teslim Kriterleri

- [ ] Kullanici istedigi adette grup ekleyebiliyor.
- [ ] Kullanici grup icinden herhangi bir kisiyi silebiliyor.
- [ ] Kullanici grup icindeki isim ve telefonu guncelleyebiliyor.
- [ ] Gruplar kullanici silmedikce kaybolmuyor.
- [ ] Kisiler kullanici silmedikce kaybolmuyor.
- [ ] Silinen grup/kisiler kampanya hedeflerine dahil edilmiyor.
- [ ] Deploy/restart sonrasi rehber ve gruplar korunuyor.
- [ ] Excel'den aktarilan kisiler grup adiyla kalici kaydedilebiliyor.
- [ ] Kampanya ekraninda birden fazla grup secilebiliyor.
- [ ] Secilen toplam numara sayisi dogru gosteriliyor.
- [ ] Manuel numara girisi grup secimiyle birlikte calisiyor.
- [ ] Mesaj + coklu medya gonderimi calisiyor.
- [ ] Progress bar tum gonderim bitince %100 oluyor.
- [ ] Gonderim bitince "Gonderiler tamamlandi" modali cikiyor.
- [ ] Login ve dashboard sonsuz loading durumuna dusmuyor.
- [ ] Site deploy sonrasi 503 veya sonsuz loading durumuna dusmuyor.
- [ ] Kod okunabilir, surdurulebilir ve gereksiz karmasiklik icermiyor.

---

## Yapilmamasi Gerekenler

- [ ] `database.sqlite` fiziksel olarak silinmeyecek.
- [ ] Mevcut production verisi backupsiz degistirilmeyecek.
- [ ] Her kucuk islem icin sinirsiz backup alinmayacak.
- [ ] Tek kisi guncellemek icin tum grup silinip yeniden yazilmayacak.
- [ ] Eski API endpointleri bir anda kaldirilmeyecek.
- [ ] Frontend tasarimi tekrar komple yikilmeyecek.
- [ ] Audit log'a tam telefon, tam isim veya mesaj icerigi gereksiz sekilde yazilmayacak.
- [ ] Soft deleted kisiler kampanya hedeflerine dahil edilmeyecek.
- [ ] Medya gonderim motoru veri kaliciligi fazinda gereksiz refactor edilmeyecek.
- [ ] Destructive Git veya dosya islemleri kullanici onayi olmadan yapilmayacak.

## Final Kontrol Sorulari

- Bu cozum veri kaybinin kok nedenini kapatiyor mu?
- Bu cozum bir yil sonra da bakimi kolay kalacak mi?
- Deploy ve restart sonrasi kullanici verisi korunuyor mu?
- Kisi ve grup islemleri tek kaydi etkileyebilecek kadar guvenli mi?
- Soft delete edilen kayitlar normal akislardan tamamen haric mi?
- Backup ve audit sistemi performansi sismirmeden calisiyor mu?
- Kod mevcut API ve frontend akislariyla geriye uyumlu mu?
- Guvenlik ve gizlilik gereksiz veri ifsasi olmadan saglaniyor mu?
