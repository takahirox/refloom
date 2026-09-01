export function displayReference(reference) {
  return reference.title || reference.sourceUrl || 'Untitled reference';
}

export function safeExternalWebsiteUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

export function formatMoment(moment) {
  if (!moment) return '';
  if (moment.label) return moment.label;
  const start = moment.start === undefined ? '' : formatSeconds(moment.start);
  const end = moment.end === undefined ? '' : formatSeconds(moment.end);
  return end ? `${start}–${end}` : start;
}

export function formatSeconds(value) {
  if (!Number.isFinite(value) || value < 0) return '';
  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}

export function formatSignal(signal) {
  const labels = {
    capture: 'Captured a reference',
    enrich: 'Updated reference details',
    'selection.create': 'Created a selection',
    'board.change': 'Changed the board',
    export: 'Exported creative direction'
  };
  return labels[signal.event] || signal.event;
}

export function safeFilename(value, extension) {
  const base = String(value || 'refloom').normalize('NFKD')
    .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'refloom';
  return `${base}.${extension}`;
}
