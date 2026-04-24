import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DeviceListSection } from './DeviceListSection';

describe('DeviceListSection', () => {
  it('renders a styled refresh control with helper copy and loading state', () => {
    const onRefresh = vi.fn();

    const { rerender } = render(
      <DeviceListSection
        devices={[]}
        loading={false}
        error={null}
        onRefresh={onRefresh}
        onSelectDevice={vi.fn()}
        onViewLogs={vi.fn()}
        onRequestSnapshot={vi.fn()}
        onRequestRecentLogs={vi.fn()}
        onRequestRestartOpenvpn={vi.fn()}
        onRequestRestartBoundaryAuth={vi.fn()}
        deviceActionLoadingId={null}
        deviceActionError={null}
      />,
    );

    expect(screen.getByText('Pull the latest device status and runtime activity.')).toBeInTheDocument();

    const refreshButton = screen.getByRole('button', { name: /refresh devices/i });
    expect(refreshButton).toHaveClass('device-refresh-button');

    fireEvent.click(refreshButton);
    expect(onRefresh).toHaveBeenCalledTimes(1);

    rerender(
      <DeviceListSection
        devices={[]}
        loading={true}
        error={null}
        onRefresh={onRefresh}
        onSelectDevice={vi.fn()}
        onViewLogs={vi.fn()}
        onRequestSnapshot={vi.fn()}
        onRequestRecentLogs={vi.fn()}
        onRequestRestartOpenvpn={vi.fn()}
        onRequestRestartBoundaryAuth={vi.fn()}
        deviceActionLoadingId={null}
        deviceActionError={null}
      />,
    );

    expect(screen.getByRole('button', { name: /refreshing devices/i })).toBeDisabled();
  });
});
