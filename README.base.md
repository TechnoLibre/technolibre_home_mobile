<!---------------------------->
<!-- multilingual suffix: en, fr -->
<!-- no suffix: en -->
<!---------------------------->

<!-- [en] -->
# ERPLibre Home Mobile

Odoo Owl + Capacitor mobile application for ERPLibre.

The following sections outline instructions on the proper use of the provided scripts, as well as the errors you may encounter when setting up a new project and how to deal with them.

Full technical documentation lives in [doc/README.md](./doc/README.md).

## Installation

To install the npm dependencies required for the development of the web app, run:

<!-- [fr] -->
# ERPLibre Home Mobile

Application mobile Odoo Owl + Capacitor pour ERPLibre.

Les sections suivantes décrivent le bon usage des scripts fournis, ainsi que les erreurs que vous pourriez rencontrer en initialisant un nouveau projet et la façon de les traiter.

La documentation technique complète se trouve dans [doc/README.md](./doc/README.md).

## Installation

Pour installer les dépendances npm nécessaires au développement de l'application web, lancer :

<!-- [common] -->
```
npm install
```

<!-- [en] -->
## Running the app

These commands run the application on android, but it can also be done with ios if the platform is installed properly.

<!-- [fr] -->
## Lancer l'application

Ces commandes lancent l'application sur Android, mais c'est également possible sur iOS si la plateforme est correctement installée.

<!-- [common] -->
```bash
# Builds and syncs the application
npm run build && npx cap sync

# Runs the app (android)
npx cap run android

# Runs the app (iOS)
npx cap run ios
```

