#pragma once

#include <stdint.h>

#include "config.h"

class LineSensor {
 public:
  void begin();

  // Returns true when one or more sensors detect the line. Position is in
  // sensor-index units (0 is leftmost, SENSOR_COUNT - 1 is rightmost).
  bool readPosition(float& position);
};
