#pragma once

#include <stdint.h>

#include "config.h"

class LineSensor {
 public:
  void begin();

  // Returns true when one or more sensors detect the line. Position is in
  // sensor-index units (0 is leftmost, SENSOR_COUNT - 1 is rightmost).
  bool readPosition(float& position);

  // Bit i is set when sensor i (0 = leftmost) detects the line. Lets callers
  // distinguish junction signatures from a single-sensor position estimate.
  uint8_t readMask();
};
