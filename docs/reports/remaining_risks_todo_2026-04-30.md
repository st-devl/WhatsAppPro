# WhasAppC Kalan Riskler Yapilacaklar Listesi

Tarih: 2026-04-30
Kaynak rapor: `docs/reports/remaining_risks_action_plan_2026-04-30.md`

## P0 - Production Smoke Test

- [ ] Yeni `hostinger-passenger` deploy akisiyle production deploy yap.
- [ ] Public `https://yardimet.site/readyz` sonucunu dogrula.
- [ ] Login akisini production uzerinde dogrula.
- [ ] QR ile WhatsApp baglantisini kur.
- [ ] Tek test kisisiyle sadece metin mesaji gonder.
- [ ] Tek test kisisiyle metin + resim mesaji gonder.
- [ ] Tek test kisisiyle metin + video mesaji gonder.
- [ ] 3-5 kisilik kucuk kampanya baslat.
- [ ] Kampanya stop akisini test et.
- [ ] Kampanya resume akisini test et.
- [ ] Kampanya retry akisini test et.
- [ ] Kampanya sonunda UI sayaci, log ve DB status degerlerini karsilastir.
- [ ] App restart sonrasi login, WhatsApp durum, medya secimi ve son kampanya status'unu kontrol et.
- [ ] Smoke test sonucunu release notuna yaz.
- [ ] PM2 surecinin kapali, Passenger'in tek runtime oldugunu dogrula.

## P1 - Single-Tenant Stabilizasyon

- [x] Urun davranisini resmi olarak single-tenant kabul et.
- [x] `DEFAULT_TENANT_ID=default` davranisini dokumante et.
- [ ] Kullanici arayuzunde multi-company, multi-account veya tenant vaadi olusturan metinleri kontrol et.
- [ ] Tenant yaratma veya coklu WhatsApp hesabi UI'i acma.
- [x] Tenant altyapisini internal veri izolasyonu olarak koru.
- [ ] Tenant izolasyon testlerini koru.
- [ ] Coklu tenant ihtiyaci dogmadan `WhatsAppRuntime` multi-instance refactor'una baslama.

## P1 - Tek Process ve DB Dayanikliligi

- [ ] Production'da sadece tek Node process calistigini dogrula.
- [ ] PM2 ile ikinci app instance calismadigini kontrol et.
- [ ] Passenger instance sayisinin birden fazla olmadigini kontrol et.
- [ ] `WHASAPPC_DATA_DIR` degerinin kalici dizine baktigini dogrula.
- [ ] Backup/restore runbook'unu `WHASAPPC_DATA_DIR` tamamini kapsayacak sekilde guncelle.
- [x] Startup sirasinda ayni data dir icin ikinci process uyarisi veya lock kontrolu tasarla.
- [ ] DB boyutu, kampanya hacmi ve eszamanli operator sayisi icin izlenecek metrikleri belirle.
- [ ] Buyume sinyali varsa native SQLite driver veya PostgreSQL kararini yeniden degerlendir.

## P1 - Session Store

- [x] Mevcut file session store'un tek process varsayimini dokumante et.
- [ ] Production'da `SESSION_STORE=sqlite` kullanildigini dogrula.
- [ ] `SESSION_STORE=file` fallback'inin sadece acil durumda kullanilacagini dokumante et.
- [ ] Production cookie ayarlarini dogrula: `secure`, `httpOnly`, `sameSite=none`.
- [x] `app_sessions` SQLite tablosunu ekle.
- [x] `express-session` icin DB-backed custom store ekle.
- [x] Session `get`, `set`, `destroy` islemlerini DB transaction uzerinden calistir.
- [x] Redis'i ilk cozum olarak ekleme; once DB-backed store'u degerlendir.

## P2 - Kampanya Teslimat ve Okundu Reconciliation

- [ ] Mevcut UI metinlerinde `Iletildi` ifadesinin gercek anlami kontrol et.
- [ ] Recipient status modelini iki katmana ayir:
  - [ ] Campaign execution status: `pending`, `sending`, `submitted`, `failed`, `skipped`.
  - [ ] Provider delivery status: `unknown`, `server_ack`, `device_ack`, `read`, `delivery_failed`.
- [ ] `campaign_recipients` tablosu icin migration tasarla:
  - [ ] `provider_message_id`
  - [ ] `provider_status`
  - [ ] `provider_status_updated_at`
  - [ ] `provider_error`
  - [ ] `submitted_at`
  - [ ] `delivered_at`
  - [ ] `read_at`
- [ ] `sock.sendMessage()` sonucundan provider message id yakala.
- [ ] `sendMessage()` basarili donunce recipient status'u `submitted` yap.
- [ ] Baileys event listener ile best-effort delivery/read status update ekle.
- [ ] Event gelmezse status'u `submitted/unknown` olarak koru.
- [ ] UI metinlerini `WhatsApp'a iletildi`, `Teslim edildi`, `Okundu`, `Basarisiz` ayrimina gore duzelt.
- [ ] Mock socket testleri ile `submitted`, `delivered`, `read`, `delivery_failed` guncellemelerini test et.
- [ ] Kesin teslimat vaadi verme; dokumanda `best-effort teslimat sinyali` ifadesini kullan.

## P2 - Legacy API Temizligi

- [ ] Legacy `/api` namespace kullanimini logla.
- [ ] Frontend'in yalnizca `/api/v1` kullandigini dogrula.
- [ ] External consumer var mi kontrol et.
- [ ] 30 gun legacy `/api` kullanimi yoksa kaldirma planini baslat.
- [ ] Regression testlerini `/api/v1` odakli hale getir.
- [ ] Sunset tarihi olan `2026-09-30` yaklasmadan kaldirma kararini tekrar degerlendir.

## P3 - Legacy JSON Migration Kaynaklari

- [ ] Production DB'nin tamamen migrate oldugunu dogrula.
- [ ] `contacts.json`, `groups.json`, `templates.json`, `daily_stats.json`, `recipient_history.json` kaynaklari icin yedek al.
- [ ] Legacy JSON okuma kodu icin sunset tarihi belirle.
- [ ] Sunset tarihine kadar bu kodlari sadece migration fallback olarak tut.
- [ ] Sunset sonrasi legacy JSON migration kodlarini kaldirmadan once restore senaryosunu test et.

## P3 - Erken Yapilmamasi Gerekenler

- [ ] Gercek ihtiyac olmadan coklu tenant UI yapma.
- [ ] Gercek ihtiyac olmadan PostgreSQL tasimasina baslama.
- [ ] Ilk cozum olarak Redis ekleme.
- [ ] Dogru status modeli olmadan full deliverability analytics paneli yapma.
- [ ] Gercek WhatsApp hesabi ile kirilgan CI/e2e otomasyonu kurma.
- [ ] Import job queue ve async import panelini buyuk dosya ihtiyaci kanitlanmadan yapma.

## Tamamlandi Sayilma Kriterleri

- [ ] Her production deploy icin manuel WhatsApp smoke test checklist'i tamamlanmis olacak.
- [ ] Sistem single-tenant olarak dokumante edilmis olacak.
- [ ] Production tek process calistigi kanitlanmis olacak.
- [ ] Session store icin DB-backed gecis karari veya uygulanmis cozum olacak.
- [ ] Kampanya recipient status modeli `submitted` ile `delivered/read` ayrimini yapacak.
- [ ] Gereksiz buyuk mimari tasimalar gercek ihtiyac dogmadan baslatilmayacak.
