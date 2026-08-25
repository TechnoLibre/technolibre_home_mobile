
# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
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

### Changed
- **Gettext catalogues leave the bundle** — 41 763 files and 857 MB, 33.5 %
  of the files and 58.7 % of the payload, against 603 MB for everything
  else. Weblate and the OCA bots maintain them and nobody reads a catalogue
  on a phone. Archives fall from 431 to 328 MB, and the build reports what
  it dropped. `BUNDLE_KEEP_PO=1` brings them back, `BUNDLE_SKIP_IMG=1` drops
  the raster images too and takes archives to 115 MB. A side effect worth
  having: 41 763 fewer files takes the build from 43 s to 22 s

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
