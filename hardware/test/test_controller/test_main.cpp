#include <ArduinoJson.h>
#include <unity.h>

#include <limits>
#include <string.h>

#include "controller.h"
#include "control_step.h"
#include "device_settings.h"
#include "mqtt_protocol.h"
#include "pid_config.h"
#include "provisioning_protocol.h"
#include "sensor_reading.h"

void setUp() {}
void tearDown() {}

void test_zero_error_has_zero_output() {
  LineController controller(10.0f, 0.0f, 0.0f, 100.0f, 10.0f);
  TEST_ASSERT_FLOAT_WITHIN(0.001f, 0.0f, controller.update(0.0f, 0.01f));
}

void test_positive_error_produces_positive_correction() {
  LineController controller(10.0f, 0.0f, 0.0f, 100.0f, 10.0f);
  TEST_ASSERT_FLOAT_WITHIN(0.001f, 20.0f, controller.update(2.0f, 0.01f));
}

void test_output_is_limited() {
  LineController controller(100.0f, 0.0f, 0.0f, 50.0f, 10.0f);
  TEST_ASSERT_FLOAT_WITHIN(0.001f, 50.0f, controller.update(2.0f, 0.01f));
  TEST_ASSERT_FLOAT_WITHIN(0.001f, -50.0f, controller.update(-2.0f, 0.01f));
}

void test_integral_is_applied_and_reset() {
  LineController controller(0.0f, 2.0f, 0.0f, 100.0f, 10.0f);
  TEST_ASSERT_FLOAT_WITHIN(0.001f, 2.0f, controller.update(1.0f, 1.0f));
  controller.reset();
  TEST_ASSERT_FLOAT_WITHIN(0.001f, 2.0f, controller.update(1.0f, 1.0f));
}

void test_derivative_responds_to_error_change() {
  LineController controller(0.0f, 0.0f, 1.0f, 100.0f, 10.0f);
  TEST_ASSERT_FLOAT_WITHIN(0.001f, 0.0f, controller.update(1.0f, 1.0f));
  TEST_ASSERT_FLOAT_WITHIN(0.001f, 2.0f, controller.update(3.0f, 1.0f));
}

void test_sensor_reading_is_derived_from_one_mask() {
  for (uint8_t mask = 0; mask < (1u << Config::SENSOR_COUNT); ++mask) {
    const SensorReading reading = sensorReadingFromMask(mask);
    uint8_t active = 0;
    uint8_t weighted = 0;
    for (uint8_t i = 0; i < Config::SENSOR_COUNT; ++i) {
      if ((mask & (1u << i)) != 0) {
        ++active;
        weighted += i;
      }
    }
    TEST_ASSERT_EQUAL_UINT8(mask, reading.mask);
    TEST_ASSERT_EQUAL(active != 0, reading.hasLine);
    if (active != 0) {
      TEST_ASSERT_FLOAT_WITHIN(0.001f,
                               static_cast<float>(weighted) / active,
                               reading.position);
    }
  }
}

void test_right_cluster_confirms_right_pivot() {
  ControlStep step;
  ControlOutput output = step.update(sensorReadingFromMask(0b11100), 10, 10);
  TEST_ASSERT_EQUAL(ControlEvent::CornerCluster, output.event);

  output = step.update(sensorReadingFromMask(0), 10, 20);
  TEST_ASSERT_EQUAL(ControlEvent::PivotStarted, output.event);
  TEST_ASSERT_EQUAL(ControlMode::Pivot, output.mode);
  TEST_ASSERT_EQUAL(MotorAction::Hold, output.motorAction);

  output = step.update(sensorReadingFromMask(0), 10, 30);
  TEST_ASSERT_EQUAL(MotorAction::Drive, output.motorAction);
  TEST_ASSERT_EQUAL_INT(Config::CORNER_PIVOT_SPEED, output.leftSpeed);
  TEST_ASSERT_EQUAL_INT(-Config::CORNER_PIVOT_SPEED, output.rightSpeed);
}

