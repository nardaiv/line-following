#include "line_sensor.h"

#include <Arduino.h>

#include "config.h"

void LineSensor::begin() {
  for (uint8_t i = 0; i < Config::SENSOR_COUNT; ++i) {
    pinMode(Config::SENSOR_PINS[i], INPUT);
  }
}

bool LineSensor::readPosition(float& position) {
  uint32_t weightedTotal = 0;
  uint32_t strengthTotal = 0;
  for (uint8_t i = 0; i < Config::SENSOR_COUNT; ++i) {
    const int reading = digitalRead(Config::SENSOR_PINS[i]);
    const bool detectsLine = Config::SENSOR_LINE_ACTIVE_LOW
                                 ? reading == LOW
                                 : reading == HIGH;
    if (detectsLine) {
      weightedTotal += i;
      ++strengthTotal;
    }
  }

  if (strengthTotal == 0) return false;
  position = static_cast<float>(weightedTotal) / strengthTotal;
  return true;
}

uint8_t LineSensor::readMask() {
  uint8_t mask = 0;
  for (uint8_t i = 0; i < Config::SENSOR_COUNT; ++i) {
    const int reading = digitalRead(Config::SENSOR_PINS[i]);
    const bool detectsLine = Config::SENSOR_LINE_ACTIVE_LOW
                                 ? reading == LOW
                                 : reading == HIGH;
    if (detectsLine) mask |= static_cast<uint8_t>(1u << i);
  }
  return mask;
}
