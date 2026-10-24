#include <string.h>

#include "device_settings.h"

namespace {

size_t boundedLength(const char* value, size_t capacity) {
  for (size_t i = 0; i < capacity; ++i) {
    if (value[i] == '\0') return i;
  }
  return capacity;
}

bool hasNoControlBytes(const char* value, size_t length) {
  for (size_t i = 0; i < length; ++i) {
    const uint8_t byte = static_cast<uint8_t>(value[i]);
    if (byte < 0x20 || byte == 0x7f) return false;
  }
  return true;
}

bool isLoopbackHost(const char* host, size_t length) {
  const char localhost[] = "localhost";
  if (length == sizeof(localhost) - 1) {
    bool matches = true;
    for (size_t i = 0; i < length; ++i) {
      char c = host[i];
      if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
      if (c != localhost[i]) matches = false;
    }
    if (matches) return true;
  }
  return length >= 4 && host[0] == '1' && host[1] == '2' &&
         host[2] == '7' && host[3] == '.';
}

bool isMdnsLocalHost(const char* host, size_t length) {
  const char suffix[] = ".local";
  if (length < sizeof(suffix) - 1) return false;
  const size_t offset = length - (sizeof(suffix) - 1);
  for (size_t i = 0; i < sizeof(suffix) - 1; ++i) {
    char c = host[offset + i];
    if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
    if (c != suffix[i]) return false;
  }
  return true;
}

bool validHostname(const char* host, size_t length) {
  if (length == 0 || length > MQTT_HOST_MAX_BYTES || host[0] == '.' ||
      host[length - 1] == '.' || isLoopbackHost(host, length) ||
      isMdnsLocalHost(host, length)) {
    return false;
  }
  size_t labelLength = 0;
  bool previousHyphen = false;
  for (size_t i = 0; i < length; ++i) {
    const char c = host[i];
    if (c == '.') {
      if (labelLength == 0 || previousHyphen) return false;
      labelLength = 0;
      previousHyphen = false;
      continue;
    }
    const bool alphaNumeric = (c >= 'a' && c <= 'z') ||
                              (c >= 'A' && c <= 'Z') ||
                              (c >= '0' && c <= '9');
    if (!alphaNumeric && c != '-') return false;
    if (labelLength == 0 && c == '-') return false;
    previousHyphen = c == '-';
    if (++labelLength > 63) return false;
  }
  return labelLength != 0 && !previousHyphen;
}

bool validRobotId(const char* id, size_t length) {
  if (length == 0 || length > ROBOT_ID_MAX_BYTES) return false;
  for (size_t i = 0; i < length; ++i) {
    const char c = id[i];
    const bool valid = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                       (c >= '0' && c <= '9') || c == '_' || c == '-';
    if (!valid) return false;
  }
  return true;
}

}  // namespace

void clearDeviceSettingsValue(DeviceSettings& settings) {
  memset(&settings, 0, sizeof(settings));
}

bool isDeviceSettingsValid(const DeviceSettings& settings) {
  const size_t ssidLength =
      boundedLength(settings.wifiSsid, sizeof(settings.wifiSsid));
  const size_t wifiPasswordLength =
      boundedLength(settings.wifiPassword, sizeof(settings.wifiPassword));
  const size_t hostLength =
      boundedLength(settings.mqttHost, sizeof(settings.mqttHost));
  const size_t userLength =
      boundedLength(settings.mqttUser, sizeof(settings.mqttUser));
  const size_t mqttPasswordLength =
      boundedLength(settings.mqttPassword, sizeof(settings.mqttPassword));
  const size_t robotIdLength =
      boundedLength(settings.robotId, sizeof(settings.robotId));

  const bool wifiPasswordValid =
      wifiPasswordLength == 0 ||
      (wifiPasswordLength >= 8 &&
       wifiPasswordLength <= WIFI_PASSWORD_MAX_BYTES);
  return ssidLength >= 1 && ssidLength <= WIFI_SSID_MAX_BYTES &&
         wifiPasswordValid && validHostname(settings.mqttHost, hostLength) &&
         settings.mqttPort != 0 && userLength >= 1 &&
         userLength <= MQTT_USER_MAX_BYTES && mqttPasswordLength >= 1 &&
         mqttPasswordLength <= MQTT_PASSWORD_MAX_BYTES &&
         validRobotId(settings.robotId, robotIdLength) &&
         hasNoControlBytes(settings.wifiSsid, ssidLength) &&
         hasNoControlBytes(settings.wifiPassword, wifiPasswordLength) &&
         hasNoControlBytes(settings.mqttUser, userLength) &&
         hasNoControlBytes(settings.mqttPassword, mqttPasswordLength);
}
