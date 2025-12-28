#!/usr/bin/env python3
from pathlib import Path
import sys
from PIL import Image

SIZES = {
    "mipmap-mdpi": 48,
    "mipmap-hdpi": 72,
    "mipmap-xhdpi": 96,
    "mipmap-xxhdpi": 144,
    "mipmap-xxxhdpi": 192,
}

def supports_webp_write() -> bool:
    # Pillow: Image.SAVE includes supported formats
    return "WEBP" in getattr(Image, "SAVE", {})

def center_crop_square(im: Image.Image) -> Image.Image:
    im = im.convert("RGBA")
    w, h = im.size
    side = min(w, h)
    left = (w - side) // 2
    top = (h - side) // 2
    return im.crop((left, top, left + side, top + side))

def save_icon(img: Image.Image, out_path: Path, prefer_webp: bool = True) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)

    if prefer_webp:
        # WebP: quality/method are reasonable defaults for icons
        img.save(out_path.with_suffix(".webp"), format="WEBP", quality=90, method=6)
    else:
        # fallback png
        img.save(out_path.with_suffix(".png"), format="PNG")

def main():
    if len(sys.argv) < 2:
        print("Usage: set_android_icon.py path/to/icon.(png|jpg|jpeg|webp)")
        sys.exit(1)

    src = Path(sys.argv[1])
    if not src.exists():
        print(f"Erreur: fichier introuvable: {src}")
        sys.exit(1)

    res_dir = Path("android/app/src/main/res")
    if not res_dir.exists():
        print(f"Erreur: dossier res introuvable: {res_dir}")
        sys.exit(1)

    im = Image.open(src)
    im = center_crop_square(im)

    prefer_webp = True
    if prefer_webp and not supports_webp_write():
        print("Attention: Pillow ne supporte pas l'écriture WebP ici -> fallback PNG.")

    for folder, size in SIZES.items():
        outdir = res_dir / folder
        outdir.mkdir(parents=True, exist_ok=True)

        resized = im.resize((size, size), Image.LANCZOS)

        # Choix du nom Android standard
        base_name = outdir / "ic_launcher"
        save_icon(resized, base_name, prefer_webp=prefer_webp)

        # round: copie identique (tu peux faire un masque rond si tu veux)
        base_round = outdir / "ic_launcher_round"
        save_icon(resized, base_round, prefer_webp=prefer_webp)

        # round: copie identique (tu peux faire un masque rond si tu veux)
        base_round = outdir / "ic_launcher_foreground"
        save_icon(resized, base_round, prefer_webp=prefer_webp)

    # playstore
    resized = im.resize((512, 512), Image.LANCZOS)
    res_dir_playstore = Path("android/app/src/main")
    base_name_playstore = res_dir_playstore / "ic_launcher-playstore"
    save_icon(resized, base_name_playstore, prefer_webp=False)

    ext = "webp" if (prefer_webp and supports_webp_write()) else "png"
    print(f"OK: icônes générées dans android/app/src/main/res/mipmap-* en .{ext}")
    print("Recommandé: npx cap sync android")

if __name__ == "__main__":
    main()
