#pragma once

#include "config.h"

class LineController {
 public:
  LineController(float kp = Config::PID_KP, float ki = Config::PID_KI,
                 float kd = Config::PID_KD,
                 float maxOutput = Config::PID_MAX_OUTPUT,
                 float integralLimit = Config::PID_INTEGRAL_LIMIT);

  // error is measured in sensor-index units; positive means the line is right
  // of center. dt is elapsed time in seconds.
  float update(float error, float dt);
  void reset();

 private:
  float kp_;
  float ki_;
  float kd_;
  float maxOutput_;
  float integralLimit_;
  float integral_;
  float previousError_;
  bool hasPreviousError_;
};
