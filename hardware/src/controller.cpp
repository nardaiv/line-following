#include "controller.h"

LineController::LineController(float kp, float ki, float kd, float maxOutput,
                               float integralLimit)
    : kp_(kp),
      ki_(ki),
      kd_(kd),
      maxOutput_(maxOutput),
      integralLimit_(integralLimit),
      integral_(0.0f),
      previousError_(0.0f),
      hasPreviousError_(false) {}

float LineController::update(float error, float dt) {
  float derivative = 0.0f;
  if (dt > 0.0f) {
    const float candidateIntegral = integral_ + error * dt;
    if (candidateIntegral > integralLimit_) {
      integral_ = integralLimit_;
    } else if (candidateIntegral < -integralLimit_) {
      integral_ = -integralLimit_;
    } else {
      integral_ = candidateIntegral;
    }

    if (hasPreviousError_) derivative = (error - previousError_) / dt;
    previousError_ = error;
    hasPreviousError_ = true;
  }

  float output = kp_ * error + ki_ * integral_ + kd_ * derivative;
  if (output > maxOutput_) output = maxOutput_;
  if (output < -maxOutput_) output = -maxOutput_;
  return output;
}

void LineController::reset() {
  integral_ = 0.0f;
  previousError_ = 0.0f;
  hasPreviousError_ = false;
}
