const DISPLAY_TIME_ZONE = 'Asia/Ho_Chi_Minh';
const DISPLAY_TIME_ZONE_LABEL = 'GMT+7';

function pad(value: string): string {
  return value.padStart(2, '0');
}

export function formatTimestamp(value?: string | null): string {
  if (!value) {
    return '-';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: DISPLAY_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });

  const parts = formatter.formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return `${byType.year}-${pad(byType.month || '')}-${pad(byType.day || '')} ${pad(byType.hour || '')}:${pad(byType.minute || '')}:${pad(byType.second || '')} ${DISPLAY_TIME_ZONE_LABEL}`;
}

