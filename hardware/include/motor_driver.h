#pragma once

class MotorDriver {
 public:
  MotorDriver();

  void begin();
  void enable();
  void setSpeeds(int leftSpeed, int rightSpeed);
  void stop();
  void standby();

 private:
  void setMotor(int in1Pin, int in2Pin, int pwmPin, int speed,
                bool reversed);
  bool enabled_;
};
