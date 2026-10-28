# Log Sistemi Güçlendirme — Tam Task Listesi

Hazırlanma tarihi: 2026-05-13

---

## 🟣 SONNET ile Yapılacaklar
*(Karmaşık logic, yeni migration, çok dosyalı değişiklikler, mimari kararlar)*

---

### KATMAN 1 — Temel Temizlik

- [ ] **T-01 · DB: Kampanya log retention fonksiyonları**
  `lib/db.js`'e 3 yeni purge fonksiyonu yaz:
  - `purgeCampaignLogs(retentionDays)` — `campaign_logs` tablosunda 30 günden eski satırları sil
  - `purgeCampaignRuns(retentionDays)` — `status IN ('completed','stopped','paused')` olan ve 30 günden eski `campaign_runs` satırlarını sil; `campaign_recipients` ve `campaign_logs` cascade ile otomatik silinir (FK var)
  - `purgeDailySendStats(retentionDays)` — 90 günden eski `daily_send_stats` satırlarını sil
  - Her fonksiyon `{ deleted, cutoff, enabled }` dönsün, `purgeExpiredAuditLogs` ile aynı pattern

- [ ] **T-02 · Retention scheduler güncelleme**
  `index.js`'deki `scheduleAuditRetention()` fonksiyonunu genişlet:
  - Mevcut `purgeExpiredAuditLogs` çağrısı korunacak
  - Yeni 3 purge fonksiyonu da buraya eklenecek
  - Her biri ayrı `.catch()` ile izole edilecek, biri patlasa diğeri çalışmaya devam etsin
  - `setInterval` 24 saatte bir çalışıyor, bu mantık korunacak
  - Her çalışma sonunda toplam silinen satır sayısı `serverLogger.info` ile loglanacak

- [ ] **T-03 · Deploy script: default retention env var**
  `deploy-production.sh`'deki `--setup-env` bloğundaki `.env` template'ine `AUDIT_RETENTION_DAYS=30` satırını ekle; ayrıca `CAMPAIGN_LOG_RETENTION_DAYS=30` ve `DAILY_STATS_RETENTION_DAYS=90` ekle. `index.js`'de bu değerleri `process.env`'den oku.

- [ ] **T-04 · err.stack enrichment: campaign_recipients**
  `lib/db.js`'deki `updateCampaignRecipient` fonksiyonunda `last_error` alanına sadece `err.message` değil; `err.message + ' | ' + stack_snippet` (stack'in ilk anlamlı satırı, max 300 karakter) yazılacak şekilde güncelle. `messenger.js`'deki catch bloğundan `error` parametresi olarak bu format geçilecek.

- [ ] **T-05 · err.stack enrichment: campaign_logs metadata**
  `lib/db.js`'deki `addCampaignLog` fonksiyonu metadata alanına `error_code` ve `stack_snippet` kabul edecek şekilde güncelle. `messenger.js` catch bloğunda `addLog('error', ...)` çağrılarına bu metadata eklenecek. `campaign_service.js` catch bloklarında da aynı pattern uygulanacak.

---

### KATMAN 2 — system_events Tablosu

- [ ] **T-06 · DB Migration: system_events tablosu**
  `lib/db.js`'e yeni migration ekle (migration ID: `017_system_events`):
  ```sql
  CREATE TABLE system_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      detail TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL
  )
  CREATE INDEX idx_system_events_tenant_created ON system_events(tenant_id, created_at)
  CREATE INDEX idx_system_events_type ON system_events(event_type, created_at)
  ```

- [ ] **T-07 · DB: system_events fonksiyonları**
  `lib/db.js`'e şunları ekle:
  - `addSystemEvent(tenantId, eventType, detail, metadata)` — async, fire-and-forget, hata fırlatmasın
  - `getSystemEvents(tenantId, limit, eventTypes)` — son N olayı getir, opsiyonel type filtresi
  - `purgeSystemEvents(retentionDays)` — 30 günden eski satırları sil
  - `purgeSystemEvents` çağrısını T-02'deki scheduler'a ekle

