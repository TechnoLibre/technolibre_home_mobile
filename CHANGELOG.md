
# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- **Chat with Odoo 18 Discuss, lot 1** — a Chat tile on the home page, with
  its unread count, opens the list of conversations of every Odoo 18 server
  of the app (filter by server, search, direct chats, groups and channels).
  A conversation shows its history by pages (or all of it at once), who is
  typing, who is online, and what became of each message: sending, sent,
  seen by everyone, not sent. Messages arrive at once through the server's
  websocket, which reconnects by itself and reloads what it cannot replay.
  A message written offline waits in a queue, in order, and a post whose
  answer was lost is found again by a hidden marker in its body instead of
  being posted twice; with the optional `erplibre_mobile_chat` server
  module, installed from « Edit an application » by a system user, the
  server recognises it too. Options › Chat turns off the read receipts and
  the typing indicator sent to the server.
- **Chat, lot 2: new conversations and management** — a New conversation
  screen starts a direct message (people found by name, the recent ones
  first), a group, or a channel restricted to an access group or open to
  everyone, and lists the public channels to join. Everything is made
  offline: the conversation appears at once, waits in the queue, and takes
  its server identity when the network returns; a create whose answer was
  lost is found again instead of made twice (by an identifier the server
  module stores, or, without it, by the conversation's fingerprint), and a
  refusal leaves the conversation marked failed until dismissed. The info
  screen lists the members by pages, adds people, renames a group or channel
  (or a chat, for oneself), edits the description, mutes the conversation
  from 15 minutes to a day, or for good, leaves it, and, for an administrator,
  removes a member. A direct message hidden on the server stays hidden and
  shows again when the other person writes. Options › Chat mutes the whole
  account per server. The server module 1.1 is detected: an older module is
  offered an upgrade (to a system user), and removal needs it. The thread
  and info screens now load their styles, and a guard checks that every
  sheet reachable from the entry is covered.
- **Chat, lot 3: files and voice** — a message carries photos, files and
  voice messages. The composer takes a camera shot (the original, kept), a
  gallery pick or any file; a HEIC photo becomes a JPEG, and a photo can be
  compressed (1920 px, JPEG quality 80) when the user asks. A voice message
  is recorded with a tap to start and a tap to stop (60 seconds at most) and
  encoded as MP3, mono, 128 kbit/s. The text and the files of a conversation
  are kept as a draft per conversation, across restarts, and the list shows a
  « Draft: » line for it. A message with files shows at once, with a
  « Preparing the photos… » line while they are compressed. The files go to the
  server one by one, streamed, in a queue lane of their own; a transfer whose
  answer was lost is not made twice (with the server module 1.2, which
  recognises the upload by its identifier, or, without it, by a search before
  the retry), a file over the server's limit is refused with a notice, and
  files wait for Wi-Fi when the option asks. The thread shows previews, the
  viewer opens a photo, the player plays a voice message, and « open with »
  hands a file to another app. Options › Chat sets the compression question,
  the cache space, a purge of the oldest-opened files (off by default, 2048
  MB, warned at 80 %) and clears the cache; a conversation's information screen
  shows its own space and clears it. Deleting an application counts the
  messages and the files not sent yet. The app bundles the MP3 encoder
  @breezystack/lamejs, licensed LGPL-3.0: Options › Third-party licenses
  names it, links its source and reproduces the licence text.
- **Chat, lot 4: actions and writing** — a long press on a message opens a
  menu: a bar of six reactions (👍 ❤️ 😂 😮 😢 🙏 at first, then the ones the
  user reacts with most), a button for the full emoji picker, Reply, Copy
  (the whole message), and, on one's own messages, Edit and Delete. Reactions
  show as chips under the message; a tap adds or removes one's own, a long
  press lists who reacted. Everything queues offline and is never applied
  twice: a reaction is sent as an explicit add or remove, one added then
  removed before it left sends nothing, and an edit or a delete whose answer
  was lost counts as done when the server shows it. A reply shows a quote
  of the original, which a tap scrolls to; an edited message shows « (modifié) »;
  a deleted one disappears, and a reply quoting it says the original is
  deleted. An edit is refused rather than overwriting a message changed or
  deleted in the browser meanwhile (with the server module 1.3 the server
  compares the body it holds; without it the app re-reads the message just
  before sending), and the refused text stays one tap away under « Reprendre ».
  The composer writes what the browser composer writes: line breaks, links,
  emoji shortcodes, and @people and #channels picked from suggestions (the
  people and channels the phone knows, then the server's), with @everyone;
  a reply, an edit in progress and the picks are kept in the draft of the
  conversation. The emoji picker has search, categories and recent emoji;
  its names, keywords and shortcodes come from Odoo 18's `web` module
  (LGPL-3.0), converted once into an asset loaded when the picker opens, and
  they are Unicode CLDR data under the Unicode-DFS-2016 licence: Options ›
  Third-party licenses names both and reproduces the Unicode text, the
  authors' sentence in the language of the app. Migrations 2026102607
  (reactions, replies, recipients) and 2026102608 (reply, edit and mentions
  of the draft). The test kit is at `HARNESS_API` 4 and the device hook at
  `DEVICE_HOOK_API` 5.
- **Chat, lot 5: finding things and the inbox** — conversations kept on top
  stay at the top of the list; Options › Chat › « Ordre de la liste » chooses
  « Épinglées d'abord » (the default) or « Non lues d'abord ». The search box of
  the list now looks through messages, people, conversations, file names, the
  inbox and the starred messages on the phone, even offline (an index on the phone
  where its database allows it, a plain scan otherwise), then asks the server
  for more when online, in the conversations the user belongs to only, without
  marking anything read; a result opens its conversation at the message. A
  message can be pinned or unpinned from its menu, and « Messages épinglés » in
  the conversation's menu lists them; a pin notice links to the message. A
  message can be starred (Favori), and the list has a Favoris box. The new
  Inbox box brings the mentions, the comments on followed records and the
  assignments, with its history; « Marquer comme lu » reads one item, « Tout
  marquer lu » those shown, and an item opens its conversation at the message,
  the record's note in the app, or the record's page. A reply in a record's
  chatter takes text, photos, files, voice and mentions, is an internal note
  unless one confirms « Envoyer comme message aux abonnés », and waits offline
  like any message. A user whose Odoo notifies by email, who therefore has an
  empty inbox, is told why and can switch to « Recevoir mes notifications dans
  Odoo » with one tap (online). Needs the server module 1.4 to be fully safe
  against doubles; without it the app falls back to searching before it
  sends. Migrations 2026102701 to 2026102704; the test kit is at `HARNESS_API`
  5 and the device hook at `DEVICE_HOOK_API` 6.
- **Chat: authors on bubbles** — in groups and channels, other people's
  messages show the author's name above the bubble and their avatar to its
  left, once per run of messages as the Odoo web client does; own messages,
  direct chats and system lines show neither. Avatars are fetched when the
  author is on screen, kept on the phone per account (counted and cleared with
  the chat cache), and initials stand in while they load or offline. Migration
  2026102705.
- **Sync test entry points** — `src/testing/syncTestKit.ts` (versioned by
  `HARNESS_API`) sets the sync code up for ERPLibre's integration tests
  against real Odoo servers; a development build also exposes
  `window.__erplibreTest` to its device tests, and `-PsyncTest` builds the
  app as `ca.erplibre.home.synctest`, beside the user's own.
- **Test bundle** — a third target in Options › Code, after Mobile and
  ERPLibre. 52 display fixtures under 400 KB: PNG in colour, alpha and
  greyscale plus the 1×1 degenerate case, BMP, static and animated GIF,
  three SVG, WAV, and borrowed JPEG, WebP, MP3, OGG and ICO; markdown,
  JSON, CSV, XML, YAML, TOML, plain text, an empty file and a Unicode
  sheet; and six code projects — Tornado, an Odoo module with an Owl
  component, JavaScript, Rust, C++ and Java. A format that does not display
  here will not display in a real repository, and it shows without
  scrolling 82 000 files. No video ships: H.264 and VP9 need an encoder
  this machine has not, and `media/PROVENANCE.md` carries the two ffmpeg
  commands that fill the gap
- **Markdown tables in the code browser** — every document under `doc/` is
  made of tables, and each pipe row rendered as a paragraph. Six heading
  levels and nested lists came with them. The renderer moved beside
  `syntax_highlight.ts` so it can be tested, including against the
  repository's own documentation
- **SMS gateway** (Options › SMS gateway) — the phone becomes the outgoing
  SMS channel of an ERPLibre server: it polls Odoo over outgoing HTTPS,
  sends through its own SIM and reports every acknowledgement, so nothing is
  billed per message and the device needs neither a fixed address nor an
  open port. The foreground service is declared `specialUse` and not
  `dataSync`, which Android 15 caps at six hours per twenty-four — a
  permanent alert channel does not fit under that cap. A scheduled job
  revives the service when the system kills it, and a boot receiver restarts
  it after a power cut. Every body is signed HMAC-SHA256, sending holds a
  budget of 24 segments per minute against the limit of 30 Android enforces
  on its own, and an incoming STOP is honoured by a dedicated receiver
- **Phone** — a keypad at `/phone`, and the application can hold the dialer
  role. Without an `InCallService`, `onCallStateChanged` files dialling and
  conversation under the same off-hook state, so nothing says WHEN the other
  party answers; the role gives that exact moment. It is granted by a system
  dialog and handed back from settings, and the components stay inert until
  it is granted — the system call screen keeps working as usual
- **Demonstration APK for a server on the local network** — `-PlanCleartext`
  builds a variant that tolerates cleartext HTTP. Android's network
  configuration accepts no CIDR range, so “only private addresses” cannot be
  written there: lifting the protection lifts it entirely, and the only
  remaining guard is the application-side check — RFC 1918 ranges plus an
  explicit agreement from the user. Weaker, hence not the default
- **Call audio demonstration**, off by default and limited to outgoing calls
  — Android exposes no interface to inject sound into a call's uplink: that
  stream belongs to the modem, and `VOICE_UPLINK`, `VOICE_DOWNLINK` and
  `VOICE_CALL` require `CAPTURE_AUDIO_OUTPUT`, reserved to platform-signed
  applications, with no write-side counterpart at any permission level. What
  remains is acoustic coupling — playing on the speaker while the microphone
  captures — from which the signal processor's echo cancellation strips back
  out whatever the device has just played, so quality is poor by
  construction
- **Chat notifications while the app is closed** — Options › Chat
  notifications sets, per Odoo 18 server, a link to the user's own ntfy (QR
  code or pasted, with a second address when Odoo reaches ntfy differently).
  Odoo publishes an encrypted push to the account's secret topic, the phone
  decrypts it and draws one notification per conversation; tapping it opens
  the conversation. Five levels:
  realtime, realtime on Wi-Fi or charging, every 15 minutes (the default for an
  install that never chose), every hour, off; the first two keep a permanent
  connection behind one minimal notification shared with the SMS gateway
  (its « Passerelle SMS » channel is replaced) and ask Android for the battery
  exemption. A phone silent longer than the ntfy cache, and an account without
  ntfy, get one summary per server counted from Odoo's unread counters;
  nothing is marked read. The lock-screen choice is per server and
  « Hidden when locked » is guaranteed: when Android hides sensitive content
  the notification shows « Nouveau message — <server> », and when Android shows
  all content or the setting cannot be read the notification stays off the lock
  screen. `-PnoChatRealtime` builds without the permanent service. Works with
  `erplibre_mobile_chat` 1.4 or without the module; migration 2026102801 adds
  the table `chat_push`

