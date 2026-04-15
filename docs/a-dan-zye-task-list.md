# WhasAppC Pro A'dan Z'ye Task List

Bu dokuman, sistemin rehber/grup kaliciligi, kampanya akisi, medya yonetimi ve frontend profesyonellestirme kapsaminda yapilmasi gerekenleri eksiksiz takip etmek icin hazirlanmistir.

Temel kural: Mevcut calisan hicbir ozellik, buton, modal, form alani, API endpointi veya Socket.IO eventi kaybolmayacak. Yeni gelistirmeler sistemi daha guvenli, daha kalici, daha hizli ve daha anlasilir hale getirecek.

## 1. Mevcut Sistemi Inceleme

- [ ] Mevcut `whatsapp-engine/public/index.html` frontend yapisini buton buton incele.
- [ ] Mevcut `whatsapp-engine/public/login.html` login akisini incele.
- [ ] Mevcut `whatsapp-engine/index.js` API ve Socket.IO endpointlerini incele.
- [ ] Mevcut `whatsapp-engine/lib/db.js` veritabani katmanini incele.
- [ ] Mevcut `whatsapp-engine/lib/messenger.js` mesaj gonderim akisini incele.
- [ ] Mevcut `whatsapp-engine/lib/connection.js` WhatsApp baglanti akisini incele.
- [ ] Mevcut SQLite dosyasinin konumunu, schema yapisini ve deploy davranisini dogrula.
- [ ] Veri kaybi riski olan tum noktalarin listesini cikar.
- [ ] Mevcut frontend id, onclick, class ve JS fonksiyon bagimliliklarini not al.
- [ ] Mevcut kullanici akislarini bozmadan hangi alanlarin refactor edilecegini belirle.

## 2. Veri Kaliciligi ve Deploy Guvenligi

- [ ] `whatsapp-engine/data/database.sqlite` dosyasinin deploy sirasinda silinmeyecek sekilde konumlandirildigini dogrula.
- [ ] Veritabani dosyasinin Git tarafindan yanlislikla overwrite edilmesini engelle.
- [ ] Gerekirse `whatsapp-engine/.gitignore` icine `data/database.sqlite` ve backup klasorlerini ekle.
- [ ] Eger database dosyasi Git tarafindan takip ediliyorsa, dosyayi fiziksel olarak silmeden sadece Git takibinden cikarmak icin plan hazirla.
- [ ] Deploy sonrasi rehber/grup verisinin kalip kalmadigini test et.
- [ ] Veritabani dosyasinin uygulama restart sonrasi korundugunu test et.
- [ ] Production ortamda kalici volume/disk kullanimi gerekip gerekmedigini dokumante et.
- [ ] Kritik veri dosyalarinin `auth`, `uploads`, `data` ile birlikte deploy stratejisini belirle.

## 3. Otomatik Yedekleme

- [ ] `whatsapp-engine/data/backups/` gibi kalici bir backup klasoru olustur.
- [ ] Grup olusturma, grup guncelleme, grup silme, kisi silme, toplu import gibi kritik islemlerden once otomatik backup al.
- [ ] Backup dosya adina tarih/saat ekle.
- [ ] Backup islemi basarisiz olursa kritik islemi durdur veya kullaniciya acik hata ver.
- [ ] Backup sayisini sinirlayacak retention kuralini belirle.
- [ ] Eski backuplari kontrollu sekilde temizle.
- [ ] Backup dosyalarini uygulama loglarinda takip edilebilir yap.
- [ ] Geri yukleme prosedurunu dokumante et.

## 4. Veritabani Migration Sistemi

- [ ] `schema_migrations` tablosu olustur.
- [ ] Her migration icin benzersiz migration id kullan.
- [ ] Migrationlar idempotent olmali, ayni migration ikinci kez calistiginda sistemi bozmamali.
- [ ] Migrationlar uygulama baslangicinda guvenli sekilde calismali.
- [ ] Migration basarisiz olursa uygulama hatayi saklamamali, acikca loglamali.
- [ ] Migration oncesi otomatik backup alinmali.
- [ ] Eski veri yeni schema'ya kayipsiz tasinmali.

