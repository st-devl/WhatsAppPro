# WhasAppC Enterprise Upgrade Baseline

Tarih: 2026-04-15

Bu dosya enterprise upgrade calismasina baslamadan onceki mevcut durumu kayit altina almak icin eklendi. Gizli degerler bu dosyada yazilmaz.

## Calisma Agaci

- Mevcut kullanici degisikligi: `docs/prd.md`
- Bu dosyaya dokunulmayacak.

## Runtime ve Secret Durumu

- `whatsapp-engine/.env` Git tarafindan takip ediliyor. Bu kritik secret hygiene problemidir.
- `whatsapp-engine/data/contacts.json` Git tarafindan takip ediliyor.
- `whatsapp-engine/data/templates.json.migrated` Git tarafindan takip ediliyor.
- `whatsapp-engine/.gitignore` runtime DB, backups, auth ve uploads icin kurallar iceriyor.

## DB Durumu

Son kontrol:

- Toplam grup: 1
- Aktif grup: 0
- Toplam kisi: 1
- Aktif kisi: 0
- Template: 1
- Audit log: 5
- Migration: 3

Not: Aktif grup/kisi bulunmuyor. Mevcut kayitlar soft-deleted durumda.

## Ana Riskler

- Socket.IO auth kontrolu olmadan baglanti kabul ediyor.
- `express-session` default MemoryStore ile calisiyor.
- Login brute-force korumasi yok.
- CSRF icin state-changing request korumasi yok.
- Security header seti yok.
- `xlsx` dependency icin high severity advisory var.
- Campaign state, media state ve WhatsApp socket global process memory uzerinde tutuluyor.

## HTTP Route Baseline

Public veya auth oncesi:

- `POST /api/v1/login`
- `POST /api/v1/logout`
- `GET /api/v1/check-auth`
- `GET /healthz`
- `GET /login.html`

Auth middleware arkasinda:

- `GET /api/v1/version`
- `GET /api/v1/runtime-status`
- `GET /api/v1/templates`
- `POST /api/v1/templates`
- `GET /api/v1/groups`
- `POST /api/v1/groups`
- `PUT /api/v1/groups/:id`
- `DELETE /api/v1/groups/:id`
- `GET /api/v1/groups/:groupId/contacts`
- `POST /api/v1/groups/:groupId/contacts`
- `PATCH /api/v1/groups/:groupId/contacts/:contactId`
- `DELETE /api/v1/groups/:groupId/contacts/:contactId`
- `POST /api/v1/upload-media`
- `DELETE /api/v1/upload-media`
- `POST /api/v1/upload-excel`
- `GET /api/v1/download-sample`
- `GET /api/v1/campaign-status`
- `POST /api/v1/reset-session`
- Static `public/`
- Static `uploads/`

## Socket.IO Baseline

- `connection`
- Server emits: `status`, `qr`, `log`
- Client emits: `start-bulk`, `stop-bulk`
- Onceki risk: connection ve event authorization HTTP session ile bagli degildi.

## Frontend Akis Baseline

- Login formu `/api/v1/login` kullanir.
- Dashboard auth durumunu `/api/v1/check-auth` ile kontrol eder.
- Gruplar `/api/v1/groups` ile tek seferde contacts dahil yuklenir.
- Manuel kisi ekleme secili grup varsa tekil contact API'sine gider.
- Secili grup yoksa liste local draft olarak saklanir.
- Excel import `/api/v1/upload-excel` ile parse edilir, frontend listeye merge eder.
- Campaign hedefleri frontend state'inden hesaplanir ve Socket.IO `start-bulk` ile gonderilir.
- Progress ve loglar Socket.IO `log` eventiyle UI'a basilir.

## Backup ve Koruma Plani

- `whatsapp-engine/data/database.sqlite` fiziksel olarak silinmeyecek.
- `whatsapp-engine/data/backups/` riskli DB degisimleri icin korunacak.
- `whatsapp-engine/uploads/` kullanici medyasi olarak kabul edilecek ve toplu silinmeyecek.
- `whatsapp-engine/auth/session/` WhatsApp oturumu olarak kabul edilecek ve reset disinda silinmeyecek.
- `.env` degerleri rapora veya loglara yazilmayacak.
- Git takibinden cikarilacak runtime dosyalari once mevcut dosya korunarak `git rm --cached` mantigiyla ele alinacak.

## Baseline Dogrulama

- `node --check` kontrolleri gecti.
- `npm --prefix whatsapp-engine run verify:data` gecti.
- `npm --prefix whatsapp-engine audit --omit=dev` xlsx icin high severity bulgu verdi.

## Faz 1 Degisiklik Baseline'i

Baslanan degisiklikler:

- HTTP security header middleware eklendi.
- State-changing requestler icin Origin/Referer same-origin guard eklendi.
- Login rate limit eklendi.
- MemoryStore yerine dosya tabanli kalici session store eklendi.
- Socket.IO connection HTTP session ile authorize edilmeye baslandi.
