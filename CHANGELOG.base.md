<!---------------------------->
<!-- multilingual suffix: en, fr -->
<!-- no suffix: en -->
<!---------------------------->

<!-- [en] -->
# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

<!-- [en] -->
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
  inbox and the favourites on the phone, even offline (an index on the phone
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

<!-- [fr] -->
# Journal des modifications

Tous les changements notables de ce projet sont consignés dans ce fichier.

Le format suit [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Non publié]

<!-- [fr] -->
### Ajouté
- **Clavardage avec Discuss d'Odoo 18, lot 1** — une tuile Clavardage sur la
  page d'accueil, avec son nombre de non lus, ouvre la liste des
  conversations de chaque serveur Odoo 18 de l'app (filtre par serveur,
  recherche, discussions directes, groupes et canaux). Une conversation
  montre son historique par pages (ou en entier d'un coup), qui écrit, qui
  est en ligne, et ce qu'est devenu chaque message : envoi, envoyé, vu par
  tous, non envoyé. Les messages arrivent aussitôt par le websocket du
  serveur, qui se reconnecte seul et recharge ce qu'il ne peut pas rejouer.
  Un message écrit hors ligne attend dans une file, dans l'ordre, et un envoi
  dont la réponse s'est perdue est retrouvé par un marqueur caché dans son
  corps au lieu d'être posté deux fois ; avec le module serveur facultatif
  `erplibre_mobile_chat`, installé depuis « Modifier une application » par
  un utilisateur système, le serveur le reconnaît aussi. Options ›
  Clavardage coupe les accusés de lecture et l'indicateur de frappe envoyés
  au serveur.
- **Clavardage, lot 2 : nouvelles conversations et gestion** — un écran
  Nouvelle conversation démarre un message direct (personnes trouvées par
  nom, les récentes d'abord), un groupe, ou un canal réservé à un groupe
  d'accès ou ouvert à tous, et liste les canaux publics à rejoindre. Tout se
  fait hors ligne : la conversation apparaît aussitôt, attend dans la file et
  prend son identité serveur au retour du réseau ; une création dont la
  réponse s'est perdue est retrouvée au lieu d'être faite deux fois (par un
  identifiant que stocke le module serveur ou, sans lui, par l'empreinte de
  la conversation), et un refus laisse la conversation marquée échouée
  jusqu'à ce qu'on l'écarte. La fiche liste les membres par pages, ajoute des
  personnes, renomme un groupe ou un canal (ou un chat, pour soi seul),
  modifie la description, met la conversation en sourdine de 15 minutes à un jour
  ou pour de bon, la quitte et, pour un administrateur, retire un membre. Un
  message direct masqué sur le serveur le reste et réapparaît quand l'autre
  personne écrit. Options › Clavardage met en sourdine tout le compte, par
  serveur. Le module serveur 1.1 est détecté : un module plus ancien se voit
  proposer sa mise à jour (à un utilisateur système), et le retrait en a
  besoin. Les écrans de fil et de fiche chargent désormais leurs styles, et
  une garde vérifie que chaque feuille atteinte depuis l'entrée est couverte.
- **Clavardage, lot 3 : fichiers et voix** — un message porte des photos,
  des fichiers et des messages vocaux. La zone de saisie prend une photo de
  l'appareil (l'original, conservé), un choix dans la galerie ou n'importe
  quel fichier ; une photo HEIC devient un JPEG, et une photo peut être
  compressée (1920 px, JPEG à 80) quand l'utilisateur le demande. Un message
  vocal s'enregistre d'un appui pour commencer et d'un appui pour finir (60
  secondes au plus) et s'encode en MP3, mono, 128 kbit/s. Le texte et les
  fichiers d'une conversation sont gardés en brouillon par conversation, d'un
  redémarrage à l'autre, et la liste en montre une ligne « Brouillon : ». Un
  message avec fichiers s'affiche aussitôt, avec une ligne « Préparation des
  photos… » pendant leur compression. Les fichiers partent un à un vers le serveur, en
  flux, dans une voie de la file qui leur est propre ; un transfert dont la
  réponse s'est perdue n'est pas fait deux fois (avec le module serveur 1.2,
  qui reconnaît le téléversement par son identifiant, ou, sans lui, par une
  recherche avant le renvoi), un fichier au-delà de la limite du serveur est
  refusé avec un avis, et les fichiers attendent le Wi-Fi quand l'option le
  demande. Le fil montre des aperçus, la visionneuse ouvre une photo, le
  lecteur joue un message vocal, et « ouvrir avec » confie un fichier à une
  autre app. Options › Clavardage règle la question de compression, l'espace
  du cache, un nettoyage des fichiers ouverts le moins récemment (désactivé
  par défaut, 2048 Mo, avertissement à 80 %) et vide le cache ; l'écran
  d'information d'une conversation montre son propre espace et le libère.
  Supprimer une application compte les messages et les fichiers pas encore
  envoyés. L'app embarque
  l'encodeur MP3 @breezystack/lamejs, sous licence LGPL-3.0 : Options ›
  Licences tierces le nomme, lie son code source et reproduit le texte de la
  licence.
