# Beşinci Boyut: 5D Kara Delik (Three.js + GLSL)

## Çalıştırma
`index.html` dosyasına çift tıklamanız yeterli. Sunucu gerekmez.
Three.js (r128) CDN'den yüklenir; internet yoksa `three.min.js` (r128) dosyasını `lib/` klasörüne koyun.

## Klasör yapısı
- `index.html` : sayfa, arayüz (W kaydırıcısı, ayarlar)
- `main.js` : sahne, render hattı, kamera, fare/dokunmatik kontrol, adaptif çözünürlük
- `shaders/fullscreen.vert.js` : tüm ekranı kaplayan üçgen (ray-march ve post-process ortak)
- `shaders/blackhole.frag.js` : ışın izleme (bükülmüş ışınlar), morf eden ufuk, 3 katmanlı kırık disk, karanlık enerji dokuları, arka plan
- `shaders/particles.vert.js` / `particles.frag.js` : 5D hareketli plazma (~110 bin parçacık, tek draw call)
- `shaders/post.frag.js` : bloom, ışık huzmeleri, kromatik sapma, ACES, vinyet, grenli film efekti

## 5. boyut mantığı
`uW` (0..1) tek parametredir: 0 küre, 0.5 kara halka, 1 bükülmüş (Hopf bağlantılı) form.
Aynı değer disk katmanlarını farklı düzlemlere açar, yerçekimini dikleştirir, ışınlara girdap ekler
ve plazma/doku gürültüsünün gizli 4. koordinatını (w4) sürer. Ayrıntılı açıklamalar shader dosyalarının başındaki yorumlardadır.

## Kontroller
Sürükle: döndür, tekerlek / iki parmak: yakınlaş, çift tık: görünümü sıfırla.
Alttaki kaydırıcıyı elle oynatınca otomatik dönüşüm durur.
