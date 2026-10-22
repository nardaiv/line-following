#pragma once

#include <stdint.h>

#include "config.h"

struct SensorReading {
  uint8_t mask;
  bool hasLine;
  float position;
};

// Derive line presence and weighted sensor-index position from one sampled mask.
SensorReading sensorReadingFromMask(uint8_t mask);
