# WhasAppC Kalan Riskler ve Gercekci Aksiyon Raporu

Tarih: 2026-04-30
Kapsam: WhatsApp gercek gonderim, tenant stratejisi, DB/session kaliciligi, teslimat takibi ve gereksiz/erken yapilar.

## Kisa Karar

Sistemi bugun "mukemmel" yapmak icin her seyi buyutmek dogru degil. En dogru yol, once production gercegine uygun tek process ve single-tenant calisma modelini netlestirmek, sonra yalnizca gercek ihtiyac dogunca DB ve coklu tenant gibi buyuk mimari tasimalara girmektir.

Bu rapordaki onerilen ana strateji:

- Kisa vadede: Sistemi tek tenant, tek process, kalici veri dizini ve operator kontrollu WhatsApp hesabi ile stabil calistir.
- Orta vadede: Teslimat takibini "submitted/delivered/read" ayrimina hazirla, gercek WhatsApp test checklist'ini zorunlu release adimi yap. Session store DB'ye alinmistir; production'da bunun dogrulanmasi gerekir.
- Uzun vadede: Coklu musteri/tenant veya yuksek concurrency gercekten gerekirse DB ve runtime mimarisini buyut.

## Oncelik Matrisi

| Konu | Bugunku Risk | Oncelik | Onerilen Karar |
| --- | --- | --- | --- |
| Gercek WhatsApp gonderim testi | Otomatik testler provider davranisini kanitlamaz | P0 | Production deploy sonrasi manuel smoke test zorunlu |
| Coklu tenant | Kodda scaffold var, runtime tek tenant | P1 | Simdilik single-tenant ilan et, yeni multi-tenant UI/API acma |
| Sql.js DB | Tek process varsayimina bagli | P1 | Tek process'i garanti et; buyume olursa SQLite driver/Postgres'e gec |
| File session store | Coklu process icin uygun degil | P1 | DB-backed session store eklendi; file store sadece fallback |
| Teslimat/okundu reconciliation | "sendMessage resolved" basari sayiliyor | P2 | Once submitted status, sonra best-effort receipt takibi |
| Legacy `/api` namespace | Geriye uyumluluk icin iki API yuzeyi var | P2 | 2026-09-30 sunset takvimine gore kaldir |
| Tenant tablolarinin fazlaligi | Single-tenant icin fazla gorunuyor | P3 | Hemen silme; gizli altyapi olarak dondur |

## 1. WhatsApp Gercek Gonderim Senaryolari

### Mevcut Durum

Kod tarafinda kampanya akisi test ediliyor, fakat Baileys/WhatsApp Web davranisi otomatik testlerle tam kanitlanamaz. Gercek QR oturumu, WhatsApp rate davranisi, medya payload'i, cihaz baglantisi, baglanti kopmasi ve WhatsApp tarafindaki teslim sinyalleri mutlaka manuel kanit ister.

### Yapilmasi Gerekenler

Release sonrasi zorunlu manuel smoke test eklenmeli:

1. QR ile baglan.
2. `/readyz` sonucu `ok: true` ve WhatsApp durumu `connected` veya beklenen durum olsun.
3. Tek test kisisiyle sadece metin gonder.
4. Tek test kisisiyle metin + resim gonder.
5. Tek test kisisiyle metin + video gonder.
6. 3-5 kisilik kucuk kampanya baslat.
7. Stop, resume ve retry akisini dene.
8. Kampanya sonunda UI sayaci, log ve DB status degerlerini karsilastir.
9. App restart sonrasi login, WhatsApp durum, medya secimi ve son kampanya status'unu kontrol et.

### Gereksiz Olan

Bu asamada WhatsApp'i tamamen otomatik e2e test etmek icin gercek cihaz veya gercek WhatsApp hesabi ile CI kurmak gereksiz ve kirilgan olur. Dogru olan, socket/mock ile is mantigini test etmek, gercek provider davranisini ise kontrollu manuel smoke test olarak tutmaktir.

### Kabul Kriteri

Her production release icin en az bir test numarasina basarili metin ve medya gonderimi kanitlanmadan buyuk kampanya baslatilmamali.

## 2. Coklu Tenant Altyapisi

### Mevcut Durum

