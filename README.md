<div align="center">
  <img src="https://raw.githubusercontent.com/edmogeor/hass-ga-manual-ui/master/icon.png" width="140" alt="Assistant UI for Google Assistant Manual Setup"/>
  <h1>Assistant UI for Google Assistant (Manual Setup)</h1>
  <p>
    <a href="https://github.com/edmogeor/hass-ga-manual-ui/actions/workflows/ci.yml">
      <img src="https://github.com/edmogeor/hass-ga-manual-ui/actions/workflows/ci.yml/badge.svg?branch=master" alt="CI"/>
    </a>
    <a href="https://github.com/edmogeor/hass-ga-manual-ui/actions/workflows/validate.yml">
      <img src="https://github.com/edmogeor/hass-ga-manual-ui/actions/workflows/validate.yml/badge.svg?branch=master" alt="Validate"/>
    </a>
    <a href="https://github.com/edmogeor/hass-ga-manual-ui/releases/latest">
      <img src="https://img.shields.io/github/v/release/edmogeor/hass-ga-manual-ui" alt="Latest release"/>
    </a>
    <a href="https://hacs.xyz">
      <img src="https://img.shields.io/badge/HACS-Custom-orange.svg" alt="HACS Custom"/>
    </a>
  </p>
</div>

A Home Assistant integration that brings the Google Assistant voice assistant to your Home Assistant without a Nabu Casa Cloud subscription. Once set up, the experience is **identical to the Nabu Casa Cloud Google Assistant** — same voice assistant card, same entity exposure UI, same per-entity 2FA toggle.

## How it works

This integration is a **UI wrapper around the built-in `google_assistant` integration** — it doesn't replace it. It configures and manages the core integration so that it appears in the voice assistant UI alongside Nabu Casa Cloud.

It's recommended to have the manual `google_assistant` setup working via YAML first before switching to this integration. That way you know your Google Cloud project and service account are correctly configured.

## Features

- **Full UI configuration** — project ID, service account, report state, PIN, all configurable in the UI
- **Google Assistant card** — appears alongside cloud assistants in the voice assistants panel
- **Entity exposure** — expose devices to Google just like with Nabu Casa Cloud
- **Per-entity 2FA control** — PIN prompt toggle for security devices (locks, garage doors)
- **Auto-resync** — automatically pushes changes to Google when entities or areas change
- **Report state** — syncs entity states back to Google for faster commands
- **YAML import** — existing `google_assistant:` YAML config is imported and can be safely removed

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
4. Set the category to **Integration** and click **Add**
5. Click **+ Explore & Download Repositories** (bottom right)
6. Search for "Google Assistant (Manual)" and install it
7. Restart Home Assistant

### Manual

Copy the `custom_components/hass_ga_manual_ui/` directory into your Home Assistant's `custom_components/` folder and restart.

## Configuration

After installation, add the integration:

1. Go to **Settings → Devices & Services → Add Integration**
2. Search for "Google Assistant (Manual)"
3. Enter your **Google Cloud project ID**
4. Paste your **service account JSON key**

The Google Assistant card will appear in **Settings → Voice assistants** alongside the cloud assistants.

## License

MIT
