import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TransfersSection } from './TransfersSection';

describe('TransfersSection', () => {
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
        activeTransferId={null}
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
});