### Changed
- **Gettext catalogues leave the bundle** — 41 763 files and 857 MB, 33.5 %
  of the files and 58.7 % of the payload, against 603 MB for everything
  else. Weblate and the OCA bots maintain them and nobody reads a catalogue
  on a phone. Archives fall from 431 to 328 MB, and the build reports what
  it dropped. `BUNDLE_KEEP_PO=1` brings them back, `BUNDLE_SKIP_IMG=1` drops
  the raster images too and takes archives to 115 MB. A side effect worth
  having: 41 763 fewer files takes the build from 43 s to 22 s

### Fixed
- **The inbox gets the comment a load overtook** — when a load of the inbox
  came between the announcement of a followed record's comment and its
  delivery, the delivery was taken for a replay and wrote nothing: of two
  comments, only the second showed. Such a delivery now re-reads the first
  page of the inbox.
- **The interface comes back after every restart** — one launch in two left the
  application on its starting screen: JavaScript ran to the end, the main thread
  sat idle in its loop, and nothing was ever painted. `launchAutoHide: false`
  makes the splash plugin install a pre-draw listener that refuses every draw of
  the activity's content, and turns off the timer that would remove it; only
  `hide()` removes it, and only if it finds it already installed. The listener is
  installed on the UI thread while `hide()` is called from the first line of the
  boot, so whichever won the race decided whether the application would ever
  appear. The splash now hides on its own after 500 ms, which frees the draw even
  when `hide()` arrives too early; the application's own boot screen, with its
  spinner and its steps, covers the loading as it was meant to
