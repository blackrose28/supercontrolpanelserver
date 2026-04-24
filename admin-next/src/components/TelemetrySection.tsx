import { useState } from 'react';
import type { TelemetryEntry } from '../api/adminApi';
import { formatTimestamp } from '../utils/formatTimestamp';

type TelemetrySectionProps = {
  selectedDeviceId: string | null;
  telemetryLoading: boolean;
  telemetryError: string | null;
  telemetry: TelemetryEntry[];
  telemetryTypeFilter: string;
  telemetryTextFilter: string;
  telemetryFromTsFilter: string;
  telemetryToTsFilter: string;
  telemetryLimit: number;
  onTelemetryTypeFilterChange: (value: string) => void;
  onTelemetryTextFilterChange: (value: string) => void;
  onTelemetryFromTsFilterChange: (value: string) => void;
  onTelemetryToTsFilterChange: (value: string) => void;
  telemetryExportUrl: string | null;
  onRefresh: () => void;
  onLimitChange: (limit: number) => void;
};

function previewPayload(payload: unknown): string {
  if (payload == null) {
    return '—';
  }
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  if (text.length > 24) {
    return `${text.slice(0, 24)}…`;
  }
  return text;
}

export function TelemetrySection({
  selectedDeviceId,
  telemetryLoading,
  telemetryError,
  telemetry,
  telemetryTypeFilter,
  telemetryTextFilter,
  telemetryFromTsFilter,
  telemetryToTsFilter,
  telemetryLimit,
  onTelemetryTypeFilterChange,
  onTelemetryTextFilterChange,
  onTelemetryFromTsFilterChange,
  onTelemetryToTsFilterChange,
  telemetryExportUrl,
  onRefresh,
  onLimitChange,
}: TelemetrySectionProps) {
  function exportEvents(format: 'json' | 'csv') {
    const sourceEvents = visibleTelemetry;
    if (sourceEvents.length === 0) {
      return;
    }

    const timestamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    let blob: Blob;
    let fileName: string;

    if (format === 'csv') {
      const header = 'id,deviceId,type,functionId,sessionId,seq,ts,payload\n';
      const rows = sourceEvents.map((entry) => {
        const event = entry as TelemetryEntry & {
          deviceId?: string;
          sessionId?: string;
          seq?: number;
        };
        const payload = JSON.stringify(entry.payload ?? null).replace(/"/g, '""');
        return [
          entry.id ?? '',
          event.deviceId ?? '',
          entry.type ?? '',
          entry.functionId ?? '',
          event.sessionId ?? '',
          event.seq != null ? String(event.seq) : '',
          entry.ts ?? '',
          `"${payload}"`,
        ].join(',');
      });
      blob = new Blob([header + rows.join('\n')], { type: 'text/csv' });
      fileName = `telemetry-${timestamp}.csv`;
    } else {
      blob = new Blob([JSON.stringify(sourceEvents, null, 2)], { type: 'application/json' });
      fileName = `telemetry-${timestamp}.json`;
    }

    const href = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(href);
  }

  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);
  const [activeTypeFilter, setActiveTypeFilter] = useState<string | null>(null);

  const statsByType = telemetry.reduce<Record<string, number>>((acc, entry) => {
    const type = entry.type || 'unknown';
    acc[type] = (acc[type] || 0) + 1;
    return acc;
  }, {});
  const statEntries = Object.entries(statsByType).sort(([a], [b]) => a.localeCompare(b));

  function toggleDetails(id: string | undefined) {
    if (!id) {
      return;
    }

    setExpandedEventId((current) => (current === id ? null : id));
  }

  function toggleType(type: string) {
    setActiveTypeFilter((current) => (current === type ? null : type));
  }

  const visibleTelemetry = activeTypeFilter
    ? telemetry.filter((entry) => (entry.type || 'unknown') === activeTypeFilter)
    : telemetry;

  const canExportEvents = visibleTelemetry.length > 0;

  return (
    <section className="panel-section telemetry-section">
      <div className="telemetry-section-header">
        <div>
          <h2>Telemetry</h2>
          <p className="telemetry-section-subtitle">
            Filter, inspect, and export device telemetry without losing context on active event types.
          </p>
        </div>
        <div className="telemetry-toolbar">
          {selectedDeviceId ? (
            <>
              <p className="telemetry-toolbar-caption">Showing up to {telemetryLimit} events</p>
              <label className="telemetry-toolbar-label toolbar-limit-field">
                Show:{' '}
              <select
                aria-label="Telemetry limit"
                className="telemetry-toolbar-select"
                value={telemetryLimit}
                onChange={(e) => onLimitChange(Number(e.target.value))}
                disabled={telemetryLoading}
              >
                <option value={50}>50</option>
                <option value={100}>100</option>
                <option value={200}>200</option>
                <option value={500}>500</option>
              </select>
              </label>
            </>
          ) : null}
          <button className="telemetry-toolbar-button" type="button" onClick={onRefresh} disabled={!selectedDeviceId || telemetryLoading}>
            Refresh telemetry
          </button>
        </div>
      </div>
      <div className="telemetry-tools-grid">
        <div className="telemetry-filter-panel">
          <div className="telemetry-panel-heading">Telemetry filters</div>
          <div className="telemetry-filter-grid">
            <label className="telemetry-filter-field">
              Type
              <input
                className="telemetry-filter-input"
                type="text"
                value={telemetryTypeFilter}
                onChange={(event) => onTelemetryTypeFilterChange(event.target.value)}
              />
            </label>
            <label className="telemetry-filter-field">
              Search
              <input
                className="telemetry-filter-input"
                type="text"
                value={telemetryTextFilter}
                onChange={(event) => onTelemetryTextFilterChange(event.target.value)}
              />
            </label>
            <label className="telemetry-filter-field">
              From
              <input
                className="telemetry-filter-input"
                type="text"
                value={telemetryFromTsFilter}
                onChange={(event) => onTelemetryFromTsFilterChange(event.target.value)}
              />
            </label>
            <label className="telemetry-filter-field">
              To
              <input
                className="telemetry-filter-input"
                type="text"
                value={telemetryToTsFilter}
                onChange={(event) => onTelemetryToTsFilterChange(event.target.value)}
              />
            </label>
          </div>
        </div>
        <div className="telemetry-export-panel">
          <div className="telemetry-panel-heading">Export</div>
          <a
            className="telemetry-export-link"
            href={telemetryExportUrl || '#'}
            aria-disabled={!telemetryExportUrl}
          >
            Export telemetry
          </a>
          <div className="telemetry-export-actions">
            <button className="telemetry-toolbar-button" type="button" disabled={!canExportEvents} onClick={() => exportEvents('json')}>Export JSON</button>
            <button className="telemetry-toolbar-button" type="button" disabled={!canExportEvents} onClick={() => exportEvents('csv')}>Export CSV</button>
          </div>
        </div>
      </div>
      {!selectedDeviceId ? <p>Select a device to load telemetry.</p> : null}
      {telemetryLoading ? <p>Loading telemetry…</p> : null}
      {telemetryError ? <p>{telemetryError}</p> : null}
      {selectedDeviceId && !telemetryLoading && !telemetryError ? (
        telemetry.length > 0 ? (
          <>
            <h3>Chart summary</h3>
            <ul>
              {statEntries.map(([type, count]) => (
                <li key={type}>{type}: {count}</li>
              ))}
            </ul>
            <ul>
              {statEntries.map(([type, count]) => {
                const active = activeTypeFilter === type;
                return (
                  <li key={`chip-${type}`}>
                    <button type="button" aria-pressed={active} onClick={() => toggleType(type)}>
                      {count} {type}
                    </button>
                  </li>
                );
              })}
            </ul>
            <div className="telemetry-panel-heading">Event stream</div>
            <ul>
              {visibleTelemetry.map((entry) => {
                const expanded = expandedEventId === entry.id;
                return (
                  <li className="telemetry-row" key={entry.id || `${entry.ts || ''}-${entry.type || ''}`}>
                    <div className="telemetry-row-main">
                      <strong>{entry.type || '-'}</strong>
                      <span>{formatTimestamp(entry.ts)}</span>
                    </div>
                    <div className="telemetry-row-main">
                      <span>{entry.functionId || '-'}</span>
                      <span title={typeof entry.payload === 'string' ? entry.payload : JSON.stringify(entry.payload ?? null)}>{previewPayload(entry.payload)}</span>
                    </div>
                    <button className="telemetry-toggle-button" type="button" aria-label="Toggle detail" onClick={() => toggleDetails(entry.id)}>{expanded ? '▲' : '▼'}</button>
                    {expanded ? <pre>{JSON.stringify(entry, null, 2)}</pre> : null}
                  </li>
                );
              })}
            </ul>
          </>
        ) : (
          <>
            <p>No telemetry matched the current filters.</p>
            <p>No data to chart</p>
          </>
        )
      ) : null}
    </section>
  );
}
