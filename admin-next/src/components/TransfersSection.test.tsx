import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TransfersSection } from './TransfersSection';

describe('TransfersSection', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders helper copy, toolbar controls, and structured transfer cards', () => {
    const onRefresh = vi.fn();
    const onDismissFinished = vi.fn();
    const onLimitChange = vi.fn();
    const onResumeTransfer = vi.fn();

    render(
      <TransfersSection
        selectedDeviceId="dev-1"
        transfersLoading={false}
        transfersError={null}
        transfersLimit={100}
        transferActionLoading={false}
        transferStartLoading={false}
        activeTransferId={null}
        servers={[]}
        transfers={[
          {
            transferId: 'tr-1',
            direction: 'upload',
            state: 'failed',
            updatedAt: '2026-04-20T00:00:00.000Z',
            phase: 'resume-ready',
            percent: 67.2,
            bytesTransferred: 672,
            bytesTotal: 1000,
            throughputBps: 25,
            etaSec: 13,
            resumeSupported: true,
            resumeToken: 'resume-1',
            resumeOffsetBytes: 672,
            tempPathHint: '/tmp/file.partial',
          },
        ]}
        onRefresh={onRefresh}
        onStopTransfer={vi.fn()}
        onDismissTransfer={vi.fn()}
        onForceRemoveTransfer={vi.fn()}
        onResumeTransfer={onResumeTransfer}
        onStartTransfer={vi.fn()}
        onDismissFinished={onDismissFinished}
        onLimitChange={onLimitChange}
      />,
    );

    expect(screen.getByText('Monitor active transfers, stalled work, and recovery actions from one place.')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Transfer history limit' })).toHaveClass('transfers-toolbar-select');
    expect(screen.getByText('Show:').closest('label')).toHaveClass('toolbar-limit-field');
    expect(screen.getByText('Showing up to 100 transfers')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh transfers' })).toHaveClass('transfers-toolbar-button');
    expect(screen.getByText('Transfer queue')).toBeInTheDocument();
    expect(screen.getByText('Progress: 67.2%')).toBeInTheDocument();
    expect(screen.getByText('Transferred: 672 / 1000 bytes')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resume' }).closest('.transfer-card')).toHaveTextContent('resume-ready');

    fireEvent.click(screen.getByRole('button', { name: 'Refresh transfers' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear finished' }));
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Transfer history limit' }), {
      target: { value: '200' },
    });

    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onDismissFinished).toHaveBeenCalledTimes(1);
    expect(onResumeTransfer).toHaveBeenCalledWith('tr-1');
    expect(onLimitChange).toHaveBeenCalledWith(200);
  });

  it('renders a server SCP launch form and submits upload/download payloads', () => {
    const onStartTransfer = vi.fn();

    render(
      <TransfersSection
        selectedDeviceId="dev-1"
        transfersLoading={false}
        transfersError={null}
        transfersLimit={50}
        transferActionLoading={false}
        transferStartLoading={false}
        activeTransferId={null}
        servers={[
          { id: 'srv-1', name: 'App Server', connectionMethod: 'ssh', host: 'app.internal', sshUser: 'ubuntu' },
        ]}
        transfers={[]}
        onRefresh={vi.fn()}
        onStopTransfer={vi.fn()}
        onDismissTransfer={vi.fn()}
        onForceRemoveTransfer={vi.fn()}
        onResumeTransfer={vi.fn()}
        onStartTransfer={onStartTransfer}
        onDismissFinished={vi.fn()}
        onLimitChange={vi.fn()}
      />,
    );

    expect(screen.getByText('Start server transfer')).toBeInTheDocument();
    expect(screen.getByText('App Server')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('combobox', { name: 'Transfer direction' }), {
      target: { value: 'download' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Local path' }), {
      target: { value: '/tmp/report.csv' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Remote path' }), {
      target: { value: '/var/tmp/report.csv' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'If destination exists' }), {
      target: { value: 'force' },
    });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Rate limit KB/s' }), {
      target: { value: '512' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Recursive' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Verify checksum' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Follow symlinks' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Preserve mtime' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Preserve mode' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start download' }));

    expect(onStartTransfer).toHaveBeenCalledWith('dev-1', 'download', {
      serverId: 'srv-1',
      localPath: '/tmp/report.csv',
      remotePath: '/var/tmp/report.csv',
      recursive: true,
      overwritePolicy: 'force',
      verifyChecksum: true,
      followSymlinks: true,
      preserveMtime: true,
      preserveMode: true,
      rateLimitKbps: 512,
    });
  });

  it('renders realtime progress bars and normalizes successful byte totals', () => {
    render(
      <TransfersSection
        selectedDeviceId="dev-1"
        transfersLoading={false}
        transfersError={null}
        transfersLimit={50}
        transferActionLoading={false}
        transferStartLoading={false}
        activeTransferId={null}
        servers={[]}
        transfers={[
          {
            transferId: 'tr-running',
            direction: 'upload',
            state: 'running',
            updatedAt: '2026-04-21T00:00:00.000Z',
            percent: 37,
            bytesTransferred: 321,
            bytesTotal: 86682104,
          },
          {
            transferId: 'tr-success',
            direction: 'download',
            state: 'succeeded',
            updatedAt: '2026-04-21T00:01:00.000Z',
            bytesTransferred: 0,
            bytesTotal: 86682104,
          },
        ]}
        onRefresh={() => {}}
        onStopTransfer={() => {}}
        onDismissTransfer={() => {}}
        onForceRemoveTransfer={() => {}}
        onResumeTransfer={() => {}}
        onStartTransfer={() => {}}
        onDismissFinished={() => {}}
        onLimitChange={() => {}}
      />,
    );

    const runningProgress = screen.getByRole('progressbar', { name: 'Transfer progress tr-running' });
    expect(runningProgress).toHaveAttribute('aria-valuenow', '37');
    expect(runningProgress.querySelector('.transfer-progress-bar')).toHaveStyle({ width: '37%' });
    expect(screen.getByText('Progress: 37.0%')).toBeInTheDocument();
    expect(screen.getByText('Transferred: 86682104 / 86682104 bytes')).toBeInTheDocument();
  });

});
