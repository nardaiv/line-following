#include "device_storage.h"

#include <Preferences.h>
#include <string.h>

namespace {

const char* const PID_NAMESPACE = "linebot_pid";
const char* const DEVICE_NAMESPACE = "linebot_net";
const uint16_t INVALID_SCHEMA_VERSION = 0;
struct PidRecord {
  uint16_t schemaVersion;
  float kp;
  float ki;
  float kd;
  uint32_t revision;
  char requestId[PID_REQUEST_ID_STORAGE_BYTES];
};

bool hasPidKeys(Preferences& preferences) {
  return preferences.isKey("schema") && preferences.isKey("kp") &&
         preferences.isKey("ki") && preferences.isKey("kd") &&
         preferences.isKey("revision");
}

bool writeString(Preferences& preferences, const char* key,
                 const char* value) {
  const size_t length = strlen(value);
  const size_t written = preferences.putString(key, value);
  return preferences.isKey(key) && (length == 0 || written > 0);
}

bool readString(Preferences& preferences, const char* key, char* value,
                size_t capacity, bool allowEmpty) {
  if (!preferences.isKey(key)) return false;
  const size_t length = preferences.getString(key, value, capacity);
  // Preferences returns the stored string size including its NUL byte. A
  // zero return means read failure/overflow; a valid empty string returns 1.
  return length != 0 && length <= capacity && (allowEmpty || length > 1);
}

bool sameDeviceSettings(const DeviceSettings& left,
                        const DeviceSettings& right) {
  return strcmp(left.wifiSsid, right.wifiSsid) == 0 &&
         strcmp(left.wifiPassword, right.wifiPassword) == 0 &&
         strcmp(left.mqttHost, right.mqttHost) == 0 &&
         left.mqttPort == right.mqttPort &&
         strcmp(left.mqttUser, right.mqttUser) == 0 &&
         strcmp(left.mqttPassword, right.mqttPassword) == 0 &&
         strcmp(left.robotId, right.robotId) == 0;
}

}  // namespace

bool loadPidConfig(PidConfig& config) {
  config = defaultPidConfig();
  Preferences preferences;
  if (!preferences.begin(PID_NAMESPACE, true)) return false;

  bool loaded = false;
  if (preferences.isKey("record")) {
    PidRecord record;
    memset(&record, 0, sizeof(record));
    if (preferences.getBytesLength("record") == sizeof(record) &&
        preferences.getBytes("record", &record, sizeof(record)) ==
            sizeof(record)) {
      PidConfig candidate = defaultPidConfig();
      candidate.schemaVersion = record.schemaVersion;
      candidate.kp = record.kp;
      candidate.ki = record.ki;
      candidate.kd = record.kd;
      candidate.revision = record.revision;
      memcpy(candidate.requestId, record.requestId,
             sizeof(candidate.requestId));
      if (isPidConfigValid(candidate)) {
        config = candidate;
        loaded = true;
      }
    }
  } else if (hasPidKeys(preferences)) {
    const uint16_t storedSchema = preferences.getUShort("schema", 0);
    PidConfig candidate = defaultPidConfig();
    candidate.kp = preferences.getFloat("kp", Config::PID_KP);
    candidate.ki = preferences.getFloat("ki", Config::PID_KI);
    candidate.kd = preferences.getFloat("kd", Config::PID_KD);
    candidate.revision = preferences.getUInt("revision", 0);
    const bool supportedSchema = storedSchema == 1 ||
                                 storedSchema == PID_CONFIG_SCHEMA_VERSION;
    const bool requestRead =
        storedSchema != PID_CONFIG_SCHEMA_VERSION ||
        readString(preferences, "rid", candidate.requestId,
                   sizeof(candidate.requestId), true);
    if (supportedSchema && requestRead && isPidConfigValid(candidate)) {
      config = candidate;
      loaded = true;
    }
  }
  preferences.end();
  return loaded;
}

