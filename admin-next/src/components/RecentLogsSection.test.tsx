import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RecentLogsSection } from './RecentLogsSection';

describe('RecentLogsSection', () => {
  it('renders helper copy, a styled limit toolbar, and readable log cards', () => {
    const onLimitChange = vi.fn();

    render(
      <RecentLogsSection
        selectedDeviceId="dev-1"
        recentLogsLoading={false}
        recentLogsError={null}
        recentLogsLimit={50}
        recentLogs={[
          {
            id: 'log-1',
            ts: '2026-04-20T00:00:00.000Z',
            type: 'function_status',
            functionId: 'vpn-agent',
          },
        ]}
        onRetry={vi.fn()}
        onLimitChange={onLimitChange}
      />,
    );

    expect(screen.getByText('Review the latest device events, function updates, and runtime activity at a glance.')).toBeInTheDocument();
    expect(screen.getByText('Recent log entries')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Recent log limit' })).toHaveClass('logs-toolbar-select');
    expect(screen.getByText('Show:').closest('label')).toHaveClass('toolbar-limit-field');
    expect(screen.getByText('Showing up to 50 entries')).toBeInTheDocument();
    expect(screen.getByText('function_status')).toBeInTheDocument();
    expect(screen.getByText('vpn-agent')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('combobox', { name: 'Recent log limit' }), {
      target: { value: '100' },
    });

    expect(onLimitChange).toHaveBeenCalledWith(100);
  });
});
