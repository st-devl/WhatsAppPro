# Manuel Regresyon Test Checklist

Bu dokuman Faz 10 madde 30'daki manuel regresyon testlerinin adim adim uygulama rehberidir. Her test icin on kosullar, adimlar ve beklenen sonuclar tanimlanmistir.

**Test Eden:** _________________
**Tarih:** _________________
**Ortam:** [ ] Local [ ] Staging [ ] Production

---

## 1. Login Basarili ve Hatali Giris

**On Kosul:** Uygulama calisir durumda.

| Adim | Islem | Beklenen Sonuc | Sonuc |
|------|-------|----------------|-------|
| 1 | Login sayfasini ac | Login formu gorunmeli | [ ] |
| 2 | Gecerli email ve sifre gir, gonder butonuna bas | Dashboard'a yonlendirilmeli | [ ] |
| 3 | Yanlis sifre gir | 401 hatasi ile login basarisiz olmali | [ ] |
| 4 | 5 kez yanlis sifre gir | Rate limit (429) uygulanmali | [ ] |

---

## 2. Login Sonrasi Yonlendirme

**On Kosul:** Basarili login yapilmis.

| Adim | Islem | Beklenen Sonuc | Sonuc |
|------|-------|----------------|-------|
| 1 | Login olduktan sonra URL'yi kontrol et | `/` veya dashboard sayfasina yonlendirilmeli | [ ] |
| 2 | Sayfayi yenile | Session korunmali, login sayfasina donulmemeli | [ ] |
| 3 | `/login` sayfasina git | Zaten login ise dashboard'a yonlendirilmeli | [ ] |

---

## 3. WhatsApp QR Bekleme ve Connected State

**On Kosul:** Basarili login yapilmis, WhatsApp baglantisi yok.

| Adim | Islem | Beklenen Sonuc | Sonuc |
|------|-------|----------------|-------|
| 1 | Dashboard'u ac | QR kod veya "baglaniyor" durumu gorunmeli | [ ] |
| 2 | QR kodu telefonla tara | "Baglandi" durumu gorunmeli | [ ] |
| 3 | Sayfayi yenile | Bagli durum korunmali | [ ] |

---

## 4. Yeni Grup Olusturma

**On Kosul:** Dashboard acik.

| Adim | Islem | Beklenen Sonuc | Sonuc |
|------|-------|----------------|-------|
| 1 | "Yeni Grup" veya equivalent butona tikla | Grup olusturma formu acilmali | [ ] |
| 2 | Grup adi gir ve kaydet | Grup listede gorunmeli | [ ] |
| 3 | Ayni isimle tekrar grup olusturmayi dene | Duplicate hata mesaji gosterilmeli | [ ] |
| 4 | Bos isimle grup olusturmayi dene | Hata mesaji gosterilmeli | [ ] |

---

## 5. Grup Silme

**On Kosul:** En az bir grup mevcut.

| Adim | Islem | Beklenen Sonuc | Sonuc |
|------|-------|----------------|-------|
| 1 | Bir grubun silme butonuna tikla | Confirm dialog gorunmeli | [ ] |
| 2 | Onayla | Grup listeden kaybolmali | [ ] |
| 3 | Sayfayi yenile | Grup hala silinmis olmali | [ ] |
| 4 | Ayni isimde yeni grup olustur | Basarili olmali (soft delete eski grup ise) | [ ] |

---

## 6. Excel Import

**On Kosul:** Gecerli bir `.xlsx` dosya hazir (icinde ad, soyad, telefon kolonlari).

| Adim | Islem | Beklenen Sonuc | Sonuc |
|------|-------|----------------|-------|
| 1 | Excel upload alanina dosya surukle veya sec | Dosya yuklenmeli | [ ] |
| 2 | Gecerli `.xlsx` dosya yukle | Import sonucu gosterilmeli (yeni, duplicate, hatali sayilari) | [ ] |
| 3 | Gecersiz dosya yukle (ornegin `.pdf`) | Hata mesaji gosterilmeli | [ ] |
| 4 | Import sirasinda loading durumu | Loading indicator gorunmeli | [ ] |

---

## 7. Manuel Kisi Ekleme

**On Kosul:** Bir grup secili.

| Adim | Islem | Beklenen Sonuc | Sonuc |
|------|-------|----------------|-------|
| 1 | Kisi ekleme formunda ad, soyad, telefon gir | Form doldurulabilmeli | [ ] |
| 2 | Kaydet butonuna bas | Kisi tabloya eklenmeli | [ ] |
| 3 | Grup kisi sayaci guncellenmeli | Sayac dogru olmali | [ ] |
| 4 | Ayni telefonu tekrar ekle | Duplicate hata mesaji gosterilmeli | [ ] |

---

