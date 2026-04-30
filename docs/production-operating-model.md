# Production Operating Model

WhasAppC production davranisi su an bilincli olarak single-tenant ve single-process kabul edilir.

## Runtime

- Production hedefi Hostinger icin `DEPLOY_RUNTIME=hostinger-passenger` olmalidir.
- Public runtime Passenger app root'tur; PM2 ayni data dizinini kullanan ikinci process olarak calistirilmamalidir.
- `release.sh` Hostinger Passenger deploy hedefinde PM2 kalintilarini kapatir.
- Uygulama startup'ta `WHASAPPC_DATA_DIR/runtime/app.lock` dosyasi ile ayni data dizinini ikinci bir Node process'in acmasini engeller.

## Tenant Modeli

- Varsayilan ve desteklenen tenant: `DEFAULT_TENANT_ID=default`.
- DB ve servislerde `tenant_id` bulunmasi, veri izolasyonu ve ilerideki buyume icindir.
- Kullaniciya coklu sirket, coklu musteri veya tenant yonetimi vaadi verilmez.
- Coklu tenant UI, tenant davetiye akisi veya tenant basina WhatsApp hesabi gercek urun ihtiyaci olmadan acilmaz.

## Persistent Data

- Production'da `WHASAPPC_DATA_DIR` kod klasoru disindaki kalici dizine bakmalidir.
- Hostinger icin onerilen yol: `/home/u341720642/domains/yardimet.site/app-data`.
- DB, session store, WhatsApp auth session, uploads, media-store ve process lock ayni kalici veri kokunu kullanir.

## Session Store

- Varsayilan session store `SESSION_STORE=sqlite`.
- `SESSION_STORE=file` sadece geriye uyumluluk veya acil fallback icin kullanilmalidir.
- SQLite session store tek process modelinde file session store'a gore daha guvenlidir ve restart sonrasi session state'i DB icinde tutar.

## Ne Zaman Buyutulur?

Asagidaki sinyaller gorulmeden PostgreSQL, Redis veya multi-tenant runtime tasimasina baslanmaz:

- Ayni anda birden fazla operator yogun kullanim yapiyor.
- Birden fazla musteri/tenant gercek ticari gereksinim haline geliyor.
- DB boyutu veya checkpoint suresi operasyonu etkiliyor.
- Teslimat/okundu raporlari musteriye SLA olarak sunulacak hale geliyor.
