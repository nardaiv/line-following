import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function createDatabase(path) {
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  const schemaVersion = db.pragma('user_version', { simple: true });
  if (schemaVersion > 2) throw new Error(`Unsupported SQLite schema ${schemaVersion}`);
  const schemaSql = `
    CREATE TABLE IF NOT EXISTS telemetry (
      robot_id TEXT NOT NULL,
      boot_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      received_at TEXT NOT NULL,
      uptime_ms INTEGER NOT NULL,
      mask INTEGER NOT NULL,
      position REAL,
      error REAL,
      correction REAL NOT NULL,
      left_pwm INTEGER NOT NULL,
      right_pwm INTEGER NOT NULL,
      mode TEXT NOT NULL,
      dt_ms INTEGER NOT NULL,
      pid_revision INTEGER NOT NULL,
      dropped_frames INTEGER NOT NULL,
      dropped_acks INTEGER NOT NULL,
      dropped_events INTEGER NOT NULL,
      PRIMARY KEY (robot_id, boot_id, seq)
    );
    CREATE INDEX IF NOT EXISTS telemetry_page_v2
      ON telemetry(robot_id, received_at DESC, seq DESC, boot_id DESC);

    CREATE TABLE IF NOT EXISTS control_events (
      robot_id TEXT NOT NULL,
      boot_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      received_at TEXT NOT NULL,
      uptime_ms INTEGER NOT NULL,
      event TEXT NOT NULL,
      mask INTEGER NOT NULL,
      mode TEXT NOT NULL,
      position REAL,
      PRIMARY KEY (robot_id, boot_id, seq)
    );
    CREATE INDEX IF NOT EXISTS control_events_latest
      ON control_events(robot_id, received_at DESC, seq DESC);

    CREATE TABLE IF NOT EXISTS robot_status (
      robot_id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      wifi TEXT,
      rssi INTEGER,
      received_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pid_states (
      robot_id TEXT PRIMARY KEY,
      kp REAL NOT NULL,
      ki REAL NOT NULL,
      kd REAL NOT NULL,
      revision INTEGER NOT NULL,
      request_id TEXT,
      persisted INTEGER NOT NULL,
      received_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pid_commands (
      robot_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      base_revision INTEGER NOT NULL,
      kp REAL NOT NULL,
      ki REAL NOT NULL,
      kd REAL NOT NULL,
      status TEXT NOT NULL,
      applied_revision INTEGER,
      reason TEXT,
      requested_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (robot_id, request_id)
    );
    CREATE INDEX IF NOT EXISTS pid_commands_pending
      ON pid_commands(robot_id, status, requested_at DESC);
  `;
  const migrateToV2 = db.transaction(() => {
    db.exec(schemaSql);
    db.pragma('user_version = 2');
  });
  migrateToV2();

  const insertTelemetry = db.prepare(`
    INSERT OR IGNORE INTO telemetry (
      robot_id, boot_id, seq, received_at, uptime_ms, mask, position, error,
      correction, left_pwm, right_pwm, mode, dt_ms, pid_revision,
      dropped_frames, dropped_acks, dropped_events
    ) VALUES (
      @robotId, @bootId, @seq, @receivedAt, @uptimeMs, @mask, @position, @error,
      @correction, @leftPwm, @rightPwm, @mode, @dtMs, @pidRevision,
      @droppedFrames, @droppedAcks, @droppedEvents
    )
  `);
  const insertEvent = db.prepare(`
    INSERT OR IGNORE INTO control_events (
      robot_id, boot_id, seq, received_at, uptime_ms, event, mask, mode, position
    ) VALUES (
      @robotId, @bootId, @seq, @receivedAt, @uptimeMs, @event, @mask, @mode, @position
    )
  `);
  const upsertStatus = db.prepare(`
    INSERT INTO robot_status (robot_id, state, wifi, rssi, received_at)
    VALUES (@robotId, @state, @wifi, @rssi, @receivedAt)
    ON CONFLICT(robot_id) DO UPDATE SET
      state=excluded.state, wifi=excluded.wifi, rssi=excluded.rssi,
      received_at=excluded.received_at
  `);
  const upsertPidState = db.prepare(`
    INSERT INTO pid_states (robot_id, kp, ki, kd, revision, request_id, persisted, received_at)
    VALUES (@robotId, @kp, @ki, @kd, @revision, @requestId, @persisted, @receivedAt)
    ON CONFLICT(robot_id) DO UPDATE SET
      kp=excluded.kp, ki=excluded.ki, kd=excluded.kd,
      revision=excluded.revision, request_id=excluded.request_id,
      persisted=excluded.persisted, received_at=excluded.received_at
  `);
  const insertPidCommand = db.prepare(`
    INSERT INTO pid_commands (
      robot_id, request_id, base_revision, kp, ki, kd, status,
      applied_revision, reason, requested_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?)
  `);
  const updatePidAck = db.prepare(`
    UPDATE pid_commands
    SET status=@status, applied_revision=@revision, reason=@reason,
        updated_at=@receivedAt
    WHERE robot_id=@robotId AND request_id=@requestId
      AND (
        (@status='applied' AND status='pending') OR
        (@status='persisted' AND status IN ('pending', 'applied')) OR
        (@status='failed' AND status IN ('pending', 'applied')) OR
        (@status='rejected' AND status='pending')
      )
  `);
  const updatePublishFailure = db.prepare(`
    UPDATE pid_commands
    SET status='failed', reason=@reason, updated_at=@updatedAt
    WHERE robot_id=@robotId AND request_id=@requestId AND status='pending'
  `);
  const reconcilePidState = db.prepare(`
    UPDATE pid_commands
    SET status=@status, applied_revision=@revision, reason=NULL,
        updated_at=@receivedAt
    WHERE robot_id=@robotId AND request_id=@requestId
      AND status IN ('pending', 'applied')
  `);

  return {
    raw: db,
    close: () => db.close(),
    insertTelemetry: row => insertTelemetry.run(row).changes === 1,
    insertEvent: row => insertEvent.run(row).changes === 1,
    upsertStatus: row => upsertStatus.run(row),
    upsertPidState: row => upsertPidState.run({
      ...row, persisted: row.persisted ? 1 : 0,
    }),
    createPidCommand(row) {
      insertPidCommand.run(
        row.robotId, row.requestId, row.baseRevision, row.kp, row.ki, row.kd,
        row.requestedAt, row.requestedAt,
      );
    },
    updatePidAck: row => updatePidAck.run(row).changes,
    updatePublishFailure: row => updatePublishFailure.run(row).changes,
    reconcilePidState: row => reconcilePidState.run({
      ...row, status: row.persisted ? 'persisted' : 'applied',
    }).changes,
    latestTelemetry(robotId) {
      return db.prepare(`
        SELECT * FROM telemetry WHERE robot_id=?
        ORDER BY received_at DESC, seq DESC, boot_id DESC LIMIT 1
      `).get(robotId) ?? null;
    },
    telemetryPage(robotId, before, limit) {
      if (before === null) {
        return db.prepare(`
          SELECT * FROM telemetry WHERE robot_id=?
          ORDER BY received_at DESC, seq DESC, boot_id DESC LIMIT ?
        `).all(robotId, limit);
      }
      if (typeof before === 'string') {
        return db.prepare(`
          SELECT * FROM telemetry WHERE robot_id=? AND received_at < ?
          ORDER BY received_at DESC, seq DESC, boot_id DESC LIMIT ?
        `).all(robotId, before, limit);
      }
      return db.prepare(`
        SELECT * FROM telemetry
        WHERE robot_id=@robotId AND (
          received_at < @receivedAt OR
          (received_at = @receivedAt AND seq < @seq) OR
          (received_at = @receivedAt AND seq = @seq AND boot_id < @bootId)
        )
        ORDER BY received_at DESC, seq DESC, boot_id DESC LIMIT @limit
      `).all({ robotId, ...before, limit });
    },
    latestStatus: robotId => db.prepare(
      'SELECT * FROM robot_status WHERE robot_id=?',
    ).get(robotId) ?? null,
    latestPidState(robotId) {
      const row = db.prepare(
        'SELECT * FROM pid_states WHERE robot_id=?',
      ).get(robotId);
      return row ? { ...row, persisted: Boolean(row.persisted) } : null;
    },
    pidCommands(robotId, limit = 20) {
      return db.prepare(`
        SELECT * FROM pid_commands WHERE robot_id=?
        ORDER BY requested_at DESC LIMIT ?
      `).all(robotId, limit);
    },
    pruneBefore(cutoff) {
      const telemetry = db.prepare('DELETE FROM telemetry WHERE received_at < ?').run(cutoff);
      const events = db.prepare('DELETE FROM control_events WHERE received_at < ?').run(cutoff);
      return telemetry.changes + events.changes;
    },
  };
}
