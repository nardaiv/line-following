#include <Arduino.h>

#include "config.h"
#include "controller.h"
#include "line_sensor.h"
#include "motor_driver.h"

namespace {

LineSensor lineSensor;
MotorDriver motors;
LineController controller;
uint32_t previousControlTime = 0;
bool motorsEnabled = false;

// Corner handling FSM:
//   Track - normal PID line following. A run of >= CORNER_MIN_RUN adjacent
//           sensors lights up when a lateral line segment (90 degree corner)
//           is over the array; the run's midpoint names the corner side.
//           The blackout (all sensors dark) arriving within
//           CORNER_RECENT_CYCLES of the latest cluster sighting confirms the
//           corner - at speed the cluster can flash by in one cycle.
//   Pivot - confirmed corner: spin on the spot toward the remembered side
//           until any sensor reacquires the line.
enum class CornerState { Track, Pivot };
CornerState cornerState = CornerState::Track;

uint16_t cyclesSinceCluster = 0xFFFF;  // sentinel: no recent cluster
bool clusterSideRight = false;         // side stamped with the latest cluster
bool pivotRight = false;               // direction stored when the corner confirms
uint32_t pivotStartMs = 0;
uint16_t lossCycles = 0;               // consecutive all-dark cycles in Track
float approachBias = 0.0f;             // decaying average of recent tracking
                                       // errors; fallback for segments
                                       // centered on the array's middle

enum class ClusterSide { None, Left, Right, Unknown };

int clampMotorSpeed(float speed) {
  if (speed > Config::MOTOR_PWM_MAX) return Config::MOTOR_PWM_MAX;
  if (speed < -Config::MOTOR_PWM_MAX) return -Config::MOTOR_PWM_MAX;
  return static_cast<int>(speed);
}

// Finds the longest contiguous run of active sensors in the bitmask. Returns
// its length and, via runMid, the run's center in sensor-index units.
uint8_t longestRun(uint8_t mask, float& runMid) {
  uint8_t bestLen = 0;
  float bestMid = 0.0f;
  uint8_t runLen = 0;
  int8_t runStart = -1;
  for (uint8_t i = 0; i <= Config::SENSOR_COUNT; ++i) {
    const bool active =
        i < Config::SENSOR_COUNT && (mask & (1u << i)) != 0;
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
  if (longestRun(mask, runMid) < Config::CORNER_MIN_RUN) return ClusterSide::None;
  const float center = (Config::SENSOR_COUNT - 1) / 2.0f;
  if (runMid > center + 0.25f) return ClusterSide::Right;
  if (runMid < center - 0.25f) return ClusterSide::Left;
  return ClusterSide::Unknown;
}

void startPivot(bool toRight) {
  pivotRight = toRight;
  pivotStartMs = millis();
  if (!motorsEnabled) {
    motors.enable();
    motorsEnabled = true;
  }
  cornerState = CornerState::Pivot;
  Serial.print("Corner confirmed: pivoting ");
  Serial.println(toRight ? "right." : "left.");
}

void applySpin() {
  const int speed = Config::CORNER_PIVOT_SPEED;
  if (pivotRight) {
    motors.setSpeeds(speed, -speed);   // left forward, right backward: spin right
  } else {
    motors.setSpeeds(-speed, speed);   // spin left
  }
}

}  // namespace

void setup() {
  Serial.begin(Config::SERIAL_BAUD);
  lineSensor.begin();
  motors.begin();
  Serial.println("HW-871 digital line sensors ready.");
  Serial.println("Place the line under the array to start the motors.");
  Serial.println("90 degree corner handling enabled.");
  previousControlTime = millis();
}

void loop() {
  const uint32_t now = millis();
  const uint32_t elapsed = now - previousControlTime;
  if (elapsed < Config::CONTROL_PERIOD_MS) return;
  previousControlTime = now;

  const uint8_t mask = lineSensor.readMask();

  switch (cornerState) {
    case CornerState::Track: {
      if (mask == 0) {
        if (cyclesSinceCluster <= Config::CORNER_RECENT_CYCLES) {
          // Lateral segment seen moments ago, now all dark: 90 degree turn.
          startPivot(clusterSideRight);
          return;  // spin is commanded on the next cycle
        }
        // Sensors occasionally drop out. Coast on the last commanded speeds
        // for a grace period before accepting a genuine loss.
        if (lossCycles == 0) {
          controller.reset();  // the previous error is no longer actionable
        }
        if (lossCycles < Config::LINE_LOSS_GRACE_CYCLES) {
          ++lossCycles;
          return;  // keep rolling on the last commanded speeds
        }
        motors.stop();
        cyclesSinceCluster = 0xFFFF;
        return;
      }

      lossCycles = 0;
      if (cyclesSinceCluster != 0xFFFF) ++cyclesSinceCluster;

      float position = 0.0f;
      lineSensor.readPosition(position);
      const float error = position - (Config::SENSOR_COUNT - 1) / 2.0f;
      approachBias = approachBias * 0.9f + error * 0.1f;

      const ClusterSide side = classifyCluster(mask);
      if (side != ClusterSide::None) {
        bool sideRight;
        if (side == ClusterSide::Right) {
          sideRight = true;
        } else if (side == ClusterSide::Left) {
          sideRight = false;
        } else {
          // Segment centered on the array: decide by the direction the line
          // was drifting before the cluster.
          sideRight = approachBias >= 0.0f;
        }
        if (cyclesSinceCluster == 0xFFFF) {
          Serial.print("Lateral segment over the array (");
          Serial.print(sideRight ? "right" : "left");
          Serial.println(").");
        }
        clusterSideRight = sideRight;
        cyclesSinceCluster = 0;
      }

      const float correction = controller.update(error, elapsed / 1000.0f);
      if (!motorsEnabled) {
        motors.enable();
        motorsEnabled = true;
      }
      motors.setSpeeds(clampMotorSpeed(Config::BASE_SPEED + correction),
                       clampMotorSpeed(Config::BASE_SPEED - correction));
      return;
    }

    case CornerState::Pivot: {
      if (mask != 0) {
        float position = 0.0f;
        lineSensor.readPosition(position);
        // Only accept a reacquire on the pivot side (or near center). A line
        // appearing on the far outer flank during the spin is the approach
        // line - grabbing it would turn the robot the wrong way, so the
        // pivot continues until the new line swings in.
        const bool onInnerSide = pivotRight ? position >= 1.5f : position <= 2.5f;
        if (onInnerSide) {
          const uint32_t pivotMs = millis() - pivotStartMs;
          motors.stop();
          controller.reset();
          cornerState = CornerState::Track;
          cyclesSinceCluster = 0xFFFF;
          lossCycles = 0;
          Serial.print("Line reacquired at index ");
          Serial.print(position, 1);
          Serial.print(" after ");
          Serial.print(pivotMs);
          Serial.println(" ms: resuming tracking.");
          return;
        }
        // Otherwise: fell through the sweep or caught the old line - keep
        // spinning (fall through to applySpin below).
      }
      if (millis() - pivotStartMs > Config::CORNER_PIVOT_TIMEOUT_MS) {
        motors.stop();
        controller.reset();
        cornerState = CornerState::Track;
        cyclesSinceCluster = 0xFFFF;
        lossCycles = 0;
        Serial.println("Pivot timeout: stopping.");
        return;
      }
      applySpin();
      return;
    }
  }
}
