/** @param {unknown} value @returns {string | null} */
function parseUtcInput(value) {
  if (typeof value !== 'string') return null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    const utcDate = new Date(value);
    return Number.isFinite(utcDate.getTime()) && utcDate.toISOString() === value
      ? value : null;
  }
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) return null;
  const seconds = match[4] ?? '00';
  const iso = `${match[1]}T${match[2]}:${match[3]}:${seconds}.000Z`;
  const parsed = new Date(iso);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== iso) return null;
  return iso;
}

/** @param {string} robotId @param {string} fromInput @param {string} toInput */
export function buildTelemetryCsvUrls(robotId, fromInput, toInput) {
  if (typeof robotId !== 'string' || robotId.length === 0) return null;
  const from = parseUtcInput(fromInput);
  const to = parseUtcInput(toInput);
  if (from === null || to === null || from >= to) return null;
  const query = new URLSearchParams({ from, to }).toString();
  const base = `/api/robots/${encodeURIComponent(robotId)}/telemetry.csv`;
  return { from, to, infoUrl: `${base}/info?${query}`, csvUrl: `${base}?${query}` };
}

/** @param {Date} date */
export function utcDateTimeInputValue(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return '';
  return date.toISOString().slice(0, 19);
}
