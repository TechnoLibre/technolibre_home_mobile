
# ERPLibre Home Mobile

Application mobile Odoo Owl + Capacitor pour ERPLibre.

Les sections suivantes décrivent le bon usage des scripts fournis, ainsi que les erreurs que vous pourriez rencontrer en initialisant un nouveau projet et la façon de les traiter.

La documentation technique complète se trouve dans [doc/README.md](./doc/README.md).

## Installation

Pour installer les dépendances npm nécessaires au développement de l'application web, lancer :

```
npm install
```

## Lancer l'application

Ces commandes lancent l'application sur Android, mais c'est également possible sur iOS si la plateforme est correctement installée.

```bash
# Builds and syncs the application
npm run build && npx cap sync

# Runs the app (android)
npx cap run android

# Runs the app (iOS)
npx cap run ios
```

Pour une façon plus commode de compiler, synchroniser et lancer l'application, voir la section [Script BSR](#script-bsr).

## Supprimer node_modules

Il arrive qu'on veuille supprimer le dossier node_modules et réinstaller les paquets npm pour résoudre un problème.

> [!CAUTION]
> En supprimant `node_modules`, vous empêchez les paquets npm comme `@odoo/owl` ou `@capacitor/app` de fonctionner jusqu'à leur réinstallation.

```bash
# Delete node_modules
rm -rf node_modules

# Reinstall packages
npm install
```

## Élagage

Pour ne désinstaller de node_modules que les paquets qui ne sont pas de véritables dépendances, la commande prune est disponible.

```
npm prune
```

## Tests

Le projet utilise [Vitest](https://vitest.dev/) pour les tests unitaires.

### Lancer les tests

Depuis la racine du dépôt :

```bash
./mobile/run_tests.sh
```

Ou directement depuis `erplibre_home_mobile` :

```bash
npm test
```

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

## Notifications du clavardage

Options › Notifications du clavardage fait sonner le téléphone pour un message
du clavardage quand l'app est fermée, sur Android. Odoo 18 publie un push
chiffré sur un sujet d'un serveur ntfy que vous faites tourner ; le téléphone
le lit, le déchiffre et affiche la notification. Le module
`erplibre_mobile_chat` n'est pas requis (version 1.4 ou aucun) ; le téléphone
s'enregistre lui-même auprès d'Odoo, sous sa propre session.

1. **Préparer ntfy** sur la machine qui le fait tourner, dans `TODO › Déployer
   › Préparer ntfy pour ERPLibre mobile`, sur cette machine ou par ssh. La
   commande pose les règles d'accès (Odoo écrit sans compte sur `up*`, chaque
   téléphone ne lit que son préfixe avec un jeton en lecture seule) et affiche
   un lien et son code QR. « Révoquer un téléphone », dans le même menu,
   supprime le compte et le jeton d'un téléphone ; « Retirer ntfy », dans l'app,
   oublie le lien et désenregistre le téléphone d'Odoo.
2. **Scanner le code QR ou coller le lien** dans Options › Notifications du
   clavardage, pour chaque compte. Le lien porte deux adresses quand Odoo
   atteint ntfy autrement que le téléphone (le téléphone par le réseau local,
   Odoo par sa boucle locale ou un nom interne) : la seconde va dans « Adresse
   de ntfy vue d'Odoo » et c'est celle sur laquelle Odoo publie ; la laisser
   vide quand les deux sont identiques.
3. **Un ntfy en http sur le réseau local** demande deux choses : « Autoriser
   http » dans Options › Synchronisation Odoo, et un APK construit avec
   `-PlanCleartext` (`./gradlew :app:assembleDebug -PlanCleartext`), car Android
   bloque le http autrement. Un ntfy en https n'a besoin ni de l'un ni de l'autre.
4. **Choisir un niveau** (une installation qui n'a jamais choisi tourne au
   niveau 3) : 1 temps réel (connexion permanente), 2 temps réel sur Wi-Fi ou
   en charge et aux 15 minutes sinon, 3 aux 15 minutes, 4 chaque heure,
   5 désactivé. Les niveaux 1 et 2 demandent à Android de laisser l'app hors de
   l'optimisation de la batterie ; si l'utilisateur refuse, l'app le dit et
   propose le niveau 3. Une seule notification permanente, partagée avec la
   passerelle SMS (son ancien canal « Passerelle SMS » est remplacé) et à la
   priorité minimale, s'affiche tant qu'une connexion permanente tourne.
5. **L'écran verrouillé**, par serveur : « Masqué quand verrouillé » (le défaut)
   est garanti. Quand Android masque le contenu sensible sur l'écran verrouillé,
   la notification y montre « Nouveau message — <serveur> », et l'auteur et le
   texte une fois déverrouillé ; quand Android montre tout le contenu, ou que
   l'app ne peut pas lire ce réglage, la notification n'apparaît pas du tout sur
   l'écran verrouillé et s'affiche normalement une fois déverrouillé. Le choix
   se fait à chaque affichage : une notification dessinée pendant qu'Android
   masquait le contenu garde cette forme si l'utilisateur change ensuite le
   réglage d'Android, jusqu'à ce qu'elle soit affichée de nouveau. « Jamais
   affiché » et « Toujours affiché » font ce qu'ils disent.

Ce qui sonne suit le réglage d'Odoo (tout, mentions, rien, par conversation).
Odoo ne réessaie jamais un push, et
rien ne marque un message comme lu : un téléphone muet plus longtemps que le
cache de ntfy, ou un compte sans ntfy, reçoit un sommaire par serveur, compté
sur les compteurs de non lus d'Odoo. Odoo publie dans la requête qui poste le
message (quand moins de 5 appareils sont parmi les destinataires) : un ntfy qui
accepte la connexion sans jamais répondre retarde un envoi jusqu'à 5 secondes
par appareil ; un port fermé échoue aussitôt. Jusqu'au module 1.5, ntfy répond
200 là où Odoo attend 201, si bien que chaque push réussi inscrit dans le
journal d'Odoo un avertissement qui porte le sujet : traiter ce journal comme
sensible.

La propriété de construction `-PnoChatRealtime` laisse le service permanent hors
de l'APK (une version sans les niveaux 1 et 2, pour un magasin qui le refuse).