- **Clavardage, lot 4 : actions et écriture** — un appui long sur un message
  ouvre un menu : une barre de six réactions (👍 ❤️ 😂 😮 😢 🙏 au début, puis
  celles dont l'utilisateur se sert le plus), un bouton vers le sélecteur
  d'émojis complet, Répondre, Copier (le message entier) et, sur ses propres
  messages, Modifier et Supprimer. Les réactions s'affichent en pastilles
  sous le message ; un appui ajoute ou retire la sienne, un appui long
  indique qui a réagi. Tout se met en file hors ligne et n'est jamais appliqué
  deux fois : une réaction part en ajout ou en retrait explicite, celle
  ajoutée puis retirée avant de partir n'envoie rien, et une modification ou
  une suppression dont la réponse s'est perdue compte comme faite quand le
  serveur la montre. Une réponse montre une citation de l'original, vers
  laquelle un appui défile ; un message modifié montre « (modifié) » ; un
  message supprimé disparaît, et une réponse qui le cite dit que l'original
  est supprimé. Une modification est refusée plutôt que d'écraser un message
  changé ou supprimé entre-temps dans le navigateur (avec le module serveur
  1.3, le serveur compare le corps qu'il détient ; sans lui, l'app relit le
  message juste avant l'envoi), et le texte refusé reste à un appui sous
  « Reprendre ». La zone de saisie écrit ce qu'écrit celle du navigateur :
  sauts de ligne, liens, codes courts d'émojis, et @personnes et #canaux
  choisis dans des suggestions (ceux que le téléphone connaît, puis ceux du
  serveur), avec @everyone ; une réponse, une modification en cours et les
  choix sont gardés dans le brouillon de la conversation. Le sélecteur
  d'émojis offre recherche, catégories et récents ; ses noms, mots-clés et
  codes courts viennent du module `web` d'Odoo 18 (LGPL-3.0), convertis une
  fois en une ressource chargée à l'ouverture du sélecteur, et ce sont des
  données Unicode CLDR sous la licence Unicode-DFS-2016 : Options › Licences
  tierces nomme les deux et reproduit le texte d'Unicode, la phrase des
  auteurs dans la langue de l'app. Migrations 2026102607 (réactions,
  réponses, destinataires) et 2026102608 (réponse, modification et mentions
  du brouillon). Le kit de test est à `HARNESS_API` 4 et le crochet appareil
  à `DEVICE_HOOK_API` 5.
- **Clavardage, lot 5 : retrouver et boîte de réception** — les conversations
  gardées en tête restent en haut de la liste ; Options › Clavardage › « Ordre
  de la liste » choisit « Épinglées d'abord » (par défaut) ou « Non lues
  d'abord ». Le champ de recherche de la liste fouille désormais messages,
  personnes, conversations, noms de fichiers, boîte de réception et favoris sur
  le téléphone, même hors ligne (un index sur le téléphone là où sa base le
  permet, un simple balayage sinon), puis demande au serveur davantage en ligne,
  dans les seules conversations de l'utilisateur, sans rien marquer lu ; un
  résultat ouvre sa conversation au message. Un message s'épingle ou se
  désépingle depuis son menu, et « Messages épinglés » dans le menu de la
  conversation les liste ; une notice d'épingle renvoie au message. Un message
  se met en favori (Favori), et la liste a une boîte Favoris. La nouvelle boîte
  de réception apporte les mentions, les commentaires des enregistrements suivis
  et les assignations, avec son historique ; « Marquer comme lu » lit un
  élément, « Tout marquer lu » ceux affichés, et un élément ouvre sa
  conversation au message, la note de l'enregistrement dans l'app, ou la page de
  l'enregistrement. Une réponse dans le fil d'un enregistrement accepte texte,
  photos, fichiers, voix et mentions, est une note interne sauf si l'on
  confirme « Envoyer comme message aux abonnés », et attend hors ligne comme
  tout message. Un utilisateur dont Odoo notifie par courriel, et dont la boîte
  est donc vide, apprend pourquoi et peut passer à « Recevoir mes notifications
  dans Odoo » d'un appui (en ligne). Le module serveur 1.4 évite tout doublon ;
  sans lui, l'app cherche avant d'envoyer. Migrations 2026102701 à 2026102704 ;
  le banc de test est à `HARNESS_API` 5 et le crochet d'appareil à
  `DEVICE_HOOK_API` 6.
- **Clavardage : auteurs sur les bulles** — dans les groupes et les canaux, les
  messages des autres montrent le nom de l'auteur au-dessus de la bulle et son
  avatar à gauche, une fois par suite de messages comme le client web d'Odoo ;
  les siens, les conversations directes et les lignes système n'en montrent
  pas. Les avatars sont chargés quand l'auteur est à l'écran, gardés sur le
  téléphone par compte (comptés et vidés avec le cache du clavardage), et des
  initiales les remplacent le temps du chargement ou hors ligne. Migration
  2026102705.
- **Points d'entrée des tests de synchro** — `src/testing/syncTestKit.ts`
  (versionné par `HARNESS_API`) prépare le code de synchro pour les tests
  d'intégration d'ERPLibre contre de vrais Odoo ; une construction de
  développement expose aussi `window.__erplibreTest` à ses tests appareil, et
  `-PsyncTest` construit l'app sous `ca.erplibre.home.synctest`, à côté de
  celle de l'utilisateur.
- **Bundle de test** — une troisième cible dans Options › Code, après Mobile
  et ERPLibre. 52 fixtures d'affichage sous 400 Ko : PNG en couleur, avec
  alpha et en niveaux de gris, plus le cas dégénéré 1×1, BMP, GIF fixe et
  animé, trois SVG, WAV, et les JPEG, WebP, MP3, OGG et ICO empruntés ;
  markdown, JSON, CSV, XML, YAML, TOML, texte brut, un fichier vide et une
  feuille Unicode ; et six projets de code — Tornado, un module Odoo avec
  composant Owl, JavaScript, Rust, C++ et Java. Un format qui ne s'affiche
  pas ici ne s'affichera pas dans un vrai dépôt, et on le voit sans dérouler
  82 000 fichiers. Aucune vidéo n'est livrée : H.264 et VP9 exigent un
  encodeur que cette machine n'a pas, et `media/PROVENANCE.md` porte les
  deux commandes ffmpeg qui comblent le manque
- **Tableaux markdown dans le navigateur de code** — chaque document de
  `doc/` est fait de tableaux, et chaque rangée de barres s'affichait en
  paragraphe. Six niveaux de titre et les listes imbriquées ont suivi. Le
  rendu est passé à côté de `syntax_highlight.ts` pour être testable, y
  compris contre la documentation du dépôt
- **Passerelle SMS** (Options › Passerelle SMS) — le téléphone devient le
  canal SMS sortant d'un serveur ERPLibre : il interroge Odoo en HTTPS
  sortant, envoie par sa propre carte SIM et rend compte de chaque accusé,
  si bien que rien n'est facturé au message et que l'appareil n'a besoin ni
  d'une adresse fixe ni d'un port ouvert. Le service au premier plan est
  déclaré `specialUse` et non `dataSync`, plafonné depuis Android 15 à six
  heures par période de vingt-quatre — un canal d'alerte permanent n'entre
  pas sous ce plafond. Une tâche planifiée le relève quand le système le
  tue, et un récepteur de démarrage le rallume après une coupure de courant.
  Chaque corps est signé en HMAC-SHA256, l'envoi se tient à 24 segments par
  minute contre la limite de 30 qu'Android applique de lui-même, et un STOP
  entrant est honoré par un récepteur dédié
- **Téléphone** — un clavier de composition à `/phone`, et l'application peut
  tenir le rôle de composeur. Sans `InCallService`, `onCallStateChanged`
  classe la composition et la conversation sous le même état décroché :
  rien ne dit QUAND le correspondant répond, alors que le rôle donne
  l'instant exact. Il se confie par un dialogue système et se rend depuis
  les réglages, et les composants restent inertes tant qu'il n'est pas
  accordé — l'écran d'appel du système fonctionne normalement
- **APK de démonstration pour un serveur du réseau local** — `-PlanCleartext`
  produit une variante qui tolère le HTTP en clair. La configuration réseau
  d'Android n'accepte aucune plage CIDR : on ne peut pas y écrire
  « seulement les adresses privées ». Lever la protection la lève donc
  entièrement, et le seul rempart restant est la vérification côté
  application — plages RFC 1918 et accord explicite de l'utilisateur. C'est
  plus faible, et ce n'est donc pas le défaut
- **Démonstration d'audio d'appel**, désactivée par défaut et limitée aux
  appels sortants — Android n'expose aucune interface pour injecter du son
  dans le flux montant d'un appel : ce flux appartient au modem, et
  `VOICE_UPLINK`, `VOICE_DOWNLINK` et `VOICE_CALL` exigent
  `CAPTURE_AUDIO_OUTPUT`, réservée aux applications signées par la
  plateforme, sans contrepartie en écriture à aucun niveau de permission.
  Reste le couplage acoustique — jouer sur le haut-parleur pendant que le
  micro capte — dont l'annulation d'écho du processeur de signal retire ce
  que l'appareil vient de jouer, d'où une qualité mauvaise par construction

### Modifié
- **Les catalogues gettext quittent le bundle** — 41 763 fichiers et 857 Mo,
  33,5 % des fichiers et 58,7 % de la charge, contre 603 Mo pour tout le
  reste. Weblate et les robots OCA les maintiennent, et personne n'en lit un
  sur un téléphone. Les archives passent de 431 à 328 Mo, et la compilation
  dit ce qu'elle a écarté. `BUNDLE_KEEP_PO=1` les ramène,
  `BUNDLE_SKIP_IMG=1` écarte aussi les images matricielles et amène les
  archives à 115 Mo. Effet de bord bienvenu : 41 763 fichiers de moins
  ramènent la compilation de 43 s à 22 s

### Corrigé
- **La boîte de réception reçoit le commentaire qu'un chargement a devancé** —
  quand un chargement de la boîte survenait entre l'annonce d'un commentaire
  d'un enregistrement suivi et sa livraison, la livraison était prise pour un
  rejeu et n'écrivait rien : de deux commentaires, seul le second apparaissait.
  Une telle livraison relit désormais la première page de la boîte.
- **L'interface revient après chaque redémarrage** — un lancement sur deux
  laissait l'application sur son écran de démarrage : le JavaScript allait au
  bout, le fil principal restait inactif dans sa boucle, et rien n'était jamais
  peint. `launchAutoHide: false` fait poser au greffon un écouteur de pré-dessin
  qui refuse tout dessin du contenu de l'activité, et désactive la minuterie qui
  le retirerait ; seul `hide()` le retire, et seulement s'il le trouve déjà posé.
  L'écouteur est posé sur le fil d'interface pendant que `hide()` part de la
  première ligne du démarrage : celui qui gagnait la course décidait si
  l'application paraîtrait un jour. L'écran du greffon s'efface désormais seul au
  bout de 500 ms, ce qui libère le dessin même quand `hide()` arrive trop tôt ;
  l'écran de démarrage de l'application, avec son indicateur et ses étapes,
  couvre le chargement comme il le devait
- **Le premier lancement après une installation ne reste plus sur son écran de
  démarrage** — une installation neuve exécute toutes les migrations, et leur
  résumé s'affichait dans une boîte modale que le démarrage attendait. Cette
  boîte est levée avant que l'interface soit peinte : elle se place derrière la
  fenêtre de lancement du système, personne ne peut la toucher, et le démarrage
  attend sans fin un geste impossible, sans la moindre erreur nulle part. Le
  résumé s'écrit désormais sous l'indicateur de démarrage, où il reste jusqu'à
  l'ouverture de l'application, et dans la console. Plus rien n'attend un geste
- **Un rapport en file est re-signé à chaque tentative** — l'enveloppe portait
  l'horodatage et le nonce de la première. Le serveur n'accepte une signature
  que dans une fenêtre de quelques minutes : un rapport mis en file pendant une
  coupure de réseau, une batterie à plat ou un serveur arrêté devenait donc
  définitivement irrecevable, était rejoué cinquante fois et bloquait derrière
  lui tous les rapports valides. L'horodatage et le nonce sont désormais posés
  juste avant chaque envoi. Le doublon reste impossible : ce qui en protège est
  le numéro de séquence que porte chaque évènement, que le serveur ordonne et
  ignore à la seconde remise. Un corps illisible est abandonné avec une ligne
  au journal au lieu d'être rejoué
- **L'empaquetage tient sous les 65 535 entrées d'un APK** — le navigateur de
  code hors ligne embarque 123 306 fichiers, et l'empaquetage échouait sur
  « Too many zip entries ». Ces dépôts sont désormais exclus par défaut, et
  `-PslimApk=false` les rétablit pour retrouver l'échec. Ce n'est pas un
  correctif : l'APK produit perd le navigateur de code, et la solution
  durable — servir ces dépôts depuis le réseau plutôt que de les embarquer —
  reste une décision de produit
- **La compilation native trouve un `protoc` d'hôte** — sentencepiece
  récupère protobuf, dont le CMake construit `protoc` pour la cible puis
  tente de l'exécuter sur l'hôte : arm64 contre x86_64, « Exec format
  error ». `android/tools/build-host-protoc.sh` produit le binaire hôte hors
  du dépôt, huit mégaoctets propres à l'architecture de qui compile, et
  `SPM_PROTOC_EXECUTABLE` le désigne. Rien à faire quand
  `BUNDLE_SKIP_WHISPER=1` saute la compilation native

## [2026.08.24.01] - 2026-08-24

Résumé du développement depuis la publication `2026.04.14.01` (14 avril 2026).
Intègre la branche `quality_functionnality_test` : 160 commits fusionnés dans
`main` sous forme de dix demandes de tirage empilées, puis 11 commits de plus
portant la documentation bilingue, cette publication et les libellés
d'accessibilité. La suite de tests passe de 854 à 1000 tests répartis sur 66
fichiers.

### Ajouté
- **Prise en charge de l'Elgato Stream Deck** — une pile USB Android native,
  écrite de zéro en Java sur `UsbDeviceConnection`, sans aucune dépendance HID
  tierce :
  - **Sept modèles** dans `DeckRegistry` — Original, MK.2, XL, XL v2, Mini,
    Plus et Neo — chacun avec sa grille de touches, son format d'image, sa
    rotation et sa géométrie de bordure
  - **Deux protocoles de transport** — pagination `TransportV1` et
    `TransportV2`, choisie par modèle
  - **Chaîne d'images** — `RgbaRotator` (rotation BGR en Java pur), encodeurs
    BMP et JPEG par modèle, et `LcdEncoder` pour la bande tactile du Plus
  - **`WriterQueue`** — fusion par touche, pour qu'un deck lent laisse tomber
    les images périmées au lieu d'accumuler du retard
  - **Multi-deck** — une `DeckSession` par appareil ouvert, un `PendingIntent`
    par appareil pour la permission, et un branchement à chaud USB restreint à
    l'identifiant de fabricant Elgato
  - **Diffusion de la caméra** — la caméra arrière peinte sur chaque deck, avec
    cadence d'images, choix de caméra, qualité JPEG, saut des images fixes et
    compensation de bordure par axe
  - **Détection de visages** — ML Kit marque les tuiles qui cadrent un visage
  - **Intégration aux notes** — touches d'action et entrées de note peintes sur
    les touches ; presser une touche pilote la note
  - **Panneau de diagnostic** (`/options/streamdeck`) — luminosité par deck, un
    scanner USB listant chaque appareil, un vidage HID brut, un journal
    d'événements qui survit à la navigation, et un interrupteur de
    rafraîchissement automatique
  - **Bandeau LCD** — texte défilant sur l'écran tactile du Plus
- **Édition de code** (`/options/code`) — le navigateur devient inscriptible :
  - **`RepoExtractorService`** — extraction paresseuse de `tar.gz` vers le
    système de fichiers Capacitor, avec un analyseur ustar intégré et des
    enveloppes `DecompressionStream`, si bien qu'aucune bibliothèque d'archive
    n'est embarquée
  - **`EditableCodeService`** — édition adossée à git via `isomorphic-git` sur
    un adaptateur `Filesystem` de Capacitor ; promouvoir un dépôt en éditable
    enregistre une référence git
  - **Panneau git** — état, un vrai diff issu du paquet `diff`, et un
    avertissement quand la référence a dérivé
  - Navigation dans la **racine de l'espace de travail**, et non plus seulement
    dans les sources de l'application
- **Galerie de photos** — toutes les photos de toutes les notes en un seul
  endroit, avec zoom par pincement, une interface qui s'efface et les prises en
  paysage tournées
- **Catalogue de fonctionnalités** (`/options/features`) — un catalogue bilingue
  de chaque fonctionnalité, avec arêtes de dépendance, état par feuille, blocs
  de fonctionnement, recherche, liens profonds et vues matrice, cartes et
  tableau de bord
- **Pipeline de bundle** — les dépôts du manifeste livrés en un `tar.gz` chacun,
  construits en parallèle à la hauteur du nombre de processeurs, avec
  `BUNDLE_SKIP_REPOS` pour itérer en développement ; gabarits Owl précompilés à
  la compilation dans leur propre fragment ; `build_id.json` émis depuis le SHA
  git
- **Moteur de transcription Groq** — sur activation explicite, à côté des ponts
  SSH, HTTP et whisper sur l'appareil déjà présents
- **Écran maintenu allumé** — garder l'écran du téléphone allumé depuis Options
- **Dialogue d'appareil** — toutes les interfaces réseau listées
- **Compteur de temps de fonctionnement** à côté du temps de démarrage sur
  l'accueil
- **Documentation** — le plugin Stream Deck, le pipeline de bundle et le mode
  édition, un script de test de fumée et la matrice matérielle manuelle qu'il ne
  peut pas remplacer, et comment déboguer une compilation Android par wifi
- **Documentation bilingue** — chaque document de `doc/`, les deux README et
  ce journal ont désormais une source `.base.md` générant un fichier anglais
  et un fichier français via mmg, selon la convention du dépôt racine. La
  moitié de la documentation n'existait qu'en français et l'autre qu'en
  anglais ; aucune moitié n'était atteignable dans l'autre langue.

### Modifié
- **La couverture AOT d'Owl est désormais complète** — les gabarits de note ont
  abandonné l'interpolation, tous les gabarits sont donc précompilés ; la
  recherche se fait par source brute
- **Bundle fournisseur découpé** avec `manualChunks`
- **Compilation Android** — une seule ABI par défaut et whisper désactivable, ce
  qui raccourcit la compilation locale
- **Dépendances** — montées de version correctives, mineures et majeures ; une
  dépendance morte retirée ; `isomorphic-git` ajouté pour le mode édition
- **Couverture de tests** — le contrôleur Stream Deck, le journal d'événements,
  trois ponts, le rendu LCD, quatre services non testés, les migrations de
  schéma, les entrées-sorties chiffrées, les classes d'erreur, l'utilitaire
  WebView, la classe de base des composants, le crochet de section, et le
  générateur de vignettes vidéo comme son rattrapage
- **Les permissions du catalogue** sont maintenant auditées contre le manifeste
  Android par un test
- **Couverture de traduction** — 62 aria-label et 354 occurrences de texte
  visible qui portaient du français en dur passent désormais par les
  dictionnaires, passés de 383 à 591 clés. 86 de ces valeurs avaient déjà
  une clé définie et non employée : elles sont branchées plutôt que
  dupliquées. Un test collecte chaque appel statique à `t()` dans le code et
  échoue si une clé manque d'un côté, ce qu'aucun rendu de gabarit n'aurait
  attrapé. Le catalogue de fonctionnalités et le diagnostic Stream Deck
  gardent leurs propres chaînes : le premier a son sélecteur FR/EN, le second
  est une sortie de journal
- **Changelog intégré** — lit le `CHANGELOG.md` embarqué au lieu de porter sa
  propre copie du texte et une constante de version en dur. La version
  affichée est le premier titre daté du fichier, dans la langue du lecteur ;
  une publication n'exige donc plus de l'incrémenter à la main

### Corrigé
- **Fiabilité du Stream Deck** — des touches qui fonctionnaient une fois puis
  s'arrêtaient ; lecture déplacée vers `UsbRequest` pour passer outre le sondage
  HID du noyau, en survivant à un délai dépassé grâce à un sondage en dernier
  recours ; rapports de touches correctement analysés pour XL, MK.2 et v2 ;
  événements émis seulement au changement ; tampon de lecture ajusté à la taille
  de paquet du point de terminaison ; chaque deck réinitialisé avant le
  démontage USB, au balayage depuis les récents et à l'arrêt du flux ; decks
  atténués plutôt que réinitialisés en veille, gardant le bus vivant ; file
  d'écriture vidée à l'arrêt du flux ; pressions sur Note limitées en cadence
  pour esquiver un plantage de la WebView ; plus de peinture quand
  l'application est masquée
- **Curseur de note** — le curseur se place dans le titre de la note à
  l'autofocus, et continue d'essayer en montrant qu'il attend
- **Persistance de transcription** — une transcription est enregistrée quoi que
  fasse l'interface
- **Contraste des notes** — icônes d'entrée inversées sur les thèmes clairs, et
  libellés de boutons lisibles sur les fonds saturés
- **Les entrées Photo et Image** restent distinctes
- **`usesCleartextTraffic`** gagne la fusion du manifeste Android
- **Dépréciations Gradle** d'affectation par espace réduites au silence
- **Un lien symbolique périmé** sous `repos/` ne casse plus la compilation
- **Le `versionCode` Android** n'avait jamais bougé de 1 depuis le premier
  commit. Android refuse d'installer un APK dont le code n'est pas supérieur
  à l'installé : aucune publication n'était donc installable par-dessus la
  précédente. Il suit désormais l'entier CalVer qu'emploient déjà les
  migrations

### Retiré
- **`debug.keystore`** retiré du dépôt
- **Le mode lecteur USBDEVFS natif** — abandonné après que le chemin
  `UsbRequest` s'est révélé suffisant
- **`build_id.json` et `feature_touched.json`** quittent le contrôle de
  version. Les deux sont des sorties de compilation ; le second dérive des
  dates de modification du système de fichiers, si bien qu'un rebase
  estampillait toutes les fonctionnalités de la même date fausse

### Sécurité
- **Quatre constats d'audit critiques** clos, puis ceux de gravité moyenne et
  faible
- **Chiffrement des identifiants** et épinglage de certificat
- **CSP**, éléments PWA embarqués, réduction R8 et une fourche de JSch

## [2026.04.14.01] - 2026-04-14

Résumé du développement depuis la publication `2026.04.13.01` (13 avril 2026).
Intègre la branche `code_integration`.

### Ajouté
- **Navigateur de code** (`/options/code`) — navigateur de code source
  multi-mode, avec trois modes de connexion :
  - **Bundle** — lit les sources de l'application embarquées à la compilation
    (`src/public/repo/`), aucune connexion SSH requise
  - **SSH Chemin** — se connecte à un serveur SSH enregistré ; affiche les
    espaces de travail disponibles dans un sélecteur, puis parcourt le système
    de fichiers distant
  - **SSH URL** — lit les dépôts du manifeste ERPLibre embarqués à la
    compilation (`src/public/repos/{slug}/`) ; les puces de projet montrent le
    nom et la révision
- **Coloration syntaxique** — tokeniseur sans dépendance pour Python,
  TypeScript, JSON, SCSS et Shell ; toutes les couleurs par variables CSS
  (valeurs par défaut de style Monokai)
- **Aperçu Markdown** — bascule entre source brute et HTML rendu pour les
  fichiers `.md`
- **Visionneuse d'images** — affichage `<img>` intégré pour `.png`, `.jpg`,
  `.svg`, `.webp` et d'autres formats ; URL de données en mode SSH, URL de
  bundle en mode hors ligne
- **Éditeur intégré** — édition d'une ligne via `writeLine()` (mode SSH
  seulement) ; la ligne surlignée se rafraîchit après enregistrement sans
  recharger tout le fichier
