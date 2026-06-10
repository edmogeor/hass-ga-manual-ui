"""Tests for hass_ga_manual_ui/const.py."""

from hass_ga_manual_ui.const import (
    ASSISTANT_ID,
    CONF_CLIENT_EMAIL,
    CONF_PRIVATE_KEY,
    CONF_REPORT_STATE,
    CONF_SECURE_DEVICES_PIN,
    CONF_SERVICE_ACCOUNT,
    CORE_GA_DATA_CONFIG,
    CORE_GA_DOMAIN,
    DOMAIN,
    WS_DISABLE,
    WS_ENABLE,
    WS_GET_CONFIG,
    WS_UPDATE_CONFIG,
)


class TestConstants:
    """Test constant values are correct and consistent."""

    def test_domain(self) -> None:
        assert DOMAIN == "hass_ga_manual_ui"

    def test_assistant_id_matches_domain(self) -> None:
        assert ASSISTANT_ID == DOMAIN

    def test_conf_keys_are_strings(self) -> None:
        conf_keys = [
            CONF_CLIENT_EMAIL,
            CONF_PRIVATE_KEY,
            CONF_REPORT_STATE,
            CONF_SECURE_DEVICES_PIN,
            CONF_SERVICE_ACCOUNT,
        ]
        for key in conf_keys:
            assert isinstance(key, str)

    def test_ws_command_strings(self) -> None:
        assert WS_GET_CONFIG == "hass_ga_manual_ui/get_config"
        assert WS_UPDATE_CONFIG == "hass_ga_manual_ui/update_config"
        assert WS_ENABLE == "hass_ga_manual_ui/enable"
        assert WS_DISABLE == "hass_ga_manual_ui/disable"

    def test_all_ws_commands_include_domain(self) -> None:
        for cmd in [WS_GET_CONFIG, WS_UPDATE_CONFIG, WS_ENABLE, WS_DISABLE]:
            assert cmd.startswith(DOMAIN), f"{cmd} should start with {DOMAIN}"

    def test_core_ga_domain(self) -> None:
        assert CORE_GA_DOMAIN == "google_assistant"

    def test_core_ga_data_config(self) -> None:
        assert CORE_GA_DATA_CONFIG == "config"

    def test_domain_not_same_as_core_ga(self) -> None:
        assert DOMAIN != CORE_GA_DOMAIN
