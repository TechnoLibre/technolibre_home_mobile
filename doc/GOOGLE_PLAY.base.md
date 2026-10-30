<!---------------------------->
<!-- multilingual suffix: en, fr -->
<!-- no suffix: en -->
<!---------------------------->

<!-- [en] -->
# Google Play — justifications and open gaps

The app is installed by APK. **No Play-ready build exists yet**: this page
writes down what a Play build must leave out and how each permission it keeps
is justified, so that nothing in the app closes the door to Google Play.

## What `-PnoChatRealtime` removes, and what it keeps

`-PnoChatRealtime` removes only `ChatPushService`, the permanent connection of
the chat notifications at levels 1 and 2 (its class and its manifest entry,
both in the `realtime` source set). The main manifest keeps, in every build:

- `SmsGatewayService`, a `specialUse` foreground service, with
  `SmsInboundReceiver`, `SmsBootReceiver` and `SmsWatchdogJob`;
- `SEND_SMS` and `RECEIVE_SMS`;
- the call permissions `READ_CALL_LOG`, `CALL_PHONE` and `READ_PHONE_STATE`;
- `SCHEDULE_EXACT_ALARM`;
- `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`.

## What a Play variant must remove (open gap)

A Play variant does not exist. It must remove, through a manifest of its own
source set with `tools:node="remove"`:

- the SMS gateway: its sources and its manifest entries (`SmsGatewayService`,
  `SmsInboundReceiver`, `SmsBootReceiver`, `SmsWatchdogJob`);
- `SEND_SMS`, `RECEIVE_SMS` and `READ_CALL_LOG`, which Play reserves for the
  default SMS or phone app; `CALL_PHONE` and `READ_PHONE_STATE` are to be
  reviewed with the phone keypad;
- `SCHEDULE_EXACT_ALARM`, used by the SMS gateway alone;
- `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` when the build has no realtime
  (`-PnoChatRealtime`).

The Play build decided for now drops levels 1 and 2: it is a
`-PnoChatRealtime` build, so it needs neither the `specialUse` service of the
chat nor the battery exemption. Levels 3 to 5 run on JobScheduler.

## If a Play build keeps levels 1 and 2

These two justifications apply only to a build that keeps levels 1 and 2.
Play may refuse it; the build without realtime is the fallback.

- **The `specialUse` foreground service** (`ChatPushService`): real-time
  messaging from the user's own server. Odoo publishes an encrypted Web Push
  to the user's own ntfy server; the service keeps one connection to it open
  so that a message arrives as soon as it is sent while the app is closed.
  There is no Firebase Cloud Messaging (FCM) path: the server belongs to the
  user, not to a service that could hold an FCM key. `dataSync` does not fit,
  since Android 15 caps it at six hours per 24. The manifest's
  `PROPERTY_SPECIAL_USE_FGS_SUBTYPE` states the same use.
- **`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`** (the system dialog
  `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`): Play's acceptable uses of
  the direct request include an app whose core function is real-time
  messaging that cannot use FCM, which is this case. The request is made only
  when the user picks level 1 or 2; refused, the app says what it costs and
  offers level 3. A device without that dialog gets the system list instead.

## Kept in every build

- **`POST_NOTIFICATIONS`**: the chat notifications, the inbox notifications,
  the summary and the minimal permanent notification. On Android 13 and later
  it is a runtime permission; refused, the options say that nothing can ring.
- **The boot receiver** (`RECEIVE_BOOT_COMPLETED`): `ChatPushBootReceiver`
  re-applies the notification level after a restart or an update, because an
  update stops the permanent service without starting it again, and
  re-schedules the periodic check.
- **Exact alarms**: the chat uses none. Its periodic checks are JobScheduler
  jobs, and the 10-second hold of the browser setting runs on a one-shot timer
  under its own wakelock. `SCHEDULE_EXACT_ALARM` belongs to the SMS gateway.
- **Cleartext**: refused by default. `network_security_config.xml` allows http
  only for the loopback addresses `localhost`, `127.0.0.1` and `10.0.2.2`.
  `-PlanCleartext` builds a demonstration APK that accepts http on the local
  network, never for distribution.

## Every permission of the merged manifest

The list below is checked against the merged manifest of
`./gradlew assembleDebug -PnoChatRealtime`, read with
`aapt2 dump xmltree --file AndroidManifest.xml app-debug.apk`; a permission
added to the app or to a plugin belongs in this table.