void test_left_cluster_confirms_left_pivot() {
  ControlStep step;
  step.update(sensorReadingFromMask(0b00111), 10, 10);
  step.update(sensorReadingFromMask(0), 10, 20);
  const ControlOutput output = step.update(sensorReadingFromMask(0), 10, 30);
  TEST_ASSERT_EQUAL(MotorAction::Drive, output.motorAction);
  TEST_ASSERT_EQUAL_INT(-Config::CORNER_PIVOT_SPEED, output.leftSpeed);
  TEST_ASSERT_EQUAL_INT(Config::CORNER_PIVOT_SPEED, output.rightSpeed);
}

void test_line_loss_coasts_for_grace_then_stops() {
  ControlStep step;
  ControlOutput output;
  for (uint16_t i = 0; i < Config::LINE_LOSS_GRACE_CYCLES; ++i) {
    output = step.update(sensorReadingFromMask(0), Config::CONTROL_PERIOD_MS,
                         (i + 1) * Config::CONTROL_PERIOD_MS);
    TEST_ASSERT_EQUAL(MotorAction::Hold, output.motorAction);
    TEST_ASSERT_EQUAL(ControlMode::Track, output.mode);
  }
  output = step.update(sensorReadingFromMask(0), Config::CONTROL_PERIOD_MS,
                       (Config::LINE_LOSS_GRACE_CYCLES + 1) *
                           Config::CONTROL_PERIOD_MS);
  TEST_ASSERT_EQUAL(MotorAction::Stop, output.motorAction);
  TEST_ASSERT_EQUAL(ControlMode::Lost, output.mode);
}

void test_right_pivot_ignores_far_left_and_reacquires_center() {
  ControlStep step;
  step.update(sensorReadingFromMask(0b11100), 10, 10);
  step.update(sensorReadingFromMask(0), 10, 20);
  step.update(sensorReadingFromMask(0), 10, 30);

  ControlOutput output = step.update(sensorReadingFromMask(0b00001), 10, 40);
  TEST_ASSERT_EQUAL(ControlMode::Pivot, output.mode);
  TEST_ASSERT_EQUAL(MotorAction::Drive, output.motorAction);

  output = step.update(sensorReadingFromMask(0b00100), 10, 50);
  TEST_ASSERT_EQUAL(ControlEvent::LineReacquired, output.event);
  TEST_ASSERT_EQUAL(ControlMode::Track, output.mode);
  TEST_ASSERT_EQUAL(MotorAction::Stop, output.motorAction);
}

void test_left_pivot_ignores_far_right_and_reacquires_center() {
  ControlStep step;
  step.update(sensorReadingFromMask(0b00111), 10, 10);
  step.update(sensorReadingFromMask(0), 10, 20);
  step.update(sensorReadingFromMask(0), 10, 30);

  ControlOutput output = step.update(sensorReadingFromMask(0b10000), 10, 40);
  TEST_ASSERT_EQUAL(ControlMode::Pivot, output.mode);
  TEST_ASSERT_EQUAL(MotorAction::Drive, output.motorAction);

  output = step.update(sensorReadingFromMask(0b00100), 10, 50);
  TEST_ASSERT_EQUAL(ControlEvent::LineReacquired, output.event);
  TEST_ASSERT_EQUAL(ControlMode::Track, output.mode);
  TEST_ASSERT_EQUAL(MotorAction::Stop, output.motorAction);
}