bool savePidConfig(const PidConfig& config) {
  if (!isPidConfigValid(config)) return false;
  PidRecord record;
  memset(&record, 0, sizeof(record));
  record.schemaVersion = config.schemaVersion;
  record.kp = config.kp;
  record.ki = config.ki;
  record.kd = config.kd;
  record.revision = config.revision;
  memcpy(record.requestId, config.requestId, sizeof(record.requestId));

  Preferences preferences;
  if (!preferences.begin(PID_NAMESPACE, false)) return false;
  const bool saved =
      preferences.putBytes("record", &record, sizeof(record)) == sizeof(record);
  preferences.end();

  if (!saved) return false;
  PidConfig readback;
  return loadPidConfig(readback) &&
         readback.schemaVersion == config.schemaVersion &&
         readback.kp == config.kp && readback.ki == config.ki &&
         readback.kd == config.kd && readback.revision == config.revision &&
         strcmp(readback.requestId, config.requestId) == 0;
}

bool clearPidConfig() {
  Preferences preferences;
  if (!preferences.begin(PID_NAMESPACE, false)) return false;
  const bool cleared = preferences.clear();
  preferences.end();
  return cleared;
}

bool loadDeviceSettings(DeviceSettings& settings) {
  clearDeviceSettingsValue(settings);
  Preferences preferences;
  if (!preferences.begin(DEVICE_NAMESPACE, true)) return false;

  bool loaded = false;
  if (preferences.isKey("schema") && preferences.isKey("port") &&
      preferences.getUShort("schema", 0) == DEVICE_SETTINGS_SCHEMA_VERSION) {
    DeviceSettings candidate;
    clearDeviceSettingsValue(candidate);
    candidate.mqttPort = preferences.getUShort("port", 0);
    const bool stringsRead =
        readString(preferences, "ssid", candidate.wifiSsid,
                   sizeof(candidate.wifiSsid), false) &&
        readString(preferences, "wpass", candidate.wifiPassword,
                   sizeof(candidate.wifiPassword), true) &&
        readString(preferences, "host", candidate.mqttHost,
                   sizeof(candidate.mqttHost), false) &&
        readString(preferences, "user", candidate.mqttUser,
                   sizeof(candidate.mqttUser), false) &&
        readString(preferences, "mpass", candidate.mqttPassword,
                   sizeof(candidate.mqttPassword), false) &&
        readString(preferences, "id", candidate.robotId,
                   sizeof(candidate.robotId), false);
    if (stringsRead && isDeviceSettingsValid(candidate)) {
      settings = candidate;
      loaded = true;
    }
  }
  preferences.end();
  return loaded;
}

bool saveDeviceSettings(const DeviceSettings& settings) {
  if (!isDeviceSettingsValid(settings)) return false;
  Preferences preferences;
  if (!preferences.begin(DEVICE_NAMESPACE, false)) return false;

  bool saved = preferences.putUShort("schema", INVALID_SCHEMA_VERSION) > 0 &&
               writeString(preferences, "ssid", settings.wifiSsid) &&
               writeString(preferences, "wpass", settings.wifiPassword) &&
               writeString(preferences, "host", settings.mqttHost) &&
               preferences.putUShort("port", settings.mqttPort) > 0 &&
               writeString(preferences, "user", settings.mqttUser) &&
               writeString(preferences, "mpass", settings.mqttPassword) &&
               writeString(preferences, "id", settings.robotId) &&
               preferences.putUShort("schema", DEVICE_SETTINGS_SCHEMA_VERSION) >
                   0;
  preferences.end();

  if (!saved) return false;
  DeviceSettings readback;
  return loadDeviceSettings(readback) &&
         sameDeviceSettings(readback, settings);
}

bool clearDeviceSettings() {
  Preferences preferences;
  if (!preferences.begin(DEVICE_NAMESPACE, false)) return false;
  const bool cleared = preferences.clear();
  preferences.end();
  return cleared;
}
