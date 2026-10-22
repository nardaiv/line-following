#pragma once

#include <stddef.h>
#include <stdint.h>

constexpr uint16_t DEVICE_SETTINGS_SCHEMA_VERSION = 1;
constexpr uint8_t WIFI_SSID_MAX_BYTES = 32;
constexpr uint8_t WIFI_PASSWORD_MAX_BYTES = 63;
constexpr uint8_t MQTT_HOST_MAX_BYTES = 253;
constexpr uint8_t MQTT_USER_MAX_BYTES = 64;
constexpr uint8_t MQTT_PASSWORD_MAX_BYTES = 64;
constexpr uint8_t ROBOT_ID_MAX_BYTES = 32;

struct DeviceSettings {
  char wifiSsid[WIFI_SSID_MAX_BYTES + 1];
  char wifiPassword[WIFI_PASSWORD_MAX_BYTES + 1];
  char mqttHost[MQTT_HOST_MAX_BYTES + 1];
  uint16_t mqttPort;
  char mqttUser[MQTT_USER_MAX_BYTES + 1];
  char mqttPassword[MQTT_PASSWORD_MAX_BYTES + 1];
  char robotId[ROBOT_ID_MAX_BYTES + 1];
};

void clearDeviceSettingsValue(DeviceSettings& settings);
bool isDeviceSettingsValid(const DeviceSettings& settings);
