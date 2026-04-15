<!-------------------------->
<!-- multilingual suffix: en, fr -->
<!-- no suffix: en -->
<!-------------------------->

<!-- [en] -->
# ERPLibre Home Mobile

Odoo Owl + Capacitor mobile application for ERPLibre.

## Installation

```bash
npm install
```

## Running the app

```bash
# Build and sync
npm run build && npx cap sync

# Run on Android
npx cap run android
```

See the [BSR Script](#bsr-script) section for a faster development workflow.

## Tests

```bash
# From the repository root
./mobile/run_tests.sh

# Or directly
npm test
```

## BSR Script

Build, Sync and Run — a convenience script for development.

```bash
npm run bsr           # Build and open on localhost (web)
npm run bsr android   # Build, sync and run on Android
npm run bsr ios       # Build, sync and run on iOS
```

## GenComp Script

Generate Owl component boilerplate:

```bash
npm run gencomp <name>              # Creates component in src/components/
npm run gencomp <name> <path>       # Creates in src/components/<path>/
npm run gencomp <name> <path> false # Without SCSS file
```

## Documentation

See [doc/README.md](./doc/README.md) for full technical documentation.

<!-- [fr] -->
# ERPLibre Home Mobile

Application mobile Odoo Owl + Capacitor pour ERPLibre.

## Installation

```bash
npm install
```

## Lancer l'application

```bash
# Build et synchronisation
npm run build && npx cap sync

# Lancer sur Android
npx cap run android
```

Voir la section [Script BSR](#script-bsr) pour un workflow de développement plus rapide.

## Tests

```bash
# Depuis la racine du dépôt
./mobile/run_tests.sh

# Ou directement
npm test
```

## Script BSR

Build, Sync et Run — un script de commodité pour le développement.

```bash
npm run bsr           # Build et ouverture sur localhost (web)
npm run bsr android   # Build, sync et lancement sur Android
npm run bsr ios       # Build, sync et lancement sur iOS
```

## Script GenComp

Génère un squelette de composant Owl :

```bash
npm run gencomp <nom>                # Crée le composant dans src/components/
npm run gencomp <nom> <chemin>       # Crée dans src/components/<chemin>/
npm run gencomp <nom> <chemin> false # Sans fichier SCSS
```

## Documentation

Voir [doc/README.fr.md](./doc/README.fr.md) pour la documentation technique complète.
