# Provenance des fixtures média

## Générées pour ce jeu de test

Écrites par `test-bundle/generate_media.py`, sans dépendance : ni ffmpeg, ni
ImageMagick, ni PIL n'étaient disponibles, donc les en-têtes sont écrits à la
main. Chaque fichier est vérifié en le décodant, pas seulement en l'écrivant.

| Fichier | Ce qu'il éprouve |
|---------|------------------|
| `image-rgb.png` | PNG couleur, damier — une échelle ou une orientation fausse se voit |
| `image-alpha.png` | Canal alpha : disque opaque sur fond transparent |
| `image-grey.png` | PNG en niveaux de gris (type 0), dégradé |
| `image-1x1.png` | Le cas dégénéré d'un seul pixel |
| `image.bmp` | BMP 24 bits non compressé, lignes de bas en haut |
| `image-static.gif` | GIF à une image, palette de 8 couleurs |
| `image-animated.gif` | GIF animé, 8 images, boucle infinie |
| `image-shapes.svg` | SVG : rect, circle, polygon, line |
| `image-text.svg` | SVG `<text>`, accents et entités |
| `image-gradient.svg` | SVG : dégradé linéaire et `stop-opacity` |
| `audio-tone.wav` | WAV PCM mono 8 kHz, deux notes, 2 s |

## Empruntées au workspace

Ces formats exigent un encodeur absent de la machine. Les fichiers viennent du
workspace ERPLibre, sont les plus petits disponibles, et leurs licences sont
compatibles avec l'AGPL-3.0+ de cette application.

| Fichier | Source | Licence |
|---------|--------|---------|
| `photo.jpg` | `addons/OCA_storage/storage_image_product/tests/fixture/logo-image.jpg` | AGPL-3 (OCA) |
| `photo-small.jpeg` | `odoo/odoo/addons/base/tests/fire_small.jpeg` | LGPL-3 (Odoo) |
| `icon.webp` | `mobile/erplibre_home_mobile/android/.../ic_launcher_foreground.webp` | AGPL-3 (ce dépôt) |
| `sound.mp3` | `odoo/addons/mail/static/src/audio/ptt_push_1.mp3` | LGPL-3 (Odoo) |
| `sound.ogg` | `odoo/addons/point_of_sale/static/src/sounds/bell.ogg` | LGPL-3 (Odoo) |
| `favicon.ico` | `addons/OCA_shopfloor-app/.../favicon.ico` | AGPL-3 (OCA) |

## Manquant : la vidéo

Aucun MP4 ni WebM n'est livrable en l'état. Le seul du workspace pèse 11 Mo, et
H.264 comme VP9 exigent un encodeur que la machine n'a pas. Quand ffmpeg est
disponible, deux commandes suffisent — moins de 10 s, quelques dizaines de Ko :

```bash
cd test-bundle/media
ffmpeg -f lavfi -i testsrc=size=160x120:rate=12:duration=6 \
       -pix_fmt yuv420p -c:v libx264 -crf 40 video.mp4
ffmpeg -f lavfi -i testsrc=size=160x120:rate=12:duration=6 \
       -c:v libvpx-vp9 -crf 50 -b:v 0 video.webm
```
