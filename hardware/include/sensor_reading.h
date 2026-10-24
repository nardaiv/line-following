#pragma once

#include <stdint.h>

#include "config.h"

struct SensorReading {
  uint8_t mask;
  bool hasLine;
  float position;
};

struct SensorFrame {
  SensorReading front;
  SensorReading rear;

  bool hasAnyLine() const { return front.hasLine || rear.hasLine; }
};

// Derive line presence and weighted sensor-index position from one sampled mask.
SensorReading sensorReadingFromMask(uint8_t mask);
SensorFrame sensorFrameFromMasks(uint8_t frontMask, uint8_t rearMask);
