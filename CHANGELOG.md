# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
