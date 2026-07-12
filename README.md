<div align="center">
  <img src="https://raw.githubusercontent.com/edmogeor/hass-ga-manual-ui/master/custom_components/hass_ga_manual_ui/brand/icon.png" width="140" alt="Assistant UI for Google Assistant Manual Setup"/>
  <h1>Assistant UI for Google Assistant (Manual Setup)</h1>
  <p>
    <a href="https://github.com/edmogeor/hass-ga-manual-ui/actions/workflows/ci.yml">
      <img src="https://github.com/edmogeor/hass-ga-manual-ui/actions/workflows/ci.yml/badge.svg?branch=master" alt="CI"/>
    </a>
    <a href="https://github.com/edmogeor/hass-ga-manual-ui/releases/latest">
      <img src="https://img.shields.io/github/v/release/edmogeor/hass-ga-manual-ui" alt="Latest release"/>
    </a>
    <a href="https://hacs.xyz">
      <img src="https://img.shields.io/badge/HACS-Custom-blue.svg" alt="HACS Custom"/>
    </a>
  </p>
</div>

A Home Assistant integration that brings the Google Assistant voice assistant to your Home Assistant without a Nabu Casa Cloud subscription. Once set up, the experience is **identical to the Nabu Casa Cloud Google Assistant**, same voice assistant card, same entity exposure UI, same per-entity 2FA toggle.

## Screenshots

<div align="center">

**Google Assistant card in Settings → Voice assistants, alongside the cloud assistants**

<img src="https://raw.githubusercontent.com/edmogeor/hass-ga-manual-ui/master/screenshots/assistants_page.png" width="760" alt="Google Assistant (Manual) management card with expose, state reporting, and security PIN settings"/>

**Expose entities to Google Assistant**

<img src="https://raw.githubusercontent.com/edmogeor/hass-ga-manual-ui/master/screenshots/entities_tab.png" width="760" alt="Expose tab listing entities exposed to Google Assistant with areas and aliases"/>

**Per-entity exposure and aliases**

<img src="https://raw.githubusercontent.com/edmogeor/hass-ga-manual-ui/master/screenshots/entity_modal.png" width="760" alt="Per-entity Voice assistants dialog with the Google Assistant (Manual) toggle and aliases"/>

</div>

## How it works

This integration is a **UI wrapper around the built-in `google_assistant` integration**, it doesn't replace it. It configures and manages the core integration so that it appears in the voice assistant UI alongside Nabu Casa Cloud.

It's recommended to have the manual `google_assistant` setup working via YAML first before switching to this integration. That way you know your Google Cloud project and service account are correctly configured.

## Features

- **Full UI configuration**, project ID, service account, report state, PIN, all configurable in the UI
- **Google Assistant card**, appears alongside cloud assistants in the voice assistants panel
- **Entity exposure**, expose devices to Google just like with Nabu Casa Cloud
- **Per-entity 2FA control**, PIN prompt toggle for security devices (locks, garage doors)
- **Auto-resync**, automatically pushes changes to Google when entities or areas change
- **Report state**, syncs entity states back to Google for faster commands
- **YAML migration**, import your existing `google_assistant:` configuration during setup
- **Export / import**, back up your settings to a standalone YAML file or restore them later

## Requirements

- Home Assistant 2025.6.0 or later
- A Google Cloud Platform project with the Google Assistant API enabled
- A service account with correct permissions
- Follow the [manual setup guide](https://www.home-assistant.io/integrations/google_assistant/#manual-setup) (steps 1–13 only)

## Installation

### HACS (recommended)

1. Open HACS in Home Assistant
2. Click **⋮ (menu)** → **Custom repositories**
3. Paste the repository URL: `https://github.com/edmogeor/hass-ga-manual-ui`
4. Search for "Google Assistant (Manual)" and install it
5. Restart Home Assistant
6. **Hard refresh your browser** (Ctrl+Shift+R / Cmd+Shift+R) to ensure the frontend loads the new UI components

### Manual

Copy the `custom_components/hass_ga_manual_ui/` directory into your Home Assistant's `custom_components/` folder and restart.

## Configuration

After installation, add the integration:

1. Go to **Settings → Devices & Services → Add Integration**
2. Search for "Google Assistant (Manual)"
3. Read the intro page. If you already have a `google_assistant:` section in your
   `configuration.yaml`, you'll instead be offered to **migrate** it (see below)
4. Enter your **Google Cloud project ID**
5. Paste your **service account JSON key**, it's verified against Google before the entry is created

The Google Assistant card will appear in **Settings → Voice assistants** alongside the cloud assistants.

## Migrating from YAML

If you already run the manual `google_assistant:` integration via
`configuration.yaml`, this integration takes over and **overrides that YAML
section at runtime** so the two never conflict.

- **During setup**, when a `google_assistant:` block is detected, the first page
  offers to migrate it. Leave the checkbox ticked to copy your existing
  **project ID**, **service account**, **exposed entities**, **state reporting**,
  **security PIN**, and **aliases** into the UI, prefilling the setup steps. Untick
  it to start fresh.
- **After migrating**, you can safely remove the `google_assistant:` section from
  your `configuration.yaml`, the integration no longer reads it.
- **Export / import**, from the Google Assistant card in **Settings → Voice
  assistants** you can export your current settings to a standalone
  `google_assistant:` YAML file (a valid manual config you could paste back into
  `configuration.yaml`), or import one to restore them. Importing **overwrites**
  exposure and flags but only **adds** aliases, it never removes existing ones.

## Uninstalling

Removing the integration also **deletes all Google Assistant configuration** (project ID, service account, PIN, exposure settings, entity aliases, and per-entity 2FA overrides). If you reinstall later, you'll need to reconfigure everything from scratch.

> [!TIP]
> Before uninstalling, back up your settings: from the Google Assistant card in **Settings → Voice assistants**, use **Export YAML** to save a standalone config file. After reinstalling, you can restore it with **Import YAML**.

## Donations

Feel free to donate if you'd like to support the development of this integration.

<a href="https://www.buymeacoffee.com/edmogeor" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me a Coffee" style="height: 60px !important;width: 217px !important;" ></a>

## License

MIT
