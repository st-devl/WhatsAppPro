# Simple Production Deploy

Bu projenin gunluk production deploy komutu:

```bash
./deploy.sh
```

Daha guvenli ama daha uzun calisan deploy:

```bash
./deploy.sh --with-tests
```

Remote `.env` dosyasi eksikse ilk kurulum:

```bash
./deploy.sh --setup-env
```

Bu komut admin e-posta ve sifreyi terminalde sorar, sifreyi bcrypt hash'e cevirir, `SESSION_SECRET` uretir ve remote `.env` dosyasi yoksa olusturur. Mevcut remote `.env` dosyasinin uzerine yazmaz.

## Ne Yapar?

- Tailwind CSS build alir.
- `public/release.json` manifestini mevcut git commit ile uretir.
- Production `node_modules` paketini gecici local klasorde hazirlar.
- Tek SSH master baglantisi acar; parola gerekiyorsa pratikte tek kez sorulur.
- Kodu ve `node_modules` paketini Hostinger Passenger app root'a aktarir.
- Remote `.env` dosyasini ve runtime veriyi korur.
- `NODE_ENV=production`, `TRUST_PROXY=1`, `COOKIE_SECURE=true`, `SESSION_STORE=sqlite` ve `WHASAPPC_DATA_DIR` degerlerini remote `.env` icinde garanti eder.
- Eski PM2 sureclerini kapatir.
- Migration calistirir.
- Passenger restart tetikler.
- `https://yardimet.site/readyz` public health check gecmeden basarili saymaz.

## Ne Yapmaz?

- GitHub'a push yapmaz.
- Local working tree temiz olmak zorunda degildir.
- `docs/project_keys.md` gibi lokal not dosyalari deploy'u engellemez.
- `--setup-env` verilmedikce production secret uretmez. Remote `.env` yoksa veya zorunlu secret eksikse durur.
- Gercek WhatsApp smoke test yapmaz.

## Varsayilan Hedef

```bash
DEPLOY_REMOTE_HOST=u341720642@141.136.43.125
DEPLOY_REMOTE_SSH_PORT=65002
DEPLOY_REMOTE_PASSENGER_PATH=/home/u341720642/domains/yardimet.site/nodejs
DEPLOY_REMOTE_DATA_PATH=/home/u341720642/domains/yardimet.site/app-data
DEPLOY_REMOTE_HEALTH_URL=https://yardimet.site/readyz
```

Bu degerler gerekirse komut basinda override edilebilir:

```bash
DEPLOY_REMOTE_HEALTH_URL=https://example.com/readyz ./deploy.sh
```

## Ilk Kurulum Gereksinimi

Remote app root icinde su dosya bulunmalidir:

```bash
/home/u341720642/domains/yardimet.site/nodejs/.env
```

Zorunlu secretlar:

```bash
ADMIN_EMAIL=
ADMIN_PASS_HASH=
SESSION_SECRET=
```

Normal deploy secret olusturmaz; sadece varligini ve guvenli gorunen degerleri dogrular.
Ilk kurulum icin `./deploy.sh --setup-env` kullanilabilir.

## Eski Release Akisi

Eski, git tabanli ve hedef secimli release akisi hala durur:

```bash
./release.sh check
./deploy.sh --legacy-release --skip-tests --skip-audit
```

Gunluk Hostinger production deploy icin artik bu akis kullanilmamalidir.
