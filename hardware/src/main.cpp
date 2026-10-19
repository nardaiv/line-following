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

// States of the 90 degree corner handler:
//   Track      - normal PID line following (the FSM starts here).
//   Confirming - a lateral line segment was seen over the array (a run of
//                adjacent sensors firing together); wait for the line to
//                vanish to confirm a 90 degree turn.
//   Pivot      - confirmed corner: spin on the spot toward the corner side
//                until any sensor reacquires the line.
enum class CornerState { Track, Confirming, Pivot };
CornerState cornerState = CornerState::Track;

uint8_t clusterCycles = 0;      // debounce counter while in the Track state
bool clusterSideRight = false;  // side remembered from the cluster cycles
uint8_t windowCycles = 0;       // time spent in the Confirming state
uint8_t blackoutCycles = 0;     // consecutive all-dark cycles in Confirming
bool pivotRight = false;        // direction stored when the corner confirms
uint32_t pivotStartMs = 0;
int8_t lastErrorSide = 0;       // last nonzero error side; fallback for
                                // clusters centered on the array's middle

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

// A lateral line segment over the array (longest run >= CORNER_MIN_RUN) is the
// corner signature. The run's midpoint names the side; a midpoint centered on
// the array gives no side information and is reported as Unknown.
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
        motors.stop();
        controller.reset();
        return;
      }

      ClusterSide side = classifyCluster(mask);
      float position = 0.0f;
      lineSensor.readPosition(position);
      const float error = position - (Config::SENSOR_COUNT - 1) / 2.0f;
      if (error > 0.25f) {
        lastErrorSide = 1;
      } else if (error < -0.25f) {
        lastErrorSide = -1;
      }

      if (side == ClusterSide::None) {
        clusterCycles = 0;
      } else {
        bool sideRight;
        if (side == ClusterSide::Right) {
          sideRight = true;
        } else if (side == ClusterSide::Left) {
          sideRight = false;
        } else {
          // Segment centered on the middle of the array: decide by the
          // direction the line was drifting before the cluster.
          sideRight = lastErrorSide >= 0;
        }
        if (clusterCycles == 0 || sideRight != clusterSideRight) {
          clusterCycles = 1;
          clusterSideRight = sideRight;
        } else {
          ++clusterCycles;
        }
        if (clusterCycles >= Config::CORNER_CLUSTER_CYCLES) {
          windowCycles = 0;
          blackoutCycles = 0;
          clusterCycles = 0;
          cornerState = CornerState::Confirming;
          Serial.print("Lateral line over the array (");
          Serial.print(clusterSideRight ? "right" : "left");
          Serial.println("): waiting for the line to end.");
        }
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

    case CornerState::Confirming: {
      ++windowCycles;
      if (mask == 0) {
        if (++blackoutCycles >= Config::CORNER_BLACKOUT_CYCLES) {
          startPivot(clusterSideRight);
          return;  // spin is commanded on the next cycle
        }
        if (windowCycles >= Config::CORNER_WINDOW_CYCLES) {
          // Rare: went dark too late - treat as a plain line loss.
          cornerState = CornerState::Track;
          motors.stop();
          controller.reset();
          Serial.println("Blackout outside the window: stopping.");
        }
        return;
      }

      blackoutCycles = 0;
      if (classifyCluster(mask) == ClusterSide::None) {
        // The line reappeared as ordinary tracking before vanishing: false
        // alarm (e.g. a thick segment or a fork), resume PID.
        cornerState = CornerState::Track;
        Serial.println("Line reappeared without a blackout: no corner.");
      }
      return;
    }

    case CornerState::Pivot: {
      if (mask != 0) {
        motors.stop();
        controller.reset();
        cornerState = CornerState::Track;
        Serial.println("Line reacquired: resuming tracking.");
        return;
      }
      if (millis() - pivotStartMs > Config::CORNER_PIVOT_TIMEOUT_MS) {
        motors.stop();
        controller.reset();
        cornerState = CornerState::Track;
        Serial.println("Pivot timeout: stopping.");
        return;
      }
      applySpin();
      return;
    }
  }
}
