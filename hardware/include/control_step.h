#pragma once

#include <stdint.h>

#include "config.h"
#include "controller.h"
#include "pid_config.h"
#include "sensor_reading.h"

enum class ControlMode : uint8_t { Track, Pivot, Lost };
enum class ControlEvent : uint8_t {
  None,
  CornerCluster,
  PivotStarted,
  LineReacquired,
  PivotTimedOut
};
enum class MotorAction : uint8_t { Hold, Drive, Stop };
enum class ControlSensor : uint8_t { None, Front, Rear };

struct ControlOutput {
  ControlMode mode;
  ControlEvent event;
  MotorAction motorAction;
  uint8_t mask;
  bool hasLine;
  float position;
  float error;
  float correction;
  int leftSpeed;
  int rightSpeed;
  uint8_t frontMask;
  bool frontHasLine;
  float frontPosition;
  uint8_t rearMask;
  bool rearHasLine;
  float rearPosition;
  ControlSensor controlSensor;
};

// Hardware-independent one-step line-following and corner/loss state machine.
class ControlStep {
 public:
  ControlStep();

  ControlOutput update(const SensorFrame& frame, uint32_t elapsedMs,
                       uint32_t nowMs);
  // Compatibility helper for native tests and callers with a front-only row.
  ControlOutput update(const SensorReading& frontReading, uint32_t elapsedMs,
                       uint32_t nowMs);
  bool configurePid(const PidConfig& config);

 private:
  LineController controller_;
  ControlMode mode_;
  uint16_t cyclesSinceCluster_;
  bool clusterSideRight_;
  bool cornerCandidateValid_;
  bool cornerCandidateRight_;
  uint8_t cornerCandidateCycles_;
  bool cornerConfirmed_;
  bool pivotRight_;
  uint32_t pivotStartMs_;
  uint16_t lossCycles_;
  uint8_t zeroMaskCycles_;
  uint8_t reacquireCycles_;
  uint32_t pidElapsedMs_;
  int lastLeftSpeed_;
  int lastRightSpeed_;
  ControlSensor lastControlSensor_;
};
