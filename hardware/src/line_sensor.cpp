#include "line_sensor.h"

#include <Arduino.h>

void LineSensor::begin() {
  for (uint8_t i = 0; i < Config::SENSOR_COUNT; ++i) {
    pinMode(Config::FRONT_SENSOR_PINS[i], INPUT);
    pinMode(Config::REAR_SENSOR_PINS[i], INPUT);
  }
}

SensorFrame LineSensor::read() {
  uint8_t frontMask = 0;
  uint8_t rearMask = 0;
  for (uint8_t i = 0; i < Config::SENSOR_COUNT; ++i) {
    const int frontReading = digitalRead(Config::FRONT_SENSOR_PINS[i]);
    const int rearReading = digitalRead(Config::REAR_SENSOR_PINS[i]);
    const bool frontDetectsLine = Config::FRONT_SENSOR_LINE_ACTIVE_LOW
                                      ? frontReading == LOW
                                      : frontReading == HIGH;
    const bool rearDetectsLine = Config::REAR_SENSOR_LINE_ACTIVE_LOW
                                     ? rearReading == LOW
                                     : rearReading == HIGH;
    if (frontDetectsLine) frontMask |= static_cast<uint8_t>(1u << i);
    if (rearDetectsLine) rearMask |= static_cast<uint8_t>(1u << i);
  }
  return sensorFrameFromMasks(frontMask, rearMask);
}
