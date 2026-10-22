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

// 75 % of the original 100: more cycle-to-cycle sensor consistency at speed.
constexpr int BASE_SPEED = 75;
constexpr uint32_t CONTROL_PERIOD_MS = 10;
constexpr uint32_t CONTROL_DT_MAX_MS = 50;  // bound PID integration after scheduling stalls

// Coast, keeping the last commanded speeds, for this many cycles (~0.5 s)
// after the line vanishes before accepting a genuine line loss. Sensor
// dropouts should not strand the robot.
constexpr uint16_t LINE_LOSS_GRACE_CYCLES = 50;

// 90 degree corner handling (see the FSM in main.cpp): a run of adjacent
// sensors firing together marks a lateral line segment, i.e. a sharp turn.
// At speed the cluster can transit the array in a couple of control cycles,
// so confirmation is anchored to the blackout arriving within
// CORNER_RECENT_CYCLES of the latest cluster sighting.
constexpr uint8_t CORNER_MIN_RUN = 3;         // adjacent sensors = corner signature
constexpr uint8_t CORNER_RECENT_CYCLES = 5;   // blackout shortly after a cluster confirms
constexpr int CORNER_PIVOT_SPEED = 90;        // spin PWM while rotating on the spot
constexpr uint32_t CORNER_PIVOT_TIMEOUT_MS = 1500;

}  // namespace Config
