./deploy.sh

./deploy-production.sh --skip-css-build

./deploy-production.sh

DEPLOY_REMOTE_PASSENGER_PATH=/home/u341720642/domains/yardimet.site/nodejs \
DEPLOY_REMOTE_DATA_PATH=/home/u341720642/domains/yardimet.site/app-data \
DEPLOY_REMOTE_HEALTH_URL="https://yardimet.site/readyz" \
./deploy-production.sh --skip-css-build

---

# 🚀 Uygulama Erişim Bilgileri

## Canlı Ortam Bağlantısı
- **Giriş URL**: [https://yardimet.site/](https://yardimet.site/)
- **Health Check URL**: [https://yardimet.site/readyz](https://yardimet.site/readyz)

## 👑 Super Admin (Yönetici) Girişi
*(Tüm sistemi, tenantları ekleyip çıkartma yetkisine sahiptir)*
- **E-posta**: `suheypt@hotmail.com`
- **Şifre**: *(Kurulumda belirlediğiniz kendi orijinal şifreniz)*

## 👥 Örnek Kullanıcı (Tenant) Girişi
*(Super Admin olarak panele giriş yapıp, "Kullanıcılar" sekmesinden yeni eklediğiniz kullanıcılar)*
- **E-posta**: *(Panelden oluşturduğunuz e-posta adresi)*
- **Şifre**: *(Kullanıcıyı oluştururken verdiğiniz şifre)*
- **Yetki**: Yalnızca kendi eklediği WhatsApp numarasını ve kendi kampanyalarını görür, diğer hesaplara erişemez.
