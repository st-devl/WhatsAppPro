# WhasAppC Sistem Inceleme Raporu

Tarih: 2026-04-30
Kapsam: Kod kalitesi, eksik/yarim yapilar, hata riski, deploy/runtime mimarisi ve test durumu.

## Dogrulama Ozeti

- `npm --prefix whatsapp-engine run lint`: basarili, 57 JS dosyasi kontrol edildi.
- `npm --prefix whatsapp-engine run migrate:status`: basarili, 13/13 migration uygulanmis, pending yok.
- `npm --prefix whatsapp-engine test`: basarili.
  - DB: 41/41
  - Message renderer: 4/4
  - Upload security: 7/7
  - Campaign safety: 6/6
  - HTTP integration: 9/9
  - Regression API: 20/20
- `npm --prefix whatsapp-engine run test:e2e`: basarili, 1 Playwright senaryosu gecti.
- `npm --prefix whatsapp-engine audit --omit=dev`: 0 vulnerability.
- `bash -n release.sh` ve `bash -n deploy.sh`: syntax hatasi yok.

## Kisa Sonuc

Uygulama cekirdek ozellikleri otomatik testlerde geciyor: auth, DB, grup/kisi CRUD, Excel import, medya guvenligi, kampanya guvenligi ve browser uzerinden temel UI akisi calisiyor. Incelemede en kritik sorun uygulama mantiginda degil, production runtime/deploy mimarisindeydi: public domain Hostinger Passenger altindaki `/home/u341720642/domains/yardimet.site/nodejs` kopyasini calistirirken eski release akisi `.builds/source/repository/whatsapp-engine` altini ve PM2 surecini saglikli sayabiliyordu. Bu rapor kapsaminda `hostinger-passenger` release hedefi eklenerek bu ayrim kod tarafinda kapatildi; production'da etkili olmasi icin bir sonraki deploy bu hedefle yapilmalidir.

## Uygulanan Duzeltmeler

- `release.sh` icine `hostinger-passenger` runtime eklendi. Bu hedef kodu Passenger app root'a kopyalar, `node_modules` bundle'ini orada kurar, Passenger `.env` dosyasini dogrular, `NODE_ENV=production`, `TRUST_PROXY=1`, `COOKIE_SECURE=true`, `WHASAPPC_DATA_DIR` degerlerini uygular, PM2 kalintilarini kapatir, migration'i Passenger app root'ta calistirir ve public `DEPLOY_REMOTE_HEALTH_URL` dogrulamasi olmadan production deploy'u basarili saymaz.
- `deploy.sh` artik bagimsiz deploy script'i degil; `release.sh` icin uyumluluk wrapper'i. Eski `--target`, `--local`, `--remote`, `--bump-patch`, `--commit-staged` bayraklarini yeni release akisine cevirir.
- Runtime data standardi genisletildi: `WHASAPPC_DATA_DIR` verildiginde DB, session store, WhatsApp auth session, uploads ve `media-store.json` ayni kalici veri kokunu kullanir.
- `MediaStore` RAM-only olmaktan cikarildi; tenant bazli medya secimi `media-store.json` dosyasina atomik rename ile yaziliyor ve restart sonrasi geri yukleniyor.
- `/healthz/details` auth arkasina alindi; public tarafta minimal `/healthz` ve `/readyz` kaldi.
- Login mesaj render'i `innerHTML` yerine DOM API ve `textContent` kullaniyor. Dashboard medya path attribute'lari escape edilerek HTML string'e yaziliyor.
- `scripts/migrate.js` artik app root'taki `.env` dosyasini yukluyor; Passenger altinda dogru `WHASAPPC_DATA_DIR` ile migration calisir.
- `docs/runtime-data-policy.md` ve `.env.example` kalici veri kokunu dokumante edecek sekilde guncellendi.
- `SESSION_STORE=sqlite` varsayilani, `app_sessions` migration'i ve production process lock eklendi; file session store artik sadece fallback.

## 1. Yarim, Eksik veya Calismayan Yapilar

