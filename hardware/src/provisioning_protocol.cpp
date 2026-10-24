#include "provisioning_protocol.h"

#include <cerrno>
#include <cstdlib>
#include <cstring>
#include <math.h>

namespace {

int hexDigit(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

bool decodeHex(const char* source, char* destination, size_t capacity) {
  const size_t encodedLength = strlen(source);
  if ((encodedLength & 1u) != 0 || encodedLength / 2 >= capacity) return false;
  const size_t decodedLength = encodedLength / 2;
  for (size_t i = 0; i < decodedLength; ++i) {
    const int high = hexDigit(source[i * 2]);
    const int low = hexDigit(source[i * 2 + 1]);
    if (high < 0 || low < 0) return false;
    const char value = static_cast<char>((high << 4) | low);
    if (value == '\0') return false;
    destination[i] = value;
  }
  destination[decodedLength] = '\0';
  return true;
}

bool parsePort(const char* text, uint16_t& port) {
  if (text[0] == '\0') return false;
  for (size_t i = 0; text[i] != '\0'; ++i) {
    if (text[i] < '0' || text[i] > '9') return false;
  }
  errno = 0;
  char* end = NULL;
  const unsigned long value = strtoul(text, &end, 10);
  if (errno != 0 || end == text || *end != '\0' || value == 0 ||
      value > 65535UL) {
    return false;
  }
  port = static_cast<uint16_t>(value);
  return true;
}

bool parseFloat(const char* text, float& value) {
  if (text[0] == '\0' || text[0] == ' ' || text[0] == '\t') return false;
  errno = 0;
  char* end = NULL;
  value = strtof(text, &end);
  return errno == 0 && end != text && *end == '\0' && isfinite(value);
}

size_t splitFields(char* text, char** fields, size_t fieldCapacity) {
  size_t count = 1;
  fields[0] = text;
  for (size_t i = 0; text[i] != '\0'; ++i) {
    if (text[i] == '|') {
      if (count == fieldCapacity) return fieldCapacity + 1;
      text[i] = '\0';
      fields[count++] = &text[i + 1];
    }
  }
  return count;
}

}  // namespace

bool parseProvisionCommand(const char* line, size_t length,
                           ProvisionCommand& command) {
  command = ProvisionCommand();
  if (line == NULL || length == 0 || length > PROVISION_FRAME_MAX_BYTES ||
      memchr(line, '\0', length) != NULL) {
    return false;
  }

  char buffer[PROVISION_FRAME_MAX_BYTES + 1];
  memcpy(buffer, line, length);
  buffer[length] = '\0';
  char* fields[9];
  const size_t fieldCount = splitFields(buffer, fields, 9);
  if (fieldCount > 9) return false;

  if (fieldCount == 1 && strcmp(fields[0], "INFO") == 0) {
    command.type = ProvisionCommandType::Info;
    return true;
  }
  if (fieldCount == 1 && strcmp(fields[0], "RESET") == 0) {
    command.type = ProvisionCommandType::ResetAll;
    return true;
  }
  if (fieldCount == 8 && strcmp(fields[0], "CFG") == 0) {
    if (!decodeHex(fields[1], command.device.wifiSsid,
                   sizeof(command.device.wifiSsid)) ||
        !decodeHex(fields[2], command.device.wifiPassword,
                   sizeof(command.device.wifiPassword)) ||
        !decodeHex(fields[3], command.device.mqttHost,
                   sizeof(command.device.mqttHost)) ||
        !parsePort(fields[4], command.device.mqttPort) ||
        !decodeHex(fields[5], command.device.mqttUser,
                   sizeof(command.device.mqttUser)) ||
        !decodeHex(fields[6], command.device.mqttPassword,
                   sizeof(command.device.mqttPassword)) ||
        !decodeHex(fields[7], command.device.robotId,
                   sizeof(command.device.robotId)) ||
        !isDeviceSettingsValid(command.device)) {
      command = ProvisionCommand();
      return false;
    }
    command.type = ProvisionCommandType::ConfigureDevice;
    return true;
  }
  if ((fieldCount == 2 || fieldCount == 4) &&
      strcmp(fields[0], "PID") == 0) {
    if (fieldCount == 2 && strcmp(fields[1], "DEFAULT") == 0) {
      command.type = ProvisionCommandType::ResetPid;
      command.pid = defaultPidConfig();
      return true;
    }
    if (fieldCount == 4 && parseFloat(fields[1], command.pid.kp) &&
        parseFloat(fields[2], command.pid.ki) &&
        parseFloat(fields[3], command.pid.kd) &&
        isPidGainsValid(command.pid.kp, command.pid.ki, command.pid.kd)) {
      command.pid.schemaVersion = PID_CONFIG_SCHEMA_VERSION;
      command.pid.revision = 0;
      command.type = ProvisionCommandType::SetPid;
      return true;
    }
  }
  command = ProvisionCommand();
  return false;
}
