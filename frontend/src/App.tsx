import { useEffect, useMemo, useRef, useState } from 'react';

import PidTuningForm, { type CommandFeedback } from './components/PidTuningForm';
import SensorArray from './components/SensorArray';
import StatusPill from './components/StatusPill';
import TelemetryExport from './components/TelemetryExport';
import TrendChart from './components/TrendChart';
import { ApiError, requestJson, sendPidCommand } from './lib/api';
import {
  chooseRobotId,
  hasDualCenterLineCue,
  normalizePidAck,
  normalizePidState,
  normalizeStatus,
  normalizeTelemetry,
} from './lib/robot-data.js';
import type { PidAck, PidState, RobotStatus, Telemetry } from './lib/robot-data.js';

type HealthResponse = { ok: boolean; mqttConnected: boolean; robots: string[] };
type LatestResponse = { telemetry: unknown; status: unknown; pid: unknown };
type HistoryResponse = { telemetry: unknown[]; nextCursor: string | null };
type PidResponse = { state: unknown; commands: unknown[] };
type PidCommandRow = {
  requestId: string;
  status: string;
  reason: string | null;
  requestedAt: string;
  kp: number;
  ki: number;
  kd: number;
};
type DisplayEvent = { name: string; at: string; detail: string };

const DEFAULT_ROBOT = 'linebot-01';
const MAX_POINTS = 60;
const STALE_AFTER_MS = 2500;

function robotPath(robotId: string, suffix: string) {
  return `/api/robots/${encodeURIComponent(robotId)}/${suffix}`;
}

function parseCommandRow(value: unknown): PidCommandRow | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const requestId = row.request_id ?? row.requestId;
  const requestedAt = row.requested_at ?? row.requestedAt;
  const status = row.status;
  const kp = row.kp;
  const ki = row.ki;
  const kd = row.kd;
  if (typeof requestId !== 'string' || typeof requestedAt !== 'string' ||
      typeof status !== 'string' || typeof kp !== 'number' ||
      typeof ki !== 'number' || typeof kd !== 'number') return null;
  const reason = row.reason;
  return {
    requestId, status, requestedAt,
    kp, ki, kd,
    reason: typeof reason === 'string' ? reason : null,
  };
}

function formatClock(value: string | null | undefined) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function formatAge(receivedAt: string | null | undefined, now: number) {
  if (!receivedAt) return 'NO SAMPLE';
  const age = Math.max(0, now - Date.parse(receivedAt));
  if (!Number.isFinite(age)) return 'NO SAMPLE';
  if (age < 1000) return `${age} ms ago`;
  return `${(age / 1000).toFixed(1)} s ago`;
}

function displayNumber(value: number | null | undefined, digits = 2) {
  return value === null || value === undefined || !Number.isFinite(value)
    ? '—' : value.toFixed(digits);
}

function modeLabel(mode: Telemetry['mode'] | null) {
  if (mode === 'lost') return 'LINE LOST';
  if (mode === 'pivot') return 'PIVOTING';
  if (mode === 'track') return 'TRACKING';
  return 'AWAITING DATA';
}

function MetricCard({ label, value, unit, detail, accent = false }: {
  label: string;
  value: string;
  unit: string;
  detail: string;
  accent?: boolean;
}) {
  return <article className={`metric-card${accent ? ' metric-card--accent' : ''}`}>
    <span className="metric-card__label">{label}</span>
    <div className="metric-card__value"><strong>{value}</strong><span>{unit}</span></div>
    <span className="metric-card__detail">{detail}</span>
  </article>;
}

function MetricPair({ label, value, unit, secondary = false }: {
  label: string;
  value: string;
  unit: string;
  secondary?: boolean;
}) {
  return <div className={`metric-pair${secondary ? ' metric-pair--secondary' : ''}`}>
    <span>{label}</span>
    <strong>{value}<small>{unit}</small></strong>
  </div>;
}