- [ ] **T-08 · whatsapp_runtime.js entegrasyonu**
  `lib/whatsapp_runtime.js`'deki bağlantı event handler'larına `addSystemEvent` çağrıları ekle:
  - `connection === 'open'` → `whatsapp_connected` | detail: "Bağlantı başarıyla kuruldu"
  - `connection === 'close'` → `whatsapp_disconnected` | detail: `"Bağlantı koptu. Reason code: {reason}"` | metadata: `{ reason, retryCount }`
  - `reason === 401 || reason === 440` → `whatsapp_session_reset` | detail: "Oturum geçersiz, sıfırlandı" | metadata: `{ reason, invalidCount }`
  - `sessionInvalidTimestamps.length >= threshold` → `whatsapp_ban_suspected` | detail: "Kısa sürede çok fazla oturum geçersizliği — ban şüphesi" | metadata: `{ invalidCount, windowMinutes }`
  - `scheduleReconnect` retryCount >= maxAutoRetries → `whatsapp_reconnect_failed` | detail: "Maksimum deneme sayısına ulaşıldı" | metadata: `{ maxAutoRetries }`

- [ ] **T-09 · messenger.js entegrasyonu**
  `lib/messenger.js`'deki kritik noktalara `addSystemEvent` çağrıları ekle:
  - `failCount >= 5` → `campaign_error_burst` | detail: "5 ardışık hata — ban koruması devreye girdi" | metadata: `{ campaignId, lastError, failCount }`
  - Tüm medya dosyaları bulunamazsa → `campaign_media_missing` | detail: "Kampanya görselleri disk üzerinde bulunamadı" | metadata: `{ campaignId, expectedCount }`

- [ ] **T-10 · API endpoint: system-events**
  `routes/system.js`'e (veya yeni `routes/events.js`) şu endpoint ekle:
  - `GET /api/v1/system-events?limit=50&type=whatsapp_disconnected`
  - Authenticated, tenant-scoped
  - Response: `{ data: [{ id, event_type, detail, metadata, created_at }] }`

---

### KATMAN 3 — Dashboard Rapor Sekmesi

- [ ] **T-11 · API: Kampanya detay raporu**
  `routes/campaigns.js`'e yeni endpoint:
  - `GET /api/v1/campaigns/:id/report`
  - DB'den `campaign_runs`, `campaign_recipients`, `campaign_logs` birleştirerek dönsün:
    ```json
    {
      "summary": { "total": 81, "sent": 63, "failed": 6, "skipped": 12, "duration_minutes": 83 },
      "skip_reasons": { "cooldown": 8, "no_whatsapp": 4 },
      "error_reasons": [{ "reason": "Connection timeout", "count": 4 }],
      "media_count": 4,
      "started_at": "...", "completed_at": "..."
    }
    ```

- [ ] **T-12 · API: 30 günlük özet**
  `routes/system.js`'e:
  - `GET /api/v1/reports/summary`
  - Dönsün:
    ```json
    {
      "period_days": 30,
      "total_sent": 1240,
      "total_campaigns": 18,
      "success_rate": 0.91,
      "whatsapp_disconnects": 3,
      "ban_warnings": 0,
      "best_day": { "date": "2026-05-10", "sent": 156 },
      "daily_breakdown": [{ "date": "...", "sent": 0, "failed": 0 }]
    }
    ```

- [ ] **T-13 · Dashboard: "Raporlar" tab HTML**
  `public/index.html`'e yeni nav tab ve panel ekle:
  - Nav'a "Raporlar" butonu
  - Panel içinde 3 bölüm:
    - Üst: 30 gün özet kartları (toplam gönderim, başarı oranı, bağlantı kopuşu, ban uyarısı)
    - Orta: Kampanya listesi tablosu (son 20 kampanya, status, gönderilen/toplam, tarih, "Detay" butonu)
    - Alt: "Son Sistem Olayları" listesi (son 20 `system_events` satırı)

- [ ] **T-14 · Dashboard: Rapor tab JavaScript**
  `public/js/dashboard.js`'e:
  - `loadReportSummary()` — `/api/v1/reports/summary` çek, kartları render et
  - `loadCampaignHistory()` — son kampanyaları tablo olarak listele
  - `loadCampaignDetail(campaignId)` — `/api/v1/campaigns/:id/report` çek, modal aç
  - `loadSystemEvents()` — system-events endpoint'ini çek, listele
  - Tab switch'de lazy load: ilk kez Raporlar sekmesine girildiğinde fetch tetiklensin

