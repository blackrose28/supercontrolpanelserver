import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DeviceDetailsSection } from './DeviceDetailsSection';

describe('DeviceDetailsSection', () => {
  it('renders helper copy and a clearer details summary layout', () => {
    render(
      <DeviceDetailsSection
        selectedDeviceId="dev-1"
        selectedDeviceLoading={false}
        selectedDeviceError={null}
        selectedDeviceDetails={{
          id: 'dev-1',
          name: 'Device One',
          status: 'connected',
          os: 'linux',
          lastSeenAt: '2026-04-20T00:00:00.000Z',
        }}
      />,
    );

    expect(screen.getByText('Review the selected device identity, health, and most recent activity snapshot.')).toBeInTheDocument();
    expect(screen.getByText('Identity')).toBeInTheDocument();
    expect(screen.getByText('Current state')).toBeInTheDocument();
    expect(screen.getByText('Recent activity')).toBeInTheDocument();
    expect(screen.getByText('Device One')).toBeInTheDocument();
    expect(screen.getByText('connected')).toBeInTheDocument();
    expect(screen.getByText('linux')).toBeInTheDocument();
    expect(screen.getByText('2026-04-20 07:00:00 GMT+7')).toBeInTheDocument();
  });

  it('renders connected status with green badge class', () => {
    render(
      <DeviceDetailsSection
        selectedDeviceId="dev-1"
        selectedDeviceLoading={false}
        selectedDeviceError={null}
        selectedDeviceDetails={{
          id: 'dev-1',
          name: 'Device One',
          status: 'connected',
          os: 'linux',
          lastSeenAt: null,
        }}
      />,
    );

    const statusElements = screen.getAllByText('connected');
    const badgeElement = statusElements.find((el) => el.classList.contains('device-status-badge'));
    expect(badgeElement).toBeDefined();
    expect(badgeElement).toHaveClass('device-status-connected');
    expect(badgeElement).toHaveClass('device-status-badge');
  });

  it('renders disconnected status with red badge class', () => {
    render(
      <DeviceDetailsSection
        selectedDeviceId="dev-2"
        selectedDeviceLoading={false}
        selectedDeviceError={null}
        selectedDeviceDetails={{
          id: 'dev-2',
          name: 'Device Two',
          status: 'disconnected',
          os: null,
          lastSeenAt: null,
        }}
      />,
    );

    const statusElements = screen.getAllByText('disconnected');
    const badgeElement = statusElements.find((el) => el.classList.contains('device-status-badge'));
    expect(badgeElement).toBeDefined();
    expect(badgeElement).toHaveClass('device-status-disconnected');
    expect(badgeElement).toHaveClass('device-status-badge');
  });
});
