#!/usr/bin/env bash
set -euo pipefail

# Usage:
# ./rename_android.sh "Nouveau Nom" "com.nouveau.package"

NEW_NAME="${1:?Missing app name}"
NEW_ID="${2:?Missing app id (package)}"

ANDROID_DIR="android"
STRINGS_FILE="$ANDROID_DIR/app/src/main/res/values/strings.xml"
GRADLE_FILE="$ANDROID_DIR/app/build.gradle"

if [[ ! -d "$ANDROID_DIR" ]]; then
  echo "Erreur: dossier ./android introuvable. Lance d'abord: npx cap add android"
  exit 1
fi

# 1) Récupérer l'ancien applicationId
OLD_ID="$(grep -E 'applicationId\s+"[^"]+"' -m1 "$GRADLE_FILE" | sed -E 's/.*applicationId\s+"([^"]+)".*/\1/')"
if [[ -z "$OLD_ID" ]]; then
  echo "Erreur: impossible de trouver applicationId dans $GRADLE_FILE"
  exit 1
fi

echo "Ancien ID : $OLD_ID"
echo "Nouveau ID: $NEW_ID"
#echo "Ancien nom : $OLD_NAME"
echo "Nouveau nom: $NEW_NAME"

# 2) Mettre à jour app_name
if [[ -f "$STRINGS_FILE" ]]; then
  # Remplace <string name="app_name">...</string>
  perl -0777 -i -pe 's{(<string\s+name="app_name">).*?(</string>)}{$1'"$NEW_NAME"'$2}g' "$STRINGS_FILE"
  perl -0777 -i -pe 's{(<string\s+name="title_activity_main">).*?(</string>)}{$1'"$NEW_NAME"'$2}g' "$STRINGS_FILE"
  perl -0777 -i -pe 's{(<string\s+name="package_name">).*?(</string>)}{$1'"$NEW_ID"'$2}g' "$STRINGS_FILE"
  perl -0777 -i -pe 's{(<string\s+name="custom_url_scheme">).*?(</string>)}{$1'"$NEW_ID"'$2}g' "$STRINGS_FILE"
else
  echo "Attention: $STRINGS_FILE introuvable, je saute la maj app_name."
fi

# 3) Mettre à jour applicationId dans build.gradle
perl -i -pe 's/applicationId\s+"'"$OLD_ID"'"/applicationId "'"$NEW_ID"'"/g' "$GRADLE_FILE"

# 4) Remplacer occurrences texte de OLD_ID -> NEW_ID dans les fichiers Android (prudent mais efficace)
#    (évite node_modules, build, etc.)
find "$ANDROID_DIR" -type f \
  \( -name "*.java" -o -name "*.kt" -o -name "*.xml" -o -name "*.gradle" -o -name "*.properties" \) \
  -not -path "*/build/*" -print0 \
  | xargs -0 perl -i -pe 's/\Q'"$OLD_ID"'\E/'"$NEW_ID"'/g'

# 5) Déplacer le dossier Java/Kotlin: com/old/pkg -> com/new/pkg
OLD_PATH="$(echo "$OLD_ID" | tr '.' '/')"
NEW_PATH="$(echo "$NEW_ID" | tr '.' '/')"
FALLBACK_PATH="ca/technolibre/home"
FALLBACK_FILE_PATH="android/app/src/main/java/$FALLBACK_PATH"
FALLBACK_FILE_PATH_JAVA_FILE="$FALLBACK_FILE_PATH/MainActivity.java"

if [[ ! -f "$FALLBACK_FILE_PATH_JAVA_FILE" ]]; then
  echo "Ancien path : $FALLBACK_FILE_PATH_JAVA_FILE NOT EXIST!"
  if git ls-tree -r --name-only HEAD | grep -qx "$FALLBACK_FILE_PATH_JAVA_FILE"; then
    echo "Checkout $FALLBACK_FILE_PATH_JAVA_FILE"
    git restore --staged "$FALLBACK_FILE_PATH_JAVA_FILE"
    git checkout -- "$FALLBACK_FILE_PATH_JAVA_FILE"
    OLD_PATH="$FALLBACK_PATH"
    echo "OLD_PATH mis à jour -> $OLD_PATH"
  else
    echo "Erreur: $FALLBACK_FILE_PATH_JAVA_FILE n'existe pas dans git"
#    exit 1
  fi
  echo "Force change ancien path : $OLD_PATH"
else
  echo "Ancien path : $OLD_PATH"
fi

echo "Nouveau path: $NEW_PATH"

SRC_MAIN="$ANDROID_DIR/app/src/main"
OLD_PKG="$OLD_ID"
OLD_PKG_FALLBACK="$(echo "$FALLBACK_PATH" | tr '/' '.')"
NEW_PKG="$NEW_ID"

echo "OLD PKG: $OLD_PKG"
echo "OLD PKG FALLBACK: $OLD_PKG_FALLBACK"
echo "NEW PKG: $NEW_PKG"

if [[ "$OLD_PATH" != "$NEW_PATH" ]] ; then
  for LANG_DIR in "$SRC_MAIN/java" "$SRC_MAIN/kotlin"; do
    echo $LANG_DIR
    if [[ -d "$LANG_DIR/$OLD_PATH" ]]; then
      echo "Déplacement des sources dans $LANG_DIR"
      mkdir -p "$LANG_DIR/$NEW_PATH"

      # Déplace tout le contenu de l'ancien package vers le nouveau
      rsync -a "$LANG_DIR/$OLD_PATH/" "$LANG_DIR/$NEW_PATH/"
      rm -rf "$LANG_DIR/$OLD_PATH"

      # Nettoie les dossiers vides parents (monte du bas vers le haut)
      DIR="$LANG_DIR/$(dirname "$OLD_PATH")"
      while [[ "$DIR" != "$LANG_DIR" ]]; do
        rmdir "$DIR" 2>/dev/null || break
        DIR="$(dirname "$DIR")"
      done
    fi

    # Renomme la déclaration de package dans les fichiers déplacés
    # Java:   package ca.technolibre.home;
    # Kotlin: package ca.technolibre.home
    find "$LANG_DIR/$NEW_PATH" -type f \( -name "*.java" -o -name "*.kt" \) -print0 \
      | xargs -0 perl -i -pe '
          s/^(\s*package\s+)\Q'"$OLD_PKG"'\E(\s*;?\s*)$/$1'"$NEW_PKG"'$2/m;
        '
    find "$LANG_DIR/$NEW_PATH" -type f \( -name "*.java" -o -name "*.kt" \) -print0 \
      | xargs -0 perl -i -pe '
          s/^(\s*package\s+)\Q'"$OLD_PKG_FALLBACK"'\E(\s*;?\s*)$/$1'"$NEW_PKG"'$2/m;
        '
  done
fi

echo "OK. Pense à lancer: npx cap sync android"