### 1.1 Production deploy hedefi ile public runtime hedefi ayrismis

- Kanit: `release.sh` remote deploy'u `.builds/source/repository` altinda yapiyor ve PM2 ile `whatsapp-engine/index.js` baslatiyor (`release.sh:372-488`). Hostinger public `.htaccess` ise Passenger app root olarak `/home/u341720642/domains/yardimet.site/nodejs` kullaniyor.
- Etki: Release script'i yesil donebilir ama public site farkli kopyadan calisir. Bugunku 503, `SESSION_SECRET`, `TRUST_PROXY`, `ADMIN_EMAIL` sorunlari bu ayrimin pratik sonucu.
- Durum: Kod tarafinda giderildi. `DEPLOY_RUNTIME=hostinger-passenger` ile public Passenger hedefi birinci sinif deploy hedefi oldu. PM2 sadece `DEPLOY_RUNTIME=node` alternatifi olarak kaldi.
- Cozum: Bir sonraki production deploy bu runtime ile yapilmali ve eski PM2 surecinin kapali kaldigi dogrulanmali.

### 1.2 Runtime data politikasi production gercegiyle tam uyumlu degil

- Kanit: `docs/runtime-data-policy.md:25-26` production runtime data'nin persistent storage'da tutulacagini soyluyor. Docker tarafinda `WHASAPPC_DATA_DIR=/data` var (`Dockerfile:14-17`), fakat Passenger `.env` icin bu ayar garanti edilmiyor.
- Etki: DB, session, auth ve uploads app klasoru altinda kalirsa deploy veya panel publish akislari veri kaybi/ayrisma riski yaratir.
- Durum: Kod tarafinda giderildi. Passenger deploy `WHASAPPC_DATA_DIR` atar; DB, session, auth, uploads ve media-store bu kalici kokten calisir.
- Cozum: Production'da onerilen deger: `/home/u341720642/domains/yardimet.site/app-data`.

### 1.3 Coklu tenant altyapisi yarim scaffold durumunda

- Kanit: DB ve servislerde `tenant_id` var; ancak WhatsApp runtime sadece default tenant'i destekliyor (`whatsapp-engine/lib/whatsapp_runtime.js:35-37`).
- Etki: Kod coklu tenant destekliyormus gibi gorunuyor, fakat WhatsApp baglantisi tek tenant ile sinirli. Ileride yeni kullanici/tenant eklendiginde sessiz davranis farklari olusabilir.
- Cozum: Ya resmi olarak "single tenant" kabul edilip tenant parametreleri sadeletilmeli, ya da tenant basina WhatsApp session/runtime yonetimi tamamlanmali.

### 1.4 WhatsApp gercek gonderim senaryolari manuel olarak tamamlanmamis

- Kanit: `docs/a-dan-zye-task-list.md:362-365` metin-only, metin+coklu medya ve tamamlandi modali testleri isaretlenmemis.
- Etki: Otomatik testler is mantigini dogruluyor; ancak gercek WhatsApp cihaz/baglanti davranisi ve medya teslimi hala manuel kanit gerektiriyor.
- Cozum: Staging veya production disi bir test numarasi ile manuel checklist tamamlanmali; mumkunse Baileys socket'i mock'lanarak medya payload ve tamamlanma UI e2e testleri genisletilmeli.

## 2. Hic Yapilmamis veya Urun Boslugu Olan Yapilar

### 2.1 Public deploy dogrulamasi opsiyonel kalmis

- Kanit: `release.sh:527-530` `DEPLOY_REMOTE_HEALTH_URL` verilmezse public URL dogrulamasi atlanir.
- Etki: Remote ic health check gecerken public domain 503 verebilir; bu bugun gercekten yasandi.
- Durum: Kod tarafinda giderildi. Production deploy artik `DEPLOY_REMOTE_HEALTH_URL` olmadan baslamaz.
- Cozum: Hostinger icin `DEPLOY_REMOTE_HEALTH_URL=https://yardimet.site/readyz` kullanilmali.

