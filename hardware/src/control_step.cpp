#include "control_step.h"

namespace {

const uint16_t NO_RECENT_CLUSTER = 0xFFFF;

enum class ClusterSide : uint8_t { None, Left, Right, Unknown };

int clampMotorSpeed(float speed) {
  if (speed > Config::MOTOR_PWM_MAX) return Config::MOTOR_PWM_MAX;
  if (speed < -Config::MOTOR_PWM_MAX) return -Config::MOTOR_PWM_MAX;
  return static_cast<int>(speed);
}

uint8_t longestRun(uint8_t mask, float& runMid) {
  uint8_t bestLen = 0;
  float bestMid = 0.0f;
  uint8_t runLen = 0;
  int8_t runStart = -1;
  for (uint8_t i = 0; i <= Config::SENSOR_COUNT; ++i) {
    const bool active = i < Config::SENSOR_COUNT && (mask & (1u << i)) != 0;
    if (active) {
      if (runStart < 0) runStart = static_cast<int8_t>(i);
      ++runLen;
    } else {
      if (runLen > bestLen) {
        bestLen = runLen;
        bestMid = (runStart + i - 1) / 2.0f;
      }
      runLen = 0;
      runStart = -1;
    }
  }
  runMid = bestMid;
  return bestLen;
}

ClusterSide classifyCluster(uint8_t mask) {
  float runMid = 0.0f;
  if (longestRun(mask, runMid) < Config::CORNER_MIN_RUN) {
    return ClusterSide::None;
  }
  const float center = (Config::SENSOR_COUNT - 1) / 2.0f;
  if (runMid > center + 0.25f) return ClusterSide::Right;
  if (runMid < center - 0.25f) return ClusterSide::Left;
  return ClusterSide::Unknown;
}

ClusterSide classifyFrontCluster(const SensorFrame& frame) {
  return classifyCluster(frame.front.mask);
}

ControlSensor selectControlSensor(const SensorFrame& frame) {
  if (frame.front.hasLine) return ControlSensor::Front;
  if (frame.rear.hasLine) return ControlSensor::Rear;
  return ControlSensor::None;
}

const SensorReading& selectedReading(const SensorFrame& frame,
                                     ControlSensor selected) {
  return selected == ControlSensor::Rear ? frame.rear : frame.front;
}

ControlOutput makeOutput(const SensorReading& reading, const SensorFrame& frame,
                         ControlSensor selected, ControlMode mode) {
  ControlOutput output;
  output.mode = mode;
  output.event = ControlEvent::None;
  output.motorAction = MotorAction::Hold;
  output.mask = reading.mask;
  output.hasLine = reading.hasLine;
  output.position = reading.position;
  output.error = 0.0f;
  output.correction = 0.0f;
  output.leftSpeed = 0;
  output.rightSpeed = 0;
  output.frontMask = frame.front.mask;
  output.frontHasLine = frame.front.hasLine;
  output.frontPosition = frame.front.position;
  output.rearMask = frame.rear.mask;
  output.rearHasLine = frame.rear.hasLine;
  output.rearPosition = frame.rear.position;
  output.controlSensor = selected;
  return output;
}

}  // namespace

ControlStep::ControlStep()
    : controller_(),
      mode_(ControlMode::Track),
      cyclesSinceCluster_(NO_RECENT_CLUSTER),
      clusterSideRight_(false),
      cornerCandidateValid_(false),
      cornerCandidateRight_(false),
      cornerCandidateCycles_(0),
      cornerConfirmed_(false),
      pivotRight_(false),
      pivotStartMs_(0),
      lossCycles_(0),
      zeroMaskCycles_(0),
      reacquireCycles_(0),
      pidElapsedMs_(0),
      lastLeftSpeed_(0),
      lastRightSpeed_(0),
      lastControlSensor_(ControlSensor::None) {}

bool ControlStep::configurePid(const PidConfig& config) {
  if (!isPidConfigValid(config)) return false;
  controller_.setGains(config.kp, config.ki, config.kd);
  return true;
}

ControlOutput ControlStep::update(const SensorReading& frontReading,
                                  uint32_t elapsedMs, uint32_t nowMs) {
  SensorFrame frame;
  frame.front = frontReading;
  frame.rear = sensorReadingFromMask(0);
  return update(frame, elapsedMs, nowMs);
}

