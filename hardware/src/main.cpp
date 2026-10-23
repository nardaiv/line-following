#include <Arduino.h>

#include <esp_system.h>
#include <limits.h>
#include <stdio.h>
#include <string.h>

#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/task.h>

#include "config.h"
#include "device_settings.h"
#include "device_storage.h"
#include "line_sensor.h"
#include "motor_driver.h"
#include "pid_config.h"
#include "provisioning_protocol.h"
#include "runtime.h"

namespace {

LineSensor lineSensor;
MotorDriver motors;
RuntimeContext runtimeContext;
char serialLine[PROVISION_FRAME_MAX_BYTES + 1];
size_t serialLineLength = 0;
bool serialLineOverflow = false;

bool settingsConfigured() {
  return isDeviceSettingsValid(runtimeContext.settings);
}

void printInfo() {
  const SensorFrame frame = lineSensor.read();
  Serial.print("INFO|configured=");
  Serial.print(settingsConfigured() ? 1 : 0);
  if (settingsConfigured()) {
    Serial.print("|robotId=");
    Serial.print(runtimeContext.settings.robotId);
    Serial.print("|mqttHost=");
    Serial.print(runtimeContext.settings.mqttHost);
    Serial.print("|mqttPort=");
    Serial.print(runtimeContext.settings.mqttPort);
  }
  Serial.print("|kp=");
  Serial.print(runtimeContext.initialPid.kp, 6);
  Serial.print("|ki=");
  Serial.print(runtimeContext.initialPid.ki, 6);
  Serial.print("|kd=");
  Serial.print(runtimeContext.initialPid.kd, 6);
  Serial.print("|revision=");
  Serial.print(runtimeContext.initialPid.revision);
  Serial.print("|sensorMask=");
  Serial.print(frame.front.mask);
  Serial.print("|rearSensorMask=");
  Serial.println(frame.rear.mask);
}

bool commitPidConfig(PidConfig candidate) {
  if (runtimeContext.initialPid.revision == UINT32_MAX) return false;
  candidate.schemaVersion = PID_CONFIG_SCHEMA_VERSION;
  candidate.revision = runtimeContext.initialPid.revision + 1;
  if (!isPidConfigValid(candidate) || !savePidConfig(candidate)) return false;
  runtimeContext.initialPid = candidate;
  runtimeContext.initialPidPersisted = true;
  return true;
}

void handleProvisionCommand(const char* line, size_t length) {
  ProvisionCommand command;
  if (!parseProvisionCommand(line, length, command)) {
    Serial.println("ERR|INVALID");
    return;
  }

  if (command.type == ProvisionCommandType::Info) {
    printInfo();
    return;
  }

  switch (command.type) {
    case ProvisionCommandType::ConfigureDevice:
      if (!saveDeviceSettings(command.device)) {
        Serial.println("ERR|STORAGE");
        return;
      }
      runtimeContext.settings = command.device;
      Serial.println("ACK|CFG|SAVED");
      printInfo();
      return;

    case ProvisionCommandType::SetPid:
    case ProvisionCommandType::ResetPid:
      if (commitPidConfig(command.pid)) {
        Serial.print("ACK|PID|SAVED|revision=");
        Serial.println(runtimeContext.initialPid.revision);
      } else {
        Serial.println("ERR|PID_OR_STORAGE");
      }
      return;

    case ProvisionCommandType::ResetAll: {
      const bool networkCleared = clearDeviceSettings();
      const bool pidCleared = clearPidConfig();
      DeviceSettings reloadedSettings;
      if (loadDeviceSettings(reloadedSettings) &&
          isDeviceSettingsValid(reloadedSettings)) {
        runtimeContext.settings = reloadedSettings;
      } else {
        clearDeviceSettingsValue(runtimeContext.settings);
      }
      PidConfig reloadedPid;
      runtimeContext.initialPidPersisted = loadPidConfig(reloadedPid);
      runtimeContext.initialPid = runtimeContext.initialPidPersisted
                                      ? reloadedPid
                                      : defaultPidConfig();
      if (!networkCleared || !pidCleared) {
        Serial.println("ERR|STORAGE");
        return;
      }
      Serial.println("ACK|RESET|CLEARED");
      printInfo();
      return;
    }

    case ProvisionCommandType::Invalid:
    case ProvisionCommandType::Info:
      break;
  }
  Serial.println("ERR|INVALID");
}

void pollProvisioningSerial() {
  while (Serial.available() > 0) {
    const int incoming = Serial.read();
    if (incoming < 0) break;
    if (incoming == '\n') {
      if (serialLineOverflow) {
        Serial.println("ERR|FRAME_TOO_LONG");
      } else {
        if (serialLineLength > 0 && serialLine[serialLineLength - 1] == '\r') {
          --serialLineLength;
        }
        if (serialLineLength > 0) {
          serialLine[serialLineLength] = '\0';
          handleProvisionCommand(serialLine, serialLineLength);
        }
      }
      serialLineLength = 0;
      serialLineOverflow = false;
    } else if (!serialLineOverflow) {
      if (serialLineLength < PROVISION_FRAME_MAX_BYTES) {
        serialLine[serialLineLength++] = static_cast<char>(incoming);
      } else {
        serialLineOverflow = true;
      }
    }
  }
}

bool createRuntimeQueues() {
  runtimeContext.telemetryQueue =
      xQueueCreate(1, sizeof(TelemetrySnapshot));
  runtimeContext.pidCommandQueue = xQueueCreate(1, sizeof(MqttPidCommand));
  runtimeContext.pidStateQueue = xQueueCreate(1, sizeof(PidStateSnapshot));
  runtimeContext.ackQueue = xQueueCreate(8, sizeof(PidAckMessage));
  runtimeContext.eventQueue = xQueueCreate(8, sizeof(ControlEventSnapshot));
  runtimeContext.persistenceRequestQueue =
      xQueueCreate(1, sizeof(PidPersistenceRequest));
  runtimeContext.persistenceResultQueue =
      xQueueCreate(2, sizeof(PidPersistenceResult));
  return runtimeContext.telemetryQueue != NULL &&
         runtimeContext.pidCommandQueue != NULL &&
         runtimeContext.pidStateQueue != NULL &&
         runtimeContext.ackQueue != NULL &&
         runtimeContext.eventQueue != NULL &&
         runtimeContext.persistenceRequestQueue != NULL &&
         runtimeContext.persistenceResultQueue != NULL;
}

void startRuntimeTasks() {
  if (!createRuntimeQueues()) {
    Serial.println("ERR|QUEUE_ALLOCATION");
    motors.standby();
    return;
  }

  TaskHandle_t storageHandle = NULL;
  runtimeContext.storageAvailable =
      xTaskCreatePinnedToCore(storageTask, "storageTask", 4096,
                              &runtimeContext, 1, &storageHandle, 0) == pdPASS;

  const BaseType_t controlCreated =
      xTaskCreatePinnedToCore(controlTask, "controlTask", 4096,
                              &runtimeContext, 4, NULL, 1);
  if (controlCreated != pdPASS) {
    Serial.println("ERR|CONTROL_TASK");
    motors.standby();
    return;
  }

  if (xTaskCreatePinnedToCore(networkTask, "networkTask", 8192,
                              &runtimeContext, 1, NULL, 0) != pdPASS) {
    Serial.println("WARN|NETWORK_TASK_UNAVAILABLE|LOCAL_CONTROL_ONLY");
  }
  if (!runtimeContext.storageAvailable) {
    Serial.println("WARN|STORAGE_TASK_UNAVAILABLE|REMOTE_PID_DISABLED");
  }
}

void provisioningStartupWindow() {
  const uint32_t startMs = millis();
  while (!settingsConfigured() ||
         static_cast<uint32_t>(millis() - startMs) < 5000U) {
    pollProvisioningSerial();
    delay(1);
  }
}

}  // namespace

