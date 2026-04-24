import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CommandsSection } from './CommandsSection';

describe('CommandsSection', () => {
  it('renders helper copy, a styled toolbar, and structured command and audit cards', () => {
    const onRefresh = vi.fn();
    const onLimitChange = vi.fn();
    const onSelectCommand = vi.fn();

    render(
      <CommandsSection
        selectedDeviceId="dev-1"
        commandsLoading={false}
        commandsError={null}
        commands={[
          {
            commandId: 'cmd-1',
            commandType: 'request_status_snapshot',
            state: 'queued',
            submittedAt: '2026-04-20T00:00:00.000Z',
            actorType: 'admin_session',
            payloadSummary: 'Manual snapshot request',
          },
        ]}
        commandsLimit={50}
        selectedCommandId="cmd-1"
        commandAudit={[
          {
            eventType: 'queued',
            ts: '2026-04-20T00:01:00.000Z',
            summary: 'Queued for delivery',
          },
        ]}
        commandAuditLoading={false}
        commandAuditError={null}
        onRefresh={onRefresh}
        onSelectCommand={onSelectCommand}
        onLimitChange={onLimitChange}
      />,
    );

    expect(screen.getByText('Inspect recent admin actions, command state changes, and per-command audit details.')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Command history limit' })).toHaveClass('commands-toolbar-select');
    expect(screen.getByText('Show:').closest('label')).toHaveClass('toolbar-limit-field');
    expect(screen.getByText('Showing up to 50 commands')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh commands' })).toHaveClass('commands-toolbar-button');
    expect(screen.getByText('Recent command activity')).toBeInTheDocument();
    expect(screen.getByText('Audit trail')).toBeInTheDocument();
    expect(screen.getByText('Queued for delivery')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /request_status_snapshot/i }).closest('.command-card-row')).toHaveTextContent('Manual snapshot request');

    fireEvent.click(screen.getByRole('button', { name: /request_status_snapshot/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh commands' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Command history limit' }), {
      target: { value: '100' },
    });

    expect(onSelectCommand).toHaveBeenCalledWith('cmd-1');
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onLimitChange).toHaveBeenCalledWith(100);
  });
});