void test_center_cluster_uses_recent_drift_direction() {
  ControlStep rightStep;
  rightStep.update(sensorReadingFromMask(0b11000), 10, 10);
  ControlOutput output =
      rightStep.update(sensorReadingFromMask(0b01110), 10, 20);
  TEST_ASSERT_EQUAL(ControlEvent::CornerCluster, output.event);
  rightStep.update(sensorReadingFromMask(0), 10, 30);
  output = rightStep.update(sensorReadingFromMask(0), 10, 40);
  TEST_ASSERT_EQUAL_INT(Config::CORNER_PIVOT_SPEED, output.leftSpeed);
  TEST_ASSERT_EQUAL_INT(-Config::CORNER_PIVOT_SPEED, output.rightSpeed);

  ControlStep leftStep;
  leftStep.update(sensorReadingFromMask(0b00011), 10, 10);
  leftStep.update(sensorReadingFromMask(0b01110), 10, 20);
  leftStep.update(sensorReadingFromMask(0), 10, 30);
  output = leftStep.update(sensorReadingFromMask(0), 10, 40);
  TEST_ASSERT_EQUAL_INT(-Config::CORNER_PIVOT_SPEED, output.leftSpeed);
  TEST_ASSERT_EQUAL_INT(Config::CORNER_PIVOT_SPEED, output.rightSpeed);
}

void test_pivot_timeout_stops_motors() {
  ControlStep step;
  step.update(sensorReadingFromMask(0b11100), 10, 10);
  step.update(sensorReadingFromMask(0), 10, 20);
  const uint32_t timeout = Config::CORNER_PIVOT_TIMEOUT_MS;
  ControlOutput output = step.update(sensorReadingFromMask(0), timeout + 1,
                                     20 + timeout + 1);
  TEST_ASSERT_EQUAL(ControlEvent::PivotTimedOut, output.event);
  TEST_ASSERT_EQUAL(ControlMode::Track, output.mode);
  TEST_ASSERT_EQUAL(MotorAction::Stop, output.motorAction);
}

void test_stale_corner_cluster_does_not_reappear_after_counter_wrap() {
  ControlStep step;
  step.update(sensorReadingFromMask(0b11100), 10, 10);
  for (uint32_t i = 0; i < 65536UL; ++i) {
    step.update(sensorReadingFromMask(0b00100), 10, 20 + i * 10);
  }
  const ControlOutput output =
      step.update(sensorReadingFromMask(0), 10, 20 + 65536UL * 10);
  TEST_ASSERT_NOT_EQUAL(ControlEvent::PivotStarted, output.event);
  TEST_ASSERT_EQUAL(ControlMode::Track, output.mode);
  TEST_ASSERT_EQUAL(MotorAction::Hold, output.motorAction);
}

void test_pivot_timeout_handles_millis_wrap_and_exact_boundary() {
  ControlStep step;
  const uint32_t clusterAt = 0xFFFFFF00UL;
  step.update(sensorReadingFromMask(0b11100), 10, clusterAt);
  const uint32_t pivotAt = clusterAt + 10U;
  ControlOutput output = step.update(sensorReadingFromMask(0), 10, pivotAt);
  TEST_ASSERT_EQUAL(ControlEvent::PivotStarted, output.event);

  const uint32_t timeout = Config::CORNER_PIVOT_TIMEOUT_MS;
  output = step.update(sensorReadingFromMask(0), timeout, pivotAt + timeout);
  TEST_ASSERT_EQUAL(ControlMode::Pivot, output.mode);
  TEST_ASSERT_EQUAL(MotorAction::Drive, output.motorAction);
  TEST_ASSERT_EQUAL(ControlEvent::None, output.event);

  output = step.update(sensorReadingFromMask(0), 1, pivotAt + timeout + 1U);
  TEST_ASSERT_EQUAL(ControlEvent::PivotTimedOut, output.event);
  TEST_ASSERT_EQUAL(ControlMode::Track, output.mode);
  TEST_ASSERT_EQUAL(MotorAction::Stop, output.motorAction);
}

void test_default_pid_config_is_valid_and_uses_existing_gains() {
  const PidConfig config = defaultPidConfig();
  TEST_ASSERT_TRUE(isPidConfigValid(config));
  TEST_ASSERT_FLOAT_WITHIN(0.001f, Config::PID_KP, config.kp);
  TEST_ASSERT_FLOAT_WITHIN(0.001f, Config::PID_KI, config.ki);
  TEST_ASSERT_FLOAT_WITHIN(0.001f, Config::PID_KD, config.kd);
  TEST_ASSERT_EQUAL_UINT32(0, config.revision);
}

