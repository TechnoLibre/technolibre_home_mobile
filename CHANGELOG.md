# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
