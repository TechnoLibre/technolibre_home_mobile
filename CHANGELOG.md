# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [2026.03] - 2026-03-20

### Added
- SQLite database backend for storing applications and notes
- Versioned migration system — migrations only run once on startup
- User notification popup when a migration is performed

### Changed
- Data is now stored in SQLite instead of SecureStorage
