# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.4] - 2026-06-22

### Fixed

- **Purging entity registry options on config removal no longer fails.** The
  `async_update_entity_options` call was missing the required `domain` parameter
  added in Home Assistant 2025.x, causing a traceback during cleanup.

- **The card now removes itself when the config entry is deleted.** Previously
  the card would remain visible until a hard browser refresh. Now the entry
  resolution always runs before card injection (not just when the cache is
  empty), and a failed state refresh removes the card from the DOM.

- **The card reappears after re-adding the integration** without needing a
  hard refresh. The missing-entry flag is now cleared on successful entry
  resolution, and card injection always retries rather than short-circuiting
  after the first failure.

- **The entity count badge refreshes after changing exposures on the Expose
  tab** and navigating back to the Assistants tab. Previously the badge
  stayed stale until a hard refresh. When the card already exists, its full
  state (toggles, PIN, entity count) is now refreshed rather than skipped.

- **Import failure toasts now include the server reason** (prefixed with the
  translated "Failed to import configuration" text), and the server no longer
  redundantly wraps the reason with its own prefix.

- **Importing a YAML file triggers a Google `requestSync`**, so newly
  exposed (or hidden) devices appear in Google Assistant immediately
  instead of waiting for the next periodic sync.

- **Changing the security devices PIN now triggers a Google `requestSync`**
  so the new PIN takes effect immediately for secure device challenges,
  rather than waiting for the next periodic sync.

## [0.2.3] - 2026-06-22

### Fixed

- **The card no longer appears when the integration has no config entry.**
  Removing the integration from Settings → Devices & Services now correctly
  suppresses the card on the Voice assistants page, instead of injecting a
  broken card with hidden settings rows.

## [0.2.2] - 2026-06-22

### Fixed

- **Import failure toasts now show the server's reason** instead of a generic
  "Import failed" message, and error toasts no longer vanish immediately (HA
  treats duration 0 as "hide", so errors now use the max visible duration).

- **Exported YAML private keys render cleanly.** Multi-line strings (PEM keys)
  now use a literal block scalar (`|`) instead of an indented single-quoted
  format, producing compact, readable YAML exports.

- **The card now refreshes after importing settings.** Entity count, toggles,
  and the PIN input are updated immediately after a YAML import, rather than
  staying stale until the next page navigation.

## [0.2.1] - 2026-06-22

### Changed

- **Importing a YAML config now adopts its credentials.** When an imported file
  carries a complete service account, it is verified against Google and, if
  accepted, becomes the entry's credentials (project ID and service account),
  then the entry reloads. A definitive rejection fails the whole import before
  anything is changed; transport failures are non-blocking, matching the config
  flow. Imports whose credentials match the existing ones skip verification and
  reload. Previously the service account in an imported file was ignored.

## [0.2.0] - 2026-06-22

### Added

- **Migrate an existing `google_assistant:` YAML configuration during setup.**
  When a `google_assistant:` section is detected in `configuration.yaml`, the
  config flow now opens with a migrate page offering to import it. Opting in
  copies your project ID, service account, exposed entities, state reporting,
  security PIN, and entity aliases into the UI, prefilling (and skipping where
  possible) the setup steps. Exposure and aliases are applied once Home Assistant
  has fully started, so entities from late-loading integrations are included, and
  the migration runs only once. The YAML section can be removed afterward.