## 5. Profesyonel Grup Modeli

- [ ] Gruplar icin kalici ve profesyonel tablo yapisi netlestir.
- [ ] Her grup icin benzersiz `id` kullan.
- [ ] Grup adi zorunlu olmali.
- [ ] Grup adi bos string veya sadece bosluk olamamali.
- [ ] Grup adlari normalize edilerek duplicate kontrolu yapilmali.
- [ ] Grup icin `created_at` alani olmali.
- [ ] Grup icin `updated_at` alani olmali.
- [ ] Grup icin `deleted_at` soft delete alani olmali.
- [ ] Kullanici kendi istemedikce grup fiziksel olarak silinmemeli.
- [ ] Grup silme islemi soft delete ile yapilmali.
- [ ] Soft deleted gruplar normal listede gorunmemeli.
- [ ] Gerekirse ileride geri alma icin soft deleted veri korunmali.

## 6. Profesyonel Kisi Modeli

- [ ] Kisiler icin kalici ve profesyonel tablo yapisi netlestir.
- [ ] Her kisi icin benzersiz `id` kullan.
- [ ] Kisi bir `group_id` ile gruba bagli olmali.
- [ ] Kisi adi opsiyonel ama temizlenmis string olmali.
- [ ] Soyad ayrimi mevcut veriyle uyumlu sekilde desteklenmeli.
- [ ] Telefon alani zorunlu olmali.
- [ ] Telefon normalize edilmis `normalized_phone` alaniyla saklanmali.
- [ ] Telefon duplicate kontrolu normalized phone uzerinden yapilmali.
- [ ] Her kisi icin `created_at` alani olmali.
- [ ] Her kisi icin `updated_at` alani olmali.
- [ ] Her kisi icin `deleted_at` soft delete alani olmali.
- [ ] Grup icinde ayni telefon numarasi ikinci kez eklenmemeli.
- [ ] Kisi silme islemi soft delete ile yapilmali.
- [ ] Kullanici istemedikce kisi verisi fiziksel olarak silinmemeli.

## 7. Telefon Normalizasyonu

- [ ] Telefon numaralarindan bosluk, tire, parantez, arti ve harf disi karakterleri temizle.
- [ ] Sadece rakam kalan normalize degeri sakla.
- [ ] Minimum telefon uzunlugu validasyonu uygula.
- [ ] Turkiye numaralari icin `90` ile baslayan formati destekle.
- [ ] Excel ve manuel giris ayni normalize fonksiyonunu kullanmali.
- [ ] Kampanya hedef listesinde duplicate numaralar tekilleştirilmeli.
- [ ] Hatali telefon formatlari kullaniciya acik mesajla bildirilmeli.

## 8. Transaction ve Veri Butunlugu

- [ ] Grup olusturma ve kisi ekleme islemlerinde transaction kullan.
- [ ] Excel import islemini transaction icinde yap.
- [ ] Toplu kisi guncelleme islemini transaction icinde yap.
- [ ] Bir islem yarida kalirsa veritabani tutarsiz durumda kalmamali.
- [ ] Basarisiz import sonucunda kismen eklenmis veri birakilmamali.
- [ ] Duplicate ve validation hatalari transaction baslamadan mumkun oldugunca ayiklanmali.
- [ ] Veritabani yazma hatalari kullaniciya saklanmadan acikca gosterilmeli.

## 9. Audit Log

- [ ] Kritik veri islemleri icin audit log tablosu olustur.
- [ ] Grup olusturma audit log kaydi tut.
- [ ] Grup guncelleme audit log kaydi tut.
- [ ] Grup silme audit log kaydi tut.
- [ ] Kisi ekleme audit log kaydi tut.
- [ ] Kisi guncelleme audit log kaydi tut.
- [ ] Kisi silme audit log kaydi tut.
- [ ] Excel import audit log kaydi tut.
- [ ] Audit log kaydinda tarih, aksiyon, hedef id, ozet bilgi tutulmali.
- [ ] Audit log sistemi performansi sismirmemeli.