- [ ] **T-15 · Dashboard: Kampanya detay modal HTML+JS**
  Mevcut modal pattern'ini kullanarak:
  - "Kampanya Raporu" modal — `campaign-report-modal` id'li
  - İçerik: özet satırları + per-recipient tablo (isim, telefon, durum, hata nedeni)
  - "CSV İndir" butonu — tablo verisini client-side CSV'e çevir ve indir
  - Pagination: çok sayıda kişi varsa 50'şer sayfalama

---

## 🟡 HAİKU ile Yapılacaklar
*(Basit log satırı ekleme, tekrarlayan pattern, config değişiklikleri, küçük düzeltmeler)*

---

### KATMAN 1

- [ ] **H-01 · messenger.js: başarılı gönderim pino logu**
  `lib/messenger.js`'de her başarılı `sock.sendMessage` sonrasına:
  ```js
  messengerLogger.info({ phone: normalizedForOverride, campaignId, tenantId, sentCount }, 'message_sent')
  ```

- [ ] **H-02 · messenger.js: başarısız gönderim pino logu**
  `lib/messenger.js`'de catch bloğundaki `addLog('error', ...)` satırından sonraya:
  ```js
  messengerLogger.error({ err, phone: normalizedForOverride, campaignId, tenantId, attemptCount: contact.attempt_count }, 'message_failed')
  ```

- [ ] **H-03 · messenger.js: cooldown skip pino logu**
  Cooldown nedeniyle atlanan kişi bloğuna:
  ```js
  messengerLogger.info({ phone: normalizedForOverride, campaignId, tenantId, expiresAt }, 'message_skipped_cooldown')
  ```

- [ ] **H-04 · messenger.js: WhatsApp'ta olmayan kişi pino logu**
  `validateOnWhatsApp` false döndüğü bloğa:
  ```js
  messengerLogger.warn({ phone: normalizedForOverride, campaignId, tenantId }, 'message_skipped_not_on_whatsapp')
  ```

- [ ] **H-05 · messenger.js: gece modu tetiklenme logu**
  `isNightMode()` bloğuna:
  ```js
  messengerLogger.warn({ campaignId, tenantId, currentHour: new Date().getHours() }, 'campaign_paused_night_mode')
  ```

- [ ] **H-06 · messenger.js: günlük limit logu**
  `sentToday >= dailyLimit` bloğuna:
  ```js
  messengerLogger.warn({ campaignId, tenantId, sentToday, dailyLimit }, 'campaign_stopped_daily_limit')
  ```

- [ ] **H-07 · messenger.js: batch pause logu**
  Batch pause başladığında:
  ```js
  messengerLogger.info({ campaignId, tenantId, batchSize, batchPauseMinutes, dailyCount }, 'campaign_batch_pause_started')
  ```

- [ ] **H-08 · messenger.js: ardışık hata limiti logu**
  `failCount >= 5` bloğuna:
  ```js
  messengerLogger.error({ campaignId, tenantId, failCount }, 'campaign_stopped_consecutive_errors')
  ```

- [ ] **H-09 · messenger.js: medya hazırlama sonuç logu**
  `preparedMedia.length > 0` sonrası:
  ```js
  messengerLogger.info({ campaignId, tenantId, preparedCount: preparedMedia.length, requestedCount: mediaFiles.length }, 'campaign_media_prepared')
  ```

- [ ] **H-10 · campaign_service.js: start pino logu**
  `start()` fonksiyonu başarıyla kampanya oluşturduktan sonra:
  ```js
  this.logger.info({ campaignId, tenantId, ownerEmail, contactCount: contacts.length, mediaCount: mediaFiles.length }, 'campaign_started')
  ```

- [ ] **H-11 · campaign_service.js: stop pino logu**
  `stopActive()` çağrıldığında:
  ```js
  this.logger.info({ campaignId: stoppedRun?.id, tenantId, ownerEmail }, 'campaign_stopped_by_user')
  ```

- [ ] **H-12 · campaign_service.js: resume/retry pino logları**
  `resume()` ve `retry()` başında:
  ```js
  this.logger.info({ campaignId, tenantId, ownerEmail, unsentCount: unsentContacts.length }, 'campaign_resumed')
  this.logger.info({ campaignId, tenantId, ownerEmail, failedCount: failedContacts.length }, 'campaign_retried')
  ```

---

### KATMAN 2

- [ ] **H-13 · Scheduler: purgeSystemEvents entegrasyonu**
  T-02'de hazırlanan scheduler'a T-07'den gelen `purgeSystemEvents` çağrısını ekle — tek satır.

