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

int clampMotorSpeed(float speed) {
  if (speed > Config::MOTOR_PWM_MAX) return Config::MOTOR_PWM_MAX;
  if (speed < -Config::MOTOR_PWM_MAX) return -Config::MOTOR_PWM_MAX;
  return static_cast<int>(speed);
}

}  // namespace

void setup() {
  Serial.begin(Config::SERIAL_BAUD);
  lineSensor.begin();
  motors.begin();
  Serial.println("HW-871 digital line sensors ready.");
  Serial.println("Place the line under the array to start the motors.");
  previousControlTime = millis();
}

void loop() {
  const uint32_t now = millis();
  const uint32_t elapsed = now - previousControlTime;
  if (elapsed < Config::CONTROL_PERIOD_MS) return;
  previousControlTime = now;

  float linePosition = 0.0f;
  if (!lineSensor.readPosition(linePosition)) {
    motors.stop();
    controller.reset();
    return;
  }

  const float center = (Config::SENSOR_COUNT - 1) / 2.0f;
  const float error = linePosition - center;
  const float correction = controller.update(error, elapsed / 1000.0f);

  if (!motorsEnabled) {
    motors.enable();
    motorsEnabled = true;
  }

  // A line to the right requires a right turn: left motor speeds up, right slows.
  motors.setSpeeds(clampMotorSpeed(Config::BASE_SPEED + correction),
                   clampMotorSpeed(Config::BASE_SPEED - correction));
}