## 8. Kisi Duzenleme

**On Kosul:** Grup icinde en az bir kisi var.

| Adim | Islem | Beklenen Sonuc | Sonuc |
|------|-------|----------------|-------|
| 1 | Bir kisinin duzenleme butonuna tikla | Duzenleme modal/form acilmali | [ ] |
| 2 | Ad veya telefonu degistir ve kaydet | Kisi guncellenmeli, tablo guncellenmeli | [ ] |
| 3 | Guncelleme sonrasi grup sayaci dogru olmali | Sayac ayni kalmali | [ ] |
| 4 | Telelonu baska bir kisinin telefonuyla degistir | Duplicate hata mesaji gosterilmeli | [ ] |

---

## 9. Kisi Silme

**On Kosul:** Grup icinde en az bir kisi var.

| Adim | Islem | Beklenen Sonuc | Sonuc |
|------|-------|----------------|-------|
| 1 | Bir kisinin silme butonuna tikla | Confirm veya dogrudan silme aksiyonu olmali | [ ] |
| 2 | Silme islemini onayla | Kisi tablodan kaybolmali | [ ] |
| 3 | Grup kisi sayaci guncellenmeli | Sayac azalmali | [ ] |
| 4 | Sayfayi yenile | Kisi hala silinmis olmali | [ ] |

---

## 10. Grup Olarak Kaydetme

**On Kosul:** Excel import veya manuel kisi listesi mevcut.

| Adim | Islem | Beklenen Sonuc | Sonuc |
|------|-------|----------------|-------|
| 1 | Kisileri "Grup olarak kaydet" secenegini kullan | Grup adi sorulmali | [ ] |
| 2 | Grup adi gir ve kaydet | Yeni grup olusturulmali, kisiler eklenmeli | [ ] |
| 3 | Grup listesinde yeni grubu kontrol et | Grup ve kisiler gorunmeli | [ ] |

---

## 11. Kampanyada Tek Grup Secme

**On Kosul:** En az bir grup mevcut, WhatsApp bagli.

| Adim | Islem | Beklenen Sonuc | Sonuc |
|------|-------|----------------|-------|
| 1 | Kampanya alaninda bir grup checkbox'ini isaretle | Grup secilmeli | [ ] |
| 2 | Hedef sayaci guncellenmeli | "Toplam X numara secildi" dogru olmali | [ ] |

---

## 12. Kampanyada Coklu Grup Secme

**On Kosul:** En az iki grup mevcut.

| Adim | Islem | Beklenen Sonuc | Sonuc |
|------|-------|----------------|-------|
| 1 | Birden fazla grup checkbox'ini isaretle | Tum secilen gruplarin kisileri toplanmali | [ ] |
| 2 | Hedef sayaci kontrol et | Tum gruplarin toplam kisi sayisi gosterilmeli | [ ] |
| 3 | Duplicate numaralar (gruplar arasi) tekillestirilmeli | Sayac duplicate haric olmali | [ ] |

---

## 13. Manuel Kampanya Numarasi Girme

**On Kosul:** Kampanya ekrani acik.

| Adim | Islem | Beklenen Sonuc | Sonuc |
|------|-------|----------------|-------|
| 1 | Manuel numara alanina numara gir | Numara eklenmeli | [ ] |
| 2 | Grup secimi ile birlikte manuel numara gir | Toplam sayi grup + manuel olmali | [ ] |
| 3 | Duplicate manuel numara gir | Tekillestirilmeli | [ ] |

---

## 14. Medya Upload ve Medya Kaldirma

**On Kosul:** Kampanya ekrani acik.

| Adim | Islem | Beklenen Sonuc | Sonuc |
|------|-------|----------------|-------|
| 1 | Medya upload alanina resim dosya surukle | Upload baslamali, loading gorunmeli | [ ] |
| 2 | Upload tamamlaninca | Preview gorunmeli | [ ] |
| 3 | Medya uzerindeki X butonuna tikla | Medya kaldirilmali | [ ] |
| 4 | Gecersiz dosya tipi yukle | Hata mesaji gosterilmeli | [ ] |

---

## 15. Metin-Only Gonderim

**On Kosul:** WhatsApp bagli, en az 1 hedef numara secili.

| Adim | Islem | Beklenen Sonuc | Sonuc |
|------|-------|----------------|-------|
| 1 | Mesaj alaniina metin gir | Metin yazilabilmeli | [ ] |
| 2 | `{{ad}}` etiketi kullan | Onizlemede isim gosterilmeli | [ ] |
| 3 | Gonder butonuna bas | Kampanya baslamali | [ ] |

---

## 16. Metin + Coklu Medya Gonderim

**On Kosul:** WhatsApp bagli, en az 1 hedef, medya eklenmis.