void setup() {
  Serial.begin(Config::SERIAL_BAUD);
  lineSensor.begin();
  motors.begin();
  runtimeContext.lineSensor = &lineSensor;
  runtimeContext.motorDriver = &motors;

  runtimeContext.initialPid = defaultPidConfig();
  runtimeContext.initialPidPersisted =
      loadPidConfig(runtimeContext.initialPid);
  if (!runtimeContext.initialPidPersisted) {
    runtimeContext.initialPid = defaultPidConfig();
  }

  DeviceSettings savedSettings;
  if (!loadDeviceSettings(savedSettings) ||
      !isDeviceSettingsValid(savedSettings)) {
    clearDeviceSettingsValue(runtimeContext.settings);
  } else {
    runtimeContext.settings = savedSettings;
  }

  snprintf(runtimeContext.bootId, sizeof(runtimeContext.bootId), "%08lX%08lX",
           static_cast<unsigned long>(millis()),
           static_cast<unsigned long>(esp_random()));
  Serial.println("Provisioning window: 5 seconds; motors stay in standby.");
  if (!settingsConfigured()) {
    Serial.println("Provision Wi-Fi/MQTT settings before the robot will arm.");
  }
  Serial.println("Send INFO for non-secret state. Credentials are never echoed.");
  provisioningStartupWindow();
  startRuntimeTasks();
}

void loop() {
  // Control, storage, and network work run in dedicated FreeRTOS tasks.
  vTaskDelay(pdMS_TO_TICKS(1000));
}
