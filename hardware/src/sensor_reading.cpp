#include "sensor_reading.h"

SensorReading sensorReadingFromMask(uint8_t mask) {
  const uint8_t validMask = static_cast<uint8_t>((1u << Config::SENSOR_COUNT) - 1u);
  mask &= validMask;

  uint32_t weightedTotal = 0;
  uint32_t strengthTotal = 0;
  for (uint8_t i = 0; i < Config::SENSOR_COUNT; ++i) {
    if ((mask & (1u << i)) != 0) {
      weightedTotal += i;
      ++strengthTotal;
    }
  }

  SensorReading reading;
  reading.mask = mask;
  reading.hasLine = strengthTotal != 0;
  reading.position = reading.hasLine
                          ? static_cast<float>(weightedTotal) / strengthTotal
                          : 0.0f;
  return reading;
}

SensorFrame sensorFrameFromMasks(uint8_t frontMask, uint8_t rearMask) {
  SensorFrame frame;
  frame.front = sensorReadingFromMask(frontMask);
  frame.rear = sensorReadingFromMask(rearMask);
  return frame;
}
