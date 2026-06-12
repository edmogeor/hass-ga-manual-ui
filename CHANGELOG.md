# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.4] - 2026-06-12

### Fixed

- The "Ask for PIN" checkbox could stay hidden for a security device if its
  initial lookup failed while the integration was momentarily disabled. Such
  transient failures are now retried instead of being cached as "no checkbox".

### Added

- Browser-refresh prompts so the new UI reliably appears after installing or
  updating. The companion script is injected into Home Assistant's app shell,
  which the browser can serve from cache, so a one-time hard refresh is needed
  to pick it up. A fresh install now posts a notification with that guidance,
  and after an update the card shows a reload prompt when it detects the browser
  is running a stale cached bundle — instead of leaving you to guess. Translated
  for all 63 supported languages.

### Changed

- Internal cleanup: route WebSocket error logging through the existing
  `_wsErrorMessage` helper, hoist a repeated cast, and use `setdefault` for the
  core Google Assistant config seed. No behavior change.

## [0.1.3] - 2026-06-11

### Fixed

- Exposed entities showed zero on the Expose tab when the voiceAssistants map
  hadn't been captured yet (e.g. on first page visit before any dialog opened).
  The page now captures the map proactively and folds our assistant out of
  dialog-internal contexts where the uncaptured map would cause errors.

### Changed

- `_toggleIntegration`, `refreshCardState`, and `_restorePinValue` now delegate
  entry-gone retry to `_withEntryRetry`, removing duplicated retry logic.
- Removed dead `_ensureVoiceAssistantEntry` and inlined single-use
  `_safeAssistantsFold` — both superseded by the expose-page fix.

### Added

- Hard-refresh note in the README install steps.
- Uninstalling section in the README documenting that configuration data is
  removed when the integration is deleted.

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