## 10. DB Katmani Refactor

- [ ] `lib/db.js` icinde veritabani sorumluluklarini temiz ayir.
- [ ] Grup CRUD fonksiyonlarini tek yerde topla.
- [ ] Kisi CRUD fonksiyonlarini tek yerde topla.
- [ ] Template fonksiyonlarini mevcut davranisi bozmadan koru.
- [ ] Kampanya durum/veri fonksiyonlarini mevcut davranisi bozmadan koru.
- [ ] Raw SQL kullaniliyorsa parametreli query kullan.
- [ ] DB fonksiyonlari controller icine dagilmamali.
- [ ] Hatalar DB katmanindan anlamli sekilde yukari tasinmali.

## 11. Grup API'leri

- [ ] `GET /api/groups` aktif gruplari ve aktif kisileri dondurmeli.
- [ ] `POST /api/groups` yeni grup olusturmali.
- [ ] `PUT /api/groups/:id` mevcut grubu guncellemeli.
- [ ] `DELETE /api/groups/:id` grubu soft delete yapmali.
- [ ] Grup adi bos ise API hata dondurmeli.
- [ ] Duplicate grup adi varsa API hata dondurmeli veya kontrollu davranmali.
- [ ] Silinmis grup tekrar listelenmemeli.
- [ ] Grup silindiginde kampanya hedef seciminde gorunmemeli.
- [ ] API response formatlari frontend ile uyumlu kalmali.

## 12. Kisi API'leri

- [ ] Gerekirse `POST /api/groups/:id/contacts` kisi ekleme endpointi olustur.
- [ ] Gerekirse `PUT /api/groups/:id/contacts/:contactId` kisi guncelleme endpointi olustur.
- [ ] Gerekirse `DELETE /api/groups/:id/contacts/:contactId` kisi silme endpointi olustur.
- [ ] Mevcut `PUT /api/groups/:id` davranisi bozulmadan geriye uyumluluk sagla.
- [ ] Kisi silme soft delete olmali.
- [ ] Kisi guncelleme ad, soyad, telefon alanlarini desteklemeli.
- [ ] Telefon guncellenirse duplicate kontrolu yapilmali.
- [ ] API hatalari frontend tarafinda anlasilir sekilde gosterilmeli.

## 13. Excel Import

- [ ] Excel yukleme mevcut `POST /api/upload-excel` endpointiyle calismaya devam etmeli.
- [ ] Excel icindeki ad/soyad/telefon kolonlari esnek okunmali.
- [ ] Bos satirlar yok sayilmali.
- [ ] Hatali telefonlu satirlar raporlanmali.
- [ ] Duplicate numaralar tekillestirilmeli.
- [ ] Import sonucu kac yeni kisi eklendigi gosterilmeli.
- [ ] Yeni kisi yoksa kullanici bilgilendirilmeli.
- [ ] Excel import mevcut aktif listeyle merge edilmeli.
- [ ] Import sonrasi kullanici grup adi vererek kaydedebilmeli.
- [ ] Import direkt kalici gruba yapiliyorsa transaction kullanilmali.

## 14. Grup Adi Ver ve Kaydet Akisi

- [ ] Rehber ekranindaki "Grup Adi Ver & Kaydet" karti korunmali.
- [ ] Kisi listesi bos ise hata gostermeli.
- [ ] Modal acildiginda kac kisi kaydedilecegi gosterilmeli.
- [ ] Grup adi zorunlu olmali.
- [ ] Ayni isimde grup varsa kullanicidan onay alinmali.
- [ ] Yeni grup gerekiyorsa grup olusturulmali.
- [ ] Kisiler hedef gruba kaydedilmeli.
- [ ] Kayit sonrasi grup listesi yenilenmeli.
- [ ] Kaydedilen grup aktif secili hale gelmeli.
- [ ] Kaydedilen grup kampanya hedeflerinde secilebilir olmali.
- [ ] Basarili islem toast ile bildirilmeli.

