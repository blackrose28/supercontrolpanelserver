import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TelemetrySection } from './TelemetrySection';

describe('TelemetrySection', () => {
  it('renders helper copy, grouped filters, and readable telemetry rows', () => {
    const onRefresh = vi.fn();
    const onLimitChange = vi.fn();
    const onTypeChange = vi.fn();
    const onTextChange = vi.fn();

    render(
      <TelemetrySection
        selectedDeviceId="dev-1"
        telemetryLoading={false}
        telemetryError={null}
        telemetry={[
          {
            id: 'evt-1',
            type: 'function_status',
            functionId: 'vpn-agent',
            ts: '2026-04-20T00:00:00.000Z',
            payload: { state: 'running' },
          },
        ]}
        telemetryTypeFilter=""
        telemetryTextFilter=""
        telemetryFromTsFilter=""
        telemetryToTsFilter=""
        telemetryLimit={100}
        onTelemetryTypeFilterChange={onTypeChange}
        onTelemetryTextFilterChange={onTextChange}
        onTelemetryFromTsFilterChange={vi.fn()}
        onTelemetryToTsFilterChange={vi.fn()}
        telemetryExportUrl="/v1/logs/export?deviceId=dev-1&limit=100"
        onRefresh={onRefresh}
        onLimitChange={onLimitChange}
      />,
    );

    expect(screen.getByText('Filter, inspect, and export device telemetry without losing context on active event types.')).toBeInTheDocument();
    expect(screen.getByText('Telemetry filters')).toBeInTheDocument();
    expect(screen.getByText('Event stream')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Telemetry limit' })).toHaveClass('telemetry-toolbar-select');
    expect(screen.getByText('Show:').closest('label')).toHaveClass('toolbar-limit-field');
    expect(screen.getByRole('button', { name: 'Refresh telemetry' })).toHaveClass('telemetry-toolbar-button');
    expect(screen.getByRole('link', { name: 'Export telemetry' })).toHaveClass('telemetry-export-link');
    expect(screen.getByLabelText('Type').closest('label')).toHaveClass('telemetry-filter-field');
    expect(screen.getByLabelText('Search').closest('label')).toHaveClass('telemetry-filter-field');
    expect(screen.getByText('function_status')).toBeInTheDocument();
    expect(screen.getByText('vpn-agent')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh telemetry' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Telemetry limit' }), {
      target: { value: '200' },
    });
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'function_status' } });
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'vpn' } });

    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onLimitChange).toHaveBeenCalledWith(200);
    expect(onTypeChange).toHaveBeenCalledWith('function_status');
    expect(onTextChange).toHaveBeenCalledWith('vpn');
  });
});
