import { useState, type FormEvent } from 'react';

import { ApiError, requestJson } from '../lib/api';
import { buildTelemetryCsvUrls, utcDateTimeInputValue } from '../lib/telemetry-export.js';

type ExportInfo = {
  robotId: string;
  from: string;
  to: string;
  rowCount: number;
  maxRows: number;
};

type ExportStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'empty' }
  | { kind: 'ready'; rowCount: number; from: string; to: string; csvUrl: string }
  | { kind: 'error'; message: string };

function defaultUtcInput(offsetMs: number) {
  return utcDateTimeInputValue(new Date(Date.now() + offsetMs));
}

export default function TelemetryExport({ robotId }: { robotId: string }) {
  const [from, setFrom] = useState(() => defaultUtcInput(-24 * 60 * 60 * 1000));
  const [to, setTo] = useState(() => defaultUtcInput(0));
  const [status, setStatus] = useState<ExportStatus>({ kind: 'idle' });
  const rangeIsValid = buildTelemetryCsvUrls(robotId, from, to) !== null;

  async function checkRange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const urls = buildTelemetryCsvUrls(robotId, from, to);
    if (!urls) {
      setStatus({ kind: 'error', message: 'Enter a valid UTC range with a start before the end.' });
      return;
    }

    setStatus({ kind: 'checking' });
    try {
      const info = await requestJson<ExportInfo>(urls.infoUrl);
      if (info.rowCount === 0) {
        setStatus({ kind: 'empty' });
        return;
      }
      const capturedUrls = buildTelemetryCsvUrls(robotId, info.from, info.to);
      if (!capturedUrls) {
        setStatus({ kind: 'error', message: 'The server returned an invalid export interval.' });
        return;
      }
      setStatus({
        kind: 'ready', rowCount: info.rowCount, from: info.from, to: info.to,
        csvUrl: capturedUrls.csvUrl,
      });
    } catch (error) {
      const message = error instanceof ApiError && error.code === 'export_too_large'
        ? 'This range exceeds the export row limit. Narrow the date range and try again.'
        : error instanceof ApiError
          ? `Could not prepare CSV export (${error.code}).`
          : 'Could not prepare CSV export.';
      setStatus({ kind: 'error', message });
    }
  }

  function changeRange(update: () => void) {
    update();
    setStatus({ kind: 'idle' });
  }

  return <section className="panel export-panel" aria-labelledby="csv-export-title">
    <div className="panel-heading panel-heading--compact">
      <div><span className="eyebrow">RECORDED TELEMETRY</span><h2 id="csv-export-title">Export CSV</h2></div>
      <span className="last-sample">UTC · END EXCLUSIVE</span>
    </div>
    <form className="export-form" onSubmit={event => void checkRange(event)}>
      <label className="export-field">
        <span>FROM (UTC)</span>
        <input
          aria-label="Export start time in UTC"
          type="datetime-local"
          step="1"
          value={from}
          disabled={status.kind === 'checking'}
          onChange={event => changeRange(() => setFrom(event.target.value))}
        />
      </label>
      <label className="export-field">
        <span>TO (UTC, EXCLUSIVE)</span>
        <input
          aria-label="Export end time in UTC"
          type="datetime-local"
          step="1"
          value={to}
          disabled={status.kind === 'checking'}
          onChange={event => changeRange(() => setTo(event.target.value))}
        />
      </label>
      <button className="button button--primary export-check" type="submit"
        disabled={status.kind === 'checking' || !rangeIsValid}>
        {status.kind === 'checking' ? 'Checking…' : 'Check range'}
      </button>
    </form>
    <div className="export-result" role="status" aria-live="polite">
      {!rangeIsValid && <span className="export-result--error">Enter a valid UTC range with a start before the end.</span>}
      {status.kind === 'empty' && <span>No telemetry is recorded in this range.</span>}
      {status.kind === 'error' && <span className="export-result--error">{status.message}</span>}
      {status.kind === 'ready' && <>
        <span>{status.rowCount.toLocaleString()} rows ready: {status.from} ≤ received_at &lt; {status.to} UTC.</span>
        <a className="button button--primary" href={status.csvUrl}>Download CSV</a>
      </>}
    </div>
    <p className="export-note">Exports persisted MQTT telemetry from SQLite; timestamps are UTC.</p>
  </section>;
}