### 2.2 Admin/env provisioning otomasyonu yok

- Kanit: `release.sh:159-183` local `whatsapp-engine/.env` dosyasini dogruluyor; public Passenger `.env` dosyasini olusturup dogrulamiyor.
- Etki: `SESSION_SECRET`, `TRUST_PROXY`, `COOKIE_SECURE`, `ADMIN_EMAIL`, `ADMIN_PASS_HASH` elle duzeltildi. Bu tekrar edilebilir bir operasyon degil.
- Durum: Kismen giderildi. `release.sh` Passenger `.env` dosyasini dogrular, zorunlu secret eksikse deploy'u durdurur ve guvenli runtime bayraklarini set eder. Secret uretimi bilincli olarak otomatik yapilmaz.
- Cozum: Ilk kurulum icin ayrica operator kontrollu bir provisioning alt komutu eklenebilir; deploy sirasinda secret olusturmak yerine eksik secret'i fail etmek daha guvenli davranistir.

### 2.3 Kampanya teslimat reconciliation/webhook yapisi yok

- Kanit: PRD'de kayip durum uzlasmasi hedefi var (`docs/prd.md:28`), ancak kodda mesaj teslim durumunu WhatsApp receipt/webhook benzeri kalici geri bildirimle uzlastiran servis yok.
- Etki: Sistem "sendMessage basarili" sonucunu gonderildi kabul ediyor; teslim/okundu/sonradan hata durumlari ayri takip edilmiyor.
- Cozum: Kampanya alici kayitlarina message id, provider status ve son receipt zamani eklenmeli. Baileys event'lerinden receipt dinlenip recipient status update edilmelidir.

## 3. Sistem Icinde Hata Cikarabilecek Yapilar

### 3.1 Sql.js dosya DB tek process varsayimina bagli

- Kanit: DB tek in-memory `SQL.Database` olarak aciliyor ve checkpoint ile dosyaya yaziliyor (`whatsapp-engine/lib/db.js:26-65`).
- Etki: Ayni DB dosyasini iki Node process acarsa son checkpoint kazanan olur; veri kaybi riski dogar. Passenger ve PM2 ayrimi devam ederse bu risk buyur.
- Durum: Kismen giderildi. Hostinger Passenger deploy PM2 sureclerini kapatir ve public Passenger disinda app baslatmaz. Sql.js halen tek process varsayimina baglidir.
- Cozum: Passenger tarafinda tek app instance politikasi korunmali; orta vadede gercek SQLite driver veya server DB karari verilmeli.

### 3.2 File session store coklu process icin guvenli degil

- Kanit: Session store tum session JSON'unu process hafizasinda tutup dosyaya rename ediyor (`whatsapp-engine/lib/session_store.js:13-43`).
- Etki: Birden fazla process ayni session dosyasini kullanirsa eski hafiza snapshot'i yeni sessionlari silebilir.
- Durum: Risk azaltilmisti ama tamamen bitmedi. Passenger hedefi PM2'yi kapatir; session store halen dosya tabanli ve coklu process icin transactional degil.
- Cozum: Tek process garantisi korunmali veya session store SQLite tablosuna alinmali.

### 3.3 MediaStore sadece hafizada

- Kanit: `MediaStore` sadece `Map` kullaniyor (`whatsapp-engine/lib/media_store.js:1-27`).
- Etki: Kullanici medya yukledikten sonra app restart olursa medya secimi kaybolur, dosyalar kalir ama UI/store bosalir. Kampanya basladiktan sonra metadata DB'ye kopyalaniyor; risk baslamadan onceki hazirlik asamasinda.
- Durum: Kod tarafinda giderildi. `MediaStore` `WHASAPPC_DATA_DIR/media-store.json` altinda tenant bazli kalici store kullanir.
- Cozum: Daha ileri adim olarak baslamamis medya secimleri DB kampanya taslagi modeline baglanabilir.

### 3.4 Public `healthz/details` bilgi sizdirabilir