DB ve servislerde `tenant_id` yaygin kullaniliyor. `tenants`, `users`, `whatsapp_accounts` tablolarinin temeli var. Buna karsin `WhatsAppRuntime.isTenantSupported()` sadece default tenant'i destekliyor. Yani sistem veri izolasyonu tarafinda coklu tenant'a hazirlik yapiyor, fakat WhatsApp baglanti runtime'i fiilen single-tenant.

### Gercekci Karar

Simdilik single-tenant urun olarak kalmak daha dogru.

Neden:

- Hostinger Passenger ortami ve tek WhatsApp hesabi gercegi single-tenant modele daha uygun.
- Coklu tenant tamamlamak sadece DB kolonlari eklemek degil; tenant basina WhatsApp session, QR, socket room, kampanya kilidi, upload quota, admin/role modeli, billing ve support operasyonu gerekir.
- Bu maliyet bugunku ihtiyac icin gereksiz buyuk.

### Yapilmasi Gerekenler

Kisa vadede:

- `DEFAULT_TENANT_ID=default` resmi davranis olarak dokumante edilmeli.
- Tenant yaratma veya coklu WhatsApp hesabi UI'i acilmamali.
- API cevaplarinda tenant bilgisi internal kalmali; kullaniciya "multi company" vaadi verilmemeli.
- Testlerde tenant izolasyonu korunmali, cunku bu veri guvenligi icin faydali.

Orta vadede, gercekten coklu musteri hedeflenirse:

- `WhatsAppRuntime` tenant basina runtime instance yoneten bir registry'ye donmeli.
- Her tenant icin ayri auth session path, QR stream, socket room ve campaign lock olmali.
- `whatsapp_accounts` tablosu gercek kaynak haline gelmeli.
- Admin panelde tenant/user/account yonetimi eklenmeli.
- Rate limit, media quota ve audit log tenant bazinda gorunur hale gelmeli.

### Gereksiz Olan

Bugun coklu tenant'i tamamen bitirmeye calismak gereksizdir. Ayrica mevcut `tenant_id` kolonlarini silmek de dogru degil; veri izolasyonu ve ilerideki buyume icin faydali bir temel sagliyor. Dogru hareket: altyapiyi koru, ozelligi pazarlama/arayuz seviyesinde acma.

## 3. Sql.js DB ve Tek Process Varsayimi

### Mevcut Durum

DB `sql.js` ile in-memory aciliyor ve checkpoint ile dosyaya yaziliyor. Bu model tek Node process icin calisir. Ayni DB dosyasini iki process ayni anda acarsa son yazan kazanabilir ve veri kaybi riski dogar.

### Gercekci Karar

Kisa vadede kalabilir, ama sadece su sartlarla:

- Production tek process calisacak.
- PM2 ile ikinci process baslatilmayacak.
- Passenger instance sayisi birden fazla yapilmayacak.
- `WHASAPPC_DATA_DIR` kalici ve tek runtime tarafindan kullanilacak.
- Duzenli DB backup korunacak.

### Ne Zaman Degistirilmeli

Su sinyallerden biri olursa `sql.js` terk edilmeli:

- Ayni anda birden fazla operator aktif kullanmaya baslarsa.
- Kampanya, upload ve CRUD islemleri ayni anda yogunlasirsa.
- DB dosyasi belirgin buyur ve checkpoint suresi hissedilir hale gelirse.
- Multi-tenant gercek urun hedefi olursa.
- Process restart veya crash sonrasi veri tutarliligi kritik SLA haline gelirse.

### Onerilen Gecis Sirasi

1. En yakin secenek: `better-sqlite3` veya benzeri native SQLite driver. Dosya SQLite kalir ama lock/transaction davranisi gercek SQLite olur.
2. Buyuk kullanim secenegi: PostgreSQL. Tenant, audit, campaign ve delivery state icin daha dogru uzun vadeli kaynak olur.

### Gereksiz Olan

Bugun hemen PostgreSQL'e gecmek gereksiz olabilir. Sistem tek operator/tek tenant/tek process calisiyorsa maliyet getirir. Ama `sql.js` kullaniminin "sinirsiz production DB" olmadigi net dokumante edilmelidir.

## 4. File Session Store

### Mevcut Durum

