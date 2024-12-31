#!/usr/bin/env bash

if [ -z "$1" ]; then
  PLATFORM="android"
else
  PLATFORM="$1"
fi

red="\033[0;31m"
clear="\033[0m"

PROJET_PATH="project-path.txt"
# Change directory to project-path
project_path_content=$(cat $PROJET_PATH) || {
  echo -e "${red}Error: Could not open file PROJET_PATH${clear}"
  exit 1
}

if [ ! -d "$project_path_content" ]; then {
  echo npm init @capacitor/app@latest
  printf "\n"
  npm init @capacitor/app@latest
  } || {
    echo -e "${red}Error: npm init @capacitor/app@latest${clear}"
    exit 1
  }
fi

cd "$project_path_content" || {
  echo -e "${red}Error: Could not change to directory $directory${clear}"
  exit 1
}

printf "\n"
echo npm i @capacitor/$PLATFORM
npm i @capacitor/$PLATFORM

printf "\n"
echo npx cap add $PLATFORM
printf "\n"
npx cap add $PLATFORM || {
  echo -e "${red}Error: Could not add the $PLATFORM platform${clear}"
}