## 15. Rehber Grup Yonetimi

- [ ] Rehber ekraninda "Gruplarim" sidebar korunmali.
- [ ] Yeni grup "+" butonu korunmali.
- [ ] Grup satiri tiklaninca grup secilmeli.
- [ ] Aktif grup gorsel olarak ayirt edilmeli.
- [ ] Grup satirinda kisi sayisi gosterilmeli.
- [ ] Grup silme "X" butonu korunmali.
- [ ] Grup silme oncesi confirm alinmali.
- [ ] Grup silinirse aktif secim temizlenmeli.
- [ ] Grup silinirse kampanya hedef seciminden de cikmali.
- [ ] Grup listesi bos ise "Henuz grup yok" state'i korunmali.
- [ ] Grup yuklenemezse hata state'i korunmali.

## 16. Rehber Kisi Yonetimi

- [ ] Rehber ekranindaki kisi tablosu korunmali.
- [ ] Kolonlar korunmali: Sira, Ad Soyad, Telefon, Islem.
- [ ] Grup secilmemisse "Lutfen Yandan Bir Grup Secin" state'i korunmali.
- [ ] Grup bossa "Rehber Bos" state'i korunmali.
- [ ] Kisi silme butonu korunmali.
- [ ] Kisi silme islemi soft delete veya guvenli kayit guncelleme ile yapilmali.
- [ ] Kullanici grup icindeki kisi adini guncelleyebilmeli.
- [ ] Kullanici grup icindeki kisi telefonunu guncelleyebilmeli.
- [ ] Kisi guncelleme duplicate telefon kontrolu yapmali.
- [ ] Kisi guncelleme sonrasi tablo ve kampanya hedef sayilari yenilenmeli.
- [ ] Kisi listesi buyudugunde UI sismemeli.

## 17. Manuel Kisi Ekleme

- [ ] "Manuel Ekle" karti korunmali.
- [ ] "Yeni Kayit" modali korunmali.
- [ ] "Ad Soyad" inputu korunmali.
- [ ] "905xxxxxxxxx" telefon inputu korunmali.
- [ ] "Iptal" butonu korunmali.
- [ ] "Ekle" butonu korunmali.
- [ ] Ad veya telefon gecersizse hata toast'i gosterilmeli.
- [ ] Duplicate numara varsa bilgi toast'i gosterilmeli.
- [ ] Basarili eklemede modal kapanmali.
- [ ] Aktif grup varsa backend'e kaydedilmeli.
- [ ] Aktif grup yoksa gecici listeye eklenmeli ve sonra grup olarak kaydedilebilmeli.

## 18. Kampanya Hedef Grup Secimi

- [ ] Kampanya ekranindaki "Hedef Gruplar" bolumu korunmali.
- [ ] Her grup checkbox karti olarak gosterilmeli.
- [ ] Kullanici birden fazla grup secebilmeli.
- [ ] Secilen gruplardaki numaralar birlestirilmeli.
- [ ] Duplicate telefonlar tekillestirilmeli.
- [ ] Her grup kartinda grup adi ve numara sayisi gosterilmeli.
- [ ] Grup yoksa "Henuz kayitli grup yok" state'i korunmali.
- [ ] Grup yuklenirken "Gruplar yukleniyor..." state'i korunmali.
- [ ] Secilen grup sayisi manuel numara bilgilendirme alaninda gosterilmeli.
- [ ] "Toplam X numara secildi" sayaci dinamik calismali.

## 19. Manuel Kampanya Numaralari

- [ ] Kampanya ekraninda "Elle Numara Gir" alani korunmali.
- [ ] Textarea sadece rakam ve virgule izin vermeli.
- [ ] Placeholder korunmali: `905320000000,905330000000,905340000000`.
- [ ] Virgulle ayrilan her numara hedef listeye eklenmeli.
- [ ] Manuel numara sayaci dinamik guncellenmeli.
- [ ] Manuel numaralar grup numaralariyla merge edilmeli.
- [ ] Duplicate manuel numaralar tekillestirilmeli.
- [ ] Gecersiz numaralar kampanya baslatmada engellenmeli veya temizlenmeli.

