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
      filteredDerivative_(0.0f),
      hasPreviousError_(false) {}

float LineController::update(float error, float dt) {
  float candidateDerivative = filteredDerivative_;
  if (dt > 0.0f) {
    if (hasPreviousError_) {
      const float rawDerivative = (error - previousError_) / dt;
      const float tau = Config::PID_DERIVATIVE_FILTER_TAU_MS / 1000.0f;
      const float alpha = tau > 0.0f ? dt / (tau + dt) : 1.0f;
      candidateDerivative += alpha * (rawDerivative - candidateDerivative);
    }
    previousError_ = error;
    hasPreviousError_ = true;
  }

  float candidateIntegral = integral_;
  if (dt > 0.0f && ki_ != 0.0f) {
    candidateIntegral += error * dt;
    if (candidateIntegral > integralLimit_) candidateIntegral = integralLimit_;
    if (candidateIntegral < -integralLimit_) candidateIntegral = -integralLimit_;
  }

  const float candidateOutput = kp_ * error + ki_ * candidateIntegral +
                                kd_ * candidateDerivative;
  const bool saturatedAgainstError =
      (candidateOutput > maxOutput_ && error * ki_ > 0.0f) ||
      (candidateOutput < -maxOutput_ && error * ki_ < 0.0f);
  if (!saturatedAgainstError) integral_ = candidateIntegral;
  filteredDerivative_ = candidateDerivative;

  float output = kp_ * error + ki_ * integral_ + kd_ * filteredDerivative_;
  if (output > maxOutput_) output = maxOutput_;
  if (output < -maxOutput_) output = -maxOutput_;
  return output;
}

void LineController::setGains(float kp, float ki, float kd) {
  kp_ = kp;
  ki_ = ki;
  kd_ = kd;
  reset();
}

void LineController::reset() {
  integral_ = 0.0f;
  previousError_ = 0.0f;
  filteredDerivative_ = 0.0f;
  hasPreviousError_ = false;
}
