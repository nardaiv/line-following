import type { Telemetry } from '../lib/robot-data.js';

type Field = 'error' | 'correction';

export default function TrendChart({ points, field, title, color, unit }: {
  points: Telemetry[];
  field: Field;
  title: string;
  color: string;
  unit: string;
}) {
  const height = 166;
  const width = 640;
  const pad = { top: 12, right: 12, bottom: 22, left: 38 };
  const min = field === 'error' ? -2 : -120;
  const max = field === 'error' ? 2 : 120;
  const usableWidth = width - pad.left - pad.right;
  const usableHeight = height - pad.top - pad.bottom;
  const data = points.flatMap((point, index) => {
    const value = point[field];
    return value === null || !Number.isFinite(value) ? [] : [{ index, value }];
  });
  const coordinates = data.map(({ index, value }) => {
    const x = pad.left + (points.length <= 1 ? 0 : index / (points.length - 1)) * usableWidth;
    const y = pad.top + ((max - value) / (max - min)) * usableHeight;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const axisLabels = field === 'error' ? ['+2', '+1', '0', '−1', '−2'] : ['+120', '+60', '0', '−60', '−120'];

  return <section className="chart-card" aria-label={`${title} trend`}>
    <div className="chart-card__heading">
      <div>
        <h3>{title}</h3>
        <span className="chart-card__sub">LAST {points.length} SAMPLES</span>
      </div>
      <span className="chart-card__unit">{unit}</span>
    </div>
    {data.length < 2 ? <div className="chart-empty">Waiting for live samples…</div> : <svg
      className="trend-chart"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`${title} values over the latest ${data.length} telemetry samples`}
      preserveAspectRatio="none"
    >
      {axisLabels.map((label, index) => {
        const y = pad.top + index * (usableHeight / 4);
        return <g key={label}>
          <line x1={pad.left} x2={width - pad.right} y1={y} y2={y}
            className={index === 2 ? 'trend-chart__zero' : 'trend-chart__grid'} />
          <text x={pad.left - 8} y={y + 4} textAnchor="end" className="trend-chart__label">{label}</text>
        </g>;
      })}
      <polyline points={coordinates} fill="none" stroke={color} strokeWidth="2.4"
        strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>}
    <div className="chart-card__footer">
      <span><i className="chart-legend" style={{ backgroundColor: color }} /> {field === 'error' ? 'Line error' : 'PID output'}</span>
      <span>{data.length < 2 ? '—' : `${data.at(-1)?.value.toFixed(2)} ${unit}`}</span>
    </div>
  </section>;
}