void test_pid_gain_validation_rejects_nonfinite_and_unbounded_values() {
  TEST_ASSERT_TRUE(isPidGainsValid(PID_KP_MAX, PID_KI_MAX, PID_KD_MAX));
  TEST_ASSERT_FALSE(isPidGainsValid(PID_KP_MAX + 0.01f, 0.0f, 0.0f));
  TEST_ASSERT_FALSE(isPidGainsValid(0.0f, -0.01f, 0.0f));
  TEST_ASSERT_FALSE(isPidGainsValid(std::numeric_limits<float>::quiet_NaN(),
                                    0.0f, 0.0f));
  TEST_ASSERT_FALSE(isPidGainsValid(0.0f, std::numeric_limits<float>::infinity(),
                                    0.0f));
}

void test_provisioning_parser_decodes_device_settings() {
  const char frame[] =
      "CFG|6c6162|70617373776f7264|3139322e3136382e312e32|1883|626f74|"
      "6d71747470617373|6c696e65626f742d3031";
  ProvisionCommand command;
  TEST_ASSERT_TRUE(parseProvisionCommand(frame, sizeof(frame) - 1, command));
  TEST_ASSERT_EQUAL(ProvisionCommandType::ConfigureDevice, command.type);
  TEST_ASSERT_TRUE(isDeviceSettingsValid(command.device));
  TEST_ASSERT_EQUAL_STRING("lab", command.device.wifiSsid);
  TEST_ASSERT_EQUAL_STRING("password", command.device.wifiPassword);
  TEST_ASSERT_EQUAL_STRING("192.168.1.2", command.device.mqttHost);
  TEST_ASSERT_EQUAL_UINT16(1883, command.device.mqttPort);
  TEST_ASSERT_EQUAL_STRING("bot", command.device.mqttUser);
  TEST_ASSERT_EQUAL_STRING("linebot-01", command.device.robotId);
}

void test_provisioning_parser_rejects_invalid_fields_and_pid_values() {
  const char badHex[] = "CFG|zz|70617373776f7264|3139322e3136382e312e32|1883|626f74|"
                        "6d71747470617373|6c696e65626f742d3031";
  ProvisionCommand command;
  TEST_ASSERT_FALSE(parseProvisionCommand(badHex, sizeof(badHex) - 1, command));
  TEST_ASSERT_EQUAL(ProvisionCommandType::Invalid, command.type);

  const char badPid[] = "PID|nan|1|0.15";
  TEST_ASSERT_FALSE(parseProvisionCommand(badPid, sizeof(badPid) - 1, command));
  TEST_ASSERT_EQUAL(ProvisionCommandType::Invalid, command.type);
}

void test_provisioning_parser_accepts_pid_default_and_info_commands() {
  ProvisionCommand command;
  const char pid[] = "PID|12.5|1|0.15";
  TEST_ASSERT_TRUE(parseProvisionCommand(pid, sizeof(pid) - 1, command));
  TEST_ASSERT_EQUAL(ProvisionCommandType::SetPid, command.type);
  TEST_ASSERT_FLOAT_WITHIN(0.001f, 12.5f, command.pid.kp);

  const char defaults[] = "PID|DEFAULT";
  TEST_ASSERT_TRUE(parseProvisionCommand(defaults, sizeof(defaults) - 1, command));
  TEST_ASSERT_EQUAL(ProvisionCommandType::ResetPid, command.type);

  const char info[] = "INFO";
  TEST_ASSERT_TRUE(parseProvisionCommand(info, sizeof(info) - 1, command));
  TEST_ASSERT_EQUAL(ProvisionCommandType::Info, command.type);
}

