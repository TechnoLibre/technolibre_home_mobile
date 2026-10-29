
# ERPLibre Home Mobile

Odoo Owl + Capacitor mobile application for ERPLibre.

The following sections outline instructions on the proper use of the provided scripts, as well as the errors you may encounter when setting up a new project and how to deal with them.

Full technical documentation lives in [doc/README.md](./doc/README.md).

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

## Tests

The project uses [Vitest](https://vitest.dev/) for unit testing.

### Running tests

From the repository root:

```bash
./mobile/run_tests.sh
```

Or directly from inside `erplibre_home_mobile`:

```bash
npm test
```

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
