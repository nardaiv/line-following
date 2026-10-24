import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function createDatabase(path) {
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  const schemaVersion = db.pragma('user_version', { simple: true });
  if (schemaVersion > 3) throw new Error(`Unsupported SQLite schema ${schemaVersion}`);
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
  const migrate = db.transaction(() => {
    db.exec(schemaSql);
    let version = db.pragma('user_version', { simple: true });
    if (version < 2) {
      db.pragma('user_version = 2');
      version = 2;
    }
    if (version < 3) {
      const telemetryColumns = new Set(
        db.prepare('PRAGMA table_info(telemetry)').all().map(column => column.name),
      );
      const additions = [
        ['front_mask', 'INTEGER'],
        ['front_position', 'REAL'],
        ['rear_mask', 'INTEGER'],
        ['rear_position', 'REAL'],
        ['control_sensor', 'TEXT'],
      ];
      for (const [name, type] of additions) {
        if (!telemetryColumns.has(name)) {
          db.exec(`ALTER TABLE telemetry ADD COLUMN ${name} ${type}`);
        }
      }
      db.exec(`
        UPDATE telemetry
        SET front_mask=COALESCE(front_mask, mask),
            front_position=COALESCE(front_position, position),
            control_sensor=COALESCE(
              control_sensor, CASE WHEN mask=0 THEN 'none' ELSE 'front' END
            )
      `);
      db.pragma('user_version = 3');
    }
  });
  migrate();
  db.exec(`
    CREATE TEMP TABLE telemetry_csv_exports (
      export_id TEXT NOT NULL,
      robot_id TEXT NOT NULL,
      boot_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      received_at TEXT NOT NULL,
      uptime_ms INTEGER NOT NULL,
      mask INTEGER NOT NULL,
      position REAL,
      error REAL,
      front_mask INTEGER,
      front_position REAL,
      rear_mask INTEGER,
      rear_position REAL,
      control_sensor TEXT,
      correction REAL NOT NULL,
      left_pwm INTEGER NOT NULL,
      right_pwm INTEGER NOT NULL,
      mode TEXT NOT NULL,
      dt_ms INTEGER NOT NULL,
      pid_revision INTEGER NOT NULL,
      dropped_frames INTEGER NOT NULL,
      dropped_acks INTEGER NOT NULL,
      dropped_events INTEGER NOT NULL,
      PRIMARY KEY (export_id, received_at, seq, boot_id)
    )
  `);

  const insertTelemetry = db.prepare(`
    INSERT OR IGNORE INTO telemetry (
      robot_id, boot_id, seq, received_at, uptime_ms, mask, position, error,
      correction, left_pwm, right_pwm, mode, dt_ms, pid_revision,
      dropped_frames, dropped_acks, dropped_events,
      front_mask, front_position, rear_mask, rear_position, control_sensor
    ) VALUES (
      @robotId, @bootId, @seq, @receivedAt, @uptimeMs, @mask, @position, @error,
      @correction, @leftPwm, @rightPwm, @mode, @dtMs, @pidRevision,
      @droppedFrames, @droppedAcks, @droppedEvents,
      @frontMask, @frontPosition, @rearMask, @rearPosition, @controlSensor
    )
  `);
  const countTelemetryRange = db.prepare(`
    SELECT COUNT(*) AS row_count FROM telemetry
    WHERE robot_id=@robotId AND received_at>=@fromAt AND received_at<@toAt
  `);
  const insertTelemetryCsvSnapshot = db.prepare(`
    INSERT INTO telemetry_csv_exports (
      export_id, robot_id, boot_id, seq, received_at, uptime_ms, mask,
      position, error, front_mask, front_position, rear_mask, rear_position,
      control_sensor, correction, left_pwm, right_pwm, mode, dt_ms, pid_revision,
      dropped_frames, dropped_acks, dropped_events
    )
    SELECT
      @exportId, robot_id, boot_id, seq, received_at, uptime_ms, mask,
      position, error, front_mask, front_position, rear_mask, rear_position,
      control_sensor, correction, left_pwm, right_pwm, mode, dt_ms, pid_revision,
      dropped_frames, dropped_acks, dropped_events
    FROM telemetry
    WHERE robot_id=@robotId AND received_at>=@fromAt AND received_at<@toAt
  `);
  const telemetryCsvSnapshotFirstPage = db.prepare(`
    SELECT robot_id, boot_id, seq, received_at, uptime_ms, mask, position, error,
      front_mask, front_position, rear_mask, rear_position, control_sensor,
      correction, left_pwm, right_pwm, mode, dt_ms, pid_revision,
      dropped_frames, dropped_acks, dropped_events
    FROM telemetry_csv_exports WHERE export_id=@exportId
    ORDER BY received_at ASC, seq ASC, boot_id ASC LIMIT @limit
  `);
  const telemetryCsvSnapshotAfterPage = db.prepare(`
    SELECT robot_id, boot_id, seq, received_at, uptime_ms, mask, position, error,
      front_mask, front_position, rear_mask, rear_position, control_sensor,
      correction, left_pwm, right_pwm, mode, dt_ms, pid_revision,
      dropped_frames, dropped_acks, dropped_events
    FROM telemetry_csv_exports
    WHERE export_id=@exportId AND (
      received_at>@receivedAt OR
      (received_at=@receivedAt AND seq>@seq) OR
      (received_at=@receivedAt AND seq=@seq AND boot_id>@bootId)
    )
    ORDER BY received_at ASC, seq ASC, boot_id ASC LIMIT @limit
  `);
  const deleteTelemetryCsvSnapshot = db.prepare(
    'DELETE FROM telemetry_csv_exports WHERE export_id=?',
  );
  const createTelemetryCsvSnapshot = db.transaction(({ exportId, robotId, fromAt, toAt, maxRows }) => {
    const rowCount = countTelemetryRange.get({ robotId, fromAt, toAt }).row_count;
    if (rowCount > maxRows) return { rowCount, tooLarge: true };
    const inserted = insertTelemetryCsvSnapshot.run({ exportId, robotId, fromAt, toAt }).changes;
    if (inserted !== rowCount) throw new Error('csv_snapshot_count_mismatch');
    return { rowCount, tooLarge: false };
  }).immediate;
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
    insertTelemetry: row => insertTelemetry.run({
      ...row,
      frontMask: row.frontMask ?? row.mask,
      frontPosition: row.frontPosition === undefined ? row.position : row.frontPosition,
      rearMask: row.rearMask ?? null,
      rearPosition: row.rearPosition ?? null,
      controlSensor: row.controlSensor ?? (row.mask === 0 ? 'none' : 'front'),
    }).changes === 1,
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
    telemetryCsvCount(robotId, fromAt, toAt) {
      return countTelemetryRange.get({ robotId, fromAt, toAt }).row_count;
    },
    openTelemetryCsvExport(robotId, fromAt, toAt, maxRows) {
      const exportId = randomUUID();
      const result = createTelemetryCsvSnapshot({
        exportId, robotId, fromAt, toAt, maxRows,
      });
      let closed = result.tooLarge || result.rowCount === 0;
      return {
        ...result,
        page(after, limit) {
          if (closed) throw new Error('csv_snapshot_closed');
          const query = after === null
            ? telemetryCsvSnapshotFirstPage : telemetryCsvSnapshotAfterPage;
          return query.all({ exportId, ...(after ?? {}), limit });
        },
        close() {
          if (closed) return;
          deleteTelemetryCsvSnapshot.run(exportId);
          closed = true;
        },
      };
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
