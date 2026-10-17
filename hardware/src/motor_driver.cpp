#include "motor_driver.h"

#include <Arduino.h>

#include "config.h"

MotorDriver::MotorDriver() : enabled_(false) {}

void MotorDriver::begin() {
  pinMode(Config::LEFT_MOTOR_IN1_PIN, OUTPUT);
  pinMode(Config::LEFT_MOTOR_IN2_PIN, OUTPUT);
  pinMode(Config::LEFT_MOTOR_PWM_PIN, OUTPUT);
  pinMode(Config::RIGHT_MOTOR_IN1_PIN, OUTPUT);
  pinMode(Config::RIGHT_MOTOR_IN2_PIN, OUTPUT);
  pinMode(Config::RIGHT_MOTOR_PWM_PIN, OUTPUT);
  pinMode(Config::MOTOR_STANDBY_PIN, OUTPUT);
  analogWrite(Config::LEFT_MOTOR_PWM_PIN, 0);
  analogWrite(Config::RIGHT_MOTOR_PWM_PIN, 0);
  digitalWrite(Config::MOTOR_STANDBY_PIN, LOW);
  enabled_ = false;
}

void MotorDriver::enable() {
  digitalWrite(Config::MOTOR_STANDBY_PIN, HIGH);
  enabled_ = true;
}

void MotorDriver::setSpeeds(int leftSpeed, int rightSpeed) {
  if (!enabled_) return;
  setMotor(Config::LEFT_MOTOR_IN1_PIN, Config::LEFT_MOTOR_IN2_PIN,
           Config::LEFT_MOTOR_PWM_PIN, leftSpeed, Config::LEFT_MOTOR_REVERSED);
  setMotor(Config::RIGHT_MOTOR_IN1_PIN, Config::RIGHT_MOTOR_IN2_PIN,
           Config::RIGHT_MOTOR_PWM_PIN, rightSpeed, Config::RIGHT_MOTOR_REVERSED);
}

void MotorDriver::stop() {
  analogWrite(Config::LEFT_MOTOR_PWM_PIN, 0);
  analogWrite(Config::RIGHT_MOTOR_PWM_PIN, 0);
}

void MotorDriver::standby() {
  stop();
  digitalWrite(Config::MOTOR_STANDBY_PIN, LOW);
  enabled_ = false;
}

void MotorDriver::setMotor(int in1Pin, int in2Pin, int pwmPin, int speed,
                           bool reversed) {
  if (reversed) speed = -speed;
  speed = constrain(speed, -Config::MOTOR_PWM_MAX, Config::MOTOR_PWM_MAX);

  if (speed > 0) {
    digitalWrite(in1Pin, HIGH);
    digitalWrite(in2Pin, LOW);
  } else if (speed < 0) {
    digitalWrite(in1Pin, LOW);
    digitalWrite(in2Pin, HIGH);
  } else {
    digitalWrite(in1Pin, LOW);
    digitalWrite(in2Pin, LOW);
  }

  analogWrite(pwmPin, abs(speed));
}
