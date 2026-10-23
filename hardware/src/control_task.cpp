#include <Arduino.h>
#include "runtime.h"

#include <freertos/task.h>
#include <string.h>

#include "config.h"
#include "control_step.h"

namespace {

void publishPidState(RuntimeContext* context, const PidConfig& config,
                     bool persisted) {
  PidStateSnapshot state = {};
  state.config = config;
  state.persisted = persisted;
  xQueueOverwrite(context->pidStateQueue, &state);
}

void enqueueAck(RuntimeContext* context, const PidAckMessage& acknowledgement) {
  if (xQueueSend(context->ackQueue, &acknowledgement, 0) != pdPASS) {
    recordAckQueueDrop(context);
  }
}

void applyMotorOutput(MotorDriver& motors, bool& enabled,
                      const ControlOutput& output) {
  if (output.motorAction == MotorAction::Hold) return;
  if (output.motorAction == MotorAction::Stop) {
    motors.stop();
    return;
  }
  if (!enabled) {
    motors.enable();
    enabled = true;
  }
  motors.setSpeeds(output.leftSpeed, output.rightSpeed);
}

void processPidCommand(RuntimeContext* context, ControlStep& control,
                       PidConfig& activePid, bool& persisted,
                       bool& persistencePending,
                       const MqttPidCommand& command) {
  PidConfig candidate;
  PidAckMessage acknowledgement;
  const PidCommandDisposition disposition = preparePidCommand(
      activePid, persisted, persistencePending, context->storageAvailable,
      command, candidate, acknowledgement);

  if (disposition != PidCommandDisposition::Apply) {
    enqueueAck(context, acknowledgement);
    return;
  }

  if (!control.configurePid(candidate)) {
    acknowledgement.status = PidAckStatus::Rejected;
    strncpy(acknowledgement.reason, "invalid_pid",
            sizeof(acknowledgement.reason) - 1);
    enqueueAck(context, acknowledgement);
    return;
  }

  PidPersistenceRequest request;
  request.config = candidate;
  if (xQueueSend(context->persistenceRequestQueue, &request, 0) != pdPASS) {
    control.configurePid(activePid);
    acknowledgement.status = PidAckStatus::Rejected;
    strncpy(acknowledgement.reason, "storage_busy",
            sizeof(acknowledgement.reason) - 1);
    enqueueAck(context, acknowledgement);
    return;
  }

  activePid = candidate;
  persisted = false;
  persistencePending = true;
  publishPidState(context, activePid, persisted);
  enqueueAck(context, acknowledgement);
}

void processPersistenceResults(RuntimeContext* context, PidConfig& activePid,
                               bool& persisted, bool& persistencePending) {
  PidPersistenceResult result;
  while (xQueueReceive(context->persistenceResultQueue, &result, 0) == pdPASS) {
    if (!persistencePending || result.revision != activePid.revision ||
        strcmp(result.requestId, activePid.requestId) != 0) {
      continue;
    }
    persistencePending = false;
    persisted = result.success;

    PidAckMessage acknowledgement = {};
    strncpy(acknowledgement.requestId, result.requestId,
            sizeof(acknowledgement.requestId) - 1);
    acknowledgement.status = result.success ? PidAckStatus::Persisted
                                            : PidAckStatus::Failed;
    acknowledgement.revision = result.revision;
    if (!result.success) {
      strncpy(acknowledgement.reason, "persist_failed",
              sizeof(acknowledgement.reason) - 1);
    }
    publishPidState(context, activePid, persisted);
    enqueueAck(context, acknowledgement);
  }
}

}  // namespace

void controlTask(void* argument) {
  RuntimeContext* context = static_cast<RuntimeContext*>(argument);
  if (context == NULL || context->lineSensor == NULL ||
      context->motorDriver == NULL) {
    vTaskDelete(NULL);
    return;
  }

  ControlStep control;
  PidConfig activePid = context->initialPid;
  if (!control.configurePid(activePid)) activePid = defaultPidConfig();
  bool persisted = context->initialPidPersisted;
  bool persistencePending = false;
  bool motorsEnabled = false;
  publishPidState(context, activePid, persisted);

  TickType_t lastWake = xTaskGetTickCount();
  TickType_t periodTicks = pdMS_TO_TICKS(Config::CONTROL_PERIOD_MS);
  if (periodTicks == 0) periodTicks = 1;
  uint32_t previousControlMs = millis();
  uint32_t lastTelemetryMs = previousControlMs;
  uint32_t sequence = 0;
  uint32_t droppedFrames = 0;

  for (;;) {
    vTaskDelayUntil(&lastWake, periodTicks);

    processPersistenceResults(context, activePid, persisted,
                              persistencePending);

    MqttPidCommand command;
    if (xQueueReceive(context->pidCommandQueue, &command, 0) == pdPASS) {
      processPidCommand(context, control, activePid, persisted,
                        persistencePending, command);
    }

    const uint32_t nowMs = millis();
    uint32_t elapsedMs = nowMs - previousControlMs;
    previousControlMs = nowMs;
    if (elapsedMs == 0) elapsedMs = 1;
    uint32_t pidDtMs = elapsedMs;
    if (pidDtMs > Config::CONTROL_DT_MAX_MS) {
      pidDtMs = Config::CONTROL_DT_MAX_MS;
    }

    const SensorFrame frame = context->lineSensor->read();
    const ControlOutput output = control.update(frame, pidDtMs, nowMs);
    applyMotorOutput(*context->motorDriver, motorsEnabled, output);
    const uint32_t sampleSequence = ++sequence;

    if (output.event != ControlEvent::None) {
      ControlEventSnapshot event = {};
      event.sequence = sampleSequence;
      event.uptimeMs = nowMs;
      event.mask = output.mask;
      event.hasLine = output.hasLine;
      event.position = output.position;
      event.mode = output.mode;
      event.event = output.event;
      if (xQueueSend(context->eventQueue, &event, 0) != pdPASS) {
        recordEventDrop(context);
      }
    }

    const uint32_t telemetryNowMs = millis();
    if (telemetryNowMs - lastTelemetryMs >= 100) {
      lastTelemetryMs = telemetryNowMs;
      if (uxQueueMessagesWaiting(context->telemetryQueue) != 0) {
        ++droppedFrames;
      }
      TelemetrySnapshot snapshot = {};
      snapshot.sequence = sampleSequence;
      snapshot.uptimeMs = telemetryNowMs;
      snapshot.dtMs = elapsedMs;
      snapshot.mask = output.mask;
      snapshot.hasLine = output.hasLine;
      snapshot.position = output.position;
      snapshot.error = output.error;
      snapshot.correction = output.correction;
      snapshot.leftPwm = static_cast<int16_t>(output.leftSpeed);
      snapshot.rightPwm = static_cast<int16_t>(output.rightSpeed);
      snapshot.mode = output.mode;
      snapshot.pidRevision = activePid.revision;
      snapshot.droppedFrames = droppedFrames;
      snapshot.droppedAcks = readAckQueueDrops(context);
      snapshot.droppedEvents = readEventDrops(context);
      snapshot.frontMask = output.frontMask;
      snapshot.frontHasLine = output.frontHasLine;
      snapshot.frontPosition = output.frontPosition;
      snapshot.rearMask = output.rearMask;
      snapshot.rearHasLine = output.rearHasLine;
      snapshot.rearPosition = output.rearPosition;
      snapshot.controlSensor = output.controlSensor;
      xQueueOverwrite(context->telemetryQueue, &snapshot);
    }
  }
}