Session store varsayilani `SESSION_STORE=sqlite` olarak DB'ye alinmistir. Eski JSON file session store `SESSION_STORE=file` ile sadece fallback olarak kalir. Production yine tek process kabul edilir; DB-backed store session kayip riskini azaltir ama Sql.js tek process varsayimini ortadan kaldirmaz.

### Yapilmasi Gerekenler

Kisa vadede:

- Tek process kurali korunmali.
- Production'da `SESSION_STORE=sqlite` kullanildigi dogrulanmali.
- `SESSION_STORE=file` sadece acil fallback olarak tutulmali.
- Session cookie ayarlari production'da `secure`, `httpOnly`, `sameSite=none` ile devam etmeli.
- Deploy sonrasi `app_sessions` migration'inin uygulanmis oldugu dogrulanmali.

### Gereksiz Olan

Bu proje Hostinger Passenger uzerindeyken Redis eklemek ilk cozum olmamali. Ek servis operasyonu getirir. Mevcut DB-backed session store daha basit ve yeterlidir.

## 5. Kampanya Teslimat ve Okundu Reconciliation

### Mevcut Durum

Kampanya alicisi `sent` durumuna, `sock.sendMessage()` basarili dondugunde geciyor. Bu teknik olarak "WhatsApp'a gonderim istegi kabul edildi" anlamina gelir; kesin teslim edildi veya okundu anlamina gelmez.

### Risk

Kullanici arayuzunde "Iletildi" ifadesi fazla iddiali kalabilir. Gercekte:

- Mesaj WhatsApp Web client tarafindan kabul edilmis olabilir.
- Karsi cihaza ulasmamis olabilir.
- Daha sonra hata veya baglanti problemi olusabilir.
- Okundu bilgisi hic gelmeyebilir veya privacy ayarlari nedeniyle kullanilamayabilir.

### Onerilen Model

Recipient status iki katmana ayrilmali:

- Campaign execution status: `pending`, `sending`, `submitted`, `failed`, `skipped`.
- Provider delivery status: `unknown`, `server_ack`, `device_ack`, `read`, `delivery_failed`.

DB alanlari:

- `provider_message_id`
- `provider_status`
- `provider_status_updated_at`
- `provider_error`
- `submitted_at`
- `delivered_at`
- `read_at`

Uygulama davranisi:

1. `sendMessage()` dondugunde recipient `submitted` olur.
2. Baileys event'lerinden message id ve delivery/read sinyalleri best-effort dinlenir.
3. Event gelirse provider status guncellenir.
4. Event gelmezse status `submitted/unknown` olarak kalir; UI bunu "WhatsApp'a gonderildi, teslim bilgisi bekleniyor" diye gosterir.

### Gercekci Not

Baileys resmi bir WhatsApp Business API degildir. Delivery/read sinyalleri her kosulda garanti kabul edilmemeli. Bu nedenle "kesin teslimat raporu" vaadi verilmemeli; "best-effort teslimat sinyali" denmeli.

### Gereksiz Olan

Hemen tam analytics/raporlama paneli yapmak gereksiz. Once DB modeli ve event listener altyapisi kurulmali. UI tarafinda basit ayrim yeterli: `Bekliyor`, `Gonderiliyor`, `WhatsApp'a iletildi`, `Teslim edildi`, `Okundu`, `Basarisiz`.

## 6. Gereksiz veya Erken Yapilar

### 6.1 Coklu Tenant UI ve Operasyonu

Gereksiz: Bugun tenant yonetim ekrani, plan/billing, tenant davetiye sistemi veya tenant basina WhatsApp hesabini bitirmek.

Yapilmali: Tenant altyapisi internal kalsin. Single-tenant urun davranisi net olsun.

### 6.2 Legacy `/api` Namespace

Mevcut durum: Frontend `/api/v1` kullaniyor, legacy `/api` ise geriye uyumluluk icin duruyor ve deprecation header'i basiyor.

Yapilmali:

- Access log ile legacy `/api` kullanan var mi izlenmeli.
- 30 gun hic kullanim yoksa legacy routes kaldirilmali.
- Kaldirmadan once regression testleri `/api/v1` odakli hale getirilmeli.

Gereksiz: Hemen silmek riskli. Eski entegrasyon varsa kirilir.

### 6.3 Legacy JSON Migration Kaynaklari

