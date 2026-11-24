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
the message id, the « read » push and the 👍 button; version 1.6 adds, per
recipient, whether the user is mentioned and whether a browser of theirs is
active, which the phone's filter and its browser setting read; without it
everything else works); the phone registers itself with Odoo, under its own
session.

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
   connection runs. The app may climb to a more economical level by itself
   (« Save battery automatically », below).
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

**Odoo's settings, changed from the app.** What Odoo pushes is decided by the
same settings as in the browser, and the app reads and changes them. Options ›
Chat, per server, offers « Channels (Odoo's setting) »: « All messages »,
« Mentions only » or « Nothing ». Odoo applies it to channels only, as the
line under it says: « Chats and groups always ring; to silence them, use
mute ». A channel's info screen offers « This channel (Odoo's setting) », with
« Default ({value}) » naming the general value; chats and groups offer the
mute only, since Odoo ignores their own setting. A change waits in the queue
when offline, and a change made in the browser reaches the app through
Odoo's bus.

**A change made just before leaving the app.** What the app sends to Odoo
from its screens (a message, a conversation marked read, a notification
setting) goes through a queue stored on the phone, and that queue runs in the
app's page. About a minute after the app leaves the screen (Home, another
app), Android's WebView freezes that page, so a change queued just before
leaving may wait until the app comes back to the front, then goes out in
order. Nothing is lost. The actions of a notification (reply, mark read,
mute, 👍) are not affected: native code runs them, app open or not.

**What the phone lets through, per server.** On top of Odoo's settings, each
account's card in Options › Chat notifications holds a filter that can only be
stricter. « Conversations »: « Everything Odoo sends » (the default),
« Mentions and direct messages » (chats and groups always ring, a channel only
when the message mentions the user, `@everyone` included), or « Nothing from
this server » (the registration stays and Odoo still pushes; the phone shows
nothing, not even a summary). Without module 1.6 the push does not say whether
the user is mentioned, so « Mentions and direct messages » lets every channel
message through, and the card says « approximate filter without module 1.6 ».
« Inbox (records and activities) » is on by default; off, no record or
activity notification rings at all, a mention included, unless « Ring anyway
when I am mentioned in a record » is checked under it (off by default; it
needs module 1.6).

**Quiet hours, per server.** « Quiet hours » is off by default, from 22:00 to
07:00 when turned on; the window may cross midnight, and a start equal to the
end is refused. Inside it, in the phone's time zone, chat, inbox and summary
notifications arrive without sound or vibration; none is dropped.

**While a browser is active**, one setting for the whole phone, applied to
each server with the module: « Ring at once », « Wait 10 s » (the default) or
« Do not send to the phone ». A browser is active when the user was active in
a connected browser within the last 5 minutes (the module's own threshold;
the status Odoo displays keeps its own delay). Under « Wait 10 s » a chat
message pushed while a browser is active is held 10 seconds and dropped if it
is read in the browser meanwhile, otherwise drawn. A held message survives the
process: it is drawn after the next catch-up of the ntfy, unless its read came
in the meantime. When the battery makes the level climb past 2, the held
messages are drawn about 10 seconds later, before the permanent service
stops; only a death of the process (a swipe on some phones, a memory kill)
leaves them for the next periodic check (15 minutes, longer under Android's
Doze). A move to level 5 drops them. A held message that can no longer be
read or drawn when its time comes is counted in the options' status panel
(« Held messages lost: {n} »). « Do not send to the phone » asks module 1.6
to push nothing to the phone while a browser is active. With module 1.5
« Wait 10 s » rings at once, and « Do not send to the phone » only works in
about the minute after the browser opens (that module's server sees the
browser only when it connects; 1.6 applies the 5-minute activity rule),
which the card states; without the module every push rings. Each card says
what applies on its server (« Browser active, on this server: {mode} »), and
« not applied on this server yet » while the server has not been told of a
change.

**Save battery automatically**, on by default, for the whole phone: « One level
more under » a battery percentage (30 % by default) and « Two levels more
under » another (15 % by default), each chosen among none, 10, 15, 20, 30, 40
and 50 %. Each threshold does what its label says: under the second the level
climbs two even when the first is « none » or lower. The climb never goes past
level 4: notifications stop only at a level 5 the user chose. On the way back
up a climb is released only 5 points above its threshold (climbed under 15 %,
back at 20 % or more), so a battery gauge wavering around a threshold climbs
once; the last climb is stored, and a check run after the app's process died
continues it. A level the battery does not raise (a chosen 5, or a chosen 4
already at the cap) keeps no climb, since no check would see a charge in
between. Android's battery saver means level 3 at least, even with the
switch off, and ends when the saver turns off. Plugged in, the phone returns
to the chosen level at once, at any percentage. While climbed, the options
show « Right now: level {level} ({why}) », the reason being « battery saver »
or « battery went under {pct} %, until {release} % or plugged in », true
both under the threshold and in the 5 points that still hold it. A job waits for the charger, so the
permanent service comes back once plugged without waiting for the 15-minute
check (up to 15 minutes when Android defers that job).