- **Empaqueteur de sources Vite** — `bundleSourcePlugin` dans `vite.config.ts`
  copie les sources de l'application vers `src/public/repo/` et les dépôts du
  manifeste vers `src/public/repos/{slug}/` à la compilation ; génère un
  `index.json` par bundle et un `manifest.json` listant les dépôts disponibles

### Modifié
- **Empaqueteur Vite — exclusion des artéfacts** : les bundles des dépôts du
  manifeste passent désormais outre `android/`, `ios/`, `build/`, `.gradle/`,
  `__pycache__/`, `venv/` et d'autres répertoires d'artéfacts, les extensions
  binaires (`.so`, `.class`, `.jar`, `.aar`, `.dex`, `.pyc`, etc.) et les
  fichiers de plus de 1 Mo — ce qui évite les échecs d'empaquetage de l'APK
  causés par l'inclusion de 39 Mo d'artéfacts Gradle compilés
- **Diagnostics de compilation** (`BUNDLE_DEBUG=1`) : traçage détaillé par
  fichier des décisions de copie ou d'omission ; durée réelle et nombre de
  fichiers omis par projet sur chaque ligne de résumé ; avertissements
  `[bundle-warn]` sur les liens symboliques brisés ou les erreurs de permission,
  sans interrompre la compilation

