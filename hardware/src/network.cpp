#include "runtime.h"

#include <Arduino.h>
#include <MQTT.h>
#include <WiFi.h>
#include <freertos/task.h>
#include <stdio.h>
#include <string.h>

namespace {

const uint32_t MIN_RECONNECT_MS = 1000;
const uint32_t MAX_RECONNECT_MS = 30000;
const uint32_t TELEMETRY_PUBLISH_PERIOD_MS = 100;

struct MqttCallbackContext {
  RuntimeContext* runtime;
  char pidSetTopic[80];
};

void enqueueRejected(RuntimeContext* runtime, const char* requestId,
                     const char* reason) {
  PidAckMessage acknowledgement = {};
  if (requestId != NULL) {
    strncpy(acknowledgement.requestId, requestId,
            sizeof(acknowledgement.requestId) - 1);
  }
  acknowledgement.status = PidAckStatus::Rejected;
  strncpy(acknowledgement.reason, reason,
          sizeof(acknowledgement.reason) - 1);
  if (xQueueSend(runtime->ackQueue, &acknowledgement, 0) != pdPASS) {
    recordAckQueueDrop(runtime);
  }
}

void mqttMessageReceived(MQTTClient* client, char topic[], char bytes[],
                         int length) {
  if (client == NULL || client->ref == NULL || topic == NULL || bytes == NULL ||
      length <= 0) {
    return;
  }
  MqttCallbackContext* callbackContext =
      static_cast<MqttCallbackContext*>(client->ref);
  RuntimeContext* runtime = callbackContext->runtime;
  if (runtime == NULL || strcmp(topic, callbackContext->pidSetTopic) != 0) {
    return;
  }

  MqttPidCommand command = {};
  if (!parseMqttPidCommand(bytes, static_cast<size_t>(length), command)) {
    if (command.requestId[0] != '\0') {
      enqueueRejected(runtime, command.requestId, "invalid_payload");
    }
    return;
  }

  if (xQueueSend(runtime->pidCommandQueue, &command, 0) != pdPASS) {
    enqueueRejected(runtime, command.requestId, "command_queue_full");
  }
}

bool publishAck(MQTTClient& mqtt, const char* topic, const char* robotId,
                const PidAckMessage& acknowledgement) {
  char payload[MQTT_MAX_PAYLOAD_BYTES + 1];
  const size_t length = encodePidAckPayload(
      robotId, acknowledgement, payload, sizeof(payload));
  if (length == 0) return false;
  return mqtt.publish(topic, payload, static_cast<int>(length), false, 1);
}

bool publishPidState(MQTTClient& mqtt, const char* topic, const char* robotId,
                     const PidStateSnapshot& state) {
  char payload[MQTT_MAX_PAYLOAD_BYTES + 1];
  const size_t length = encodePidStatePayload(robotId, state, payload,
                                               sizeof(payload));
  if (length == 0) return false;
  return mqtt.publish(topic, payload, static_cast<int>(length), true, 1);
}

bool publishTelemetry(MQTTClient& mqtt, const char* topic, const char* robotId,
                      const char* bootId, const TelemetrySnapshot& snapshot,
                      uint32_t networkDrops) {
  char payload[MQTT_MAX_PAYLOAD_BYTES + 1];
  TelemetrySnapshot copy = snapshot;
  copy.droppedFrames += networkDrops;
  const size_t length = encodeTelemetryPayload(robotId, bootId, copy, payload,
                                                 sizeof(payload));
  if (length == 0) return false;
  return mqtt.publish(topic, payload, static_cast<int>(length), false, 0);
}

bool publishEvent(MQTTClient& mqtt, const char* topic, const char* robotId,
                  const char* bootId,
                  const ControlEventSnapshot& event) {
  char payload[MQTT_MAX_PAYLOAD_BYTES + 1];
  const size_t length =
      encodeEventPayload(robotId, bootId, event, payload, sizeof(payload));
  if (length == 0) return false;
  return mqtt.publish(topic, payload, static_cast<int>(length), false, 0);
}

void publishStatus(MQTTClient& mqtt, const char* topic, const char* robotId,
                   const char* state) {
  char payload[160];
  int length;
  if (strcmp(state, "online") == 0) {
    length = snprintf(payload, sizeof(payload),
                      "{\"v\":1,\"robotId\":\"%s\",\"state\":\"online\","
                      "\"wifi\":\"connected\",\"rssi\":%d}",
                      robotId, WiFi.RSSI());
  } else {
    length = snprintf(payload, sizeof(payload),
                      "{\"v\":1,\"robotId\":\"%s\",\"state\":\"offline\"}",
                      robotId);
  }
  if (length > 0 && static_cast<size_t>(length) < sizeof(payload)) {
    mqtt.publish(topic, payload, length, true, 1);
  }
}

}  // namespace

