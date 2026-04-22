import type { DeviceSummary } from '../types/device';

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
    <section className="panel-section">
      <h2>Device Details</h2>
      {!selectedDeviceId ? <p>Select a device to view details.</p> : null}
      {selectedDeviceLoading ? <p>Loading selected device…</p> : null}
      {selectedDeviceError ? <p>{selectedDeviceError}</p> : null}
      {selectedDeviceDetails && !selectedDeviceLoading && !selectedDeviceError ? (
        <dl>
          <dt>ID</dt>
          <dd>{selectedDeviceDetails.id}</dd>
          <dt>Name</dt>
          <dd>{selectedDeviceDetails.name}</dd>
          <dt>Status</dt>
          <dd>{selectedDeviceDetails.status}</dd>
          <dt>OS</dt>
          <dd>{selectedDeviceDetails.os || '-'}</dd>
          <dt>Last Seen</dt>
          <dd>{selectedDeviceDetails.lastSeenAt || '-'}</dd>
        </dl>
      ) : null}
    </section>
  );
}
