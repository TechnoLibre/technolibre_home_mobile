#!/bin/env bash
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

cordova create "$PROJET_PATH" "$project_name_package_content" "$project_name_content"
