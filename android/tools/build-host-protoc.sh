#!/usr/bin/env bash
# Construit un `protoc` pour la machine HÔTE, nécessaire à la compilation
# croisée de sentencepiece vers Android.
#
# Le problème qu'il règle
# -----------------------
# sentencepiece récupère protobuf, dont le CMake construit `protoc` pour la
# CIBLE puis tente de l'exécuter sur l'hôte afin de générer les .pb.cc. Sur un
# hôte x86_64 visant arm64, cela donne :
#
#   /bin/sh: .../obj/arm64-v8a/protoc-25.6.0: Exec format error
#
# sentencepiece prévoit le cas : renseigner `SPM_PROTOC_EXECUTABLE` désactive la
# construction de protoc pour la cible et utilise celui qu'on lui donne. C'est
# le chemin de compilation croisée officiel, pas un contournement.
#
# La version doit correspondre EXACTEMENT à celle que sentencepiece récupère :
# le code généré et la bibliothèque d'exécution vont par paire. Le script lit
# donc la version dans son CMakeLists plutôt que de la coder en dur.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANDROID_DIR="$(dirname "$HERE")"
APP_DIR="$ANDROID_DIR/app"
SPM_CMAKE="$APP_DIR/src/main/cpp/sentencepiece/CMakeLists.txt"
CACHE="$HERE/protoc"
BIN="$CACHE/bin/protoc"

if [[ ! -f "$SPM_CMAKE" ]]; then
    echo "sentencepiece absent : rien à faire, l'APK se construira sans MarianMT."
    echo "  attendu à $APP_DIR/src/main/cpp/sentencepiece/"
    exit 0
fi

# Version exigée, lue à la source.
WANTED="$(awk '
    /FetchContent_Declare\(/ { getline name; gsub(/[[:space:]]/, "", name)
                               inblock = (name == "protobuf"); next }
    inblock && /GIT_TAG/      { gsub(/[[:space:]]/, "", $2); print $2; exit }
' "$SPM_CMAKE" | tr -d 'v')"
if [[ -z "$WANTED" ]]; then
    echo "Impossible de lire la version de protobuf dans $SPM_CMAKE" >&2
    exit 1
fi

if [[ -x "$BIN" ]]; then
    HAVE="$("$BIN" --version 2>/dev/null | awk '{print $2}')"
    if [[ "$HAVE" == "$WANTED" ]]; then
        echo "protoc $HAVE déjà présent : $BIN"
        exit 0
    fi
    echo "protoc $HAVE en cache mais $WANTED est attendu, reconstruction."
fi

# Source : celle que Gradle a déjà récupérée si elle est là, sinon on clone.
SRC="$(find "$APP_DIR/.cxx" -maxdepth 6 -type d -name protobuf-src 2>/dev/null | head -1 || true)"
CLONED=""
if [[ -n "$SRC" && -d "$SRC/third_party/abseil-cpp/absl" ]]; then
    echo "Sources protobuf réutilisées depuis le build Gradle : $SRC"
else
    SRC="$HERE/.protobuf-src"
    if [[ ! -d "$SRC/third_party/abseil-cpp/absl" ]]; then
        echo "Clonage de protobuf v$WANTED avec ses sous-modules…"
        rm -rf "$SRC"
        git clone --depth=1 --branch "v$WANTED" --recurse-submodules --shallow-submodules \
            https://github.com/protocolbuffers/protobuf.git "$SRC"
    fi
    CLONED="1"
fi

BUILD="$HERE/.protoc-build"
rm -rf "$BUILD"
echo "Configuration…"
cmake -S "$SRC" -B "$BUILD" \
    -DCMAKE_BUILD_TYPE=Release \
    -Dprotobuf_BUILD_TESTS=OFF \
    -Dprotobuf_BUILD_EXAMPLES=OFF \
    -Dprotobuf_ABSL_PROVIDER=module \
    -Dprotobuf_INSTALL=OFF \
    >/dev/null

echo "Compilation de protoc (quelques minutes)…"
cmake --build "$BUILD" --target protoc -j"$(nproc)" >/dev/null

mkdir -p "$CACHE/bin"
install -m 0755 "$BUILD/protoc" "$BIN"
rm -rf "$BUILD"
[[ -n "$CLONED" ]] || true

echo "protoc $("$BIN" --version | awk '{print $2}') installé : $BIN"
echo "Gradle le détectera seul au prochain build."