Mevcut durum: `contacts.json`, `groups.json`, `templates.json`, `daily_stats.json`, `recipient_history.json` legacy import kaynaklari olarak okunuyor ve `.migrated` yapiliyor.

Yapilmali:

- Aktif production DB tamamen migrate olduktan ve yedek alindiktan sonra legacy JSON okuma kodu icin sunset tarihi belirlenmeli.
- O tarihe kadar sadece migration fallback olarak kalmali.

Gereksiz: Bu dosyalari hemen silmek veya migration kodunu hemen kaldirmak riskli. Geri donus ve eski kurulum import senaryolari icin kisa sure daha kalabilir.

### 6.4 Import Worker Plan Dokumanlari

Mevcut durumda Excel parse worker thread ile yapiliyor. `docs/import-worker-plan.md` daha buyuk async import job sisteminden bahsediyor.

Yapilmali:

- Buyuk dosya ve import history ihtiyaci yoksa async import job sistemi simdilik yapilmamali.
- Dokuman "gelecek opsiyon" olarak isaretlenmeli.

Gereksiz: Import job queue, progress polling ve imports tablosu bugun icin fazla olabilir.

### 6.5 Full Provider Analytics

Gereksiz: Dashboard'a hemen detayli deliverability grafikleri, okundu oranlari, saatlik heatmap, kisi bazli zaman cizelgesi eklemek.

Yapilmali: Once dogru status modeli kurulsun. Veri guvenilir hale gelmeden analitik UI yapmak yaniltici olur.

## 7. Onerilen Yol Haritasi

### Faz 0: Production Smoke ve Operasyon Disiplini

Sure: 0.5-1 gun

- Yeni `hostinger-passenger` deploy akisiyle production'a cik.
- Public `/readyz`, login, QR, tek mesaj, medya mesaj ve kucuk kampanya smoke testlerini tamamla.
- Smoke test sonucunu release notuna yaz.
- PM2'nin kapali kaldigini ve Passenger'in tek runtime oldugunu dogrula.

### Faz 1: Single-Tenant Stabilizasyon

Sure: 1-2 gun

- Single-tenant davranisini dokumante et.
- Tenant UI veya multi-account beklentisi olusturabilecek metinleri kaldir.
- Legacy `/api` kullanimini logla.
- Session store icin DB-backed tasarim kararini hazirla.

### Faz 2: Session ve DB Dayanikliligi

Sure: 2-4 gun

- `app_sessions` tablosu ve DB-backed session store production'da dogrula.
- Process startup'taki ayni data dir lock kontrolunu production'da dogrula.
- Backup/restore runbook'u `WHASAPPC_DATA_DIR` tamamini kapsayacak sekilde guncelle.

### Faz 3: Teslimat Status Modeli

Sure: 4-7 gun

- Campaign recipient tablosuna provider status alanlari ekle.
- `sendMessage()` sonucundan message id yakala.
- Baileys event listener ile best-effort status update ekle.
- UI metinlerini "gonderildi" ve "teslim edildi" ayrimina gore duzelt.
- Mock socket testleri ile submitted/delivered/read guncellemelerini test et.

### Faz 4: DB Mimarisi Karari

Sure: Karar 1 gun, uygulama 3-10 gun

- Gercek kullanim metriklerine bak: kisi sayisi, kampanya hacmi, eszamanli operator, DB boyutu.
- Kucuk/orta kullanim devam ediyorsa native SQLite driver'a gecis yeterli.
- Coklu musteri veya yuksek eszamanlilik hedefleniyorsa PostgreSQL planlanmali.

### Faz 5: Coklu Tenant Karari

Sure: Urun karari olmadan baslanmamali

- Satis/operasyon tarafinda birden fazla musteri gercek ihtiyacsa multi-tenant runtime tasarimi yap.
- Ihtiyac yoksa tenant scaffold'u internal veri izolasyonu olarak kalsin.

## Net Sonuc

Bugun yapilmasi gereken en dogru hareket, sistemi tek tenant ve tek process olarak profesyonelce sabitlemek; gereksiz multi-tenant, Redis, full analytics veya PostgreSQL tasimalarina hemen girmemektir.

Asil eksik kalan urun degeri teslimat reconciliation'dir. Ancak bu da tek seferde buyuk panel olarak degil, once dogru DB status modeli ve provider event listener ile baslamalidir.
