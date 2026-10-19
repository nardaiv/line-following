#pragma once

#include <stdint.h>

namespace Config {

constexpr uint32_t SERIAL_BAUD = 115200;

// Five HW-871 digital outputs, ordered from the robot's left to right.
constexpr uint8_t SENSOR_COUNT = 5;
static const uint8_t SENSOR_PINS[SENSOR_COUNT] = {36, 37, 38, 39, 40};
// Most HW-871 boards report LOW when a sensor detects the line. Change this
// to false if your board reports HIGH over the line.
constexpr bool SENSOR_LINE_ACTIVE_LOW = true;

// TB6612FNG: motor A is left; motor B is right. Avoid S3 USB and strapping pins.
constexpr uint8_t LEFT_MOTOR_IN1_PIN = 11;
constexpr uint8_t LEFT_MOTOR_IN2_PIN = 12;
constexpr uint8_t LEFT_MOTOR_PWM_PIN = 13;
constexpr uint8_t RIGHT_MOTOR_IN1_PIN = 14;
constexpr uint8_t RIGHT_MOTOR_IN2_PIN = 15;
constexpr uint8_t RIGHT_MOTOR_PWM_PIN = 16;
constexpr uint8_t MOTOR_STANDBY_PIN = 17;
constexpr bool LEFT_MOTOR_REVERSED = false;
constexpr bool RIGHT_MOTOR_REVERSED = false;
constexpr int MOTOR_PWM_MAX = 180;

// PID output is a PWM correction. Gains need tuning for the robot and track.
constexpr float PID_KP = 12.5f;
constexpr float PID_KI = 1.0f;
constexpr float PID_KD = 0.15f;
constexpr float PID_MAX_OUTPUT = 120.0f;
constexpr float PID_INTEGRAL_LIMIT = 10.0f;

constexpr int BASE_SPEED = 100;
constexpr uint32_t CONTROL_PERIOD_MS = 10;

// 90 degree corner handling (see the FSM in main.cpp): a run of adjacent
// sensors firing together marks a lateral line segment, i.e. a sharp turn.
constexpr uint8_t CORNER_MIN_RUN = 3;          // adjacent sensors = corner signature
constexpr uint8_t CORNER_CLUSTER_CYCLES = 2;   // consecutive cluster cycles to debounce
constexpr uint8_t CORNER_WINDOW_CYCLES = 15;   // max cycles to wait for the blackout
constexpr uint8_t CORNER_BLACKOUT_CYCLES = 2;  // consecutive all-dark cycles to confirm
constexpr int CORNER_PIVOT_SPEED = 90;         // spin PWM while rotating on the spot
constexpr uint32_t CORNER_PIVOT_TIMEOUT_MS = 1500;

}  // namespace Config
