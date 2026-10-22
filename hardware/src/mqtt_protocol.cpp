#include "mqtt_protocol.h"

#include <ArduinoJson.h>
#include <math.h>
#include <string.h>

namespace {

const uint8_t PROTOCOL_VERSION = 1;

bool validRequestId(const char* requestId, size_t length) {
  if (length == 0 || length > PID_REQUEST_ID_MAX_BYTES) return false;
  for (size_t i = 0; i < length; ++i) {
    const char c = requestId[i];
    const bool valid = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                       (c >= '0' && c <= '9') || c == '-' || c == '_';
    if (!valid) return false;
  }
  return true;
}

const char* modeName(ControlMode mode) {
  switch (mode) {
    case ControlMode::Track:
      return "track";
    case ControlMode::Pivot:
      return "pivot";
    case ControlMode::Lost:
      return "lost";
  }
  return "unknown";
}

const char* eventName(ControlEvent event) {
  switch (event) {
    case ControlEvent::CornerCluster:
      return "corner_cluster";
    case ControlEvent::PivotStarted:
      return "pivot_started";
    case ControlEvent::LineReacquired:
      return "line_reacquired";
    case ControlEvent::PivotTimedOut:
      return "pivot_timeout";
    case ControlEvent::None:
      return "none";
  }
  return "unknown";
}

const char* ackStatusName(PidAckStatus status) {
  switch (status) {
    case PidAckStatus::Applied:
      return "applied";
    case PidAckStatus::Persisted:
      return "persisted";
    case PidAckStatus::Rejected:
      return "rejected";
    case PidAckStatus::Failed:
      return "failed";
  }
  return "failed";
}

void writeAck(PidAckMessage& acknowledgement, const char* requestId,
             PidAckStatus status, const char* reason, uint32_t revision) {
  memset(&acknowledgement, 0, sizeof(acknowledgement));
  if (requestId != NULL) {
    size_t length = 0;
    while (length < sizeof(acknowledgement.requestId) - 1 &&
           requestId[length] != '\0') {
      acknowledgement.requestId[length] = requestId[length];
      ++length;
    }
  }
  acknowledgement.status = status;
  acknowledgement.revision = revision;
  if (reason != NULL) {
    strncpy(acknowledgement.reason, reason,
            sizeof(acknowledgement.reason) - 1);
  }
}

template <size_t Capacity>
size_t serializeDocument(StaticJsonDocument<Capacity>& document, char* output,
                         size_t outputCapacity) {
  if (output == NULL || outputCapacity == 0 || document.overflowed()) return 0;
  const size_t required = measureJson(document);
  if (required == 0 || required >= outputCapacity ||
      required > MQTT_MAX_PAYLOAD_BYTES) {
    return 0;
  }
  return serializeJson(document, output, outputCapacity);
}

}  // namespace

bool parseMqttPidCommand(const char* payload, size_t length,
                         MqttPidCommand& command) {
  memset(&command, 0, sizeof(command));
  if (payload == NULL || length == 0 || length > MQTT_MAX_PAYLOAD_BYTES) {
    return false;
  }

  StaticJsonDocument<256> document;
  const DeserializationError error = deserializeJson(document, payload, length);
  if (error || !document.is<JsonObjectConst>()) return false;

  const JsonVariantConst version = document["v"];
  const JsonVariantConst request = document["requestId"];
  const JsonVariantConst baseRevision = document["baseRevision"];
  const JsonVariantConst kp = document["kp"];
  const JsonVariantConst ki = document["ki"];
  const JsonVariantConst kd = document["kd"];
  if (!version.is<uint8_t>() || version.as<uint8_t>() != PROTOCOL_VERSION ||
      !request.is<const char*>()) {
    return false;
  }

  const char* requestId = request.as<const char*>();
  const size_t requestLength = strlen(requestId);
  if (!validRequestId(requestId, requestLength)) return false;
  memcpy(command.requestId, requestId, requestLength);
  command.requestId[requestLength] = '\0';

  if (!baseRevision.is<uint32_t>() || !kp.is<float>() || !ki.is<float>() ||
      !kd.is<float>()) {
    return false;
  }
  command.baseRevision = baseRevision.as<uint32_t>();
  command.kp = kp.as<float>();
  command.ki = ki.as<float>();
  command.kd = kd.as<float>();
  return isfinite(command.kp) && isfinite(command.ki) && isfinite(command.kd) &&
         isPidGainsValid(command.kp, command.ki, command.kd);
}