void networkTask(void* argument) {
  RuntimeContext* runtime = static_cast<RuntimeContext*>(argument);
  if (runtime == NULL || !isDeviceSettingsValid(runtime->settings)) {
    vTaskDelete(NULL);
    return;
  }

  char telemetryTopic[80];
  char statusTopic[80];
  char pidSetTopic[80];
  char pidStateTopic[80];
  char pidAckTopic[80];
  char eventTopic[80];
  snprintf(telemetryTopic, sizeof(telemetryTopic), "robots/%s/telemetry",
           runtime->settings.robotId);
  snprintf(statusTopic, sizeof(statusTopic), "robots/%s/status",
           runtime->settings.robotId);
  snprintf(pidSetTopic, sizeof(pidSetTopic), "robots/%s/pid/set",
           runtime->settings.robotId);
  snprintf(pidStateTopic, sizeof(pidStateTopic), "robots/%s/pid/state",
           runtime->settings.robotId);
  snprintf(pidAckTopic, sizeof(pidAckTopic), "robots/%s/pid/ack",
           runtime->settings.robotId);
  snprintf(eventTopic, sizeof(eventTopic), "robots/%s/event",
           runtime->settings.robotId);

  MqttCallbackContext callbackContext = {};
  callbackContext.runtime = runtime;
  strncpy(callbackContext.pidSetTopic, pidSetTopic,
          sizeof(callbackContext.pidSetTopic) - 1);

  WiFiClient transport;
  MQTTClient mqtt(MQTT_MAX_PAYLOAD_BYTES, 128);
  mqtt.begin(runtime->settings.mqttHost, runtime->settings.mqttPort, transport);
  mqtt.setOptions(30, true, 1500);
  mqtt.onMessageAdvanced(mqttMessageReceived);
  mqtt.ref = &callbackContext;

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(runtime->settings.wifiSsid, runtime->settings.wifiPassword);

  const uint64_t mac = ESP.getEfuseMac();
  char clientId[32];
  snprintf(clientId, sizeof(clientId), "linebot-%012llX",
           static_cast<unsigned long long>(mac & 0xFFFFFFFFFFFFULL));
  char offlinePayload[96];
  snprintf(offlinePayload, sizeof(offlinePayload),
           "{\"v\":1,\"robotId\":\"%s\",\"state\":\"offline\"}",
           runtime->settings.robotId);

  PidStateSnapshot latestPidState = {};
  latestPidState.config = runtime->initialPid;
  latestPidState.persisted = runtime->initialPidPersisted;
  bool pidStateDirty = true;
  TelemetrySnapshot pendingTelemetry = {};
  bool hasPendingTelemetry = false;
  ControlEventSnapshot pendingEvent = {};
  bool hasPendingEvent = false;
  uint32_t networkDrops = 0;
  uint32_t reconnectDelayMs = MIN_RECONNECT_MS;
  uint32_t wifiReconnectDelayMs = MIN_RECONNECT_MS;
  uint32_t nextMqttAttemptMs = 0;
  uint32_t nextWifiAttemptMs = 0;
  uint32_t lastTelemetryPublishMs = 0;
  bool hasPendingAck = false;
  PidAckMessage pendingAck = {};

  for (;;) {
    const uint32_t nowMs = millis();
    if (WiFi.status() != WL_CONNECTED) {
      if (mqtt.connected()) {
        publishStatus(mqtt, statusTopic, runtime->settings.robotId, "offline");
        mqtt.disconnect();
      }
      if (static_cast<int32_t>(nowMs - nextWifiAttemptMs) >= 0) {
        WiFi.reconnect();
        nextWifiAttemptMs = nowMs + wifiReconnectDelayMs;
        wifiReconnectDelayMs *= 2;
        if (wifiReconnectDelayMs > MAX_RECONNECT_MS) {
          wifiReconnectDelayMs = MAX_RECONNECT_MS;
        }
      }
      TelemetrySnapshot received;
      while (xQueueReceive(runtime->telemetryQueue, &received, 0) == pdPASS) {
        if (hasPendingTelemetry) ++networkDrops;
        pendingTelemetry = received;
        hasPendingTelemetry = true;
      }
      if (hasPendingEvent) {
        recordEventDrop(runtime);
        hasPendingEvent = false;
      }
      ControlEventSnapshot staleEvent;
      while (xQueueReceive(runtime->eventQueue, &staleEvent, 0) == pdPASS) {
        recordEventDrop(runtime);
      }
      vTaskDelay(pdMS_TO_TICKS(50));
      continue;
    }

    if (WiFi.status() == WL_CONNECTED) {
      wifiReconnectDelayMs = MIN_RECONNECT_MS;
    }
    if (!mqtt.connected() &&
        static_cast<int32_t>(nowMs - nextMqttAttemptMs) >= 0) {
      mqtt.setWill(statusTopic, offlinePayload, true, 1);
      if (mqtt.connect(clientId, runtime->settings.mqttUser,
                       runtime->settings.mqttPassword)) {
        reconnectDelayMs = MIN_RECONNECT_MS;
        nextMqttAttemptMs = nowMs;
        publishStatus(mqtt, statusTopic, runtime->settings.robotId, "online");
        mqtt.subscribe(pidSetTopic, 1);
        pidStateDirty = true;
      } else {
        nextMqttAttemptMs = nowMs + reconnectDelayMs;
        reconnectDelayMs *= 2;
        if (reconnectDelayMs > MAX_RECONNECT_MS) {
          reconnectDelayMs = MAX_RECONNECT_MS;
        }
      }
    }

    if (mqtt.connected()) mqtt.loop();

    PidStateSnapshot stateUpdate;
    while (xQueueReceive(runtime->pidStateQueue, &stateUpdate, 0) == pdPASS) {
      latestPidState = stateUpdate;
      pidStateDirty = true;
    }
    TelemetrySnapshot telemetryUpdate;
    while (xQueueReceive(runtime->telemetryQueue, &telemetryUpdate, 0) == pdPASS) {
      if (hasPendingTelemetry) ++networkDrops;
      pendingTelemetry = telemetryUpdate;
      hasPendingTelemetry = true;
    }

    if (mqtt.connected()) {
      if (pidStateDirty &&
          publishPidState(mqtt, pidStateTopic, runtime->settings.robotId,
                          latestPidState)) {
        pidStateDirty = false;
      }

      if (!hasPendingAck &&
          xQueueReceive(runtime->ackQueue, &pendingAck, 0) == pdPASS) {
        hasPendingAck = true;
      }
      if (hasPendingAck &&
          publishAck(mqtt, pidAckTopic, runtime->settings.robotId, pendingAck)) {
        hasPendingAck = false;
      }

      if (hasPendingTelemetry &&
          nowMs - lastTelemetryPublishMs >= TELEMETRY_PUBLISH_PERIOD_MS &&
          publishTelemetry(mqtt, telemetryTopic, runtime->settings.robotId,
                           runtime->bootId, pendingTelemetry, networkDrops)) {
        hasPendingTelemetry = false;
        lastTelemetryPublishMs = nowMs;
      }
    }

    vTaskDelay(pdMS_TO_TICKS(10));
  }
}
