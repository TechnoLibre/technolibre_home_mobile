
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