void test_control_step_applies_only_valid_pid_configs() {
  ControlStep step;
  PidConfig config = defaultPidConfig();
  config.kp = 0.0f;
  config.ki = 0.0f;
  config.kd = 0.0f;
  TEST_ASSERT_TRUE(step.configurePid(config));

  const SensorReading left = sensorReadingFromMask(0b00001);
  ControlOutput output = step.update(left, 10, 10);
  TEST_ASSERT_EQUAL_INT(Config::BASE_SPEED, output.leftSpeed);
  TEST_ASSERT_EQUAL_INT(Config::BASE_SPEED, output.rightSpeed);

  config.kp = std::numeric_limits<float>::quiet_NaN();
  TEST_ASSERT_FALSE(step.configurePid(config));
  output = step.update(left, 10, 20);
  TEST_ASSERT_EQUAL_INT(Config::BASE_SPEED, output.leftSpeed);
  TEST_ASSERT_EQUAL_INT(Config::BASE_SPEED, output.rightSpeed);
}

void test_device_settings_reject_loopback_broker_address() {
  const char frame[] =
      "CFG|6c6162|70617373776f7264|6c6f63616c686f7374|1883|626f74|"
      "6d71747470617373|6c696e65626f742d3031";
  ProvisionCommand command;
  TEST_ASSERT_FALSE(parseProvisionCommand(frame, sizeof(frame) - 1, command));
}

void test_pid_config_rejects_invalid_persisted_request_id() {
  PidConfig config = defaultPidConfig();
  TEST_ASSERT_TRUE(isPidConfigValid(config));
  memcpy(config.requestId, "request-1", sizeof("request-1"));
  TEST_ASSERT_TRUE(isPidConfigValid(config));
  config.requestId[0] = 'b';
  config.requestId[1] = 'a';
  config.requestId[2] = 'd';
  config.requestId[3] = ' ';
  config.requestId[4] = '\0';
  TEST_ASSERT_FALSE(isPidConfigValid(config));
}

void test_mqtt_pid_set_payload_is_parsed_and_gain_checked() {
  const char payload[] =
      "{\"v\":1,\"requestId\":\"web-001\",\"baseRevision\":4,"
      "\"kp\":12.5,\"ki\":1,\"kd\":0.15}";
  MqttPidCommand command;
  TEST_ASSERT_TRUE(parseMqttPidCommand(payload, sizeof(payload) - 1, command));
  TEST_ASSERT_EQUAL_STRING("web-001", command.requestId);
  TEST_ASSERT_EQUAL_UINT32(4, command.baseRevision);
  TEST_ASSERT_FLOAT_WITHIN(0.001f, 12.5f, command.kp);
  TEST_ASSERT_FLOAT_WITHIN(0.001f, 1.0f, command.ki);
  TEST_ASSERT_FLOAT_WITHIN(0.001f, 0.15f, command.kd);
}

void test_mqtt_pid_set_rejects_bad_schema_revision_and_ranges() {
  MqttPidCommand command;
  const char wrongVersion[] =
      "{\"v\":2,\"requestId\":\"web-1\",\"baseRevision\":0,"
      "\"kp\":1,\"ki\":1,\"kd\":0.1}";
  TEST_ASSERT_FALSE(parseMqttPidCommand(wrongVersion, sizeof(wrongVersion) - 1,
                                        command));

  const char badRevision[] =
      "{\"v\":1,\"requestId\":\"web-1\",\"baseRevision\":-1,"
      "\"kp\":1,\"ki\":1,\"kd\":0.1}";
  TEST_ASSERT_FALSE(parseMqttPidCommand(badRevision, sizeof(badRevision) - 1,
                                        command));

  const char badGain[] =
      "{\"v\":1,\"requestId\":\"web-1\",\"baseRevision\":0,"
      "\"kp\":61,\"ki\":1,\"kd\":0.1}";
  TEST_ASSERT_FALSE(parseMqttPidCommand(badGain, sizeof(badGain) - 1, command));
  TEST_ASSERT_EQUAL_STRING("web-1", command.requestId);
}