## [2026.04.13.01] - 2026-04-13

Résumé du développement depuis la publication `2026.03.18.01` (20 mars 2026).
Intègre les branches `feature/local_gpt` et `feature/deploy_ssh_erplibre`
fusionnées dans `main`, ainsi que des améliorations de la branche `gpt_whisper`.

### Ajouté
- **Transcription Whisper** : transcription audio et vidéo locale, sur
  l'appareil (Android), via whisper.cpp / GGML — aucun serveur externe, aucun
  abonnement requis
- **Modèles Whisper** : 6 variantes disponibles — tiny, base, small, medium,
  large-v3-turbo et distil-large-v3 (anglais seulement) — avec taille, vitesse
  et progression affichées sur chaque carte de modèle
- **OCR** : détection de texte ML Kit sur les entrées photo (ML Kit Text
  Recognition)
- **Scan réseau** : découverte SSH sur le réseau local en /24 via
  NetworkScanPlugin (50 fils parallèles, bannière SSH confirmée)
- **Déploiement SSH** : parcours de déploiement d'ERPLibre depuis l'application
  — connexion SSH (JSch), `git clone`, `make install` — avec progression
  visuelle par étape (gris → vert) et journal en temps réel
- **Suivi des processus** : journal SQLite des transcriptions et téléchargements
  d'arrière-plan, persisté entre les redémarrages ; modal de détail avec journal
  de débogage Java-level et bouton de navigation vers la note associée
