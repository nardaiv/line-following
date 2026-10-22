import { getSensorState, getSensorStates } from '../lib/robot-data.js';

const SENSOR_LABELS = ['OUTER L', 'INNER L', 'CENTER', 'INNER R', 'OUTER R'];

export default function SensorArray({ mask, position, stale, hasSample }: {
  mask: number;
  position: number | null;
  stale: boolean;
  hasSample: boolean;
}) {
  const active = getSensorStates(mask);
  const states = active.map((_, index) => getSensorState(mask, index, hasSample));
  return <div className={`sensor-array${stale ? ' sensor-array--stale' : ''}`}>
    <div className="sensor-array__rail" role="list" aria-label="Five IR sensors, ordered from robot left to right">
      {active.map((_, index) => <div
        className={`sensor-cell${states[index] === 'line' ? ' sensor-cell--active' : ''}${position !== null && Math.round(position) === index ? ' sensor-cell--position' : ''}`}
        key={index}
        role="listitem"
      >
        <span className="sensor-cell__light" aria-hidden="true" />
        <span className="sensor-cell__index">S{index + 1}</span>
        <span className="sensor-cell__label">{SENSOR_LABELS[index]}</span>
        <span className="sr-only">
          {states[index] === 'unknown' ? 'No sensor sample received' :
            states[index] === 'line' ? 'Line detected' : 'No line detected'}
        </span>
      </div>)}
    </div>
    <div className="sensor-array__legend">
      <span>{hasSample
        ? <><i className="legend-dot legend-dot--active" /> Active sensor detects line</>
        : 'Awaiting first sensor sample'}</span>
      <span>BIT 0 = ROBOT LEFT</span>
    </div>
  </div>;
}
