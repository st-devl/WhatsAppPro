# normal deploy
rtk env PATH=/Users/suheyp/.nvm/versions/node/v22.22.0/bin:$PATH ./deploy-production.sh --with-tests


# hızlı deploy

rtk env PATH=/Users/suheyp/.nvm/versions/node/v22.22.0/bin:$PATH ./deploy-production.sh

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
