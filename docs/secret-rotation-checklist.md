# Secret Rotation Checklist

Bu dokuman secret degerlerini yazmaz. Sadece rotasyon adimlarini tanimlar.

## Hemen Yapilacaklar

- `whatsapp-engine/.env` Git takibinden cikarilacak.
- Production `SESSION_SECRET` yeni uzun random degerle degistirilecek.
- Admin sifresi degistirilecek ve yeni bcrypt hash production environment'a yazilacak.
- Eski admin sifresi ve eski session secret gecersiz kabul edilecek.
- Deploy sonrasi login/logout ve session persist akisi test edilecek.

## Git Gecmisi Riski

- `.env` daha once Git tarafindan takip edildigi icin eski secret degerleri sizmis kabul edilecek.
- Public veya paylasimli remote varsa Git history rewrite veya repository secret purge plani uygulanacak.
- Rotation tamamlanmadan eski secretlere guvenilmeyecek.

## Operasyon Kurali

- Secret degerleri PR, issue, dokuman, log veya ekran goruntusune yazilmayacak.
- `.env.example` sadece anahtar isimleri ve guvenli placeholder degerler tasiyacak.
- Production secretler hosting paneli, secret manager veya environment variable ile verilecek.

