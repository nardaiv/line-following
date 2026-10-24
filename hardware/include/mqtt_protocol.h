#pragma once

#include <stddef.h>
#include <stdint.h>

#include "control_step.h"
#include "pid_config.h"

constexpr size_t MQTT_MAX_PAYLOAD_BYTES = 512;
constexpr size_t PID_REQUEST_ID_MAX_BYTES = 36;

enum class PidCommandDisposition : uint8_t { Reject, Apply, Duplicate };

enum class PidAckStatus : uint8_t { Applied, Persisted, Rejected, Failed };

struct MqttPidCommand {
  char requestId[PID_REQUEST_ID_MAX_BYTES + 1];
  uint32_t baseRevision;
  float kp;
  float ki;
  float kd;
};

struct TelemetrySnapshot {
  uint32_t sequence;
  uint32_t uptimeMs;
  uint32_t dtMs;
  uint8_t mask;
  bool hasLine;
  float position;
  float error;
  float correction;
  int16_t leftPwm;
  int16_t rightPwm;
  ControlMode mode;
  uint32_t pidRevision;
  uint32_t droppedFrames;
  uint32_t droppedAcks;
  uint32_t droppedEvents;
  uint8_t frontMask;
  bool frontHasLine;
  float frontPosition;
  uint8_t rearMask;
  bool rearHasLine;
  float rearPosition;
  ControlSensor controlSensor;
};

struct ControlEventSnapshot {
  uint32_t sequence;
  uint32_t uptimeMs;
  uint8_t mask;
  bool hasLine;
  float position;
  ControlMode mode;
  ControlEvent event;
};

struct PidStateSnapshot {
  PidConfig config;
  bool persisted;
};

struct PidAckMessage {
  char requestId[PID_REQUEST_ID_MAX_BYTES + 1];
  PidAckStatus status;
  char reason[32];
  uint32_t revision;
};

PidCommandDisposition preparePidCommand(const PidConfig& current,
                                         bool currentPersisted,
                                         bool persistencePending,
                                         bool storageAvailable,
                                         const MqttPidCommand& command,
                                         PidConfig& candidate,
                                         PidAckMessage& acknowledgement);
bool parseMqttPidCommand(const char* payload, size_t length,
                         MqttPidCommand& command);
size_t encodeTelemetryPayload(const char* robotId, const char* bootId,
                              const TelemetrySnapshot& snapshot, char* output,
                              size_t capacity);
size_t encodeEventPayload(const char* robotId, const char* bootId,
                          const ControlEventSnapshot& event, char* output,
                          size_t capacity);
size_t encodePidStatePayload(const char* robotId,
                             const PidStateSnapshot& snapshot, char* output,
                             size_t capacity);
size_t encodePidAckPayload(const char* robotId, const PidAckMessage& ack,
                           char* output, size_t capacity);
