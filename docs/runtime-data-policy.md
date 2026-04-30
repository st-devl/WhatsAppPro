# Runtime Data Policy

Bu sistemde runtime veri kod artifact'i degildir ve Git ile deploy edilmez.

## Runtime Veri

- `whatsapp-engine/.env`
- `whatsapp-engine/data/database.sqlite`
- `whatsapp-engine/data/database.sqlite.*`
- `whatsapp-engine/data/backups/`
- `whatsapp-engine/data/contacts.json` (legacy import source only)
- `whatsapp-engine/data/groups.json` (legacy import source only)
- `whatsapp-engine/data/templates.json` (legacy import source only)
- `whatsapp-engine/data/*.migrated`
- `whatsapp-engine/data/daily_stats.json` (legacy import source only)
- `whatsapp-engine/data/recipient_history.json` (legacy import source only)
- `whatsapp-engine/data/sessions/`
- `whatsapp-engine/data/media-store.json`
- `whatsapp-engine/data/runtime/app.lock`
- `whatsapp-engine/auth/`
- `whatsapp-engine/uploads/`

## Kurallar

- Bu dosya ve klasorler fiziksel olarak silinmeden once kullanici onayi gerekir.
- Git takibinden cikarmak icin `git rm --cached` kullanilir; dosyanin kendisi korunur.
- Production deploy, runtime data klasorlerini persistent storage uzerinde tutar.
- Hostinger Passenger production hedefinde `WHASAPPC_DATA_DIR` kod klasorunun disindaki kalici dizine ayarlanir. Onerilen yol: `/home/u341720642/domains/yardimet.site/app-data`.
- `WHASAPPC_DATA_DIR` verildiginde SQLite DB, session store, WhatsApp auth session, upload dosyalari, media-store ve process lock ayni kalici veri kokunu kullanir.
- Backup, auth session ve uploads klasorleri deploy artifact'iyle overwrite edilmez.
- Restore islemi icin once mevcut DB ve uploads snapshot'i alinir.
- Aktif runtime state SQLite icindedir; JSON dosyalari sadece eski kurulumlari migrate etmek icin okunur ve `.migrated` olarak ayrilir.