- **The first launch after an install no longer stops on its starting screen** —
  a fresh install runs every migration, and the summary was shown in a modal
  dialog the boot waited on. That dialog is raised before the interface is
  painted, so it sits behind the system's starting window: nobody can reach
  it, and the boot waits forever for a tap that cannot happen, with no error
  anywhere. The summary is now written under the boot spinner, where it stays
  until the application opens, and to the console. Nothing waits for a gesture
- **A queued report is re-signed at each attempt** — the envelope carried the
  timestamp and the nonce of the first try. The server accepts a signature
  only within a few minutes, so a report queued while the network, the
  battery or the server was down became permanently unacceptable, was retried
  fifty times and blocked every valid report behind it. Timestamp and nonce
  are now set just before each send. Duplicates stay impossible: what guards
  against them is the sequence number each event carries, which the server
  orders and ignores on a second delivery. A body that cannot be parsed is
  dropped with a journal line instead of being replayed
- **Packaging stays under the 65 535 entries an APK allows** — the offline
  code browser embeds 123 306 files, and packaging failed on “Too many zip
  entries”. Those repositories are now excluded by default, and
  `-PslimApk=false` puts them back to reproduce the failure. This is not a
  fix: the resulting APK has no code browser, and the durable answer —
  serving those repositories from the network rather than embedding them —
  remains a product decision
