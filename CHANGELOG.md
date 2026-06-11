# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] - 2026-06-11

### Fixed

- Integration failed to load on Python 3.13 (Home Assistant's runtime) because of
  an unparenthesized `except` clause that only parses on Python 3.14+. On update
  this took the whole integration down, making the card and all exposed entities
  appear to vanish.
- Exposed entities did not show on the Voice assistants → Expose tab until an
  entity's settings dialog had been opened elsewhere; the page now populates on
  first visit.

### Changed

- Marked the integration as single-instance: a second config entry can no longer
  be added (the "Add" option is removed), preventing duplicate, conflicting
  Google Assistant bridges.
- Pruning of the internal `google_assistant` config entry is now ownership-based
  and fail-safe: it only ever touches entries this integration created (never a
  `google_assistant` entry you set up yourself) and does nothing when it cannot
  read its own state.

## [0.1.1] - 2026-06-11

### Added

- Translations for all 63 supported languages.

## [0.1.0] - 2026-06-10

Initial release.
