#include <unity.h>

#include "controller.h"

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

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_zero_error_has_zero_output);
  RUN_TEST(test_positive_error_produces_positive_correction);
  RUN_TEST(test_output_is_limited);
  RUN_TEST(test_integral_is_applied_and_reset);
  RUN_TEST(test_derivative_responds_to_error_change);
  return UNITY_END();
}
