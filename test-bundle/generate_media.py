#!/usr/bin/env python3
"""Génère les fixtures média du bundle de test, bibliothèque standard seule.

Ni ffmpeg, ni ImageMagick, ni PIL sur cette machine : PNG, GIF, BMP et WAV
s'ecrivent a la main, ce qui a l'avantage de produire des fichiers dont on
connait chaque octet. JPEG, WebP, MP3 et MP4 ne s'ecrivent pas sans encodeur.
"""
import struct, zlib, wave, math, os, sys

OUT = sys.argv[1]

def chunk(tag, data):
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))

def png(path, w, h, pixel, alpha=False, grey=False):
    """pixel(x, y) -> tuple d'octets, selon le mode."""
    if grey:
        ctype, nch = 0, 1
    elif alpha:
        ctype, nch = 6, 4
    else:
        ctype, nch = 2, 3
    raw = bytearray()
    for y in range(h):
        raw.append(0)                     # filtre 0 : aucun
        for x in range(w):
            raw.extend(pixel(x, y))
    body = (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, ctype, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
            + chunk(b"IEND", b""))
    open(path, "wb").write(body)
    return len(body)

def gif(path, w, h, frames, delay_cs=25):
    """frames : liste d'index de palette, un octet par pixel."""
    pal = bytes([0,0,0, 255,255,255, 214,44,56, 44,120,214, 240,200,60, 60,190,120, 128,128,128, 255,140,0])
    pal += b"\x00" * (3 * (8 - len(pal)//3))
    out = bytearray(b"GIF89a")
    out += struct.pack("<HHBBB", w, h, 0xF2, 0, 0)   # table globale de 8 couleurs
    out += pal
    if len(frames) > 1:
        out += b"!\xff\x0bNETSCAPE2.0\x03\x01\x00\x00\x00"   # boucle infinie
    for fr in frames:
        out += b"!\xf9\x04\x04" + struct.pack("<H", delay_cs) + b"\x00\x00"
        out += b"," + struct.pack("<HHHH", 0, 0, w, h) + b"\x00"
        # Taille de code MINIMALE : 8. Elle doit correspondre a ce qu'ecrit
        # lzw8 — un 7 ici et le decodeur lit des codes de 8 bits quand on en
        # ecrit de 9, ce qui rend une image de la bonne taille et du mauvais
        # contenu. Mesure : 1040 pixels decodes pour 1024 ecrits.
        out += b"\x08"
        enc = lzw8(fr)
        for i in range(0, len(enc), 255):
            blk = enc[i:i+255]
            out += bytes([len(blk)]) + blk
        out += b"\x00"
    out += b";"
    open(path, "wb").write(bytes(out))
    return len(out)

def lzw8(pixels):
    """LZW GIF a 8 bits de code initial, sans dictionnaire : clear/litteral/eoi."""
    CLEAR, EOI = 0x100, 0x101
    bits, acc, nbits, out = 9, 0, 0, bytearray()
    def emit(code):
        nonlocal acc, nbits
        acc |= code << nbits
        nbits += bits
        while nbits >= 8:
            out.append(acc & 0xFF)
            acc >>= 8
            nbits -= 8
    emit(CLEAR)
    n = 0
    for px in pixels:
        emit(px)
        n += 1
        if n == 100:            # on repart avant que le dictionnaire grandisse
            emit(CLEAR); n = 0
    emit(EOI)
    if nbits:
        out.append(acc & 0xFF)
    return bytes(out)

def bmp(path, w, h, pixel):
    row = (w * 3 + 3) // 4 * 4
    px = bytearray()
    for y in range(h - 1, -1, -1):       # BMP part du bas
        line = bytearray()
        for x in range(w):
            r, g, b = pixel(x, y)
            line += bytes([b, g, r])
        line += b"\x00" * (row - len(line))
        px += line
    size = 54 + len(px)
    hdr = b"BM" + struct.pack("<IHHI", size, 0, 0, 54)
    hdr += struct.pack("<IiiHHIIiiII", 40, w, h, 1, 24, 0, len(px), 2835, 2835, 0, 0)
    open(path, "wb").write(hdr + bytes(px))
    return size

def wav(path, seconds=2.0, rate=8000):
    with wave.open(path, "wb") as f:
        f.setnchannels(1); f.setsampwidth(2); f.setframerate(rate)
        frames = bytearray()
        n = int(rate * seconds)
        for i in range(n):
            t = i / rate
            # deux notes, pour qu'on entende que ca joue vraiment
            freq = 440.0 if t < seconds / 2 else 660.0
            env = min(1.0, 8 * min(t, seconds - t))     # attaque/chute douces
            v = int(12000 * env * math.sin(2 * math.pi * freq * t))
            frames += struct.pack("<h", v)
        f.writeframes(bytes(frames))
    return os.path.getsize(path)

# ── les fixtures ────────────────────────────────────────────────────────────
os.makedirs(OUT, exist_ok=True)
made = {}

# damier couleur, pour voir tout de suite si l'echelle ou l'orientation ment
def damier(x, y):
    c = ((x // 8) + (y // 8)) % 2
    return (214, 44, 56) if c else (44, 120, 214)
made["image-rgb.png"] = png(f"{OUT}/image-rgb.png", 64, 64, damier)

# transparence : un disque opaque sur fond transparent
def disque(x, y):
    dx, dy = x - 32, y - 32
    inside = dx * dx + dy * dy <= 28 * 28
    return (60, 190, 120, 255) if inside else (0, 0, 0, 0)
made["image-alpha.png"] = png(f"{OUT}/image-alpha.png", 64, 64, disque, alpha=True)

# degrade en niveaux de gris
made["image-grey.png"] = png(f"{OUT}/image-grey.png", 64, 16,
                             lambda x, y: (x * 4,), grey=True)

# 1x1 : le cas degenere
made["image-1x1.png"] = png(f"{OUT}/image-1x1.png", 1, 1, lambda x, y: (255, 0, 0))

# BMP non compresse
made["image.bmp"] = bmp(f"{OUT}/image.bmp", 32, 32, damier)

# GIF statique puis anime : une barre qui traverse
static = [1 if (x // 8 + y // 8) % 2 else 2 for y in range(32) for x in range(32)]
made["image-static.gif"] = gif(f"{OUT}/image-static.gif", 32, 32, [static])
frames = []
for k in range(8):
    frames.append([3 if abs(x - k * 4) < 3 else 0 for y in range(32) for x in range(32)])
made["image-animated.gif"] = gif(f"{OUT}/image-animated.gif", 32, 32, frames, delay_cs=12)

# audio
made["audio-tone.wav"] = wav(f"{OUT}/audio-tone.wav", 2.0)

for k, v in sorted(made.items()):
    print(f"  {k:24s} {v:7d} o")
