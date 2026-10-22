#pragma once

#include <stddef.h>
#include <stdint.h>

#include "device_settings.h"
#include "pid_config.h"

constexpr size_t PROVISION_FRAME_MAX_BYTES = 1100;

enum class ProvisionCommandType : uint8_t {
  Invalid = 0,
  Info,
  ConfigureDevice,
  SetPid,
  ResetPid,
  ResetAll
};

struct ProvisionCommand {
  ProvisionCommandType type;
  DeviceSettings device;
  PidConfig pid;
};

// Parse one bounded ASCII line. Secrets are hex-decoded into the result and are
// never included in an error or acknowledgement string.
bool parseProvisionCommand(const char* line, size_t length,
                           ProvisionCommand& command);
