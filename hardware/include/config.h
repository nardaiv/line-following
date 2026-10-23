#pragma once

#include <stdint.h>

namespace Config {

constexpr uint32_t SERIAL_BAUD = 115200;

// Front and rear HW-871 rows, each ordered from the robot's left to right.
constexpr uint8_t SENSOR_COUNT = 5;

// static const uint8_t FRONT_SENSOR_PINS[SENSOR_COUNT] = {36, 37, 38, 39, 40};
static const uint8_t FRONT_SENSOR_PINS[SENSOR_COUNT] = {40, 39, 38, 37, 36};

// Rear row GPIOs supplied for this robot, left to right: 21, 47, 9, 8, 18.
static const uint8_t REAR_SENSOR_PINS[SENSOR_COUNT] = {21, 47, 9, 8, 18};
// The rows are approximately 20 mm apart longitudinally; verify the mounted
// distance before using it for geometric heading compensation.
constexpr uint16_t SENSOR_ROW_SEPARATION_MM = 20;
// Most HW-871 boards report LOW when a sensor detects the line. Change this
// per row if the installed board reports HIGH over the line.
constexpr bool FRONT_SENSOR_LINE_ACTIVE_LOW = true;
constexpr bool REAR_SENSOR_LINE_ACTIVE_LOW = true;

// TB6612FNG: motor A is left; motor B is right. Avoid S3 USB and strapping pins.
// constexpr uint8_t LEFT_MOTOR_IN1_PIN = 11;
// constexpr uint8_t LEFT_MOTOR_IN2_PIN = 12;
// constexpr uint8_t LEFT_MOTOR_PWM_PIN = 13;
// constexpr uint8_t RIGHT_MOTOR_IN1_PIN = 14;
// constexpr uint8_t RIGHT_MOTOR_IN2_PIN = 15;
// constexpr uint8_t RIGHT_MOTOR_PWM_PIN = 16;
constexpr uint8_t LEFT_MOTOR_IN1_PIN = 14;
constexpr uint8_t LEFT_MOTOR_IN2_PIN = 15;
constexpr uint8_t LEFT_MOTOR_PWM_PIN = 16;
constexpr uint8_t RIGHT_MOTOR_IN1_PIN = 11;
constexpr uint8_t RIGHT_MOTOR_IN2_PIN = 12;
constexpr uint8_t RIGHT_MOTOR_PWM_PIN = 13;
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
// Initial low-pass time constant for derivative noise from the binary sensor array.
// Keep gains unchanged until hardware traces establish a safe tuning baseline.
constexpr uint32_t PID_DERIVATIVE_FILTER_TAU_MS = 30;

// 75 % of the original 100: more cycle-to-cycle sensor consistency at speed.
constexpr int BASE_SPEED = 75;
constexpr uint32_t CONTROL_PERIOD_MS = 10;
constexpr uint32_t CONTROL_DT_MAX_MS = 50;  // bound PID integration after scheduling stalls

// Retain the last commanded motor speeds for this many cycles (~0.5 s) after
// the line vanishes before accepting a genuine line loss. This is not coasting;
// measure stopping distance before changing the grace period or action.
constexpr uint16_t LINE_LOSS_GRACE_CYCLES = 50;

// Corner handling in control_step.cpp: a run of adjacent
// sensors firing together marks a lateral line segment, i.e. a sharp turn.
// At speed the cluster can transit the array in a couple of control cycles,
// so accept one directional cluster sample but require a confirmed blackout
// within CORNER_RECENT_CYCLES of the latest cluster sighting.
constexpr uint8_t CORNER_MIN_RUN = 3;         // adjacent sensors = corner signature
constexpr uint8_t CORNER_RECENT_CYCLES = 5;   // blackout shortly after a cluster confirms
// React to one directional cluster sample for turn candidates. Keep the
// separate blackout and line-reacquisition confirmations at two samples.
constexpr uint8_t CORNER_CONFIRM_CYCLES = 1;
constexpr uint8_t CORNER_BLACKOUT_CONFIRM_CYCLES = 2;
constexpr uint8_t LINE_REACQUIRE_CONFIRM_CYCLES = 2;
constexpr int CORNER_PIVOT_SPEED = 90;        // spin PWM while rotating on the spot
constexpr uint32_t CORNER_PIVOT_TIMEOUT_MS = 1500;

}  // namespace Config