| Permission | What uses it | In a Play build |
|---|---|---|
| `INTERNET` | Odoo, ntfy, bundles | kept |
| `ACCESS_NETWORK_STATE` | network plugin; level 2 (Wi-Fi); the SMS gateway's retry | kept |
| `WAKE_LOCK` | the notification jobs and the hold; local notifications | kept |
| `POST_NOTIFICATIONS` | every notification of the app | kept |
| `RECEIVE_BOOT_COMPLETED` | `ChatPushBootReceiver`; `SmsBootReceiver` | kept (chat) |
| `FOREGROUND_SERVICE` | foreground services | kept |
| `FOREGROUND_SERVICE_DATA_SYNC` | speech model download | kept |
| `FOREGROUND_SERVICE_SPECIAL_USE` | `SmsGatewayService`; `ChatPushService` in a realtime build | removed unless levels 1 and 2 stay |
| `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` | levels 1 and 2; the SMS gateway | removed without realtime |
| `SCHEDULE_EXACT_ALARM` | the SMS gateway's polling | removed |
| `SEND_SMS` | the SMS gateway | removed |
| `RECEIVE_SMS` | the SMS gateway (STOP replies) | removed |
| `READ_CALL_LOG` | the caller's record, optional | removed |
| `CALL_PHONE` | the phone keypad | to review |
| `READ_PHONE_STATE` | SIM names, the line's state | to review |
| `MODIFY_AUDIO_SETTINGS` | call audio demonstration | to review |
| `RECORD_AUDIO` | voice notes and voice messages | kept |
| `CAMERA` | photos, QR code of the ntfy link (plugins) | kept |
| `ACCESS_COARSE_LOCATION` | geolocation of notes | kept |
| `ACCESS_FINE_LOCATION` | geolocation of notes | kept |
| `READ_EXTERNAL_STORAGE` | video player, Android 12 and earlier (`maxSdkVersion` 32) | kept |
| `WRITE_EXTERNAL_STORAGE` | video player, Android 12 and earlier (`maxSdkVersion` 32) | kept |
| `USE_BIOMETRIC` | biometric unlock (plugin) | kept |
| `USE_FINGERPRINT` | biometric unlock on older Android (plugin) | kept |

The comments of the SMS gateway saying that Play's justification « does not
apply » stay: they describe the gateway, which is outside any Play build.

<!-- [fr] -->
# Google Play — justifications et écarts ouverts

L'app s'installe par APK. **Aucune construction prête pour Play n'existe
encore** : cette page consigne ce qu'une construction Play doit laisser de
côté et comment se justifie chaque permission qu'elle garde, pour que rien
dans l'app ne ferme la porte à Google Play.

## Ce que `-PnoChatRealtime` retire, et ce qu'elle garde

