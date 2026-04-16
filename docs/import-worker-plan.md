# Import Worker Plan

Excel import bugunku haliyle HTTP request icinde parse edilir. Bu kisa vadede calisir, ancak buyuk dosyalarda event loop'u mesgul eder. Faz 7 queue/worker gecisiyle import parse islemi de arka plana alinacak.

## Hedef Mimari

- `POST /api/imports` dosyayi alir, dosya imzasini dogrular ve import job olusturur.
- Worker `.xlsx` dosyasini parse eder.
- Import sonucu `imports` tablosunda saklanir: status, total_rows, valid_rows, duplicate_rows, invalid_rows, error.
- Frontend import progress'i polling veya Socket.IO ile izler.
- Basarili import sonucu kullanici tarafindan secili gruba merge/replace olarak uygulanir.

## Gecis Adimlari

- Current endpoint geriye uyumluluk icin korunur.
- Buyuk dosyalar icin yeni async endpoint eklenir.
- Dosya parse timeout ve row limit uygulanir.
- Temp dosyalar job tamamlaninca temizlenir.
- Import audit kaydi PII maskeli yazilir.

## Kabul

- HTTP request 50 MB Excel parse ederken event loop'u uzun sure bloke etmez.
- Import status restart sonrasi kaybolmaz.
- Hatali importlar kullaniciya satir sayisi ve neden ozetleriyle doner.