| Adim | Islem | Beklenen Sonuc | Sonuc |
|------|-------|----------------|-------|
| 1 | Mesaj gir ve birden fazla medya ekle | Mesaj + medya hazir olmali | [ ] |
| 2 | Gonder butonuna bas | Kampanya baslamali | [ ] |
| 3 | Gonderim sirasinda medya ile birlikte gitmeli | Alici mesaj + medya aldigini dogrula | [ ] |

---

## 17. Kampanya Durdurma

**On Kosul:** Kampanya calisiyor.

| Adim | Islem | Beklenen Sonuc | Sonuc |
|------|-------|----------------|-------|
| 1 | "Durdur" butonuna tikla | Kampanya durmali | [ ] |
| 2 | Progress durmalidir | Gonderim durmali | [ ] |
| 3 | Durum "stopped" olmali | UI'da durduruldu gorunmeli | [ ] |

---

## 18. Progress %100 ve Tamamlandi Modali

**On Kosul:** Kampanya tum numaralara gonderildi.

| Adim | Islem | Beklenen Sonuc | Sonuc |
|------|-------|----------------|-------|
| 1 | Kampanya tamamlanana kadar bekle | Progress %100 olmali | [ ] |
| 2 | Tamamlandi modali acilmali | "Gonderiler tamamlandi" mesaji gorunmeli | [ ] |
| 3 | Modal kapatilmali | Kapatma islevsel olmali | [ ] |

---

## 19. Uygulama Restart Sonrasi Gruplar/Kisiler Korunuyor mu

**On Kosul:** Gruplar ve kisiler mevcut.

| Adim | Islem | Beklenen Sonuc | Sonuc |
|------|-------|----------------|-------|
| 1 | Mevcut grup ve kisi sayisini not al | Kayit altina al | [ ] |
| 2 | Uygulamayi restart et | `docker restart` veya `pm2 restart` | [ ] |
| 3 | Tekrar login ol ve gruplari kontrol et | Grup sayisi ayni olmali | [ ] |
| 4 | Grup icindeki kisileri kontrol et | Kisi sayilari ayni olmali | [ ] |
| 5 | Kampanya hedef sayacini kontrol et | Hedef sayilar dogru olmali | [ ] |

---

## 20. Deploy Sonrasi Gruplar/Kisiler Korunuyor mu

**On Kosul:** Production veya staging ortaminda deploy yapilacak.

| Adim | Islem | Beklenen Sonuc | Sonuc |
|------|-------|----------------|-------|
| 1 | Deploy oncesi grup ve kisi sayilarini not al | Kayit altina al | [ ] |
| 2 | Deploy/Git pull + restart yap | Yeni kod devreye girmeli | [ ] |
| 3 | Site acilisini kontrol et | 503 veya sonsuz loading OLMAMALI | [ ] |
| 4 | Login ol ve gruplari kontrol et | Grup sayisi ayni olmali | [ ] |
| 5 | Kisileri kontrol et | Kisi sayilari ayni olmali | [ ] |
| 6 | Yeni grup/kisi eklemeyi dene | Normal calismali | [ ] |

---

## Sonuc Ozeti

| # | Test | Gecti | Kaldi | Yorum |
|---|------|-------|-------|-------|
| 1 | Login basarili/hatali | [ ] | [ ] | |
| 2 | Login yonlendirme | [ ] | [ ] | |
| 3 | WhatsApp QR + connected | [ ] | [ ] | |
| 4 | Yeni grup olusturma | [ ] | [ ] | |
| 5 | Grup silme | [ ] | [ ] | |
| 6 | Excel import | [ ] | [ ] | |
| 7 | Manuel kisi ekleme | [ ] | [ ] | |
| 8 | Kisi duzenleme | [ ] | [ ] | |
| 9 | Kisi silme | [ ] | [ ] | |
| 10 | Grup olarak kaydetme | [ ] | [ ] | |
| 11 | Tek grup secme | [ ] | [ ] | |
| 12 | Coklu grup secme | [ ] | [ ] | |
| 13 | Manuel numara girme | [ ] | [ ] | |
| 14 | Medya upload/kaldirma | [ ] | [ ] | |
| 15 | Metin-only gonderim | [ ] | [ ] | |
| 16 | Metin + coklu medya | [ ] | [ ] | |
| 17 | Kampanya durdurma | [ ] | [ ] | |
| 18 | Progress + tamamlandi | [ ] | [ ] | |
| 19 | Restart sonrasi veri | [ ] | [ ] | |
| 20 | Deploy sonrasi veri | [ ] | [ ] | |

**Genel Sonuc:** [ ] TUM TESTLER GECTI / [ ] BASARISIZ TEST(ler) VAR

**Notlar:**
_______________________________________________________________
_______________________________________________________________