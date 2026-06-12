# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.6] - 2026-06-12

### Fixed

- The settings card, expose tab, and entity dialog did not appear when reaching
  Voice assistants by navigating within Home Assistant (only on a full page load
  to the page directly). The companion now re-runs its injection on client-side
  navigation, so it works regardless of how you get there.
- Card text could fall back to English instead of the user's language after the
  0.1.5 locale change.

### Changed

- The "a new version is available — refresh" prompt is now a persistent
  notification (matching the install notification) and appears on any page, not
  only the Voice assistants page. It points at a hard refresh, which is what
  actually clears Home Assistant's cached frontend.

## [0.1.5] - 2026-06-12

### Changed

- Internal: the integration's own UI strings (the setup notices and the
  voice-assistant card text) now load from a dedicated `locale/` store served by
  the integration, rather than as custom keys inside Home Assistant's translation
  files. This lets the integration pass Home Assistant's `hassfest` validation —
  a requirement for the HACS default store — while keeping full translations for
  all 63 supported languages. No user-facing change.

## [0.1.4] - 2026-06-12

### Fixed

- The "Ask for PIN" checkbox could stay hidden for a security device if its
  initial lookup failed while the integration was momentarily disabled. Such
  transient failures are now retried instead of being cached as "no checkbox".
- A console error from Home Assistant's brand-icon element when our assistant
  was added to the order before its display-name map entry was ready. We now
  wait for the map before advertising ourselves, and fall back to our own icon
  if the lookup is ever missing.

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
