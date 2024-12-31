#!/usr/bin/env bash
PROJET_PATH="project-path.txt"
# Change directory to project-path
project_path_content=$(cat $PROJET_PATH) || {
  echo "Error: Could not open file PROJET_PATH"
  exit 1
}
cd "$project_path_content" || {
  echo "Error: Could not change to directory $directory"
  exit 1
}

# Build Android app
npx cap sync android
npx cap build android
#npx cap build android --keystorepath debug.keystore --keystorepass android --keystorealias android --keystorealiaspass android --androidreleasetype APK
