import type { DeviceSummary } from '../types/device';
import { formatTimestamp } from '../utils/formatTimestamp';

type DeviceDetailsSectionProps = {
  selectedDeviceId: string | null;
  selectedDeviceLoading: boolean;
  selectedDeviceError: string | null;
  selectedDeviceDetails: DeviceSummary | null;
};

export function DeviceDetailsSection({
  selectedDeviceId,
  selectedDeviceLoading,
  selectedDeviceError,
  selectedDeviceDetails,
}: DeviceDetailsSectionProps) {
  return (
    <section className="panel-section device-details-section">
      <div className="device-details-header">
        <div>
          <h2>Device Details</h2>
          <p className="device-details-subtitle">
            Review the selected device identity, health, and most recent activity snapshot.
          </p>
        </div>
      </div>
      {!selectedDeviceId ? <p>Select a device to view details.</p> : null}
      {selectedDeviceLoading ? <p>Loading selected device…</p> : null}
      {selectedDeviceError ? <p>{selectedDeviceError}</p> : null}
      {selectedDeviceDetails && !selectedDeviceLoading && !selectedDeviceError ? (
        <div className="device-details-grid">
          <div className="device-details-card">
            <h3>Identity</h3>
            <dl className="device-details-list">
              <dt>ID</dt>
              <dd>{selectedDeviceDetails.id}</dd>
              <dt>Name</dt>
              <dd>{selectedDeviceDetails.name}</dd>
            </dl>
          </div>
          <div className="device-details-card">
            <h3>Current state</h3>
            <dl className="device-details-list">
              <dt>Status</dt>
              <dd>{selectedDeviceDetails.status}</dd>
              <dt>OS</dt>
              <dd>{selectedDeviceDetails.os || '-'}</dd>
            </dl>
          </div>
          <div className="device-details-card">
            <h3>Recent activity</h3>
            <dl className="device-details-list">
              <dt>Last Seen</dt>
              <dd>{formatTimestamp(selectedDeviceDetails.lastSeenAt)}</dd>
            </dl>
          </div>
        </div>
      ) : null}
    </section>
  );
}