- **The native build finds a host `protoc`** — sentencepiece fetches
  protobuf, whose CMake builds `protoc` for the target then tries to run it
  on the host: arm64 against x86_64, “Exec format error”.
  `android/tools/build-host-protoc.sh` produces the host binary outside the
  repository, eight megabytes specific to the builder's architecture, and
  `SPM_PROTOC_EXECUTABLE` names it. Nothing to do when
  `BUNDLE_SKIP_WHISPER=1` skips the native build altogether

## [2026.08.24.01] - 2026-08-24

Summary of development since release `2026.04.14.01` (April 14, 2026).
Integrates the `quality_functionnality_test` branch: 160 commits merged
into `main` as ten stacked pull requests, then 11 further commits carrying
the bilingual documentation, this release and the accessibility labels.
Test suite goes from 854 to 1000 tests across 66 files.

### Added
- **Elgato Stream Deck support** — a native Android USB stack, written from
  scratch in Java against `UsbDeviceConnection`, with no third-party HID
  dependency:
  - **Seven models** in `DeckRegistry` — Original, MK.2, XL, XL v2, Mini,
    Plus and Neo — each with its own key grid, image format, rotation and
    bezel geometry
  - **Two wire protocols** — `TransportV1` and `TransportV2` pagination,
    selected per model
  - **Image pipeline** — `RgbaRotator` (pure-Java BGR rotation), BMP and
    JPEG encoders per model, and `LcdEncoder` for the Plus touchscreen strip
  - **`WriterQueue`** — per-slot coalescing, so a slow deck drops stale
    frames instead of building a backlog
  - **Multi-deck** — one `DeckSession` per open device, a `PendingIntent`
    per device for permission, and USB hotplug restricted to the Elgato
    vendor ID
  - **Camera streaming** — the rear camera painted across every deck, with
    frame rate, camera choice, JPEG quality, still-frame skipping and
    per-axis bezel compensation
  - **Face detection** — ML Kit marks the tiles that frame a face
  - **Note integration** — action keys and note entries painted on the
    keys; pressing a key drives the note
  - **Diagnostic panel** (`/options/streamdeck`) — per-deck brightness, a
    USB scanner listing every device, a raw HID byte dump, an event log
    that survives navigation, and an auto-refresh toggle
  - **LCD marquee** — scrolling text on the Plus touchscreen