- **Moniteur de ressources** : graphiques temps réel de CPU, RAM et batterie via
  DeviceStatsPlugin (`/proc/stat` + `MemoryInfo` + `BatteryManager` en Java
  natif)
- **Tags hiérarchiques** : système de tags parent/enfant avec sélecteur de
  couleur, noms résolus dans les puces de la liste de notes, noms au-dessus du
  titre dans l'éditeur, et une vue « par tag » dédiée depuis l'accueil
- **Priorité de note** : matrice d'Eisenhower (urgent/important) avec icônes et
  filtrage dans la liste de notes
- **Tableau de bord d'accueil** : disposition en tableau de bord remplaçant les
  simples boutons

### Modifié
- **Téléchargement WakeLock** : `PowerManager.PARTIAL_WAKE_LOCK` garde le
  processeur et le réseau actifs écran éteint ; reprise par `Range: bytes=N-` sur
  le fichier `.partial`
- **Téléchargement multi-fils (×4)** : les téléchargements frais (taille connue)
  emploient 4 connexions HTTP Range parallèles écrivant dans un `FileChannel`
  préalloué — théoriquement jusqu'à 4 fois plus rapide
- **Service au premier plan** : mode alternatif avec une notification Android
  persistante et un bouton Annuler ; ré-attachement automatique à la Promise JS
  après recréation de l'Activity
