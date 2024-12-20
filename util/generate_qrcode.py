#!/usr/bin/env python3

import qrcode
from PIL import Image, ImageOps, ImageDraw, ImageFont


# import cairosvg
#
# def ajouter_texte_avec_emoji(image, texte, police, position):
#   """Ajoute du texte avec emoji à l'image en utilisant CairoSVG."""
#   # Ajouter les attributs width et height au SVG
#   cairosvg.svg2png(bytestring=f'<svg width="100" height="50"><text font-family="{police.getname()[0]}" font-size="{police.size}">{texte}</text></svg>', write_to='temp_emoji.png')
#   img_emoji = Image.open('temp_emoji.png').convert("RGBA")
#   image.paste(img_emoji, position, img_emoji)

def obtenir_taille_texte(texte, police):
    """Calcule la taille du texte en pixels."""
    bbox = ImageDraw.Draw(Image.new('RGB', (1, 1))).textbbox((0, 0), texte, font=police)
    return bbox[2] - bbox[0], bbox[3] - bbox[1]  # Largeur, hauteur


def generer_qrcode_avec_image(url, chemin_image, chemin_qrcode, texte, texte_size=20,
                              texte_with_emoji=False):
    """
    Génère un QR code avec une image au centre, un fond blanc sous le logo et du texte en dessous.

    Args:
      url: L'URL à encoder dans le QR code.
      chemin_image: Le chemin d'accès à l'image à insérer au centre.
      chemin_qrcode: Le chemin d'accès pour enregistrer le QR code généré.
      texte: Le texte à afficher sous l'image.
    """
    qr = qrcode.QRCode(
        version=5,
        error_correction=qrcode.constants.ERROR_CORRECT_H,
        box_size=10,
        border=4,
    )
    qr.add_data(url)
    qr.make(fit=True)

    img_qr = qr.make_image(fill_color="black", back_color="white").convert('RGB')

    # Ouvrir l'image et la redimensionner
    img_logo = Image.open(chemin_image).convert("RGBA")
    basewidth = int(img_qr.size[0] / 4)
    wpercent = (basewidth / float(img_logo.size[0]))
    hsize = int((float(img_logo.size[1]) * float(wpercent)))
    img_logo = img_logo.resize((basewidth, hsize), Image.Resampling.LANCZOS)

    # Ajouter une bordure blanche au logo
    bordure = 5
    img_logo = ImageOps.expand(img_logo, border=bordure, fill="white")

    # Créer une image blanche de la même taille que le logo avec bordure
    fond_blanc = Image.new("RGBA", img_logo.size, "white")

    # Coller le logo sur le fond blanc
    fond_blanc.paste(img_logo, (0, 0), img_logo)

    # Positionner l'image au centre du QR code
    if texte:
        pos_logo = ((img_qr.size[0] - fond_blanc.size[0]) // 2,
                    (img_qr.size[1] - fond_blanc.size[1]) // 2)
        img_qr.paste(fond_blanc, pos_logo, fond_blanc)

        # Ajouter le texte sous l'image
        dessin = ImageDraw.Draw(img_qr)
        # police_font_name = "arial.ttf"
        # police_font_name = "LiberationSans-Regular.ttf"
        police_font_name = "Ubuntu-R.ttf"
        # police_font_name = "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf"
        # police_font_name = "/usr/share/fonts/truetype/noto/NotoMono-Regular.ttf"
        if texte_with_emoji:
            police_font_name = "./util/NotoColorEmoji.ttf"
        try:
            police = ImageFont.truetype(police_font_name, texte_size)
        except OSError as e:
            print(e)
            print(f"Error with police name {police_font_name}, use default.")
            police = ImageFont.load_default(size=texte_size)
        taille_texte = obtenir_taille_texte(texte, police)
        pos_texte = (img_qr.size[0] // 2 - taille_texte[0] // 2,
                     pos_logo[1] + fond_blanc.size[
                         1] - 20)  # Positionner le texte sous l'image
        dessin.text(pos_texte, texte, font=police, fill="black")
        # ajouter_texte_avec_emoji(img_qr, "🦁", police, pos_texte)

    # Enregistrer le QR code
    img_qr.save(chemin_qrcode)


# Exemple d'utilisation
url = "https://transfert.facil.services/r/5HUHCSNhxB#79rhATf47bcnzA4oHWp6KpzQKNkeg7E3wMlFwJF6W00="
chemin_image = "technolibre-home/www/img/logo.png"  # Remplacez par le chemin de votre image
chemin_qrcode = "qrcode_avec_image.png"
texte = "APK Symba"
generer_qrcode_avec_image(url, chemin_image, chemin_qrcode, texte,
                          texte_with_emoji=False)