- **Code editing** (`/options/code`) — the browser becomes writable:
  - **`RepoExtractorService`** — lazy `tar.gz` extraction to the Capacitor
    filesystem, with an inline ustar parser and `DecompressionStream`
    wrappers, so no archive library ships in the bundle
  - **`EditableCodeService`** — git-backed edits through `isomorphic-git`
    over a Capacitor `Filesystem` adapter; promoting a repo to editable
    records a git baseline
  - **Git panel** — status, a real diff from the `diff` package, and a
    warning when the baseline has drifted
  - **Workspace root** browsing, not just the app's own sources
- **Photo gallery** — every photo from every note in one place, with pinch
  to zoom, chrome that hides, and landscape shots rotated
- **Feature catalogue** (`/options/features`) — a bilingual catalogue of
  every feature with dependency edges, per-leaf status, how-it-works
  blocks, search, deep links and matrix, card and dashboard views
- **Bundle pipeline** — manifest repos shipped as one `tar.gz` each, built
  in parallel at CPU-count concurrency, with `BUNDLE_SKIP_REPOS` for dev
  iteration; Owl templates precompiled at build time into their own chunk;
  `build_id.json` emitted from the git sha
- **Groq transcription backend** — opt-in, alongside the existing SSH,
  HTTP and on-device whisper bridges
- **Keep-awake** — hold the phone screen on from Options
- **Device dialog** — every network interface listed
- **Uptime counter** beside the startup time on Home
- **Documentation** — the Stream Deck plugin, the bundle pipeline and edit
  mode, a smoke script and the manual hardware matrix it cannot replace,
  and how to debug an Android build over wifi
- **Bilingual documentation** — every document under `doc/`, both READMEs
  and this changelog now have a `.base.md` source generating an English and
  a French file through mmg, following the root repository's convention.
  Half the documentation was French-only and half English-only; neither
  half was reachable by the other language.

### Changed
- **Owl AOT coverage is now complete** — note templates dropped template
  interpolation, so every template is precompiled; lookup is by raw source
- **Vendor bundle split** with `manualChunks`
- **Android build** — one ABI by default and whisper skippable, cutting
  local build time
- **Dependencies** — patch, minor and major bumps; one dead dependency
  dropped; `isomorphic-git` added for edit mode
- **Test coverage** — the Stream Deck controller, event log, three
  bridges, the LCD renderer, four untested services, the schema
  migrations, encrypted file IO, the error classes, the WebView util, the
  component base class, the section hook, and the video thumbnail
  generator and its backfill
- **Catalogue permissions** are now audited against the Android manifest
  by a test
- **Translation coverage** — 62 aria-labels and 354 occurrences of visible
  text that held hardcoded French now go through the dictionaries, which
  grew from 383 to 591 keys. 86 of those values already had a key defined
  and unused, so they are wired rather than duplicated. A test collects
  every static `t()` call in app code and fails when a key is missing from
  either side, which nothing rendering templates would have caught. The
  feature catalogue and the Stream Deck diagnostics keep their own strings:
  the first has its own FR/EN toggle, the second is log output
- **In-app changelog** — reads the bundled `CHANGELOG.md` instead of
  carrying its own copy of the text and a hardcoded version constant. The
  version shown is the file's first dated heading, in the reader's
  language, so a release no longer needs it bumped by hand

### Fixed
- **Stream Deck reliability** — buttons that worked once then stopped;
  reads moved to `UsbRequest` to get past the kernel HID poll, surviving a
  timeout with a poll as last resort; key reports parsed correctly for XL,
  MK.2 and v2; events emitted only on change; the read buffer matched to
  the endpoint packet size; every deck reset before USB teardown, on swipe
  from recents, and when streaming stops; decks dimmed rather than reset on
  sleep, keeping the bus alive; the writer queue drained when streaming
  stops; Note presses throttled to dodge a WebView crash; no painting while
  the app is hidden