- **Téléchargements parallèles** : plusieurs modèles Whisper téléchargeables
  simultanément ; si le service au premier plan est occupé, les modèles
  supplémentaires retombent automatiquement en mode wakelock
- **Thèmes** : sélecteur clair/sombre avec 4 palettes (dark, light, nord,
  solarized) ; toutes les couleurs des composants migrées vers des variables CSS
  (`vars.scss`)
- **Sélecteur de cadence** (moniteur de ressources) : boutons surdimensionnés
  remplacés par une liste de boutons radio avec des gestionnaires d'événements
  OWL nommés
- **Émoji d'Options** : icônes émoji sur tous les éléments du menu Options
- **Temps de démarrage** : affiché sur l'écran d'accueil
- **Erreurs Java** : tous les messages d'erreur de WhisperPlugin et de
  WhisperDownloadService traduits en français

### Corrigé
- Retrait du repli `fetch()` sur Android natif (causait un dépassement mémoire
  pour les modèles de plus de 200 Mo, par base64 dans la WebView)
- Fil de téléchargement du service au premier plan dupliqué à la recréation de
  l'Activity Android
- Boutons de sélection du mode de téléchargement sans effet (gestionnaire lambda
  OWL)
- Sélecteur de couleur des tags, affichage et couleurs des puces
- Visibilité des icônes et couleurs d'accentuation en thème clair
- Bouton de navigation vers le moniteur de ressources (lambda OWL)
- Visibilité des boutons noirs en thème clair

