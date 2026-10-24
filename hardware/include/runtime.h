#pragma once

#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>

#include "device_settings.h"
#include "line_sensor.h"
#include "motor_driver.h"
#include "mqtt_protocol.h"

struct PidPersistenceRequest {
  PidConfig config;
};

struct PidPersistenceResult {
  uint32_t revision;
  char requestId[PID_REQUEST_ID_STORAGE_BYTES];
  bool success;
};

struct RuntimeContext {
  DeviceSettings settings;
  PidConfig initialPid;
  bool initialPidPersisted;
  bool storageAvailable;
  char bootId[17];
  LineSensor* lineSensor;
  MotorDriver* motorDriver;
  portMUX_TYPE ackDropsMux = portMUX_INITIALIZER_UNLOCKED;
  uint32_t ackQueueDrops = 0;
  uint32_t eventDrops = 0;
  QueueHandle_t telemetryQueue;
  QueueHandle_t pidCommandQueue;
  QueueHandle_t pidStateQueue;
  QueueHandle_t ackQueue;
  QueueHandle_t eventQueue;
  QueueHandle_t persistenceRequestQueue;
  QueueHandle_t persistenceResultQueue;
};

inline void recordAckQueueDrop(RuntimeContext* context) {
  portENTER_CRITICAL(&context->ackDropsMux);
  ++context->ackQueueDrops;
  portEXIT_CRITICAL(&context->ackDropsMux);
}

inline uint32_t readAckQueueDrops(RuntimeContext* context) {
  portENTER_CRITICAL(&context->ackDropsMux);
  const uint32_t value = context->ackQueueDrops;
  portEXIT_CRITICAL(&context->ackDropsMux);
  return value;
}

inline void recordEventDrop(RuntimeContext* context) {
  portENTER_CRITICAL(&context->ackDropsMux);
  ++context->eventDrops;
  portEXIT_CRITICAL(&context->ackDropsMux);
}

inline uint32_t readEventDrops(RuntimeContext* context) {
  portENTER_CRITICAL(&context->ackDropsMux);
  const uint32_t value = context->eventDrops;
  portEXIT_CRITICAL(&context->ackDropsMux);
  return value;
}

void controlTask(void* argument);
void networkTask(void* argument);
void storageTask(void* argument);