Odoo never retries a push, and nothing marks a message read: a phone silent for longer
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
receive them). The module marks each device with the phone's browser setting;
module 1.6 adds to the pushes, per recipient, whether the user is mentioned
and whether a browser of theirs is active, which the filter and « Wait 10 s »
read. The app sends the setting in the form the server's module level reads:
Odoo 18 ignores a route argument it does not know, so a 1.5 server would take
1.6's argument and ring. Without module 1.5 there is no 👍 (a reaction found by time
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
message, le push « lu » et le bouton 👍 ; la version 1.6 ajoute, pour chaque
destinataire, si l'utilisateur est mentionné et si un de ses navigateurs est
actif, que lisent le filtre du téléphone et son réglage du navigateur ; sans
lui, tout le reste fonctionne) ; le téléphone s'enregistre lui-même auprès
d'Odoo, sous sa propre session.

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
   L'app peut monter d'elle-même à un niveau plus économe (« Économiser
   automatiquement », plus bas).
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

**Les réglages d'Odoo, changés depuis l'app.** Ce qu'Odoo pousse se décide par
les mêmes réglages que dans le navigateur, et l'app les lit et les change.
Options › Clavardage, par serveur, offre « Canaux (réglage d'Odoo) » : « Tous
les messages », « Mentions seulement » ou « Rien ». Odoo ne l'applique qu'aux
canaux, comme le dit la ligne en dessous : « Les discussions et les groupes
sonnent toujours ; pour les faire taire, utilisez la sourdine ». L'écran
d'information d'un canal offre « Ce canal (réglage d'Odoo) », avec « Par défaut
({value}) » qui nomme la valeur générale ; les discussions et les groupes
n'offrent que la sourdine, puisqu'Odoo ignore leur propre réglage. Un
changement attend dans la file hors ligne, et un changement fait dans le
navigateur arrive dans l'app par le bus d'Odoo.

**Un changement fait juste avant de quitter l'app.** Ce que l'app envoie à
Odoo depuis ses écrans (un message, une conversation marquée lue, un réglage
de notification) passe par une file conservée sur le téléphone, et
cette file tourne dans la page de l'app. Environ une minute après que l'app
quitte l'écran (Accueil, une autre app), la WebView d'Android gèle cette page :
un changement mis en file juste avant de partir peut attendre que l'app
revienne au premier plan, puis part dans l'ordre. Rien n'est perdu. Les
actions d'une notification (répondre, marquer lu, sourdine, 👍) n'en sont pas
touchées : le code natif les exécute, l'app ouverte ou non.

**Ce que le téléphone laisse passer, par serveur.** Par-dessus les réglages
d'Odoo, la carte de chaque compte dans Options › Notifications du clavardage
porte un filtre qui ne peut qu'être plus strict. « Conversations » : « Tout ce
qu'Odoo envoie » (le défaut), « Mentions et messages directs » (les
discussions et les groupes sonnent toujours, un canal seulement quand le
message mentionne l'utilisateur, `@everyone` compris) ou « Rien de ce
serveur » (l'enregistrement reste et Odoo pousse toujours ; le téléphone
n'affiche rien, pas même un sommaire). Sans le module 1.6, le push ne dit pas
si l'utilisateur est mentionné : « Mentions et messages directs » laisse alors
passer tout message de canal, et la carte dit « filtre approximatif sans le
module 1.6 ». « Boîte de réception (enregistrements et activités) » est
activée par défaut ; désactivée, aucune notification d'enregistrement ou
d'activité ne sonne, une mention comprise, sauf si « Sonner quand même si on
me mentionne dans un enregistrement » est cochée en dessous (désactivée par
défaut ; elle demande le module 1.6).

**Les heures calmes, par serveur.** « Heures calmes » est désactivé par
défaut, de 22:00 à 07:00 une fois activé ; la fenêtre peut passer minuit, et
un début égal à la fin est refusé. Pendant la fenêtre, dans le fuseau du
téléphone, les notifications du clavardage, de la boîte de réception et le
sommaire arrivent sans son ni vibration ; aucune n'est retirée.

**Quand un navigateur est actif**, un seul réglage pour tout le téléphone,
appliqué à chaque serveur qui a le module : « Sonner tout de suite »,
« Attendre 10 s » (le défaut) ou « Ne pas envoyer au téléphone ». Un
navigateur est actif quand l'utilisateur y a eu une activité, connecté, dans
les 5 dernières minutes (le seuil propre au module ; le statut qu'Odoo affiche
garde son délai). Avec « Attendre 10 s », un message de clavardage poussé
pendant qu'un navigateur est actif est retenu 10 secondes et retiré s'il est
lu dans le navigateur entre-temps, sinon affiché. Un message retenu survit au
processus : il est affiché après le prochain rattrapage du ntfy, à moins que
sa lecture soit arrivée entre-temps. Quand la batterie fait monter le niveau
au-delà de 2, les messages retenus sont affichés une dizaine de secondes plus
tard, avant l'arrêt du service permanent ; seule la mort du processus (un
balayage sur certains téléphones, une fin forcée faute de mémoire) les laisse
à la prochaine relève périodique (15 minutes, davantage sous le Doze
d'Android). Un passage au niveau 5 les retire. Un message retenu qui ne peut
plus être lu ni affiché à son heure est compté dans le panneau d'état des
options (« Messages retenus perdus : {n} »). « Ne pas envoyer au téléphone »
demande au module 1.6 de ne rien pousser au téléphone tant qu'un navigateur
est actif. Avec le module 1.5, « Attendre 10 s » sonne tout de suite, et « Ne
pas envoyer au téléphone » ne joue que dans la minute environ qui suit
l'ouverture du navigateur (le serveur de ce module ne voit le navigateur qu'à
sa connexion ; la 1.6 applique la règle des 5 minutes d'activité), ce que dit
la carte ; sans le module, tout push sonne. Chaque
carte dit ce qui s'applique sur son serveur (« Navigateur actif, sur ce
serveur : {mode} »), et « pas encore appliqué sur ce serveur » tant que le
serveur n'a pas appris un changement.

**Économiser automatiquement**, activé par défaut, pour tout le téléphone :
« Un niveau de plus sous » un pourcentage de batterie (30 % par défaut) et
« Deux niveaux de plus sous » un autre (15 % par défaut), chacun choisi parmi
aucun, 10, 15, 20, 30, 40 et 50 %. Chaque seuil fait ce que dit son libellé :
sous le second, le niveau monte de deux même quand le premier est « aucun » ou
plus bas. La montée ne dépasse jamais le niveau 4 : les notifications ne
s'arrêtent qu'à un niveau 5 choisi par l'utilisateur. En remontant, une montée
n'est relâchée que 5 points au-dessus de son seuil (montée sous 15 %, retour à
20 % ou plus) : une jauge qui oscille autour d'un seuil ne fait monter qu'une
fois ; la dernière montée est conservée, et une relève lancée après la mort du
processus de l'app la poursuit. Un niveau que la batterie ne fait pas monter
(un 5 choisi, ou un 4 choisi déjà au plafond) ne conserve aucune montée,
puisqu'aucune relève ne verrait une charge entre-temps. L'économiseur de batterie d'Android veut dire
le niveau 3 au moins, même l'interrupteur désactivé, et cesse avec lui.
Branché, le téléphone revient aussitôt au niveau choisi, quel que soit le
pourcentage. Pendant une montée, les options affichent « En ce moment : niveau
{level} ({why}) », la raison étant « économiseur de batterie » ou « batterie
passée sous {pct} %, jusqu'à {release} % ou au branchement », vrai sous le
seuil comme dans les 5 points qui la retiennent encore. Une tâche attend le chargeur : le service permanent revient une
fois branché sans attendre la relève aux 15 minutes (jusqu'à 15 minutes quand
Android diffère cette tâche).

Odoo ne réessaie jamais un push, et
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
appareils marqués du téléphone les reçoivent). Le module marque chaque
appareil du réglage du navigateur du téléphone ; le module 1.6 ajoute aux
push, pour chaque destinataire, si l'utilisateur est mentionné et si un de ses
navigateurs est actif, que lisent le filtre et « Attendre 10 s ». L'app envoie
le réglage sous la forme que lit le niveau du module du serveur : Odoo 18
ignore un argument de route qu'il ne connaît pas, si bien qu'un serveur 1.5
prendrait l'argument de la 1.6 et sonnerait. Sans le module 1.5,
il n'y a pas de 👍 (une réaction trouvée par l'heure pourrait tomber sur un
autre message), « Marquer lu » trouve le plus récent message par sa date, et
une notification part au prochain contrôle ou à l'ouverture de l'app.

La propriété de construction `-PnoChatRealtime` laisse le service permanent hors
de l'APK (une version sans les niveaux 1 et 2, pour un magasin qui le refuse).