ControlOutput ControlStep::update(const SensorFrame& frame,
                                  uint32_t elapsedMs, uint32_t nowMs) {
  const ControlSensor selected = selectControlSensor(frame);
  const SensorReading& reading = selectedReading(frame, selected);
  const bool linePresent = selected != ControlSensor::None;
  ControlOutput output = makeOutput(reading, frame, selected, mode_);

  if (mode_ == ControlMode::Lost) {
    if (linePresent) {
      if (reacquireCycles_ < Config::LINE_REACQUIRE_CONFIRM_CYCLES) {
        ++reacquireCycles_;
      }
      if (reacquireCycles_ >= Config::LINE_REACQUIRE_CONFIRM_CYCLES) {
        mode_ = ControlMode::Track;
        cyclesSinceCluster_ = NO_RECENT_CLUSTER;
        cornerCandidateValid_ = false;
        cornerConfirmed_ = false;
        lossCycles_ = 0;
        zeroMaskCycles_ = 0;
        reacquireCycles_ = 0;
        pidElapsedMs_ = 0;
        controller_.reset();
        lastControlSensor_ = selected;
        output.mode = ControlMode::Track;
        output.event = ControlEvent::LineReacquired;
        output.motorAction = MotorAction::Stop;
        lastLeftSpeed_ = 0;
        lastRightSpeed_ = 0;
        return output;
      }
    } else {
      reacquireCycles_ = 0;
    }
    output.mode = ControlMode::Lost;
    output.motorAction = MotorAction::Stop;
    lastLeftSpeed_ = 0;
    lastRightSpeed_ = 0;
    return output;
  }

  if (mode_ == ControlMode::Pivot) {
    if (frame.front.hasLine) {
      const bool onInnerSide = pivotRight_ ? frame.front.position >= 1.5f
                                           : frame.front.position <= 2.5f;
      if (onInnerSide) {
        if (reacquireCycles_ < Config::LINE_REACQUIRE_CONFIRM_CYCLES) {
          ++reacquireCycles_;
        }
      } else {
        reacquireCycles_ = 0;
      }
      if (reacquireCycles_ >= Config::LINE_REACQUIRE_CONFIRM_CYCLES) {
        mode_ = ControlMode::Track;
        cyclesSinceCluster_ = NO_RECENT_CLUSTER;
        cornerCandidateValid_ = false;
        cornerConfirmed_ = false;
        lossCycles_ = 0;
        zeroMaskCycles_ = 0;
        reacquireCycles_ = 0;
        pidElapsedMs_ = 0;
        controller_.reset();
        lastControlSensor_ = ControlSensor::Front;
        output.mode = ControlMode::Track;
        output.event = ControlEvent::LineReacquired;
        output.motorAction = MotorAction::Stop;
        lastLeftSpeed_ = 0;
        lastRightSpeed_ = 0;
        return output;
      }
    } else {
      reacquireCycles_ = 0;
    }

    if (static_cast<uint32_t>(nowMs - pivotStartMs_) >
        Config::CORNER_PIVOT_TIMEOUT_MS) {
      mode_ = ControlMode::Lost;
      cyclesSinceCluster_ = NO_RECENT_CLUSTER;
      cornerConfirmed_ = false;
      lossCycles_ = 0;
      pidElapsedMs_ = 0;
      controller_.reset();
      lastControlSensor_ = ControlSensor::None;
      output.mode = ControlMode::Lost;
      output.event = ControlEvent::PivotTimedOut;
      output.motorAction = MotorAction::Stop;
      lastLeftSpeed_ = 0;
      lastRightSpeed_ = 0;
      return output;
    }

    output.mode = ControlMode::Pivot;
    output.motorAction = MotorAction::Drive;
    output.leftSpeed = pivotRight_ ? Config::CORNER_PIVOT_SPEED
                                   : -Config::CORNER_PIVOT_SPEED;
    output.rightSpeed = -output.leftSpeed;
    lastLeftSpeed_ = output.leftSpeed;
    lastRightSpeed_ = output.rightSpeed;
    return output;
  }

  // After a confirmed front-row corner, front loss starts the turn even if
  // the rear row still sees the old straight segment.
  if (!frame.front.hasLine && cornerConfirmed_ &&
      cyclesSinceCluster_ <= Config::CORNER_RECENT_CYCLES) {
    if (zeroMaskCycles_ < Config::CORNER_BLACKOUT_CONFIRM_CYCLES) {
      ++zeroMaskCycles_;
    }
    if (zeroMaskCycles_ >= Config::CORNER_BLACKOUT_CONFIRM_CYCLES) {
      pivotRight_ = clusterSideRight_;
      pivotStartMs_ = nowMs;
      mode_ = ControlMode::Pivot;
      reacquireCycles_ = 0;
      pidElapsedMs_ = 0;
      controller_.reset();
      lastControlSensor_ = ControlSensor::None;
      output.mode = ControlMode::Pivot;
      output.event = ControlEvent::PivotStarted;
      output.motorAction = MotorAction::Drive;
      output.leftSpeed = pivotRight_ ? Config::CORNER_PIVOT_SPEED
                                     : -Config::CORNER_PIVOT_SPEED;
      output.rightSpeed = -output.leftSpeed;
      lastLeftSpeed_ = output.leftSpeed;
      lastRightSpeed_ = output.rightSpeed;
      return output;
    }
    output.motorAction = MotorAction::Hold;
    output.leftSpeed = lastLeftSpeed_;
    output.rightSpeed = lastRightSpeed_;
    pidElapsedMs_ += elapsedMs;
    if (pidElapsedMs_ > Config::CONTROL_DT_MAX_MS) {
      pidElapsedMs_ = Config::CONTROL_DT_MAX_MS;
    }
    return output;
  }

  if (!linePresent) {
    if (lossCycles_ < Config::LINE_LOSS_GRACE_CYCLES) {
      ++lossCycles_;
      output.motorAction = MotorAction::Hold;
      output.leftSpeed = lastLeftSpeed_;
      output.rightSpeed = lastRightSpeed_;
      pidElapsedMs_ += elapsedMs;
      if (pidElapsedMs_ > Config::CONTROL_DT_MAX_MS) {
        pidElapsedMs_ = Config::CONTROL_DT_MAX_MS;
      }
      return output;
    }

    mode_ = ControlMode::Lost;
    cyclesSinceCluster_ = NO_RECENT_CLUSTER;
    cornerCandidateValid_ = false;
    cornerConfirmed_ = false;
    zeroMaskCycles_ = 0;
    reacquireCycles_ = 0;
    pidElapsedMs_ = 0;
    controller_.reset();
    lastControlSensor_ = ControlSensor::None;
    output.mode = ControlMode::Lost;
    output.motorAction = MotorAction::Stop;
    lastLeftSpeed_ = 0;
    lastRightSpeed_ = 0;
    return output;
  }

  lossCycles_ = 0;
  zeroMaskCycles_ = 0;
  if (cyclesSinceCluster_ != NO_RECENT_CLUSTER) {
    if (cyclesSinceCluster_ < NO_RECENT_CLUSTER - 1) {
      ++cyclesSinceCluster_;
    }
    if (cyclesSinceCluster_ > Config::CORNER_RECENT_CYCLES) {
      cyclesSinceCluster_ = NO_RECENT_CLUSTER;
      cornerConfirmed_ = false;
    }
  }

  const ClusterSide side = classifyFrontCluster(frame);
  if (side == ClusterSide::Left || side == ClusterSide::Right) {
    const bool candidateRight = side == ClusterSide::Right;
    if (cornerConfirmed_ && clusterSideRight_ != candidateRight) {
      cornerConfirmed_ = false;
      cyclesSinceCluster_ = NO_RECENT_CLUSTER;
    }
    if (!cornerCandidateValid_ || cornerCandidateRight_ != candidateRight) {
      cornerCandidateValid_ = true;
      cornerCandidateRight_ = candidateRight;
      cornerCandidateCycles_ = 1;
    } else if (cornerCandidateCycles_ < Config::CORNER_CONFIRM_CYCLES) {
      ++cornerCandidateCycles_;
    }
    if (cornerCandidateCycles_ >= Config::CORNER_CONFIRM_CYCLES) {
      if (!cornerConfirmed_ || clusterSideRight_ != candidateRight) {
        output.event = ControlEvent::CornerCluster;
      }
      cornerConfirmed_ = true;
      clusterSideRight_ = candidateRight;
      cyclesSinceCluster_ = 0;
    }
  } else {
    cornerCandidateValid_ = false;
    cornerCandidateCycles_ = 0;
    if (side == ClusterSide::Unknown) {
      cornerConfirmed_ = false;
      cyclesSinceCluster_ = NO_RECENT_CLUSTER;
    }
  }

  if (lastControlSensor_ != ControlSensor::None &&
      lastControlSensor_ != selected) {
    // The two rows may observe different positions during a turn. Avoid a
    // derivative kick when switching the measurement source.
    controller_.reset();
    pidElapsedMs_ = 0;
  }
  lastControlSensor_ = selected;

  const float center = (Config::SENSOR_COUNT - 1) / 2.0f;
  const float error = reading.position - center;
  output.error = error;
  uint32_t pidDtMs = pidElapsedMs_ + elapsedMs;
  pidElapsedMs_ = 0;
  if (pidDtMs == 0) pidDtMs = 1;
  if (pidDtMs > Config::CONTROL_DT_MAX_MS) {
    pidDtMs = Config::CONTROL_DT_MAX_MS;
  }
  const float correction = controller_.update(error, pidDtMs / 1000.0f);
  output.correction = correction;
  output.leftSpeed = clampMotorSpeed(Config::BASE_SPEED + correction);
  output.rightSpeed = clampMotorSpeed(Config::BASE_SPEED - correction);
  output.motorAction = MotorAction::Drive;
  lastLeftSpeed_ = output.leftSpeed;
  lastRightSpeed_ = output.rightSpeed;
  return output;
}