void test_pid_command_application_is_revision_guarded_and_idempotent() {
  PidConfig current = defaultPidConfig();
  current.revision = 3;
  MqttPidCommand command = {};
  strcpy(command.requestId, "web-004");
  command.baseRevision = 3;
  command.kp = 10.0f;
  command.ki = 1.0f;
  command.kd = 0.1f;
  PidConfig candidate;
  PidAckMessage ack;

  PidCommandDisposition disposition = preparePidCommand(
      current, true, false, true, command, candidate, ack);
  TEST_ASSERT_EQUAL(PidCommandDisposition::Apply, disposition);
  TEST_ASSERT_EQUAL_UINT32(4, candidate.revision);
  TEST_ASSERT_EQUAL_STRING("web-004", candidate.requestId);
  TEST_ASSERT_EQUAL(PidAckStatus::Applied, ack.status);

  disposition = preparePidCommand(candidate, true, false, true, command,
                                  current, ack);
  TEST_ASSERT_EQUAL(PidCommandDisposition::Duplicate, disposition);
  TEST_ASSERT_EQUAL(PidAckStatus::Persisted, ack.status);

  strcpy(command.requestId, "web-stale");
  command.baseRevision = 2;
  disposition = preparePidCommand(candidate, true, false, true, command,
                                  current, ack);
  TEST_ASSERT_EQUAL(PidCommandDisposition::Reject, disposition);
  TEST_ASSERT_EQUAL_STRING("stale_revision", ack.reason);

  command.baseRevision = candidate.revision;
  disposition = preparePidCommand(candidate, false, true, true, command,
                                  current, ack);
  TEST_ASSERT_EQUAL(PidCommandDisposition::Reject, disposition);
  TEST_ASSERT_EQUAL_STRING("busy", ack.reason);

  disposition = preparePidCommand(candidate, true, false, false, command,
                                  current, ack);
  TEST_ASSERT_EQUAL(PidCommandDisposition::Reject, disposition);
  TEST_ASSERT_EQUAL_STRING("storage_unavailable", ack.reason);
}

void test_mqtt_telemetry_state_and_ack_payloads_serialize() {
  char payload[MQTT_MAX_PAYLOAD_BYTES + 1];
  TelemetrySnapshot telemetry = {};
  telemetry.sequence = 7;
  telemetry.uptimeMs = 1234;
  telemetry.dtMs = 10;
  telemetry.mask = 0b00100;
  telemetry.hasLine = false;
  telemetry.correction = 1.25f;
  telemetry.leftPwm = 76;
  telemetry.rightPwm = 74;
  telemetry.mode = ControlMode::Lost;
  telemetry.pidRevision = 2;
  telemetry.droppedFrames = 3;
  telemetry.droppedAcks = 2;
  telemetry.droppedEvents = 1;
  size_t length = encodeTelemetryPayload("linebot-01", "boot-a1", telemetry,
                                         payload, sizeof(payload));
  TEST_ASSERT_GREATER_THAN_UINT32(0, length);
  StaticJsonDocument<640> document;
  TEST_ASSERT_FALSE(deserializeJson(document, payload, length));
  TEST_ASSERT_EQUAL_STRING("linebot-01", document["robotId"]);
  TEST_ASSERT_EQUAL_STRING("boot-a1", document["bootId"]);
  TEST_ASSERT_TRUE(document["position"].isNull());
  TEST_ASSERT_EQUAL_STRING("lost", document["mode"]);
  TEST_ASSERT_EQUAL_UINT32(3, document["droppedFrames"]);
  TEST_ASSERT_EQUAL_UINT32(2, document["droppedAcks"]);
  TEST_ASSERT_EQUAL_UINT32(1, document["droppedEvents"]);

  ControlEventSnapshot event = {};
  event.sequence = 8;
  event.uptimeMs = 1240;
  event.mask = 0b01110;
  event.hasLine = true;
  event.position = 2.0f;
  event.mode = ControlMode::Pivot;
  event.event = ControlEvent::PivotStarted;
  length = encodeEventPayload("linebot-01", "boot-a1", event, payload,
                              sizeof(payload));
  TEST_ASSERT_GREATER_THAN_UINT32(0, length);
  document.clear();
  TEST_ASSERT_FALSE(deserializeJson(document, payload, length));
  TEST_ASSERT_EQUAL_STRING("pivot_started", document["event"]);
  TEST_ASSERT_EQUAL_UINT32(8, document["seq"]);

  PidStateSnapshot state = {};
  state.config = defaultPidConfig();
  state.config.revision = 9;
  memcpy(state.config.requestId, "web-009", sizeof("web-009"));
  state.persisted = true;
  length = encodePidStatePayload("linebot-01", state, payload,
                                 sizeof(payload));
  TEST_ASSERT_GREATER_THAN_UINT32(0, length);
  document.clear();
  TEST_ASSERT_FALSE(deserializeJson(document, payload, length));
  TEST_ASSERT_EQUAL_UINT32(9, document["revision"]);
  TEST_ASSERT_TRUE(document["persisted"].as<bool>());
  TEST_ASSERT_EQUAL_STRING("web-009", document["requestId"]);

  PidAckMessage ack = {};
  memcpy(ack.requestId, "web-009", sizeof("web-009"));
  ack.status = PidAckStatus::Persisted;
  ack.revision = 9;
  length = encodePidAckPayload("linebot-01", ack, payload, sizeof(payload));
  TEST_ASSERT_GREATER_THAN_UINT32(0, length);
  document.clear();
  TEST_ASSERT_FALSE(deserializeJson(document, payload, length));
  TEST_ASSERT_EQUAL_STRING("persisted", document["status"]);
  TEST_ASSERT_EQUAL_UINT32(9, document["revision"]);
}

