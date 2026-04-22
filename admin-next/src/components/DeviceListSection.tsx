import { Fragment, useState, type ReactNode } from 'react';
import type { DeviceSummary } from '../types/device';

type DeviceListSectionProps = {
  devices: DeviceSummary[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onSelectDevice: (deviceId: string) => void;
  onViewLogs: (deviceId: string) => void;
  onRequestSnapshot: (deviceId: string) => void;
  onRequestRecentLogs: (deviceId: string) => void;
  deviceActionLoadingId: string | null;
  deviceActionError: string | null;
  expandedDeviceId?: string | null;
  renderExpandedContent?: (deviceId: string) => ReactNode;
};

export function DeviceListSection({
  devices,
  loading,
  error,
  onRefresh,
  onSelectDevice,
  onViewLogs,
  onRequestSnapshot,
  onRequestRecentLogs,
  deviceActionLoadingId,
  deviceActionError,
  expandedDeviceId,
  renderExpandedContent,
}: DeviceListSectionProps) {
  const [openMenuDeviceId, setOpenMenuDeviceId] = useState<string | null>(null);

  function toggleMenu(deviceId: string) {
    setOpenMenuDeviceId((current) => (current === deviceId ? null : deviceId));
  }

  return (
    <section>
      <h2>Devices</h2>
      <button type="button" onClick={onRefresh} disabled={loading}>
        Refresh devices
      </button>
      {loading ? <p>Loading devices…</p> : null}
      {error ? <p>{error}</p> : null}
      {deviceActionError ? <p>{deviceActionError}</p> : null}
      {!loading && !error ? (
        devices.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th>OS</th>
                <th>Last Seen</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {devices.map((device) => (
                <Fragment key={device.id}>
                  <tr>
                    <td data-label="Name">{device.name}</td>
                    <td data-label="Status">{device.status}</td>
                    <td data-label="OS">{device.os || '-'}</td>
                    <td data-label="Last Seen">{device.lastSeenAt || '-'}</td>
                    <td data-label="Actions">
                      <div className="device-actions-cell">
                        <button
                          type="button"
                          aria-label={`Select ${device.name}`}
                          aria-expanded={expandedDeviceId === device.id}
                          onClick={() => onSelectDevice(device.id)}
                        >
                          {expandedDeviceId === device.id ? 'Hide' : 'Select'}
                        </button>
                        <button
                          type="button"
                          aria-expanded={openMenuDeviceId === device.id}
                          aria-haspopup="menu"
                          aria-label={`Actions for ${device.name}`}
                          onClick={() => toggleMenu(device.id)}
                        >
                          Actions
                        </button>
                        {openMenuDeviceId === device.id ? (
                          <div className="device-actions-menu" role="menu" aria-label={`Actions for ${device.name}`}>
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => {
                                setOpenMenuDeviceId(null);
                                onViewLogs(device.id);
                              }}
                            >
                              View logs
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              disabled={deviceActionLoadingId === device.id}
                              onClick={() => {
                                setOpenMenuDeviceId(null);
                                onRequestRecentLogs(device.id);
                              }}
                            >
                              {deviceActionLoadingId === device.id ? 'Requesting…' : 'Request recent logs'}
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              disabled={deviceActionLoadingId === device.id}
                              onClick={() => {
                                setOpenMenuDeviceId(null);
                                onRequestSnapshot(device.id);
                              }}
                            >
                              {deviceActionLoadingId === device.id ? 'Requesting…' : 'Request snapshot'}
                            </button>
                          </div>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                  {expandedDeviceId === device.id && renderExpandedContent ? (
                    <tr className="device-expanded-row">
                      <td colSpan={5}>
                        <div className="device-expanded-panel">
                          {renderExpandedContent(device.id)}
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        ) : (
          <p>No devices found.</p>
        )
      ) : null}
    </section>
  );
}
