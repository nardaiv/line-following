#include "pid_config.h"

#include <math.h>
#include <string.h>

PidConfig defaultPidConfig() {
  PidConfig config;
  memset(&config, 0, sizeof(config));
  config.schemaVersion = PID_CONFIG_SCHEMA_VERSION;
  config.kp = Config::PID_KP;
  config.ki = Config::PID_KI;
  config.kd = Config::PID_KD;
  config.revision = 0;
  return config;
}

bool isPidGainsValid(float kp, float ki, float kd) {
  return isfinite(kp) && isfinite(ki) && isfinite(kd) && kp >= 0.0f &&
         kp <= PID_KP_MAX && ki >= 0.0f && ki <= PID_KI_MAX && kd >= 0.0f &&
         kd <= PID_KD_MAX;
}

bool isPidConfigValid(const PidConfig& config) {
  size_t idLength = 0;
  while (idLength < sizeof(config.requestId) &&
         config.requestId[idLength] != '\0') {
    const char c = config.requestId[idLength];
    const bool valid = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                       (c >= '0' && c <= '9') || c == '-' || c == '_';
    if (!valid) return false;
    ++idLength;
  }
  return config.schemaVersion == PID_CONFIG_SCHEMA_VERSION &&
         idLength < sizeof(config.requestId) &&
         isPidGainsValid(config.kp, config.ki, config.kd);
}
