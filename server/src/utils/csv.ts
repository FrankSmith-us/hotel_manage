function sanitizeCsvCell(val: unknown): string {
  const raw = val === null || val === undefined ? '' : String(val);
  // Neutralize CSV formula injection
  const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  if (/[",\n\r]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

export function buildCsv(headers: string[], rows: unknown[][]): string {
  const lines = [
    headers.map(sanitizeCsvCell).join(','),
    ...rows.map((row) => row.map(sanitizeCsvCell).join(',')),
  ];
  return '\uFEFF' + lines.join('\r\n');
}