- **Note caret** — the caret lands in the note title on auto-focus, and
  keeps trying while showing that it is waiting
- **Transcription persistence** — a transcription is saved whatever the UI
  is doing
- **Note contrast** — entry icons inverted on light themes, and button
  labels legible on saturated fills
- **Photo and Image entries** are kept distinct
- **`usesCleartextTraffic`** wins the Android manifest merge
- **Gradle** space-assignment deprecations silenced
- **Stale symlink** under `repos/` no longer breaks the build
- **Android `versionCode`** had never moved from 1 since the first commit.
  Android refuses to install an APK whose code is not greater than the
  installed one, so no release was upgradable over its predecessor. It now
  follows the CalVer integer the migrations already use

### Removed
- **`debug.keystore`** removed from the repository
- **Native USBDEVFS reader mode** — dropped after the `UsbRequest` path
  proved sufficient
- **`build_id.json` and `feature_touched.json`** left version control.
  Both are build outputs; the second derives from filesystem mtimes, so a
  rebase stamped every feature with the same false date

### Security
- **Four critical audit findings** closed, then the medium and low ones
- **Credential encryption** and certificate pinning
- **CSP**, bundled PWA elements, R8 shrinking, and a JSch fork

## [2026.04.14.01] - 2026-04-14

Summary of development since release `2026.04.13.01` (April 13, 2026).
Integrates the `code_integration` branch.

### Added
- **Code browser** (`/options/code`) — multi-mode source code navigator with
  three connection modes:
  - **Bundle** — reads the app's own sources bundled at compile time
    (`src/public/repo/`), no SSH connection required
  - **SSH Path** — connects to a registered SSH server; displays available
    workspaces as a picker, then browses the remote filesystem
  - **SSH URL** — reads ERPLibre manifest repos bundled at compile time
    (`src/public/repos/{slug}/`); project chips show name and revision
- **Syntax highlighting** — zero-dependency tokeniser for Python, TypeScript,
  JSON, SCSS and Shell; all colours via CSS variables (Monokai-style defaults)
- **Markdown preview** — toggle between raw source and rendered HTML for `.md`
  files
- **Image viewer** — inline `<img>` display for `.png`, `.jpg`, `.svg`,
  `.webp` and other image formats; data-URL for SSH mode, bundle URL for
  offline mode
- **Inline editor** — single-line editing via `writeLine()` (SSH mode only);
  the highlighted line refreshes after save without reloading the full file
- **Vite source bundler** — `bundleSourcePlugin` in `vite.config.ts` copies
  app sources to `src/public/repo/` and manifest repos to
  `src/public/repos/{slug}/` at build time; generates `index.json` per bundle
  and `manifest.json` listing available repos

### Changed
- **Vite bundler — artifact exclusions**: manifest repo bundles now skip
  `android/`, `ios/`, `build/`, `.gradle/`, `__pycache__/`, `venv/` and other
  build-artifact directories, binary file extensions (`.so`, `.class`, `.jar`,
  `.aar`, `.dex`, `.pyc`, etc.) and files > 1 MB — prevents APK packaging
  failures caused by bundling 39 MB of compiled Gradle artifacts
- **Build diagnostics** (`BUNDLE_DEBUG=1`): per-file verbose tracing of
  copy/skip decisions; per-project wall-clock timing and skipped-file count on
  every summary line; `[bundle-warn]` warnings on broken symlinks or permission
  errors without aborting the build

## [2026.04.13.01] - 2026-04-13

Summary of development since release `2026.03.18.01` (March 20, 2026).
Integrates branches `feature/local_gpt` and `feature/deploy_ssh_erplibre`
merged into `main`, along with improvements from the `gpt_whisper` branch.

### Added
- **Whisper transcription**: local on-device audio and video transcription (Android)
  via whisper.cpp / GGML — no external server, no subscription required
- **Whisper models**: 6 variants available — tiny, base, small, medium,
  large-v3-turbo and distil-large-v3 (English only) — with size, speed and
  progress displayed on each model card
- **OCR**: ML Kit text detection on photo entries (ML Kit Text Recognition)
- **Network scan**: SSH discovery on the local /24 network via NetworkScanPlugin
  (50 parallel threads, confirmed SSH banner)