<!-- [en] -->
For a more convenient way of building, syncing and running the application, check out the [BSR Script](#bsr-script) section.

## Deleting node_modules

Sometimes, you might want to remove the node_modules folder and reinstall the npm packages to solve issues.

> [!CAUTION]
> When deleting `node_modules`, you are preventing the npm packages, such as `@odoo/owl` or `@capacitor/app` from working until they are reinstalled.

<!-- [fr] -->
Pour une façon plus commode de compiler, synchroniser et lancer l'application, voir la section [Script BSR](#script-bsr).

## Supprimer node_modules

Il arrive qu'on veuille supprimer le dossier node_modules et réinstaller les paquets npm pour résoudre un problème.

> [!CAUTION]
> En supprimant `node_modules`, vous empêchez les paquets npm comme `@odoo/owl` ou `@capacitor/app` de fonctionner jusqu'à leur réinstallation.

<!-- [common] -->
```bash
# Delete node_modules
rm -rf node_modules

# Reinstall packages
npm install
```

<!-- [en] -->
## Pruning

To only uninstall packages that aren't actual depencencies from node_modules, you can run the prune command.

<!-- [fr] -->
## Élagage

Pour ne désinstaller de node_modules que les paquets qui ne sont pas de véritables dépendances, la commande prune est disponible.

<!-- [common] -->
```
npm prune
```

<!-- [en] -->
## Tests

The project uses [Vitest](https://vitest.dev/) for unit testing.

### Running tests

From the repository root:

<!-- [fr] -->
## Tests

Le projet utilise [Vitest](https://vitest.dev/) pour les tests unitaires.

### Lancer les tests

Depuis la racine du dépôt :

<!-- [common] -->
```bash
./mobile/run_tests.sh
```

<!-- [en] -->
Or directly from inside `erplibre_home_mobile`:

<!-- [fr] -->
Ou directement depuis `erplibre_home_mobile` :

<!-- [common] -->
```bash
npm test
```

<!-- [en] -->
### Test files

Test files are located in `src/__tests__/`:

| File | Coverage |
|------|----------|
| `appService.test.ts` | CRUD applications, initialization regression |
| `databaseService.test.ts` | SQLite operations (applications, notes) |
| `dataMigration.test.ts` | SecureStorage → SQLite migration |
| `migrationService.test.ts` | Migration runner, version storage |
| `migrationPopup.test.ts` | Migration notification dialog |
| `noteService.test.ts` | CRUD notes, tags, intents |

### Mocks

Capacitor plugins are mocked under `src/__mocks__/`:

| Mock | Purpose |
|------|---------|
| `capacitor-secure-storage-plugin.ts` | In-memory key/value store |
| `@capacitor/dialog.ts` | Stubbed alert/confirm |
| `@capacitor/core.ts` | Stubbed Capacitor core |
| `@capacitor-community/sqlite.ts` | In-memory SQLite via `sql.js` |
| `@odoo/owl.ts` | Stubbed Owl EventBus |

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

<!-- [fr] -->
### Fichiers de test

Les fichiers de test se trouvent dans `src/__tests__/` :

| Fichier | Couverture |
|---------|-----------|
| `appService.test.ts` | CRUD applications, régression d'initialisation |
| `databaseService.test.ts` | Opérations SQLite (applications, notes) |
| `dataMigration.test.ts` | Migration SecureStorage → SQLite |
| `migrationService.test.ts` | Runner de migrations, stockage de version |
| `migrationPopup.test.ts` | Dialogue de notification de migration |
| `noteService.test.ts` | CRUD notes, tags, intents |

### Mocks

Les plugins Capacitor sont mockés dans `src/__mocks__/` :

| Mock | Rôle |
|------|------|
| `capacitor-secure-storage-plugin.ts` | Stockage clé/valeur en mémoire |
| `@capacitor/dialog.ts` | alert/confirm bouchonnés |
| `@capacitor/core.ts` | Cœur de Capacitor bouchonné |
| `@capacitor-community/sqlite.ts` | SQLite en mémoire via `sql.js` |
| `@odoo/owl.ts` | EventBus d'Owl bouchonné |

## Script BSR

BSR signifie _Build_, _Sync_ et _Run_ — les actions courantes du développement. Comme il faut souvent compiler l'application et la lancer sur un appareil précis, ce script existe pour accélérer ce cycle.

Voici les commandes

`npm run bsr` : compile l'application et la démarre sur localhost (web)

`npm run bsr web` : identique à `npm run bsr`

`npm run bsr ios` : compile et synchronise l'application, puis la lance sur un appareil iOS.

`npm run bsr android` : compile et synchronise l'application, puis la lance sur un appareil Android.

## Script GenComp

Cette section détaille le script GenComp.

GenComp signifie _Generate Component_. Le script permet de générer le squelette d'un composant Owl, pour commencer plus vite à programmer ses fonctionnalités.

### Commandes

`npm run gencomp <nom>` : génère le composant dans le dossier `components`
`npm run gencomp <nom> <chemin>` : génère le composant dans le dossier indiqué
`npm run gencomp <nom> <chemin> <add-css>` : génère le composant dans le dossier indiqué, et omet le fichier CSS si add-css vaut `false`.

### Paramètres

#### Nom

Nom du composant ; « Component » lui sera ajouté automatiquement.

#### Chemin

Chemin du composant, relatif au dossier `components`.

Un chemin `notes/item` crée le composant dans `src/components/notes/item`.

Paramètre optionnel.

#### AddCSS

S'il vaut `false`, le fichier CSS n'est pas créé et n'est pas ajouté aux imports de `src/css/components.scss`.

Paramètre optionnel.

### Exemple

`npm run gencomp noteItem notes/item false` crée le composant `NoteItem` dans `src/components/notes/item` sans le fichier CSS.

<!-- [en] -->
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

<!-- [fr] -->
## Scripts shell

Cette section détaille les scripts shell fournis, pour mieux les comprendre et les employer à bon escient.

<details>
<summary>Déplier</summary>

### create.sh

Script généralisé pour créer un projet Odoo Owl/Capacitor et y ajouter une plateforme donnée. Sans argument de plateforme, il ajoute Android par défaut et se comporte donc comme `create-android.sh`.

### create-android.sh

Crée un projet Odoo Owl/Capacitor et y ajoute la plateforme Android.

### create-ios.sh

Crée un projet Odoo Owl/Capacitor et y ajoute la plateforme iOS.

### add-android.sh

Ajoute la plateforme Android au projet.

### add-ios.sh

Ajoute la plateforme iOS au projet.

### build-android.sh

Compile le projet Capacitor. Produit une application Android exécutable et signée.

### build-ios.sh

Compile le projet Capacitor. Produit une application iOS exécutable et signée.

### sync.sh

Copie le projet Odoo Owl compilé vers toutes les plateformes et met à jour les plugins natifs et les dépendances dans `package.json`.

</details>

## Erreurs

Cette section recense les erreurs susceptibles de survenir en initialisant un nouveau projet Odoo Owl/Capacitor, que ce soit avec les scripts des sections précédentes ou en tapant les commandes à la main. Les solutions sont également fournies.

<details>
<summary>Déplier</summary>

## iOS

### `build-ios.sh` ou `npx cap build ios` :

#### Erreur :

error: Signing for "App" requires a development team. Select a development team in the Signing & Capabilities editor. (in target 'App' from project 'App')

#### Solution :

https://forum.ionicframework.com/t/ionic-capacitor-failed-ios-build/177400/2

## Android

### `build-android.sh` ou `npx cap build android`

</details>

## Documentation Odoo Owl

[Dépôt GitHub officiel d'Odoo Owl](https://github.com/odoo/owl/tree/master?tab=readme-ov-file#documentation)
