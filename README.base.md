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

<!-- [en] -->
## Chat notifications

Options › Chat notifications makes the phone ring for a chat message while the
app is closed, on Android. Odoo 18 publishes an encrypted push to a topic of a
ntfy server that you run; the phone reads it, decrypts it, and draws the
notification. The `erplibre_mobile_chat` module is not needed (version 1.5 adds
the message id, the « read » push and the 👍 button; without it everything else
works); the phone registers itself with Odoo, under its own session.

1. **Prepare ntfy** on the machine that runs it, in `TODO › Deploy › Prepare
   ntfy for ERPLibre mobile`, on that machine or over ssh. The command sets
   the access rules (Odoo writes without an account on `up*`, each phone reads
   only its own prefix with one read-only token) and prints a link and its QR
   code. A phone name already prepared is refused: pick another one, or
   revoke that phone and prepare it again. « Revoke a phone » in the same menu
   deletes a phone's account and token: that phone's token stops working at
   once, but Odoo keeps its devices and goes on publishing to their topics
   until the app removes the account or applies a new link. « Remove ntfy » in
   the app forgets the link and unregisters the phone from Odoo.
2. **Scan the QR code or paste the link** in Options › Chat notifications, for
   each account. The link carries two addresses when Odoo reaches ntfy
   differently from the phone (the phone through the local network, Odoo through
   its own loopback or an internal name): the second goes in « ntfy address as
   Odoo reaches it » and is what Odoo publishes to; leave it empty when both are
   the same.
3. **A ntfy in http on the local network** needs two things: « Allow http »
   in Options › Odoo sync, and an APK built with `-PlanCleartext`
   (`./gradlew :app:assembleDebug -PlanCleartext`), because Android blocks http
   otherwise. A ntfy behind https needs neither.
4. **Pick a level** (an install that never chose runs level 3):
   1 realtime (a permanent connection), 2 realtime on Wi-Fi or while charging
   and every 15 minutes otherwise, 3 every 15 minutes, 4 every hour, 5 off.
   Levels 1 and 2 ask Android to leave the app out of battery optimisation; if
   the user refuses, the app says so and offers level 3. One permanent
   notification, shared with the SMS gateway (its former « Passerelle SMS »
   channel is replaced) and at the minimum priority, shows while a permanent
   connection runs.
5. **The lock screen**, per server: « Hidden when locked » (the default) is a
   guarantee. When Android hides sensitive content on the lock screen, the
   notification shows « Nouveau message — <server> » there, and the author and
   text once unlocked; when Android shows all content, or the app cannot read
   that setting, the notification does not appear on the lock screen at all and
   shows normally once unlocked. The choice is made each time a notification is
   posted: one drawn while Android hid content keeps that form if the user later
   changes the Android setting, until it is posted again. « Never shown » and
   « Always shown » do what they say.
6. **Actions**, from the notification itself, on a chat notification (a direct
   chat, a group or a channel; an inbox notification, a summary or a status
   notification gets none). Android shows at most three buttons, so two are
   always there and the third depends on the message:
   - « Reply » types a message that is posted in the conversation as the user;
   - « Mark read » marks the conversation read in Odoo up to the newest message
     shown, even when sending « read » is turned off in Options › Chat, and
     clears that conversation's @mentions up to that message from the Odoo
     Inbox (nothing else leaves the Inbox);
   - « 👍 » reacts to the newest message received (the user's own reply does
     not count), offered when that message has a message id, which only module
     1.5 pushes; otherwise « Mute 1 h » takes the place (and takes it back once
     a 👍 has been sent).

   The buttons are offered in every lock-screen mode, « Never shown » included
   (the text stays hidden there). On every server except « Always shown » ones,
   Android 12 and later asks to unlock before an action runs. Every action is
   written to a sealed local store before any network call, so it is never
   lost and never
   done twice: a reply carries a client identifier (the module stores it, and
   without the module the phone looks the hidden marker of the body up first,
   after a 3-minute quiet window), and mark read, mute and 👍 are target states
   that a repeat leaves unchanged. Replies to one conversation are sent in the
   order they were typed. An action that fails for a network reason is retried
   with a growing delay.
   Before each action the phone checks that the server still knows the
   session, because Odoo answers « mark read » with success while doing nothing
   when the session is dead. A dead session, a refusal, two messages found
   under one marker, or 24 hours of failures hand the action to the app: Android
   forbids opening the app from a background action, so the phone shows one
   notification per server, « Ouvrez l'app pour terminer une action —
   <server> », and the app signs in again and sends the action, once, at its
   next start. An action that cannot even be recorded shows « Action non
   envoyée — <server> ».