PidCommandDisposition preparePidCommand(const PidConfig& current,
                                         bool currentPersisted,
                                         bool persistencePending,
                                         bool storageAvailable,
                                         const MqttPidCommand& command,
                                         PidConfig& candidate,
                                         PidAckMessage& acknowledgement) {
  candidate = current;
  size_t requestLength = 0;
  while (requestLength < sizeof(command.requestId) &&
         command.requestId[requestLength] != '\0') {
    ++requestLength;
  }
  if (!validRequestId(command.requestId, requestLength)) {
    writeAck(acknowledgement, NULL, PidAckStatus::Rejected, "invalid_request",
             current.revision);
    return PidCommandDisposition::Reject;
  }

  if (current.requestId[0] != '\0' &&
      strcmp(current.requestId, command.requestId) == 0) {
    const PidAckStatus status = currentPersisted
                                    ? PidAckStatus::Persisted
                                    : (persistencePending ? PidAckStatus::Applied
                                                          : PidAckStatus::Failed);
    const char* reason = currentPersisted
                             ? "duplicate"
                             : (persistencePending ? "persistence_pending"
                                                   : "persistence_failed");
    writeAck(acknowledgement, command.requestId, status, reason,
             current.revision);
    return PidCommandDisposition::Duplicate;
  }
  if (!storageAvailable) {
    writeAck(acknowledgement, command.requestId, PidAckStatus::Rejected,
             "storage_unavailable", current.revision);
    return PidCommandDisposition::Reject;
  }
  if (persistencePending) {
    writeAck(acknowledgement, command.requestId, PidAckStatus::Rejected,
             "busy", current.revision);
    return PidCommandDisposition::Reject;
  }
  if (command.baseRevision != current.revision) {
    writeAck(acknowledgement, command.requestId, PidAckStatus::Rejected,
             "stale_revision", current.revision);
    return PidCommandDisposition::Reject;
  }
  if (current.revision == UINT32_MAX) {
    writeAck(acknowledgement, command.requestId, PidAckStatus::Rejected,
             "revision_exhausted", current.revision);
    return PidCommandDisposition::Reject;
  }

  candidate.schemaVersion = PID_CONFIG_SCHEMA_VERSION;
  candidate.kp = command.kp;
  candidate.ki = command.ki;
  candidate.kd = command.kd;
  candidate.revision = current.revision + 1;
  memset(candidate.requestId, 0, sizeof(candidate.requestId));
  memcpy(candidate.requestId, command.requestId, requestLength + 1);
  if (!isPidConfigValid(candidate)) {
    candidate = current;
    writeAck(acknowledgement, command.requestId, PidAckStatus::Rejected,
             "invalid_pid", current.revision);
    return PidCommandDisposition::Reject;
  }
  writeAck(acknowledgement, command.requestId, PidAckStatus::Applied, NULL,
           candidate.revision);
  return PidCommandDisposition::Apply;
}

size_t encodeTelemetryPayload(const char* robotId, const char* bootId,
                              const TelemetrySnapshot& snapshot, char* output,
                              size_t capacity) {
  if (robotId == NULL || bootId == NULL) return 0;
  StaticJsonDocument<640> document;
  document["v"] = PROTOCOL_VERSION;
  document["robotId"] = robotId;
  document["bootId"] = bootId;
  document["seq"] = snapshot.sequence;
  document["uptimeMs"] = snapshot.uptimeMs;
  document["mask"] = snapshot.mask;
  if (snapshot.hasLine) {
    document["position"] = snapshot.position;
    document["error"] = snapshot.error;
  } else {
    document["position"] = nullptr;
    document["error"] = nullptr;
  }
  document["correction"] = snapshot.correction;
  document["leftPwm"] = snapshot.leftPwm;
  document["rightPwm"] = snapshot.rightPwm;
  document["mode"] = modeName(snapshot.mode);
  document["dtMs"] = snapshot.dtMs;
  document["pidRevision"] = snapshot.pidRevision;
  document["droppedFrames"] = snapshot.droppedFrames;
  document["droppedAcks"] = snapshot.droppedAcks;
  document["droppedEvents"] = snapshot.droppedEvents;
  return serializeDocument(document, output, capacity);
}

size_t encodeEventPayload(const char* robotId, const char* bootId,
                          const ControlEventSnapshot& event, char* output,
                          size_t capacity) {
  if (robotId == NULL || bootId == NULL || event.event == ControlEvent::None) {
    return 0;
  }
  StaticJsonDocument<384> document;
  document["v"] = PROTOCOL_VERSION;
  document["robotId"] = robotId;
  document["bootId"] = bootId;
  document["seq"] = event.sequence;
  document["uptimeMs"] = event.uptimeMs;
  document["event"] = eventName(event.event);
  document["mask"] = event.mask;
  document["mode"] = modeName(event.mode);
  if (event.hasLine) {
    document["position"] = event.position;
  } else {
    document["position"] = nullptr;
  }
  return serializeDocument(document, output, capacity);
}

size_t encodePidStatePayload(const char* robotId,
                             const PidStateSnapshot& snapshot, char* output,
                             size_t capacity) {
  if (robotId == NULL || !isPidConfigValid(snapshot.config)) return 0;
  StaticJsonDocument<384> document;
  document["v"] = PROTOCOL_VERSION;
  document["robotId"] = robotId;
  document["kp"] = snapshot.config.kp;
  document["ki"] = snapshot.config.ki;
  document["kd"] = snapshot.config.kd;
  document["revision"] = snapshot.config.revision;
  document["persisted"] = snapshot.persisted;
  if (snapshot.config.requestId[0] != '\0') {
    document["requestId"] = snapshot.config.requestId;
  }
  return serializeDocument(document, output, capacity);
}

size_t encodePidAckPayload(const char* robotId, const PidAckMessage& ack,
                           char* output, size_t capacity) {
  if (robotId == NULL) return 0;
  StaticJsonDocument<384> document;
  document["v"] = PROTOCOL_VERSION;
  document["robotId"] = robotId;
  document["requestId"] = ack.requestId;
  document["status"] = ackStatusName(ack.status);
  if (ack.reason[0] != '\0') document["reason"] = ack.reason;
  document["revision"] = ack.revision;
  return serializeDocument(document, output, capacity);
}