- [ ] **H-14 · Deploy: AUDIT_RETENTION_DAYS=30 aktif et**
  `deploy-production.sh`'deki `--setup-env` `.env` template'inde `AUDIT_RETENTION_DAYS=` satırı boş bırakılmış. Bunu `AUDIT_RETENTION_DAYS=30` olarak doldur.

---

### KATMAN 3

- [ ] **H-15 · Dashboard: Raporlar tab CSS sınıfları**
  `public/index.html`'deki mevcut tab stillerini kopyalayarak Raporlar tab için aynı active/inactive sınıflarını uygula — T-13'te oluşturulan HTML'in stillemesi.

- [ ] **H-16 · Dashboard: event type badge renkleri**
  `dashboard.js`'de event_type'a göre renk map'i tanımla:
  ```js
  const eventColors = {
    whatsapp_connected: 'text-green-400',
    whatsapp_disconnected: 'text-red-400',
    whatsapp_session_reset: 'text-orange-400',
    whatsapp_ban_suspected: 'text-red-600 font-bold',
    campaign_error_burst: 'text-red-400',
    campaign_media_missing: 'text-amber-400'
  }
  ```

- [ ] **H-17 · Dashboard: boş durum null-guard**
  `loadReportSummary()` fetch başarısız olursa veya data boş gelirse kartlarda `—` göster, sayfa çökmemesi için null-guard ekle.

---

## Özet Tablo

| # | Görev | Model | Katman | Durum |
|---|---|---|---|---|
| T-01 | DB purge fonksiyonları (3 adet) | Sonnet | 1 | ⬜ |
| T-02 | Retention scheduler güncelleme | Sonnet | 1 | ⬜ |
| T-03 | Deploy script env vars | Sonnet | 1 | ⬜ |
| T-04 | err.stack → campaign_recipients | Sonnet | 1 | ⬜ |
| T-05 | err.stack → campaign_logs metadata | Sonnet | 1 | ⬜ |
| T-06 | DB Migration: system_events | Sonnet | 2 | ⬜ |
| T-07 | DB: system_events fonksiyonları | Sonnet | 2 | ⬜ |
| T-08 | whatsapp_runtime.js entegrasyonu | Sonnet | 2 | ⬜ |
| T-09 | messenger.js system_events | Sonnet | 2 | ⬜ |
| T-10 | API: system-events endpoint | Sonnet | 2 | ⬜ |
| T-11 | API: kampanya detay raporu | Sonnet | 3 | ⬜ |
| T-12 | API: 30 günlük özet | Sonnet | 3 | ⬜ |
| T-13 | Dashboard: Raporlar tab HTML | Sonnet | 3 | ⬜ |
| T-14 | Dashboard: Rapor JS | Sonnet | 3 | ⬜ |
| T-15 | Dashboard: Kampanya detay modal | Sonnet | 3 | ⬜ |
| H-01 | messenger: sent logu | Haiku | 1 | ⬜ |
| H-02 | messenger: failed logu | Haiku | 1 | ⬜ |
| H-03 | messenger: cooldown skip logu | Haiku | 1 | ⬜ |
| H-04 | messenger: not on WhatsApp logu | Haiku | 1 | ⬜ |
| H-05 | messenger: gece modu logu | Haiku | 1 | ⬜ |
| H-06 | messenger: günlük limit logu | Haiku | 1 | ⬜ |
| H-07 | messenger: batch pause logu | Haiku | 1 | ⬜ |
| H-08 | messenger: ardışık hata logu | Haiku | 1 | ⬜ |
| H-09 | messenger: medya hazırlama logu | Haiku | 1 | ⬜ |
| H-10 | campaign_service: start logu | Haiku | 1 | ⬜ |
| H-11 | campaign_service: stop logu | Haiku | 1 | ⬜ |
| H-12 | campaign_service: resume/retry | Haiku | 1 | ⬜ |
| H-13 | Scheduler: purgeSystemEvents | Haiku | 2 | ⬜ |
| H-14 | Deploy: AUDIT_RETENTION_DAYS=30 | Haiku | 2 | ⬜ |
| H-15 | Dashboard: tab CSS | Haiku | 3 | ⬜ |
| H-16 | Dashboard: event badge renkleri | Haiku | 3 | ⬜ |
| H-17 | Dashboard: boş durum guard | Haiku | 3 | ⬜ |

**Toplam: 15 Sonnet + 17 Haiku = 32 görev**
