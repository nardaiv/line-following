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

ControlOutput makeOutput(const SensorReading& reading, ControlMode mode) {
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
  return output;
}

}  // namespace

ControlStep::ControlStep()
    : controller_(),
      mode_(ControlMode::Track),
      cyclesSinceCluster_(NO_RECENT_CLUSTER),
      clusterSideRight_(false),
      pivotRight_(false),
      pivotStartMs_(0),
      lossCycles_(0),
      approachBias_(0.0f),
      lineLost_(false) {}

bool ControlStep::configurePid(const PidConfig& config) {
  if (!isPidConfigValid(config)) return false;
  controller_.setGains(config.kp, config.ki, config.kd);
  return true;
}

ControlOutput ControlStep::update(const SensorReading& reading,
                                  uint32_t elapsedMs, uint32_t nowMs) {
  ControlOutput output = makeOutput(
      reading, lineLost_ && reading.mask == 0 ? ControlMode::Lost : mode_);

  if (mode_ == ControlMode::Track) {
    if (reading.mask == 0) {
      if (cyclesSinceCluster_ <= Config::CORNER_RECENT_CYCLES) {
        pivotRight_ = clusterSideRight_;
        pivotStartMs_ = nowMs;
        mode_ = ControlMode::Pivot;
        output.mode = ControlMode::Pivot;
        output.event = ControlEvent::PivotStarted;
        return output;
      }
      if (lossCycles_ == 0) controller_.reset();
      if (lossCycles_ < Config::LINE_LOSS_GRACE_CYCLES) {
        ++lossCycles_;
        output.mode = ControlMode::Track;
        return output;
      }
      cyclesSinceCluster_ = NO_RECENT_CLUSTER;
      lineLost_ = true;
      output.mode = ControlMode::Lost;
      output.motorAction = MotorAction::Stop;
      return output;
    }

    lossCycles_ = 0;
    lineLost_ = false;
    if (cyclesSinceCluster_ != NO_RECENT_CLUSTER) ++cyclesSinceCluster_;

    const float center = (Config::SENSOR_COUNT - 1) / 2.0f;
    const float error = reading.position - center;
    output.error = error;
    approachBias_ = approachBias_ * 0.9f + error * 0.1f;

    const ClusterSide side = classifyCluster(reading.mask);
    if (side != ClusterSide::None) {
      bool sideRight;
      if (side == ClusterSide::Right) {
        sideRight = true;
      } else if (side == ClusterSide::Left) {
        sideRight = false;
      } else {
        sideRight = approachBias_ >= 0.0f;
      }
      if (cyclesSinceCluster_ == NO_RECENT_CLUSTER) {
        output.event = ControlEvent::CornerCluster;
      }
      clusterSideRight_ = sideRight;
      cyclesSinceCluster_ = 0;
    }

    const float correction = controller_.update(error, elapsedMs / 1000.0f);
    output.correction = correction;
    output.leftSpeed = clampMotorSpeed(Config::BASE_SPEED + correction);
    output.rightSpeed = clampMotorSpeed(Config::BASE_SPEED - correction);
    output.motorAction = MotorAction::Drive;
    return output;
  }

  if (reading.mask != 0) {
    const bool onInnerSide = pivotRight_ ? reading.position >= 1.5f
                                         : reading.position <= 2.5f;
    if (onInnerSide) {
      mode_ = ControlMode::Track;
      cyclesSinceCluster_ = NO_RECENT_CLUSTER;
      lossCycles_ = 0;
      lineLost_ = false;
      controller_.reset();
      output.mode = ControlMode::Track;
      output.event = ControlEvent::LineReacquired;
      output.motorAction = MotorAction::Stop;
      return output;
    }
  }

  if (static_cast<uint32_t>(nowMs - pivotStartMs_) >
      Config::CORNER_PIVOT_TIMEOUT_MS) {
    mode_ = ControlMode::Track;
    cyclesSinceCluster_ = NO_RECENT_CLUSTER;
    lossCycles_ = 0;
    lineLost_ = false;
    controller_.reset();
    output.mode = ControlMode::Track;
    output.event = ControlEvent::PivotTimedOut;
    output.motorAction = MotorAction::Stop;
    return output;
  }

  output.mode = ControlMode::Pivot;
  output.motorAction = MotorAction::Drive;
  output.leftSpeed = pivotRight_ ? Config::CORNER_PIVOT_SPEED
                                  : -Config::CORNER_PIVOT_SPEED;
  output.rightSpeed = -output.leftSpeed;
  return output;
}
