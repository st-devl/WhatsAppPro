# WhasAppC Enterprise Upgrade Task List

Bu liste onceki teknik rapordaki tum bulgularin atlanmadan uygulanmasi icin hazirlandi. Uygulama sirasinda runtime veri, production DB, auth session, upload ve secret dosyalari kullanici onayi olmadan silinmeyecek.

## Uygulama Kurallari

- Her faz kucuk, dogrulanabilir ve geri alinabilir degisikliklerle ilerleyecek.
- Kritik guvenlik ve veri butunlugu once, buyuk mimari refactor sonra yapilacak.
- Her faz sonunda test, dogrulama ve kalan risk raporu verilecek.
- Runtime veri repo artifact'i olarak tasinmayacak.
- Secret degerleri dokumana veya loglara yazilmayacak.
- Geriye uyumluluk kirilacaksa once migration ve deprecation plani yazilacak.

## Faz 0 - Baseline ve Koruma

- [x] `git status` ve kullanici degisiklikleri kayit altina alinacak.
- [x] Tracked runtime/secret dosyalari listelenecek.
- [x] DB grup/kisi/template/audit sayilari kayit altina alinacak.
- [x] HTTP route listesi, Socket.IO eventleri ve frontend ana akislar belgelenecek.
- [x] `data`, `uploads`, `auth/session` ve `.env` icin backup/koruma plani yazilacak.
- [x] Kabul: Baslamadan once korunacak veri ve dokunulmayacak alanlar net olacak.

## Faz 1 - Kritik Guvenlik

- [x] Socket.IO session middleware ile korunacak.
- [x] Auth olmayan socket connection reddedilecek.
- [x] `start-bulk`, `stop-bulk`, QR/status eventleri sadece authenticated socket ile calisacak.
- [x] Login brute-force rate limit eklenecek.
- [x] `express-session` MemoryStore kullanimi kaldirilacak.
- [x] Kalici session store uygulanacak veya production store stratejisi netlestirilecek.
- [x] CSRF icin state-changing requestlerde same-origin kontrolu uygulanacak.
- [x] Security header seti eklenecek: CSP, HSTS, frameguard, nosniff, referrer policy.
- [x] Kabul: Login olmayan kullanici HTTP API ve Socket.IO uzerinden islem baslatamayacak.

## Faz 2 - Secret ve Runtime Veri Disiplini

- [x] `.env` Git takibinden cikarilacak.
- [x] `.env.example` olusturulacak.
- [x] Secret rotation checklist'i yazilacak.
- [x] `data/database.sqlite`, backups, uploads, auth session ve runtime JSON dosyalari Git takibinden cikarilacak.
- [x] Production icin persistent volume veya managed storage stratejisi yazilacak.
- [ ] Deploy'un DB overwrite etmedigi test edilecek.
- [ ] Kabul: Secret ve runtime veri repo ile deploy edilmeyecek.

## Faz 3 - Dependency ve Upload Guvenligi

- [x] `xlsx` high severity acigi cozulacak.
- [x] `exceljs`, CSV parser veya izole import worker secilecek.
- [x] Upload MIME kontrolu magic-number kontrolu ile desteklenecek.
- [ ] Excel parse request thread disina alinacak.
- [x] Upload sonrasi gecici Excel dosyalari temizlenecek.
- [ ] Medya icin dosya boyutu, toplam kota ve retention kuralı uygulanacak.
- [ ] Path traversal testleri eklenecek.
- [x] Kabul: Yanlis veya zararli dosya parse edilmeden reddedilecek.

## Faz 4 - Backend Mimari Ayrisma

- [x] `index.js` bootstrap disinda sorumluluk tasimayacak hale getirilecek.
- [x] `routes/auth`, `routes/groups`, `routes/contacts`, `routes/templates`, `routes/uploads`, `routes/campaigns` olusturulacak.
- [x] Controller, service ve repository katmanlari ayrilacak.
- [x] WhatsApp lifecycle ayri service olacak.
- [x] Socket.IO gateway ayri modul olacak.
- [x] Ortak error middleware eklenecek.
- [x] Ortak validation katmani eklenecek.
- [x] Kabul: Backend sorumluluklari dosya ve modul bazinda ayrilmis olacak.

## Faz 5 - Veritabani Modeli ve Kalicilik

- [ ] `sql.js` export-on-write modeli native SQLite WAL veya Postgres ile degistirilecek.
- [x] Foreign key enforcement aktif edilecek.
- [x] Partial unique index ile aktif grup adi duplicate engellenecek.
- [x] Partial unique index ile aktif grup icinde duplicate telefon engellenecek.
- [x] `campaign_runs` ve `campaign_recipients` tablolari eklenecek.
- [x] Migration runner fail-fast ve idempotent olacak.
- [x] Backup basarisizsa riskli write islemi duracak.
- [ ] Kabul: Iliski ve duplicate butunlugu sadece application code'a bagli olmayacak.

## Faz 6 - API Standardizasyonu

- [x] Response formati `{ data, error, code }` seklinde standardize edilecek.
- [x] `/api/v1` namespace plani uygulanacak.
- [x] `GET /groups` metadata ve `contact_count` dondurecek.
- [x] `GET /groups/:id/contacts` server-side pagination destekleyecek.
- [x] Search, filtering ve sorting query parametreleri eklenecek.
- [x] Idempotency key veya duplicate-safe write stratejisi uygulanacak.
- [x] Validation, not found, duplicate ve server error kodlari standart olacak.
- [x] Kabul: Buyuk contacts payload'i tek istekte donmeyecek.