void test_device_settings_reject_mdns_local_broker_host() {
  const char frame[] =
      "CFG|6c6162|70617373776f7264|62726f6b65722e6c6f63616c|1883|626f74|"
      "6d71747470617373|6c696e65626f742d3031";
  ProvisionCommand command;
  TEST_ASSERT_FALSE(parseProvisionCommand(frame, sizeof(frame) - 1, command));
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_zero_error_has_zero_output);
  RUN_TEST(test_positive_error_produces_positive_correction);
  RUN_TEST(test_output_is_limited);
  RUN_TEST(test_integral_is_applied_and_reset);
  RUN_TEST(test_derivative_responds_to_error_change);
  RUN_TEST(test_sensor_reading_is_derived_from_one_mask);
  RUN_TEST(test_right_cluster_confirms_right_pivot);
  RUN_TEST(test_left_cluster_confirms_left_pivot);
  RUN_TEST(test_line_loss_coasts_for_grace_then_stops);
  RUN_TEST(test_right_pivot_ignores_far_left_and_reacquires_center);
  RUN_TEST(test_left_pivot_ignores_far_right_and_reacquires_center);
  RUN_TEST(test_center_cluster_uses_recent_drift_direction);
  RUN_TEST(test_pivot_timeout_stops_motors);
  RUN_TEST(test_stale_corner_cluster_does_not_reappear_after_counter_wrap);
  RUN_TEST(test_pivot_timeout_handles_millis_wrap_and_exact_boundary);
  RUN_TEST(test_default_pid_config_is_valid_and_uses_existing_gains);
  RUN_TEST(test_pid_gain_validation_rejects_nonfinite_and_unbounded_values);
  RUN_TEST(test_provisioning_parser_decodes_device_settings);
  RUN_TEST(test_provisioning_parser_rejects_invalid_fields_and_pid_values);
  RUN_TEST(test_provisioning_parser_accepts_pid_default_and_info_commands);
  RUN_TEST(test_control_step_applies_only_valid_pid_configs);
  RUN_TEST(test_device_settings_reject_loopback_broker_address);
  RUN_TEST(test_pid_config_rejects_invalid_persisted_request_id);
  RUN_TEST(test_mqtt_pid_set_payload_is_parsed_and_gain_checked);
  RUN_TEST(test_mqtt_pid_set_rejects_bad_schema_revision_and_ranges);
  RUN_TEST(test_pid_command_application_is_revision_guarded_and_idempotent);
  RUN_TEST(test_mqtt_telemetry_state_and_ack_payloads_serialize);
  RUN_TEST(test_device_settings_reject_mdns_local_broker_host);
  return UNITY_END();
}