### Accessibilité
- 5 sprints d'accessibilité couvrant : l'attribut `lang` sur `<html>`, le lien
  d'évitement vers le contenu, les rôles et repères ARIA sur tous les composants
  majeurs, la prise en charge de `prefers-reduced-motion`, les régions vives,
  les rôles de dialogue, l'ARIA sur le gestionnaire de tags, les entrées de note
  (audio, photo, vidéo, géo, texte, glissement, suppression) et l'écran de
  synchronisation

## [2026.03.18.01] - 2026-03-20

### Ajouté
- Moteur de base de données SQLite avec chiffrement AES-256 (remplace
  SecureStorage)
- Protection biométrique de la clé de chiffrement de la base (sur activation)
- Système de migrations versionnées — les migrations ne s'exécutent qu'une fois
  au démarrage
- Fenêtre de notification à l'utilisateur quand une migration est effectuée
- Écran de démarrage avec progression pas à pas de l'initialisation
- Sous-pages d'Options avec navigation par fil d'Ariane
- Diagnostic de la taille de la base SQLite, avec détail par fichier
- Vidéo : lecture en surcouche HTML5 (remplace CapacitorVideoPlayer)
- Vidéo : vignette depuis la première image, mise en cache à côté du fichier
- Vidéo : migration pour rattraper les vignettes des entrées existantes
- Vidéo : ouverture automatique de la caméra à l'ajout d'une entrée
- Photo : prise en charge de la capture avec visionneuse plein écran
- Photo : ouverture automatique de la caméra à l'ajout d'une entrée
- Géolocalisation : le bouton « Ouvrir la carte » lance l'application de carte
  native

### Modifié
- Les données sont maintenant stockées en SQLite plutôt que dans SecureStorage
- La taille de la base lit les tailles réelles des fichiers par
  `Filesystem.stat()` plutôt que par PRAGMA

### Corrigé
- Écouteurs d'événements périmés à la destruction du composant de note, causant
  des entrées fantômes
- Caméra vidéo s'ouvrant automatiquement sur toutes les vues de note au lieu des
  seules nouvelles entrées
- Situation de compétition à l'ouverture de la caméra photo avant que le
  composant soit monté

## [2025.12.28.01] - 2025-12-28

### Ajouté
- Gestion des applications : ajouter, modifier et supprimer des instances Odoo
- Notes à types d'entrée multiples : texte, enregistrement audio, enregistrement
  vidéo, photo et géolocalisation
- Tags et libellés pour les notes
- Données stockées dans SecureStorage