## 20. Mesaj ve Sablon Akisi

- [ ] Mesaj textarea'si korunmali.
- [ ] `{{ad}}` etiketi korunmali.
- [ ] `{A|B|C}` varyasyon placeholder mantigi korunmali.
- [ ] Telefon onizlemesi mesaj yazildikca guncellenmeli.
- [ ] "Sablonlar" dropdown korunmali.
- [ ] `GET /api/templates` ile sablonlar yuklenmeli.
- [ ] Sablon secilince mesaj alani dolmali.
- [ ] "Sablon Kaydet" butonu korunmali.
- [ ] "Sablon Kaydet" modali korunmali.
- [ ] Sablon adi inputu korunmali.
- [ ] Modal "Iptal" ve "Kaydet" butonlari korunmali.
- [ ] `POST /api/templates` ile sablon kaydi yapilmali.
- [ ] Kayit sonrasi sablon listesi yenilenmeli.

## 21. Medya Upload Akisi

- [ ] "MEDYA EKLE" butonu korunmali.
- [ ] Coklu medya secimi korunmali.
- [ ] `image/*` ve `video/*` kabul edilmeli.
- [ ] Medya yuklenirken loading/spinner gosterilmeli.
- [ ] Upload sirasinda medya butonu disabled olmali.
- [ ] Upload basariliysa kac medya yuklendigi gosterilmeli.
- [ ] Upload hatasi toast ve status alaniyla gosterilmeli.
- [ ] Medya preview alani korunmali.
- [ ] Her medyanin sag ustunde "x" kaldirma butonu olmali.
- [ ] Kaldirma butonu ilgili medya path'i ile `DELETE /api/upload-media` cagirmali.
- [ ] Kaldirilan medya listeden silinmeli.
- [ ] Medya kalmazsa status idle hale donmeli.
- [ ] Telefon onizlemesinde ilk medya gosterilmeli.
- [ ] Gorsel ve video onizlemesi dogru ayrilmali.

## 22. Mesaj Gonderim Motoru Entegrasyonu

- [ ] Kampanya baslatirken hedef contacts dogru olusturulmali.
- [ ] Payload icinde `contacts`, `message`, `delayRange`, `dailyLimit` olmali.
- [ ] `start-bulk` Socket.IO eventi korunmali.
- [ ] `stop-bulk` Socket.IO eventi korunmali.
- [ ] Mesaj ve medya birlikte gonderilebilmeli.
- [ ] Birden fazla medya varsa tum medyalar gonderilmeli.
- [ ] Ilk medyaya caption/metin eklenmeli.
- [ ] Sonraki medyalar metinsiz gonderilebilmeli.
- [ ] Metin-only kampanya calismali.
- [ ] Medya-only kampanya davranisi netlestirilmeli.
- [ ] Gonderim hatalari loglara dusmeli.

## 23. Kampanya Baslat/Durdur UI

- [ ] "BASLAT" butonu korunmali.
- [ ] WhatsApp bagli degilse buton disabled olmali.
- [ ] QR bekleniyorsa buton metni "QR OKUTUN" olmali.
- [ ] Bagli degilse buton metni "WHATSAPP BAGLI DEGIL" olmali.
- [ ] Sunucu baglantisi yoksa buton metni "SUNUCU BAGLANTISI YOK" olmali.
- [ ] WhatsApp bagliysa buton aktif ve "BASLAT" olmali.
- [ ] Mesaj veya hedef yoksa kampanya baslatilmamali.
- [ ] Baslatinca "BASLAT" gizlenmeli.
- [ ] Baslatinca "DURDUR" gosterilmeli.
- [ ] "DURDUR" butonu korunmali.
- [ ] Durdurunca `stop-bulk` eventi gonderilmeli.
- [ ] Durdurulunca "BASLAT" geri gosterilmeli.

## 24. Progress ve Tamamlandi Modali