- Kanit: `/healthz/details` auth olmadan runtime status ve lastError donduruyor (`whatsapp-engine/index.js:144-150`).
- Etki: WhatsApp runtime hata kodlari ve sistem durumu public izlenebilir.
- Durum: Kod tarafinda giderildi. `/healthz/details` artik `requireAuth` arkasinda.

### 3.5 Frontend'de guvenli olmayan `innerHTML` kaliplari var

- Kanit: Login mesajlari server text'ini HTML icine escape etmeden koyuyor (`whatsapp-engine/public/login.html:106-110`). Dashboard'da media path'leri de HTML string'e yaziliyor (`whatsapp-engine/public/js/dashboard.js:651-679`).
- Etki: Bugunku backend mesajlari genelde statik ve path'ler server uretimli oldugu icin risk dusuk; ancak pattern buyurse XSS riski dogurur.
- Durum: Kod tarafinda giderildi. Login mesajlari DOM API ile uretiliyor; dashboard medya path'leri escape ediliyor.

## 4. Amator/Yama Gibi Duran Kodlar

### 4.1 Deploy script'leri iki farkli dunya anlatiyor

- Kanit: `deploy.sh` hala Docker Compose remote deploy varsayiyor (`deploy.sh:326-390`), `release.sh` ise node bundle + PM2 akisi kullaniyor (`release.sh:353-488`).
- Etki: Ekip veya gelecek otomasyon yanlis script'i kullanirsa production farkli davranir.
- Durum: Kod tarafinda giderildi. `deploy.sh` artik `release.sh` wrapper'i.

### 4.2 Remote deploy icinde birikmis kriz onarimlari kalici mimariye donusmemis

- Kanit: `release.sh` remote working tree'de sadece belirli partial deploy kalintilarini temizliyor (`release.sh:390-397`), eksik dosyalari `git show HEAD:...` ile geri koyuyor (`release.sh:419-437`), node_modules bundle'i Mac'te hazirlayip remote'a aciyor (`release.sh:359-369`).
- Etki: Bu kodlar krizi toparladi ama Hostinger Passenger gercegini modellemiyor. Bir yil sonra bakildiginda "neden boyle" sorusu dogurur.
- Durum: Kismen giderildi. `docker`, `node` ve `hostinger-passenger` hedefleri ayrildi; `node` hedefi PM2 veya kullanici restart komutu icin kaldi.

### 4.3 `release.sh` gecici node_modules bundle temp cleanup eksik

- Kanit: `bundle_tmp="$(mktemp -d)"` olusturuluyor (`release.sh:359`), fonksiyon sonunda garanti `rm -rf` trap'i yok.
- Etki: Local makinede temp klasorleri kalabilir; kritik degil ama iscilik olarak eksik.
- Durum: Kod tarafinda giderildi. Bundle temp klasoru trap ile temizleniyor, tar olustururken `COPYFILE_DISABLE=1` kullaniliyor.

## Oncelikli Aksiyon Plani

1. Production runtime'i tekillestir: Hostinger Passenger kullanilacaksa `release.sh` public `/nodejs` hedefini deploy etsin, PM2 sureci kaldirilsin.
2. Persistent data path standardi getir: `WHASAPPC_DATA_DIR=/home/u341720642/domains/yardimet.site/app-data` gibi app kodundan ayri bir dizin kullan.
3. Production env provisioning'i otomatiklestir: zorunlu env'leri public runtime uzerinde dogrula, eksikse deploy'u durdur.
4. `DEPLOY_REMOTE_HEALTH_URL` production icin zorunlu olsun.
5. Session ve media store'u kalici/transactional hale getir veya tek process sinirini sert sekilde garanti et.
6. WhatsApp gercek gonderim manuel checklist'ini tamamla; medya ve tamamlanma modali icin E2E kapsam ekle.
7. Public detay health endpoint'ini kapat veya auth arkasina al.
8. Deploy script karmaşasini azalt: `deploy.sh` deprecated, `release.sh` hedef bazli sade mimariye tasinsin.
