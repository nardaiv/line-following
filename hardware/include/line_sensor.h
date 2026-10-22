#pragma once

#include "sensor_reading.h"

class LineSensor {
 public:
  void begin();

  // Samples every digital input once; position and presence come from that mask.
  SensorReading read();
};