- **SSH deployment**: ERPLibre deployment workflow from the app —
  SSH connection (JSch), `git clone`, `make install` — with per-step visual
  progress (grey → green) and real-time log
- **Process tracking**: SQLite journal of background transcriptions and downloads,
  persisted across restarts; detail modal with Java-level debug log and
  navigation button to the associated note
- **Resource monitor**: real-time CPU, RAM and battery graphs via
  DeviceStatsPlugin (native Java `/proc/stat` + `MemoryInfo` + `BatteryManager`)
- **Hierarchical tags**: parent/child tag system with colour picker,
  resolved names in note list chips, names above the title in the editor,
  and a dedicated "by tag" view from the home screen
- **Note priority**: Eisenhower matrix (urgent/important) with icons and
  filtering in the note list
- **Home dashboard**: dashboard layout replacing simple buttons

### Changed
- **WakeLock download**: `PowerManager.PARTIAL_WAKE_LOCK` keeps the CPU and
  network active when the screen is off; resume via `Range: bytes=N-` on
  `.partial` file
- **Multi-thread download (×4)**: fresh downloads (known size) use 4 parallel
  HTTP Range connections writing to a pre-allocated `FileChannel` —
  theoretically up to 4× faster throughput
- **Foreground Service**: alternative mode with a persistent Android notification
  and Cancel button; automatic re-attachment to the JS Promise after Activity
  recreation
- **Parallel downloads**: multiple Whisper models downloadable simultaneously;
  if the Foreground Service is busy, additional models automatically fall back
  to wakelock mode
- **Themes**: light/dark selector with 4 colour presets (dark, light, nord,
  solarized); all component colours migrated to CSS variables (`vars.scss`)
- **Rate selector** (resource monitor): replaced oversized buttons with a radio
  list using named OWL event handlers
- **Options emoji**: emoji icons on all Options menu items
- **Boot time**: displayed on the home screen
- **Java errors**: all error messages in WhisperPlugin and WhisperDownloadService
  translated to French

### Fixed
- Removed `fetch()` fallback on native Android (caused OOM for models > 200 MB
  via base64 in WebView)
- Duplicate Foreground Service download thread on Android Activity recreation
- Download mode selection buttons doing nothing (OWL lambda handler)
- Tag colour picker, display and chip colours
- Icon visibility and accent colours in light theme
- Navigation button to the resource monitor (OWL lambda)
- Black button visibility in light theme

### Accessibility
- 5 accessibility sprints covering: `lang` attribute on `<html>`, skip-to-content
  link, ARIA roles and landmarks on all major components, `prefers-reduced-motion`
  support, live regions, dialog roles, ARIA on the tag manager, note entries
  (audio, photo, video, geo, text, drag, delete) and the sync screen

## [2026.03.18.01] - 2026-03-20

### Added
- SQLite database backend with AES-256 encryption (replaces SecureStorage)
- Biometric protection for database encryption key (opt-in)
- Versioned migration system — migrations only run once on startup
- User notification popup when a migration is performed
- Boot screen with step-by-step initialization progress
- Options sub-pages with breadcrumb navigation
- SQLite database size diagnostic with per-file details
- Video: HTML5 overlay playback (replaces CapacitorVideoPlayer)
- Video: thumbnail from first frame, cached alongside the video file
- Video: migration to backfill thumbnails for existing entries
- Video: auto-open camera when adding a new entry
- Photo: camera capture support with fullscreen viewer
- Photo: auto-open camera when adding a new entry
- Geolocation: "Ouvrir la carte" button opens the native map app

### Changed
- Data is now stored in SQLite instead of SecureStorage
- DB size reads actual file sizes via Filesystem.stat() instead of PRAGMA

### Fixed
- Stale event listeners on note component destroy causing ghost entries
- Video camera auto-opening on all note views instead of only on new entries
- Race condition when opening photo camera before component was mounted

## [2025.12.28.01] - 2025-12-28

### Added
- Application management: add, edit, and delete Odoo instances
- Notes with multiple entry types: text, audio recording, video recording, photo, and geolocation
- Tags and labels for notes
- Data stored in SecureStorage