- [ ] Progress kutusu baslangicta gizli olmali.
- [ ] Kampanya baslayinca progress kutusu gosterilmeli.
- [ ] Progress yuzdesi Socket.IO log eventinden guncellenmeli.
- [ ] Progress bar genisligi yuzdelik degerle guncellenmeli.
- [ ] Tum gonderim bitince progress kesin olarak `%100` olmali.
- [ ] Tum gonderim bitince "Gonderiler tamamlandi" modali acilmali.
- [ ] Modal ortada ve net gorunmeli.
- [ ] Modal aciklamasi korunmali: "Tum hedefler islendi. Ilerleme %100 olarak tamamlandi."
- [ ] "Tamam" butonu modali kapatmali.
- [ ] Aktif kampanya recover edilirse progress ve loglar geri yuklenmeli.

## 25. WhatsApp Baglanti UI

- [ ] QR canvas alani korunmali.
- [ ] "QR Bekleniyor..." loading metni korunmali.
- [ ] Baglaninca yesil check gosterilmeli.
- [ ] Baglanti status badge'i korunmali.
- [ ] Sol panelde baglanti indikator noktasi korunmali.
- [ ] `GET /api/runtime-status` periyodik olarak calismali.
- [ ] Socket `qr` eventi QR'i render etmeli.
- [ ] Socket `status` eventi UI durumunu guncellemeli.
- [ ] Socket connect error durumunda hata state'i gosterilmeli.
- [ ] "Baglantiyi Sifirla" butonu confirm ile calismali.

## 26. Sistem Loglari

- [ ] Sistem log paneli korunmali.
- [ ] Baslik korunmali: "Sistem Loglari".
- [ ] Kapatma "X" butonu korunmali.
- [ ] Baslangic log metni korunmali: `>> Bekleniyor...`.
- [ ] Error loglari kirmizi gosterilmeli.
- [ ] Success loglari yesil gosterilmeli.
- [ ] Wait loglari amber/sari gosterilmeli.
- [ ] Info/default loglari gri gosterilmeli.
- [ ] Loglar yeni gelen en ustte veya tutarli bir sirada gosterilmeli.
- [ ] Log paneli buyuk log sayisinda performansi dusurmemeli.

## 27. Frontend Profesyonel Tasarim

- [ ] Login sayfasi daha kurumsal ve guven veren hale getirilmeli.
- [ ] Dashboard layout'u daha modern ve okunabilir hale getirilmeli.
- [ ] Navbar status alanlari daha net tasarlanmali.
- [ ] Sol QR ve telefon onizleme paneli daha profesyonel olmali.
- [ ] Kampanya hazirlama ekraninda aksiyon hiyerarsisi net olmali.
- [ ] Rehber ekraninda grup ve kisi yonetimi daha kullanisli olmali.
- [ ] Tum butonlar belirgin hit-area'ya sahip olmali.
- [ ] Loading, disabled, success, error ve empty state'ler net olmali.
- [ ] Tehlikeli islemler kirmizi/uyari diliyle ayrilmali.
- [ ] Mobil uyumluluk saglanmali.
- [ ] Tablet ve desktop layoutlari test edilmeli.
- [ ] Gereksiz gorsel kalabalik azaltılmali.
- [ ] Tipografi, renk ve spacing sistemi tutarli olmali.
- [ ] Mevcut id ve JS bagimliliklari korunmali veya eksiksiz guncellenmeli.

## 28. Login Akisi

- [ ] E-posta inputu korunmali.
- [ ] Sifre inputu korunmali.
- [ ] "Giris Yap" butonu korunmali.
- [ ] Login submit sirasinda buton disabled olmali.
- [ ] Submit sirasinda metin "Giris yapiliyor..." olmali.
- [ ] Basarili login sonrasi "Giris basarili! Oturum dogrulaniyor..." mesaji gosterilmeli.
- [ ] `/api/check-auth` ile oturum dogrulamasi yapilmali.
- [ ] Oturum hazirsa dashboard'a yonlendirmeli.
- [ ] Oturum dogrulamasi gecikirse hata mesaji gosterilmeli.
- [ ] Kullanici zaten login ise login sayfasi dashboard'a yonlendirmeli.
- [ ] Hata durumunda buton tekrar aktif olmali.

