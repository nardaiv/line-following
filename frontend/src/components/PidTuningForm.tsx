import { useEffect, useRef, useState } from 'react';

import { GAIN_LIMITS, parseGainDraft } from '../lib/robot-data.js';
import type { GainDraft, PidGains, PidState } from '../lib/robot-data.js';

export type CommandFeedback = {
  status: 'idle' | 'pending' | 'applied' | 'persisted' | 'rejected' | 'failed' | 'error';
  requestId: string | null;
  message: string | null;
};

export default function PidTuningForm({
  pid,
  mqttConnected,
  adminToken,
  onTokenChange,
  feedback,
  busy,
  onApply,
}: {
  pid: PidState | null;
  mqttConnected: boolean;
  adminToken: string;
  onTokenChange: (token: string) => void;
  feedback: CommandFeedback;
  busy: boolean;
  onApply: (gains: PidGains) => void;
}) {
  const [draft, setDraft] = useState<GainDraft>({ kp: '', ki: '', kd: '' });
  const [dirty, setDirty] = useState(false);
  const revision = useRef<number | null>(null);
  const gains = parseGainDraft(draft);

  useEffect(() => {
    if (!pid) return;
    if (!dirty || revision.current !== pid.revision) {
      setDraft({ kp: String(pid.kp), ki: String(pid.ki), kd: String(pid.kd) });
      setDirty(false);
    }
    revision.current = pid.revision;
  }, [pid, dirty]);

  function updateGain(key: keyof GainDraft, value: string) {
    setDraft(current => ({ ...current, [key]: value }));
    setDirty(true);
  }

  const canSubmit = Boolean(
    pid && mqttConnected && gains && dirty && adminToken.trim().length >= 32 && !busy,
  );

  return <section className="panel pid-panel" aria-labelledby="pid-title">
    <div className="panel-heading">
      <div>
        <span className="eyebrow">CLOSED-LOOP TUNING</span>
        <h2 id="pid-title">PID controller</h2>
      </div>
      <span className={`revision-tag${pid?.persisted ? ' revision-tag--saved' : ''}`}>
        {pid ? `REV ${pid.revision}` : 'NO STATE'}
      </span>
    </div>

    {pid ? <div className="confirmed-gains" aria-label="Device-confirmed gains">
      <div><span>DEVICE KP</span><strong>{pid.kp.toFixed(2)}</strong></div>
      <div><span>DEVICE KI</span><strong>{pid.ki.toFixed(2)}</strong></div>
      <div><span>DEVICE KD</span><strong>{pid.kd.toFixed(3)}</strong></div>
    </div> : <div className="inline-empty">Waiting for the device to publish its saved PID state.</div>}

    <form className="pid-form" onSubmit={event => {
      event.preventDefault();
      if (gains && canSubmit) onApply(gains);
    }}>
      <div className="gain-grid">
        {(['kp', 'ki', 'kd'] as const).map(key => <label className="gain-field" key={key}>
          <span className="gain-field__label">{key.toUpperCase()}</span>
          <input
            aria-label={`${key.toUpperCase()} draft`}
            type="number"
            inputMode="decimal"
            min="0"
            max={GAIN_LIMITS[key]}
            step={key === 'kd' ? '0.001' : '0.01'}
            value={draft[key]}
            onChange={event => updateGain(key, event.target.value)}
            placeholder="0.00"
          />
          <span className="gain-field__limit">0 — {GAIN_LIMITS[key]}</span>
        </label>)}
      </div>

      <label className="token-field">
        <span>Local admin token</span>
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={adminToken}
          onChange={event => onTokenChange(event.target.value)}
          placeholder="Enter ADMIN_TOKEN for this session"
        />
      </label>
      <p className="privacy-note">Token remains in page memory only; it is never saved to browser storage.</p>

      <div className="pid-submit-row">
        <span className="gain-draft-status">
          {dirty ? 'UNSAVED DRAFT' : pid ? 'MATCHES DEVICE' : 'AWAITING DEVICE'}
        </span>
        <button className="button button--primary" type="submit" disabled={!canSubmit}>
          {busy ? 'Sending…' : 'Apply gains'}
          <span aria-hidden="true">↗</span>
        </button>
      </div>
    </form>

    <div className={`command-feedback command-feedback--${feedback.status}`} role="status" aria-live="polite">
      <span className="command-feedback__icon" aria-hidden="true">
        {feedback.status === 'persisted' ? '✓' : feedback.status === 'rejected' || feedback.status === 'failed' || feedback.status === 'error' ? '!' : '·'}
      </span>
      <span>{feedback.message ?? (feedback.status === 'idle'
        ? (pid?.persisted ? 'Device gains are saved in ESP32 NVS.' : 'Device gains are not yet confirmed as saved.')
        : `PID command ${feedback.status}.`)}</span>
    </div>
    {feedback.requestId && <p className="request-id">REQUEST {feedback.requestId}</p>}
  </section>;
}