## Faz 7 - Campaign Queue ve Worker

- [x] Kampanya gonderimi Socket.IO handler icinden cikarilacak.
- [x] Queue teknolojisi secilecek: BullMQ/Redis veya DB-backed queue.
- [x] Worker process/task runner eklenecek.
- [x] Her campaign run DB'de kalici olacak.
- [x] Her recipient icin status, retry, error, sent_at tutulacak.
- [ ] Stop, resume ve retry akislarinin ownership kontrolu olacak.
- [x] `main_campaign` global id kaldirilacak.
- [x] Kabul: Restart sonrasi campaign state kaybolmayacak.

## Faz 8 - Multi-Tenant Hazirlik

- [ ] `tenants`, `users`, `roles`, `whatsapp_accounts` modeli tasarlanacak.
- [ ] Tum is tablolarina `tenant_id` eklenecek.
- [ ] Tum repository queryleri tenant scoped olacak.
- [ ] Socket.IO tenant isolation uygulanacak.
- [ ] Media, auth session ve WhatsApp session tenant/user bazli ayrilacak.
- [ ] Kabul: Tenantlar birbirinin verisine erisemeyecek.

## Faz 9 - Frontend Refactor

- [ ] Tek HTML yapi parcalanacak.
- [ ] Vite + TypeScript veya minimal modular JS karari verilecek.
- [ ] API client katmani olusturulacak.
- [ ] State management DOM'dan ayrilacak.
- [ ] Inline `onclick` kullanimi kaldirilacak.
- [ ] Toast, modal, form ve table componentleri ortaklastirilacak.
- [ ] Build-time Tailwind'e gecilecek.
- [ ] Design token tek kaynak olacak.
- [ ] Kabul: Frontend 1700 satirlik tek dosya olmaktan cikacak.

## Faz 10 - Template ve Mesaj Motoru

- [ ] Preview renderer ve gercek gonderim renderer ortaklastirilacak.
- [ ] `{{ad}}`, `{{soyadi}}` ve `{a|b}` syntax'i tek yerde islenecek.
- [ ] Invalid placeholder kullaniciya gosterilecek.
- [ ] Template syntax unit testleri eklenecek.
- [ ] Campaign baslamadan ornek final mesaj validasyonu yapilacak.
- [ ] Kabul: Preview ile gonderilen mesaj ayni kurallardan gececek.

## Faz 11 - Logging, Audit ve Privacy

- [ ] `console.log` structured logger ile degistirilecek.
- [ ] Request id, user id, tenant id ve campaign id log context'e eklenecek.
- [ ] PII redaction uygulanacak.
- [ ] Audit log API'si eklenecek.
- [ ] Login success/fail, Excel import, campaign start/stop audit'e yazilacak.
- [ ] Audit retention ve export stratejisi belirlenecek.
- [ ] Kabul: Loglar debug edilebilir olacak ve PII sizdirmayacak.

## Faz 12 - Performans ve Cache

- [x] `GET /groups` icindeki O(G*C) JS filter davranisi kaldirilacak.
- [x] SQL aggregate ile contact count alinacak.
- [x] Buyuk contacts listelerinde pagination ve server-side search kullanilacak.
- [ ] Redis cache alanlari belirlenecek: session, rate limit, campaign progress, group metadata.
- [ ] Cache invalidation kurallari yazilacak.
- [ ] Backup ve audit retention uygulanacak.
- [ ] Kabul: 10k+ contact senaryosunda API ve UI sismeyecek.

## Faz 13 - DevOps ve Deployment

- [ ] `deploy.sh` icindeki `git add .`, otomatik commit ve main push kaldirilacak.
- [ ] Dockerfile eklenecek.
- [ ] `.dockerignore` eklenecek.
- [ ] Healthcheck ve readiness endpointleri ayrilacak.
- [ ] Migration command tanimlanacak.
- [ ] Backup/restore runbook yazilacak.
- [ ] Node engine dependency ile uyumlu hale getirilecek.
- [ ] CI pipeline: install, lint, unit test, integration test, audit, build.
- [ ] Kabul: Deploy manuel script ve sansa bagli olmayacak.

## Faz 14 - Test Stratejisi

- [ ] Unit test: phone normalization, template rendering, validation, repository.
- [ ] Integration test: login/logout, socket auth, group CRUD, contact CRUD, upload validation.
- [ ] E2E test: login, grup olusturma, kisi ekleme/duzenleme/silme, Excel import.
- [ ] Security test: unauth socket blocked, CSRF blocked, brute-force limited, invalid upload rejected.
- [ ] CI icinde testler zorunlu gate olacak.
- [ ] Kabul: Kritik akislar otomatik test olmadan tamamlanmis sayilmayacak.

## Faz 15 - Eski Yapi Temizligi

- [ ] Bos docs dosyalari doldurulacak veya kaldirilacak.
- [ ] Runtime JSON kullanimi migrate edilip kaldirilacak.
- [ ] Kullanilmayan dependencyler kaldirilacak.
- [ ] Sabit `v1.2.0 GOLD EDITION` metinleri runtime version'a baglanacak.
- [ ] Kullanilmayan CSS/helper kodlari temizlenecek.
- [ ] Eski endpointler deprecation planina alinacak.
- [ ] Kabul: Sistem eski yamalari gereksiz sekilde tasimayacak.
