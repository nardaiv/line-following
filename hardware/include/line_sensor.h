#pragma once

#include "sensor_reading.h"

class LineSensor {
 public:
  void begin();

  // Samples both digital rows once and derives positions from those masks.
  SensorFrame read();
};
