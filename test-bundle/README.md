# Bundle de test — documents d'affichage

Cette arborescence est la troisième cible du navigateur de code
(**Options › Code › Test**). Elle n'existe que pour éprouver l'affichage : un
format qui ne s'affiche pas ici ne s'affichera pas dans un vrai dépôt, et on le
voit sans dérouler 82 000 fichiers.

Contrairement aux deux autres cibles, elle n'est pas dérivée de sources : ces
fichiers sont du contenu, et ils sont donc versionnés.

## Ce qu'elle contient

| Dossier | Contenu |
|---------|---------|
| `media/` | PNG, GIF, BMP, SVG, WAV générés ; JPEG, WebP, MP3, OGG, ICO empruntés |
| `text/` | markdown, JSON, CSV, XML, YAML, TOML, texte brut, fichier vide, Unicode |
| `code/` | six projets : Tornado, Odoo+Owl, JavaScript, Rust, C++, Java |

Le poids total tient sous 400 Ko. `media/PROVENANCE.md` dit d'où vient chaque
fichier, sous quelle licence, et ce qu'il éprouve.

## Régénérer les médias

```bash
./test-bundle/generate_media.py test-bundle/media
```

Le script n'emploie que la bibliothèque standard : ni ffmpeg, ni ImageMagick,
ni PIL n'étaient disponibles, donc les en-têtes PNG, GIF et BMP sont écrits à la
main. Chaque fichier produit est vérifié en le décodant.

## Ce qui manque

**La vidéo.** Aucun MP4 ni WebM n'est livrable : H.264 comme VP9 exigent un
encodeur absent, et le seul MP4 du workspace pèse 11 Mo. `PROVENANCE.md` donne
les deux commandes ffmpeg qui produisent un clip de 6 s en quelques dizaines de
Ko, le jour où ffmpeg est là.