`-PnoChatRealtime` retire seulement `ChatPushService`, la connexion permanente
des notifications du clavardage aux niveaux 1 et 2 (sa classe et son entrée de
manifeste, toutes deux dans l'ensemble de sources `realtime`). Le manifeste
principal garde, dans toute construction :

- `SmsGatewayService`, un service de premier plan `specialUse`, avec
  `SmsInboundReceiver`, `SmsBootReceiver` et `SmsWatchdogJob` ;
- `SEND_SMS` et `RECEIVE_SMS` ;
- les permissions d'appel `READ_CALL_LOG`, `CALL_PHONE` et `READ_PHONE_STATE` ;
- `SCHEDULE_EXACT_ALARM` ;
- `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`.

## Ce qu'une variante Play doit retirer (écart ouvert)

Aucune variante Play n'existe. Elle doit retirer, par un manifeste de son
propre ensemble de sources avec `tools:node="remove"` :

- la passerelle SMS : ses sources et ses entrées de manifeste
  (`SmsGatewayService`, `SmsInboundReceiver`, `SmsBootReceiver`,
  `SmsWatchdogJob`) ;
- `SEND_SMS`, `RECEIVE_SMS` et `READ_CALL_LOG`, que Play réserve à l'app de
  SMS ou de téléphone par défaut ; `CALL_PHONE` et `READ_PHONE_STATE` sont à
  revoir avec le clavier téléphonique ;
- `SCHEDULE_EXACT_ALARM`, dont seule la passerelle SMS se sert ;
- `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` quand la construction n'a pas de
  temps réel (`-PnoChatRealtime`).

La construction Play décidée pour l'instant laisse tomber les niveaux 1 et 2 :
c'est une construction `-PnoChatRealtime`, qui n'a donc besoin ni du service
`specialUse` du clavardage ni de la dispense de batterie. Les niveaux 3 à 5
tournent sur JobScheduler.

## Si une construction Play garde les niveaux 1 et 2

Ces deux justifications ne valent que pour une construction qui garde les
niveaux 1 et 2. Play peut la refuser ; la construction sans temps réel est le
repli.

- **Le service de premier plan `specialUse`** (`ChatPushService`) : une
  messagerie en temps réel depuis le propre serveur de l'utilisateur. Odoo
  publie un Web Push chiffré sur le propre serveur ntfy de l'utilisateur ; le
  service y garde une connexion ouverte pour qu'un message arrive dès son
  envoi, app fermée. Il n'y a pas de chemin Firebase Cloud Messaging (FCM) :
  le serveur appartient à l'utilisateur, pas à un service qui pourrait tenir
  une clé FCM. `dataSync` ne convient pas, puisqu'Android 15 le plafonne à six
  heures par 24. La propriété `PROPERTY_SPECIAL_USE_FGS_SUBTYPE` du manifeste
  énonce le même usage.
- **`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`** (la boîte de dialogue système
  `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`) : les usages admis par Play
  pour la demande directe comprennent une app dont la fonction première est
  une messagerie en temps réel qui ne peut pas passer par FCM, ce qui est le
  cas ici. La demande ne se fait que quand l'utilisateur choisit le niveau 1
  ou 2 ; refusée, l'app dit ce qu'elle coûte et propose le niveau 3. Un
  appareil sans cette boîte reçoit la liste du système à la place.

## Gardé dans toute construction

- **`POST_NOTIFICATIONS`** : les notifications du clavardage, celles de la
  boîte de réception, le sommaire et la notification permanente minimale. Sur
  Android 13 et suivants c'est une permission demandée à l'exécution ;
  refusée, les options disent que rien ne peut sonner.
- **Le récepteur de démarrage** (`RECEIVE_BOOT_COMPLETED`) :
  `ChatPushBootReceiver` réapplique le niveau des notifications après un
  redémarrage ou une mise à jour, car une mise à jour arrête le service
  permanent sans le relancer, et replanifie la relève périodique.
- **Les alarmes exactes** : le clavardage n'en utilise aucune. Ses relèves
  périodiques sont des tâches JobScheduler, et l'attente de 10 secondes du
  réglage du navigateur tourne sur une minuterie unique sous son propre
  wakelock. `SCHEDULE_EXACT_ALARM` appartient à la passerelle SMS.
- **Le texte en clair** : refusé par défaut. `network_security_config.xml`
  n'autorise le http que pour les adresses de boucle locale `localhost`,
  `127.0.0.1` et `10.0.2.2`. `-PlanCleartext` construit un APK de
  démonstration qui accepte le http sur le réseau local, jamais pour la
  distribution.

## Chaque permission du manifeste fusionné

La liste ci-dessous est vérifiée contre le manifeste fusionné de
`./gradlew assembleDebug -PnoChatRealtime`, lu par
`aapt2 dump xmltree --file AndroidManifest.xml app-debug.apk` ; une permission
ajoutée à l'app ou à un plugin a sa place dans ce tableau.

| Permission | Ce qui s'en sert | Dans une construction Play |
|---|---|---|
| `INTERNET` | Odoo, ntfy, bundles | gardée |
| `ACCESS_NETWORK_STATE` | plugin réseau ; niveau 2 (Wi-Fi) ; reprise de la passerelle SMS | gardée |
| `WAKE_LOCK` | les tâches des notifications et l'attente ; notifications locales | gardée |
| `POST_NOTIFICATIONS` | toute notification de l'app | gardée |
| `RECEIVE_BOOT_COMPLETED` | `ChatPushBootReceiver` ; `SmsBootReceiver` | gardée (clavardage) |
| `FOREGROUND_SERVICE` | services de premier plan | gardée |
| `FOREGROUND_SERVICE_DATA_SYNC` | téléchargement du modèle de parole | gardée |
| `FOREGROUND_SERVICE_SPECIAL_USE` | `SmsGatewayService` ; `ChatPushService` dans une construction temps réel | retirée sauf si les niveaux 1 et 2 restent |
| `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` | niveaux 1 et 2 ; la passerelle SMS | retirée sans temps réel |
| `SCHEDULE_EXACT_ALARM` | cadence de la passerelle SMS | retirée |
| `SEND_SMS` | la passerelle SMS | retirée |
| `RECEIVE_SMS` | la passerelle SMS (réponses STOP) | retirée |
| `READ_CALL_LOG` | la fiche de l'appelant, facultative | retirée |
| `CALL_PHONE` | le clavier téléphonique | à revoir |
| `READ_PHONE_STATE` | noms des cartes SIM, état de la ligne | à revoir |
| `MODIFY_AUDIO_SETTINGS` | démonstration audio des appels | à revoir |
| `RECORD_AUDIO` | notes et messages vocaux | gardée |
| `CAMERA` | photos, code QR du lien ntfy (plugins) | gardée |
| `ACCESS_COARSE_LOCATION` | géolocalisation des notes | gardée |
| `ACCESS_FINE_LOCATION` | géolocalisation des notes | gardée |
| `READ_EXTERNAL_STORAGE` | lecteur vidéo, Android 12 et avant (`maxSdkVersion` 32) | gardée |
| `WRITE_EXTERNAL_STORAGE` | lecteur vidéo, Android 12 et avant (`maxSdkVersion` 32) | gardée |
| `USE_BIOMETRIC` | déverrouillage biométrique (plugin) | gardée |
| `USE_FINGERPRINT` | déverrouillage biométrique sur un Android ancien (plugin) | gardée |

Les commentaires de la passerelle SMS qui disent que la justification de Play
« ne s'applique pas » restent : ils décrivent la passerelle, qui est hors de
toute construction Play.
