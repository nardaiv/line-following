#pragma once

#include "device_settings.h"
#include "pid_config.h"

// Load functions return false for absent, incompatible, invalid, or unavailable
// NVS data and always leave their output at safe defaults on failure.
bool loadPidConfig(PidConfig& config);
bool savePidConfig(const PidConfig& config);
bool clearPidConfig();

bool loadDeviceSettings(DeviceSettings& settings);
bool saveDeviceSettings(const DeviceSettings& settings);
bool clearDeviceSettings();