What rings follows Odoo's own settings: the general one (all, mentions,
nothing) and a conversation's mute. Chat and group pushes ignore a
conversation's own notification setting; only a mute stops them. Odoo never
retries a push, and nothing marks a message read: a phone silent for longer
than the ntfy cache, or an account
without ntfy, gets one summary per server, counted from Odoo's unread counters.
Odoo publishes inside the request that posts the message (when fewer than 5
devices are among the recipients), so a ntfy that accepts the connection and
never answers delays a post by up to 5 seconds per device; a closed port fails
at once. Without module 1.5, ntfy answers 200 where Odoo expects 201, so each
successful push logs an Odoo warning that carries the topic: treat that log as
sensitive.

Module 1.5 (optional) marks the phone's devices through
`/erplibre_mobile_chat/push/device`, which the app calls after each
registration. Their pushes then carry the message id and the channel type, are
sent after the transaction commits (2 seconds at most per device), and are
accepted on ntfy's 200 without
logging the topic; a « read » push removes the notification at once when the
conversation is read elsewhere, and an « inbox done » push removes the inbox
notification of a record done elsewhere (only the phone's marked devices
receive them). A phone setting that stays silent while a browser is online
comes with a later version. Without module 1.5 there is no 👍 (a reaction found by time
could land on another message), « Mark read » finds the newest message by
date, and a notification goes at the next check or when the app opens.

The build property `-PnoChatRealtime` leaves the permanent service out of the
APK (a build without levels 1 and 2, for a store that refuses it).

<!-- [fr] -->
## Notifications du clavardage

Options › Notifications du clavardage fait sonner le téléphone pour un message
du clavardage quand l'app est fermée, sur Android. Odoo 18 publie un push
chiffré sur un sujet d'un serveur ntfy que vous faites tourner ; le téléphone
le lit, le déchiffre et affiche la notification. Le module
`erplibre_mobile_chat` n'est pas requis (la version 1.5 ajoute l'identifiant du
message, le push « lu » et le bouton 👍 ; sans lui, tout le reste fonctionne) ;
le téléphone s'enregistre lui-même auprès d'Odoo, sous sa propre session.