export default function App() {
  const [robotId, setRobotId] = useState(DEFAULT_ROBOT);
  const [robotIds, setRobotIds] = useState<string[]>([DEFAULT_ROBOT]);
  const [telemetry, setTelemetry] = useState<Telemetry | null>(null);
  const [history, setHistory] = useState<Telemetry[]>([]);
  const [status, setStatus] = useState<RobotStatus | null>(null);
  const [pid, setPid] = useState<PidState | null>(null);
  const [commands, setCommands] = useState<PidCommandRow[]>([]);
  const [mqttConnected, setMqttConnected] = useState(false);
  const [backendOnline, setBackendOnline] = useState(false);
  const [streamOnline, setStreamOnline] = useState(false);
  const [feedback, setFeedback] = useState<CommandFeedback>({
    status: 'idle', requestId: null, message: null,
  });
  const [sending, setSending] = useState(false);
  const [lastEvent, setLastEvent] = useState<DisplayEvent | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const activeRobotId = useRef(robotId);
  activeRobotId.current = robotId;

  useEffect(() => {
    let active = true;
    let refreshTimer = 0;
    let clockTimer = 0;
    setTelemetry(null);
    setHistory([]);
    setStatus(null);
    setPid(null);
    setCommands([]);
    setStreamOnline(false);
    setLastEvent(null);
    setFeedback({ status: 'idle', requestId: null, message: null });
    setLoadError(null);

    const refreshSnapshot = async () => {
      let health: HealthResponse;
      try {
        health = await requestJson<HealthResponse>('/health');
      } catch (error) {
        if (!active) return;
        setBackendOnline(false);
        setLoadError(error instanceof Error ? error.message : 'Unable to reach local bridge');
        return;
      }
      if (!active) return;
      setBackendOnline(Boolean(health.ok));
      setMqttConnected(Boolean(health.mqttConnected));
      if (Array.isArray(health.robots) && health.robots.length > 0) {
        setRobotIds(health.robots);
        const selectedRobot = chooseRobotId(health.robots, robotId);
        if (selectedRobot !== robotId) {
          setRobotId(selectedRobot);
          return;
        }
      }

      try {
        const [latest, pidResponse, historyResponse] = await Promise.all([
          requestJson<LatestResponse>(robotPath(robotId, 'latest')),
          requestJson<PidResponse>(robotPath(robotId, 'pid')),
          requestJson<HistoryResponse>(`${robotPath(robotId, 'telemetry')}?limit=${MAX_POINTS}`),
        ]);
        if (!active) return;
        const latestTelemetry = normalizeTelemetry(latest.telemetry);
        const samples = historyResponse.telemetry
          .map(normalizeTelemetry)
          .filter((item): item is Telemetry => item !== null)
          .reverse();
        setHistory(samples.slice(-MAX_POINTS));
        setTelemetry(latestTelemetry ?? samples.at(-1) ?? null);
        setStatus(normalizeStatus(latest.status));
        setPid(normalizePidState(pidResponse.state));
        setCommands(pidResponse.commands.map(parseCommandRow)
          .filter((item): item is PidCommandRow => item !== null).slice(0, 5));
        setLoadError(null);
      } catch (error) {
        if (!active) return;
        setLoadError(error instanceof Error ? error.message : 'Unable to load robot data');
      }
    };

    const refreshHealth = async () => {
      try {
        const health = await requestJson<HealthResponse>('/health');
        if (!active) return;
        setBackendOnline(Boolean(health.ok));
        setMqttConnected(Boolean(health.mqttConnected));
        if (Array.isArray(health.robots) && health.robots.length > 0) {
          setRobotIds(health.robots);
          const selectedRobot = chooseRobotId(health.robots, robotId);
          if (selectedRobot !== robotId) setRobotId(selectedRobot);
        }
      } catch {
        if (active) setBackendOnline(false);
      }
    };

    const eventSource = new EventSource(robotPath(robotId, 'events'));
    eventSource.onopen = () => {
      if (!active) return;
      setStreamOnline(true);
      void refreshSnapshot();
    };
    eventSource.onerror = () => {
      if (active) setStreamOnline(false);
    };
    const listen = (eventName: string, handler: (payload: unknown) => void) => {
      eventSource.addEventListener(eventName, event => {
        try {
          handler(JSON.parse((event as MessageEvent<string>).data));
        } catch {
          setLoadError(`Could not decode ${eventName} event`);
        }
      });
    };

    listen('telemetry', payload => {
      const next = normalizeTelemetry(payload);
      if (!active || !next) return;
      setTelemetry(next);
      setHistory(current => [...current, next].slice(-MAX_POINTS));
      setBackendOnline(true);
    });
    listen('status', payload => {
      if (!active) return;
      setStatus(normalizeStatus(payload));
    });
    listen('pid-state', payload => {
      if (!active) return;
      const next = normalizePidState(payload);
      if (!next) return;
      setPid(next);
      if (next.persisted && next.requestId) {
        setFeedback(current => current.requestId === next.requestId
          ? { status: 'persisted', requestId: next.requestId, message: 'New gains are saved in ESP32 NVS.' }
          : current);
      }
    });
    listen('pid-ack', payload => {
      if (!active) return;
      const ack = normalizePidAck(payload);
      if (!ack) return;
      setFeedback(feedbackFromAck(ack));
      void refreshSnapshot();
    });
    listen('event', payload => {
      if (!active || !payload || typeof payload !== 'object') return;
      const event = payload as Record<string, unknown>;
      const name = typeof event.event === 'string' ? event.event.replaceAll('_', ' ') : 'control event';
      const at = typeof event.receivedAt === 'string' ? event.receivedAt : new Date().toISOString();
      setLastEvent({ name, at, detail: `MODE ${String(event.mode ?? '—').toUpperCase()}` });
    });
    listen('connection', payload => {
      if (!active || !payload || typeof payload !== 'object') return;
      const connection = (payload as { mqtt?: unknown }).mqtt;
      if (connection === 'connected') setMqttConnected(true);
      if (connection === 'disconnected' || connection === 'reconnecting') setMqttConnected(false);
    });

    void refreshSnapshot();
    refreshTimer = window.setInterval(() => void refreshHealth(), 5000);
    clockTimer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      active = false;
      eventSource.close();
      window.clearInterval(refreshTimer);
      window.clearInterval(clockTimer);
    };
  }, [robotId]);

  useEffect(() => {
    if (!pid || !pid.persisted || !pid.requestId) return;
    setFeedback(current => current.requestId === pid.requestId && current.status !== 'persisted'
      ? { status: 'persisted', requestId: pid.requestId, message: 'New gains are saved in ESP32 NVS.' }
      : current);
  }, [pid]);

  const stale = !telemetry || now - Date.parse(telemetry.receivedAt) > STALE_AFTER_MS;
  const onlineState = status?.state === 'online' && !stale;
  const straightCue = !telemetry || telemetry.rearMask === null
    ? null : hasDualCenterLineCue(telemetry.frontMask, telemetry.rearMask);
  const displayedHistory = useMemo(() => history.slice(-MAX_POINTS), [history]);

  async function applyPid(gains: { kp: number; ki: number; kd: number }) {
    const targetRobotId = robotId;
    setSending(true);
    setFeedback({ status: 'pending', requestId: null, message: 'Publishing full PID set to device…' });
    try {
      const result = await sendPidCommand(targetRobotId, gains);
      if (activeRobotId.current !== targetRobotId) return;
      setFeedback(current => current.requestId === result.requestId && current.status !== 'pending'
        ? current
        : {
          status: 'pending',
          requestId: result.requestId,
          message: 'Waiting for device apply and NVS persistence acknowledgement.',
        });
      await requestJson<LatestResponse>(robotPath(targetRobotId, 'latest')).then(snapshot => {
        if (activeRobotId.current !== targetRobotId) return;
        const nextPid = normalizePidState(snapshot.pid);
        if (nextPid) setPid(nextPid);
      });
    } catch (error) {
      if (activeRobotId.current !== targetRobotId) return;
      const message = error instanceof ApiError ? error.code.replaceAll('_', ' ') :
        error instanceof Error ? error.message : 'PID command failed';
      setFeedback({ status: 'error', requestId: null, message });
    } finally {
      setSending(false);
    }
  }

  const backendTone = backendOnline ? 'online' : 'offline';
  const mqttTone = mqttConnected ? 'online' : 'warning';
  const robotTone = onlineState ? 'online' : stale ? 'warning' : 'offline';

  return <main className="app-shell">
    <header className="topbar">
      <a className="brand" href="#top" aria-label="Track Lab home">
        <span className="brand-mark" aria-hidden="true"><i /><i /><i /><i /><i /></span>
        <span className="brand-name">TRACK<span>LAB</span></span>
      </a>
      <div className="topbar__center">
        <span className="eyebrow">LOCAL ROBOT TELEMETRY</span>
        <h1>Line follower console</h1>
      </div>
      <div className="topbar__right">
        <label className="robot-select-label" htmlFor="robot-select">DEVICE</label>
        <select id="robot-select" value={robotId} onChange={event => setRobotId(event.target.value)}>
          {robotIds.map(id => <option value={id} key={id}>{id}</option>)}
        </select>
      </div>
    </header>

    <section className="connection-strip" aria-label="System connections">
      <StatusPill tone={backendTone}>{backendOnline ? 'BRIDGE ONLINE' : 'BRIDGE OFFLINE'}</StatusPill>
      <StatusPill tone={mqttTone}>{mqttConnected ? 'MQTT CONNECTED' : 'MQTT DISCONNECTED'}</StatusPill>
      <StatusPill tone={robotTone}>{stale ? 'TELEMETRY STALE' : onlineState ? 'ROBOT ONLINE' : 'ROBOT OFFLINE'}</StatusPill>
      <span className="connection-strip__spacer" />
      <span className={`stream-state${streamOnline ? ' stream-state--on' : ''}`}>
        <span className="stream-state__pulse" />{streamOnline ? 'LIVE SSE' : 'CONNECTING'}
      </span>
      <span className="connection-strip__updated">{formatAge(telemetry?.receivedAt, now)}</span>
    </section>

    {loadError && <div className="alert alert--error" role="alert">
      <strong>Bridge unavailable</strong><span>{loadError}</span>
      <button type="button" onClick={() => window.location.reload()}>Retry</button>
    </div>}

    <section className="metrics-grid" aria-label="Live controller metrics">
      <MetricCard label="Line error" value={displayNumber(telemetry?.error)} unit="ERR" detail="−2 left · +2 right" accent />
      <MetricCard label="PID correction" value={displayNumber(telemetry?.correction, 1)} unit="PWM" detail="Controller output" />
      <MetricCard label="Motor command" value={telemetry ? `${telemetry.leftPwm} / ${telemetry.rightPwm}` : '— / —'} unit="L / R" detail="Signed PWM · max 180" />
      <MetricCard label="Control step" value={telemetry ? String(telemetry.dtMs) : '—'} unit="MS" detail={`DROP ${telemetry?.droppedFrames ?? '—'} FRAMES`} />
    </section>

    <div className="dashboard-grid">
      <section className="telemetry-column" aria-label="Sensor and response telemetry">
        <section className="panel sensor-panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">{telemetry && telemetry.rearMask !== null
                ? 'DUAL 5-CHANNEL ARRAYS' : '5-CHANNEL IR ARRAY'}</span>
              <h2>Sensor rows</h2>
            </div>
            <span className={`mode-pill mode-pill--${telemetry?.mode ?? 'waiting'}`}>
              <span className="mode-pill__dot" />{modeLabel(telemetry?.mode ?? null)}
            </span>
          </div>
          <div className="sensor-row">
            <div className="sensor-row__label">
              <span>FRONT ARRAY</span>
              <span>{telemetry?.controlSensor === 'front' ? 'CONTROL INPUT' : 'LOOKAHEAD'}</span>
            </div>
            <SensorArray
              rowLabel="Front row"
              mask={telemetry?.frontMask ?? 0}
              position={telemetry?.frontPosition ?? null}
              stale={stale}
              hasSample={telemetry !== null}
            />
          </div>
          {telemetry && telemetry.rearMask !== null && <div className="sensor-row sensor-row--rear">
            <div className="sensor-row__label">
              <span>REAR ARRAY</span>
              <span>{telemetry.controlSensor === 'rear' ? 'CONTROL FALLBACK' : 'TRAILING ROW'}</span>
            </div>
            <SensorArray
              rowLabel="Rear row"
              mask={telemetry.rearMask}
              position={telemetry.rearPosition}
              stale={stale}
              hasSample
            />
          </div>}
          <div className="sensor-readout">
            <div><span>FRONT POS</span><strong>{telemetry?.frontPosition === null || telemetry?.frontPosition === undefined
              ? 'NO LINE' : telemetry.frontPosition.toFixed(1)}<small>/ 4</small></strong></div>
            <div><span>REAR POS</span><strong>{telemetry?.rearMask === null || telemetry?.rearMask === undefined
              || telemetry.rearPosition === null ? '—' : telemetry.rearPosition.toFixed(1)}<small>/ 4</small></strong></div>
            <div><span>CONTROL ROW</span><strong>{telemetry?.controlSensor.toUpperCase() ?? '—'}</strong></div>
            <div><span>STRAIGHT CUE</span><strong>{straightCue === null ? '—' : straightCue ? 'YES' : 'NO'}</strong></div>
          </div>
        </section>

        <section className="charts-grid" aria-label="Recent response charts">
          <TrendChart points={displayedHistory} field="error" title="Line error" color="#c4ef5d" unit="ERR" />
          <TrendChart points={displayedHistory} field="correction" title="PID correction" color="#ef91bc" unit="PWM" />
        </section>

        <TelemetryExport key={robotId} robotId={robotId} />

        <section className="panel detail-panel">
          <div className="panel-heading panel-heading--compact">
            <div><span className="eyebrow">DEVICE DIAGNOSTICS</span><h2>Runtime snapshot</h2></div>
            <span className="last-sample">RX {formatClock(telemetry?.receivedAt)}</span>
          </div>
          <div className="detail-grid">
            <MetricPair label="LEFT MOTOR" value={telemetry ? String(telemetry.leftPwm) : '—'} unit="PWM" />
            <MetricPair label="RIGHT MOTOR" value={telemetry ? String(telemetry.rightPwm) : '—'} unit="PWM" />
            <MetricPair label="PID REVISION" value={telemetry ? String(telemetry.pidRevision) : '—'} unit="" />
            <MetricPair label="QUEUE DROPS" value={telemetry ? String(telemetry.droppedAcks + telemetry.droppedEvents) : '—'} unit="ACK / EVT" secondary />
          </div>
          <div className="detail-footer">
            <span>Wi-Fi {status?.wifi ?? '—'}{status?.rssi !== null && status?.rssi !== undefined ? ` · ${status.rssi} dBm` : ''}</span>
            <span>LAST RX {formatAge(telemetry?.receivedAt, now)}</span>
          </div>
        </section>
      </section>

      <aside className="control-column">
        <PidTuningForm
          key={robotId}
          pid={pid}
          mqttConnected={mqttConnected}
          feedback={feedback}
          busy={sending}
          onApply={gains => void applyPid(gains)}
        />

        <section className="panel activity-panel">
          <div className="panel-heading panel-heading--compact">
            <div><span className="eyebrow">DEVICE EVENTS</span><h2>Recent activity</h2></div>
            <span className="activity-live"><i />LIVE</span>
          </div>
          <div className="activity-list">
            {feedback.requestId && <div className="activity-item">
              <span className="activity-item__icon activity-item__icon--pid">P</span>
              <div><strong>PID {feedback.status.toUpperCase()}</strong><span>Request {feedback.requestId.slice(0, 8)} · {feedback.message ?? ''}</span></div>
              <time>{formatClock(pid?.receivedAt)}</time>
            </div>}
            {lastEvent && <div className="activity-item">
              <span className="activity-item__icon activity-item__icon--event">↗</span>
              <div><strong>{lastEvent.name}</strong><span>{lastEvent.detail}</span></div>
              <time>{formatClock(lastEvent.at)}</time>
            </div>}
            {commands.slice(0, 3).map(command => <div className="activity-item" key={command.requestId}>
              <span className="activity-item__icon activity-item__icon--history">↻</span>
              <div><strong>PID {command.status.toUpperCase()}</strong>
                <span>Kp {command.kp.toFixed(2)} · Ki {command.ki.toFixed(2)} · Kd {command.kd.toFixed(3)}</span>
              </div>
              <time>{formatClock(command.requestedAt)}</time>
            </div>)}
            {!lastEvent && !commands.length && !feedback.requestId && <div className="activity-empty">
              <span className="activity-empty__line" />
              <span>Events will appear here when the robot reports a turn or PID update.</span>
            </div>}
          </div>
          <p className="safety-note"><span aria-hidden="true">ⓘ</span> Steering stays on the ESP32. The dashboard only observes telemetry and adjusts PID gains.</p>
        </section>
      </aside>
    </div>

    <footer className="app-footer">
      <span><strong>TRACKLAB</strong> · ESP32-S3 LINE FOLLOWER</span>
      <span>LOCAL MODE · {status?.state?.toUpperCase() ?? 'AWAITING DEVICE STATUS'} · {formatClock(telemetry?.receivedAt)}</span>
    </footer>
  </main>;
}

function feedbackFromAck(ack: PidAck): CommandFeedback {
  const messages: Record<PidAck['status'], string> = {
    applied: 'Device applied the new gains; waiting for NVS save confirmation.',
    persisted: 'New gains are saved in ESP32 NVS.',
    rejected: `Device rejected the update${ack.reason ? `: ${ack.reason}` : '.'}`,
    failed: `PID save failed${ack.reason ? `: ${ack.reason}` : '.'}`,
  };
  return {
    status: ack.status,
    requestId: ack.requestId,
    message: messages[ack.status],
  };
}
