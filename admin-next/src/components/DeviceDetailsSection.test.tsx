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
});
