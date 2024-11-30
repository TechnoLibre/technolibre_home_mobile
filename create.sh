#!/bin/env bash

if [ -z "$1" ]; then
  PLATFORM="android"
else
  PLATFORM="$1"
fi

PROJET_PATH="project-path.txt"
# Change directory to project-path
project_path_content=$(cat $PROJET_PATH) || {
  echo "Error: Could not open file PROJET_PATH"
  exit 1
}
PROJET_NAME="project-name.txt"
# Change directory to project-path
project_name_content=$(cat $PROJET_NAME) || {
  echo "Error: Could not open file PROJET_NAME"
  exit 1
}
PROJET_NAME_PACKAGE="project-name-package.txt"
# Change directory to project-path
project_name_package_content=$(cat $PROJET_NAME_PACKAGE) || {
  echo "Error: Could not open file PROJET_NAME_PACKAGE"
  exit 1
}

echo cordova create "$project_path_content" "$project_name_package_content" "$project_name_content"
cordova create "$project_path_content" "$project_name_package_content" "$project_name_content" || {
  echo "Error: cordova create $project_path_content $project_name_package_content $project_name_content"
  exit 1
}

cd "$project_path_content" || {
  echo "Error: Could not change to directory $directory"
  exit 1
}

# Platform
cordova platform add $PLATFORM

# Plugin
cordova plugin add cordova-plugin-inappbrowser