## 29. API Hata Yonetimi

- [ ] Tum frontend fetch cagri hatalari yakalanmali.
- [ ] Timeout gerektiren fetchlerde timeout korunmali.
- [ ] API hata mesajlari kullaniciya toast veya inline state ile gosterilmeli.
- [ ] JSON parse hatalari uygulamayi kitlememeli.
- [ ] Offline/sunucu yok durumunda UI anlasilir hata vermeli.
- [ ] Kritik islemlerde basarisiz cevap veri kaybina yol acmamali.
- [ ] Backend hatalari loglanmali.

## 30. Guvenlik ve Gizlilik

- [ ] Auth gerektiren sayfalar session kontroluyle korunmali.
- [ ] API endpointleri auth middleware arkasinda kalmali.
- [ ] Kullanici inputlari sanitize edilmeli.
- [ ] HTML injection riskleri escape edilmeli.
- [ ] Telefon ve isim verileri gereksiz sekilde loglanmamali.
- [ ] Upload edilen medya dosyalari sadece izinli tiplerde olmali.
- [ ] Silme islemleri confirm veya net geri bildirimle korunmali.
- [ ] Kritik veri aksiyonlari backup/audit ile izlenmeli.

## 31. Performans ve Sismeme Kurallari

- [ ] Buyuk grup listelerinde UI donmamali.
- [ ] Buyuk kisi listelerinde tablo performansi dusmemeli.
- [ ] Gerekirse pagination, virtual scroll veya arama planlanmali.
- [ ] Gereksiz API cagrisindan kacınılmali.
- [ ] Grup listesi ve kampanya hedef listesi ayni kaynaktan tutarli beslenmeli.
- [ ] Medya preview'leri gereksiz buyuk dosya transferi yaratmamali.
- [ ] Log listesi sinirsiz buyuyup DOM'u sismirmemeli.
- [ ] Veritabani sorgularinda gerekli indexler eklenmeli.
- [ ] Normalized phone ve group_id icin index planlanmali.

## 32. Test Senaryolari

- [ ] Login basarili akisi test edilmeli.
- [ ] Login hatali sifre akisi test edilmeli.
- [ ] Login sonrasi yonlendirme test edilmeli.
- [ ] WhatsApp QR bekleme state'i test edilmeli.
- [ ] WhatsApp connected state'i test edilmeli.
- [ ] Baglantiyi sifirla akisi test edilmeli.
- [ ] Yeni grup olusturma test edilmeli.
- [ ] Duplicate grup adi test edilmeli.
- [ ] Grup silme test edilmeli.
- [ ] Excel import test edilmeli.
- [ ] Duplicate numarali Excel import test edilmeli.
- [ ] Manuel kisi ekleme test edilmeli.
- [ ] Duplicate manuel kisi test edilmeli.
- [ ] Kisi silme test edilmeli.
- [ ] Kisi guncelleme test edilmeli.
- [ ] Grup olarak kaydetme test edilmeli.
- [ ] Mevcut grup uzerine yazma onayi test edilmeli.
- [ ] Kampanyada tek grup secme test edilmeli.
- [ ] Kampanyada coklu grup secme test edilmeli.
- [ ] Kampanyada manuel numara girme test edilmeli.
- [ ] Grup + manuel numara merge/dedupe test edilmeli.
- [ ] Sablon kaydetme test edilmeli.
- [ ] Sablon secme test edilmeli.
- [ ] Medya upload test edilmeli.
- [ ] Birden fazla medya upload test edilmeli.
- [ ] Medya kaldirma test edilmeli.
- [ ] Metin-only gonderim test edilmeli.
- [ ] Metin + gorsel gonderim test edilmeli.
- [ ] Metin + iki gorsel gonderim test edilmeli.
- [ ] Video medya gonderimi test edilmeli.
- [ ] Kampanya durdurma test edilmeli.
- [ ] Progress %100 tamamlanma test edilmeli.
- [ ] Tamamlandi modali test edilmeli.
- [ ] Uygulama restart sonrasi gruplar kaldi mi test edilmeli.
- [ ] Deploy sonrasi gruplar kaldi mi test edilmeli.