1. **Préparer ntfy** sur la machine qui le fait tourner, dans `TODO › Déployer
   › Préparer ntfy pour ERPLibre mobile`, sur cette machine ou par ssh. La
   commande pose les règles d'accès (Odoo écrit sans compte sur `up*`, chaque
   téléphone ne lit que son préfixe avec un jeton en lecture seule) et affiche
   un lien et son code QR. Un nom de téléphone déjà préparé est refusé : en
   choisir un autre, ou révoquer ce téléphone et le préparer de nouveau.
   « Révoquer un téléphone », dans le même menu, supprime le compte et le jeton
   d'un téléphone : son jeton cesse aussitôt de fonctionner, mais Odoo garde
   ses appareils et continue de publier sur leurs sujets jusqu'à ce que l'app
   retire le compte ou applique un nouveau lien. « Retirer ntfy », dans l'app,
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
6. **Les actions**, depuis la notification elle-même, sur une notification de
   clavardage (une discussion directe, un groupe ou un canal ; une notification
   de boîte de réception, un sommaire ou un état n'en a aucune). Android
   n'affiche que trois boutons : deux sont toujours là et le troisième dépend
   du message :
   - « Répondre » saisit un message qui est publié dans la conversation au nom
     de l'utilisateur ;
   - « Marquer lu » marque la conversation lue dans Odoo jusqu'au plus récent
     message affiché, même quand l'envoi de « lu » est
     désactivé dans Options › Clavardage, et retire de la boîte de réception
     d'Odoo les @mentions de cette conversation jusqu'à ce message (rien
     d'autre n'en sort) ;
   - « 👍 » réagit au plus récent message reçu (la réponse de l'utilisateur ne
     compte pas), offert quand ce message a un identifiant, que seul le module
     1.5 pousse ; sinon « Muet 1 h » prend sa place (et la reprend une fois un
     👍 envoyé).

   Les boutons sont offerts dans tous les modes d'écran verrouillé, « Jamais
   affiché » compris (le texte y reste masqué). Sur tout serveur sauf
   « Toujours affiché », Android 12 et suivants demande de déverrouiller avant
   qu'une action s'exécute. Chaque action est écrite dans un magasin local
   scellé avant tout appel réseau : elle n'est jamais perdue ni faite deux fois. Une réponse porte
   un identifiant client (le module le garde ; sans le module, le téléphone
   cherche d'abord le marqueur caché du corps, après une fenêtre de calme de
   3 minutes), et marquer lu, mettre en sourdine et 👍 sont des états cibles
   qu'une répétition laisse intacts. Les réponses à une même conversation
   partent dans l'ordre où elles ont été saisies. Une action qui échoue pour
   une raison de réseau est réessayée avec un délai croissant.
   Avant chaque action, le téléphone vérifie que le serveur connaît encore la
   session, car Odoo répond « marquer lu » par un succès sans rien faire quand
   la session est morte. Une session morte, un refus, deux messages trouvés sous
   un même marqueur ou 24 heures d'échecs confient l'action à l'app : Android
   interdit d'ouvrir l'app depuis une action en arrière-plan, alors le téléphone
   affiche une notification par serveur, « Ouvrez l'app pour terminer une
   action — <serveur> », et l'app se reconnecte et envoie l'action, une fois, à
   son prochain démarrage. Une action qui ne peut même pas être enregistrée
   affiche « Action non envoyée — <serveur> ».

Ce qui sonne suit les réglages d'Odoo : le réglage général (tout, mentions,
rien) et la sourdine d'une conversation. Les push d'un clavardage ou d'un
groupe ignorent le réglage de notification propre à la conversation ; seule la
sourdine les arrête. Odoo ne réessaie jamais un push, et
rien ne marque un message comme lu : un téléphone muet plus longtemps que le
cache de ntfy, ou un compte sans ntfy, reçoit un sommaire par serveur, compté
sur les compteurs de non lus d'Odoo. Odoo publie dans la requête qui poste le
message (quand moins de 5 appareils sont parmi les destinataires) : un ntfy qui
accepte la connexion sans jamais répondre retarde un envoi jusqu'à 5 secondes
par appareil ; un port fermé échoue aussitôt. Sans le module 1.5, ntfy répond
200 là où Odoo attend 201, si bien que chaque push réussi inscrit dans le
journal d'Odoo un avertissement qui porte le sujet : traiter ce journal comme
sensible.

Le module 1.5 (facultatif) marque les appareils du téléphone par
`/erplibre_mobile_chat/push/device`, que l'app appelle après chaque
enregistrement. Leurs push portent alors l'identifiant du message et le type de
canal, partent après la validation de la transaction (2 secondes au plus par
appareil) et sont acceptés sur le 200 de ntfy sans journaliser le sujet ; un push « lu » retire aussitôt la
notification quand la conversation est lue ailleurs, et un push « boîte de
réception faite » retire celle d'un enregistrement traité ailleurs (seuls les
appareils marqués du téléphone les reçoivent). Un réglage du téléphone pour se
taire quand un navigateur est en ligne vient avec une prochaine version. Sans
le module 1.5,
il n'y a pas de 👍 (une réaction trouvée par l'heure pourrait tomber sur un
autre message), « Marquer lu » trouve le plus récent message par sa date, et
une notification part au prochain contrôle ou à l'ouverture de l'app.

La propriété de construction `-PnoChatRealtime` laisse le service permanent hors
de l'APK (une version sans les niveaux 1 et 2, pour un magasin qui le refuse).
