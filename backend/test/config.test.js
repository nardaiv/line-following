import test from 'node:test';
import assert from 'node:assert/strict';

const testEnvironment = {
  MQTT_URL: 'mqtt://127.0.0.1:1883',
  MQTT_USERNAME: 'test-user',
  MQTT_PASSWORD: 'test-password',
  DB_PATH: ':memory:',
  ADMIN_TOKEN: 'x'.repeat(40),
  ALLOWED_ORIGINS: 'http://localhost:5173',
  ROBOT_IDS: 'linebot-01',
};

test('HTTP service refuses non-loopback binds', async () => {
  const previous = Object.fromEntries(
    [...Object.keys(testEnvironment), 'HTTP_HOST', 'DOTENV_CONFIG_PATH']
      .map(key => [key, process.env[key]]),
  );
  Object.assign(process.env, testEnvironment);
  process.env.DOTENV_CONFIG_PATH = '/dev/null';
  try {
    const { validateEnvironment } = await import('../src/config.js');
    assert.throws(
      () => validateEnvironment({ ...testEnvironment, HTTP_HOST: '0.0.0.0' }),
      /loopback/,
    );
    assert.equal(validateEnvironment({ ...testEnvironment, HTTP_HOST: '127.0.0.1' }).httpHost,
                 '127.0.0.1');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