## 33. Dokumantasyon

- [ ] Rehber/grup veri modelini dokumante et.
- [ ] Backup stratejisini dokumante et.
- [ ] Deployda korunmasi gereken klasorleri dokumante et.
- [ ] API endpointlerini dokumante et.
- [ ] Frontend buton ve ekran akislarini dokumante et.
- [ ] Kampanya gonderim akisinda hedeflerin nasil secildigini dokumante et.
- [ ] Excel import formatini dokumante et.
- [ ] Veri kaybi durumunda geri yukleme adimlarini dokumante et.
- [ ] Test edilen senaryolari dokumante et.

## 34. Uygulama Sirasi

- [ ] Once mevcut veri ve schema yedeklenmeli.
- [ ] Sonra deploy veri kaliciligi garanti altina alinmali.
- [ ] Sonra migration sistemi eklenmeli.
- [ ] Sonra grup ve kisi modelinin kalici/profesyonel hali uygulanmali.
- [ ] Sonra API katmani guclendirilmeli.
- [ ] Sonra Excel/manual import akislarina veri butunlugu eklenmeli.
- [ ] Sonra frontend rehber yonetimi guncellenmeli.
- [ ] Sonra kampanya hedef grup secimi dogrulanmali.
- [ ] Sonra medya ve mesaj gonderim akisi tekrar test edilmeli.
- [ ] Sonra frontend profesyonel tasarim uygulanmali.
- [ ] En sonda tam regresyon testleri yapilmali.

## 35. Teslim Kriterleri

- [ ] Kullanici istedigi adette grup ekleyebiliyor.
- [ ] Kullanici grup icinden herhangi bir kisiyi silebiliyor.
- [ ] Kullanici grup icindeki isim ve telefonu guncelleyebiliyor.
- [ ] Gruplar kullanici silmedikce silinmiyor.
- [ ] Kisiler kullanici silmedikce silinmiyor.
- [ ] Deploy/restart sonrasi rehber ve gruplar korunuyor.
- [ ] Excel'den aktarilan kisiler grup adiyla kalici kaydedilebiliyor.
- [ ] Kampanya ekraninda birden fazla grup checkbox ile secilebiliyor.
- [ ] Secilen toplam numara sayisi dinamik gosteriliyor.
- [ ] Manuel numara girisi grup secimiyle birlikte calisiyor.
- [ ] Medya upload loading durumu net gorunuyor.
- [ ] Eklenen medyalar X ile kaldirilabiliyor.
- [ ] Mesaj + coklu medya gonderimi calisiyor.
- [ ] Progress bar tum gonderim bitince %100 oluyor.
- [ ] Gonderim bitince "Gonderiler tamamlandi" modali cikiyor.
- [ ] Login ve dashboard loading/redirect sorunlari tekrar olusmuyor.
- [ ] Site deploy sonrasi 503 veya sonsuz loading durumuna dusmuyor.
- [ ] Kod okunabilir, surdurulebilir ve gereksiz karmasiklik icermiyor.

## 36. Final Kontrol

- [ ] Bu cozum sadece patch degil, kok neden cozumudur.
- [ ] Bu cozum bir yil sonra da dogru kalacak sekilde tasarlanmistir.
- [ ] Sistem buyudugunde veri modeli ve UI sismeyecek sekildedir.
- [ ] Gereksiz komplekslik veya duplicate kod yoktur.
- [ ] Kod okunabilir ve bakimi kolaydir.
- [ ] Guvenlik ve veri butunlugu korunmustur.
- [ ] Performans darboğazi olusturacak tasarimlardan kacinilmistir.
- [ ] Kullanici verisi istenmeden silinmeyecek sekilde korunmustur.
- [ ] Mevcut butonlar, modallar, formlar ve akislar eksiksiz korunmustur.
