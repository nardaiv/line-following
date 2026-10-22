#pragma once

#include <stddef.h>
#include <stdint.h>

#include "config.h"

constexpr uint16_t PID_CONFIG_SCHEMA_VERSION = 2;
constexpr size_t PID_REQUEST_ID_STORAGE_BYTES = 37;

// Conservative mathematical bounds: each individual PID term remains within
// PID_MAX_OUTPUT at the largest sensor error, integral clamp, or one-cycle
// derivative step. These bounds prevent numeric/actuator saturation abuse;
// they are not a substitute for bench-tuning stability limits.
constexpr float PID_MAX_ABS_ERROR = (Config::SENSOR_COUNT - 1) / 2.0f;
constexpr float PID_KP_MAX = Config::PID_MAX_OUTPUT / PID_MAX_ABS_ERROR;
constexpr float PID_KI_MAX = Config::PID_MAX_OUTPUT / Config::PID_INTEGRAL_LIMIT;
constexpr float PID_KD_MAX =
    (Config::PID_MAX_OUTPUT * (Config::CONTROL_PERIOD_MS / 1000.0f)) /
    (2.0f * PID_MAX_ABS_ERROR);

struct PidConfig {
  uint16_t schemaVersion;
  float kp;
  float ki;
  float kd;
  uint32_t revision;
  char requestId[PID_REQUEST_ID_STORAGE_BYTES];
};

PidConfig defaultPidConfig();
bool isPidGainsValid(float kp, float ki, float kd);
bool isPidConfigValid(const PidConfig& config);