- **Export and import settings as a standalone YAML file.** The Google Assistant
  card in Settings → Voice assistants now has **Export** and **Import** buttons.
  Export produces a valid manual `google_assistant:` config (validated against
  core Google Assistant's own schema). Import asks for confirmation, then
  overwrites exposure and flags while only adding aliases, it never removes
  existing ones.

- **Service account verification during setup.** The pasted service account is
  now checked against Google's HomeGraph token endpoint before the config entry
  is created, so bad keys are caught immediately. Transient/network failures do
  not block setup.

### Changed

- The config flow is now split into separate pages (intro/migrate → project ID →
  service account) instead of a single combined step.

- Import/export and related card messages now use Home Assistant's native toast
  notifications instead of a persistent notification.

## [0.1.13] - 2026-06-21

### Changed

- Internal cleanup with no change to behavior. Project-ID validation now uses a
  single regex instead of a hand-rolled character loop, the `_get_version()`
  wrapper was inlined to a module global, the two identical websocket-error
  predicates were factored into one helper, and the navigation-scan magic
  numbers were given names. Removed roughly 18 narration/duplicate debug and
  info log lines from the config flow and websocket handlers that only restated
  control flow or an error already raised to the user.

## [0.1.12] - 2026-06-14

### Fixed

- Our brand icon could intermittently fail to appear (blank icon cells in the
  expose tab and entity settings) after a page refresh. The custom-element
  patches that draw the icon were installed from the page's `DOMContentLoaded`
  step, which races against Home Assistant's lazily-loaded voice-assistants
  panel, when the panel defined and rendered the icon elements first, our
  override landed too late and the cell stayed blank. The prototype/interceptor
  patches now install synchronously at module load, before that panel chunk can
  define its elements, so our icon renders on the first paint. This also makes
  the same race-free installation cover the settings card, the per-entity
  "Ask for PIN" checkbox, and the expose toggles.

- Our icon could still be missing entirely from the **Expose** tab's assistant
  column on a hard refresh. That column is built from the page's
  `_availableAssistants` list, which Home Assistant memoizes along with the
  column itself, so if our patch that adds our assistant to the list landed
  after the table's first render, the column stayed cached without our icon and
  never rebuilt. The expose-page patch now installs synchronously via the same
  custom-element interceptor as the icon patches, before the table's first
  render, so our column is present from the start.

## [0.1.11] - 2026-06-13

### Changed

- The frontend's startup log is now a styled two-tone console badge
  (`hass-ga-manual-ui vX.Y.Z`), matching other HA frontend plugins. The
  developer-facing console log prefix changed from `[GA Manual]` to
  `[hass-ga-manual-ui]`. The user-facing assistant name ("Google Assistant
  (Manual)") is unchanged.

### Fixed

- Renaming an exposed entity's voice aliases now triggers an immediate Google
  `requestSync` instead of waiting for the next unrelated sync. Home Assistant's
  shared "describing attributes" set, which Nabu Casa Cloud also uses to decide
  when to resync, omits `aliases` even though they become Google nicknames, so
  alias-only edits never pushed on their own. We now include `aliases` in the
  resync trigger.

- The entity dialog's "Expose" tab toggles could still show a stale state after
  toggling exposure, even with the 0.1.10 settle-write fix. Home Assistant's
  expose dialog hands the toggle component a one-time `exposed` snapshot and
  never refreshes it when the entity changes, so the corrected state never
  reached the toggles until the dialog was reopened. We now recompute exposure
  from the updated entity registry entry and feed it back into the dialog, so
  the toggles refresh in place.

## [0.1.10] - 2026-06-13

### Fixed

- After toggling the entity dialog's master "Expose" switch (or a per-assistant
  switch), the toggles could show a stale state, the rows not collapsing when
  unexposed, or only some assistants showing on after re-exposing, until the
  dialog was reopened. Home Assistant fires the expose write without awaiting it
  and then immediately refetches the entity, so the refresh could read a
  half-written entry. We now settle the write first, snapshotting the switch
  state synchronously so Home Assistant's handler still receives valid values
  (otherwise it sent a malformed `expose_entity` call).

- The CDN Google Assistant brand icon would sometimes appear instead of our
  self-hosted icon in the expose tab and entity settings. Lit only re-calls
  `render()` when reactive properties change, so icon elements that rendered
  before our prototype patch was installed stayed stale. After patching we now
  walk the DOM and force `requestUpdate()` on any matching stale icon elements.

## [0.1.9] - 2026-06-12

### Added

- The Google Assistant (Manual) row in the entity dialog now shows the same
  "not supported" notice and greyed-out toggle as the cloud Google Assistant row
  when an entity's domain can't be handled by Google Assistant.

### Fixed

- The entity dialog's expose toggles ignored Google Assistant (Manual) when
  deciding what to show: the master "Expose" toggle and the per-assistant rows
  reflected only the cloud/Assist assistants, so an entity exposed only to us
  showed the master off with no rows, and toggling the master off didn't hide
  the rows when our toggle was the one left on. This was a splice bug in Home
  Assistant's dialog dropping our injected entry from the list that drives the
  master toggle and row visibility; the dialog now counts our assistant like any
  other (which also subsumes the earlier master-toggle unexpose fix).

## [0.1.8] - 2026-06-12

### Fixed

- The Google Assistant icon could intermittently disappear or show the generic
  Google icon on the expose tab, and the assistant row/toggle could fail to
  appear when opening an entity. The icon is now rendered inside Home
  Assistant's own render lifecycle (instead of being painted into the shadow
  DOM after the fact), so it survives the element reuse that Home Assistant
  does when scrolling the expose table or reordering the entity dialog rows.
  Our self-hosted icon is always used for this integration, never the brands
  CDN.
- The entity dialog's master "Expose" toggle did not unexpose the entity from
  Google Assistant (Manual): turning it off left the entity exposed to us (so it
  stayed in the exposed-entities list), even though toggling our own row off
  worked. This was Home Assistant's `_toggleAll` dropping the last assistant in
  its list, which is our injected entry, so the master toggle now explicitly
  includes our assistant.

## [0.1.7] - 2026-06-12

### Fixed

- The Google Assistant icon (card, expose table, entity dialog) no longer
  depends on Home Assistant's brands CDN, which isn't a registered brand for
  this manual integration and could throw a console error. The icon is now
  bundled with the integration and served locally.

### Changed

- Refreshed the integration icon with a small code/manual-setup badge.

## [0.1.6] - 2026-06-12

### Fixed

- The settings card, expose tab, and entity dialog did not appear when reaching
  Voice assistants by navigating within Home Assistant (only on a full page load
  to the page directly). The companion now re-runs its injection on client-side
  navigation, so it works regardless of how you get there.
- Card text could fall back to English instead of the user's language after the
  0.1.5 locale change.

### Changed

- The "a new version is available, refresh" prompt is now a persistent
  notification (matching the install notification) and appears on any page, not
  only the Voice assistants page. It points at a hard refresh, which is what
  actually clears Home Assistant's cached frontend.

## [0.1.5] - 2026-06-12

### Changed

- Internal: the integration's own UI strings (the setup notices and the
  voice-assistant card text) now load from a dedicated `locale/` store served by
  the integration, rather than as custom keys inside Home Assistant's translation
  files. This lets the integration pass Home Assistant's `hassfest` validation,
  a requirement for the HACS default store, while keeping full translations for
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
  is running a stale cached bundle, instead of leaving you to guess. Translated
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
  `_safeAssistantsFold`, both superseded by the expose-page fix.

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
