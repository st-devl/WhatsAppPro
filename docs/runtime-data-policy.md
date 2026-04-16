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
- `whatsapp-engine/auth/`
- `whatsapp-engine/uploads/`

## Kurallar

- Bu dosya ve klasorler fiziksel olarak silinmeden once kullanici onayi gerekir.
- Git takibinden cikarmak icin `git rm --cached` kullanilir; dosyanin kendisi korunur.
- Production deploy, runtime data klasorlerini persistent storage uzerinde tutar.
- Backup, auth session ve uploads klasorleri deploy artifact'iyle overwrite edilmez.
- Restore islemi icin once mevcut DB ve uploads snapshot'i alinir.
- Aktif runtime state SQLite icindedir; JSON dosyalari sadece eski kurulumlari migrate etmek icin okunur ve `.migrated` olarak ayrilir.
