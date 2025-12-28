# TechnoLibre Home Capacitor

This repository contains an Odoo Owl/Capacitor project.

The following sections outline instructions on the proper use of the provided scripts, as well as the errors you may encounter when setting up a new project and how to deal with them.

## Installation

To install the npm dependencies required for the development of the web app, run:

```
npm install
```

## Running the app

These commands run the application on android, but it can also be done with ios if the platform is installed properly.

```bash
# Builds and syncs the application
npm run build && npx cap sync

# Runs the app (android)
npx cap run android

# Runs the app (iOS)
npx cap run ios
```

For a more convenient way of building, syncing and running the application, check out the [BSR Script](#bsr-script) section.

## Deleting node_modules

Sometimes, you might want to remove the node_modules folder and reinstall the npm packages to solve issues.

> [!CAUTION]
> When deleting `node_modules`, you are preventing the npm packages, such as `@odoo/owl` or `@capacitor/app` from working until they are reinstalled.

```bash
# Delete node_modules
rm -rf node_modules

# Reinstall packages
npm install
```

## Pruning

To only uninstall packages that aren't actual depencencies from node_modules, you can run the prune command.

```
npm prune
```

## BSR Script

BSR means _Build_, _Sync_ and _Run_, common actions during development. Since you'll often need to build the application and launch it on specific devices, this script was built to make this workflow faster.

Here are the commands

`npm run bsr`: Builds the app and starts it on localhost (web)

`npm run bsr web`: Same as `npm run bsr`

`npm run bsr ios`: Builds and syncs the app, then runs it on an iOS device.

`npm run bsr android`: Builds and syncs the app, then runs it on an android device.

## GenComp Script

This section provices details on the GenComp script.

GenComp means _Generate Component_. The Script allows you to generate a boilerplate Owl component so you can start programming component features faster.

### Commands

`npm run gencomp <name>`: Generates the component in the `components` folder
`npm run gencomp <name> <path>`: Generates the component in the provided folder
`npm run gencomp <name> <path> <add-css>`: Generates the component in the provided folder, and omits the CSS file if add-css is set to `false`.

### Parameters

#### Name

Name of the component, will have "Component" appended to it automatically.

#### Path

Path of the component relative to the `components` folder.

A path of `notes/item` will create the component in `src/components/notes/item`.

Optional parameter.

#### AddCSS

If set to `false`, the CSS file will not be created and it will not be added to the imports in `src/css/components.scss`.

Optional parameter.

### Example

`npm run gencomp noteItem notes/item false` will create the component `NoteItem` in `src/components/notes/item` without the CSS file.

## Shell Scripts

This section provides details on the provided shell scripts to help you better understand them and use them in appropriate situations.

<details>
<summary>Expand</summary>

### create.sh

Generalized script to create an Odoo Owl/Capacitor project and add a specific platform. If no platform argument is specified, defaults to adding the Android platform and therefore behaves like `create-android.sh`.

### create-android.sh

Creates an Odoo Owl/Capacitor project and adds the Android platform.

### create-ios.sh

Creates an Odoo Owl/Capacitor project and adds the iOS platform.

### add-android.sh

Adds the Android platform to the project.

### add-ios.sh

Adds the iOS platform to the project.

### build-android.sh

Builds the Capacitor project. Creates a signed Android executable application.

### build-ios.sh

Builds the Capacitor project. Creates a signed iOS executable application.

### sync.sh

Copies the built Odoo Owl project to all platforms and updates the native plugins and dependencies in `package.json`.

</details>

## Errors

This section outlines the errors that may be faced when trying to initialize a new Odoo Owl/Capacitor project by using the scripts from the previous sections or by manually entering the appropriate commands. The solutions to these errors will also be provided.

<details>
<summary>Expand</summary>

## iOS

### `build-ios.sh` or `npx cap build ios`:

#### Error:

error: Signing for "App" requires a development team. Select a development team in the Signing & Capabilities editor. (in target 'App' from project 'App')

#### Solution:

https://forum.ionicframework.com/t/ionic-capacitor-failed-ios-build/177400/2

## Android

### `build-android.sh` or `npx cap build android`

</details>

## Odoo Owl Documentation

[Official Odoo Owl GitHub](https://github.com/odoo/owl/tree/master?tab=readme-ov-file#documentation)
