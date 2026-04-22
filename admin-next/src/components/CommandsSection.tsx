import type { CommandAuditEntry, CommandHistoryEntry } from '../api/adminApi';

type CommandsSectionProps = {
  selectedDeviceId: string | null;
  commandsLoading: boolean;
  commandsError: string | null;
  commands: CommandHistoryEntry[];
  commandsLimit: number;
  selectedCommandId: string | null;
  commandAudit: CommandAuditEntry[];
  commandAuditLoading: boolean;
  commandAuditError: string | null;
  onRefresh: () => void;
  onSelectCommand: (commandId: string) => void;
  onLimitChange: (limit: number) => void;
};

function formatActor(command: CommandHistoryEntry): string {
  if (command.actorType === 'admin_api_token') {
    return command.actorId ? `API token ${command.actorId}` : 'API token';
  }
  if (command.actorType === 'admin_env_token') {
    return 'Env token';
  }
  if (command.actorType === 'admin_session') {
    return 'Admin UI';
  }
  return command.actorType || '-';
}

export function CommandsSection({
  selectedDeviceId,
  commandsLoading,
  commandsError,
  commands,
  commandsLimit,
  selectedCommandId,
  commandAudit,
  commandAuditLoading,
  commandAuditError,
  onRefresh,
  onSelectCommand,
  onLimitChange,
}: CommandsSectionProps) {
  return (
    <section className="panel-section commands-section">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2>Command History</h2>
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
          {selectedDeviceId ? (
            <label style={{ fontSize: '0.9rem' }}>
              Show:{' '}
              <select
                value={commandsLimit}
                onChange={(e) => onLimitChange(Number(e.target.value))}
                disabled={commandsLoading}
              >
                <option value={20}>20</option>
                <option value={50}>50</option>
                <option value={100}>100</option>
                <option value={200}>200</option>
              </select>
            </label>
          ) : null}
          <button className="panel-refresh-button" type="button" onClick={onRefresh} disabled={!selectedDeviceId || commandsLoading}>
            Refresh commands
          </button>
        </div>
      </div>
      {!selectedDeviceId ? <p>Select a device to load command history.</p> : null}
      {commandsLoading ? <p>Loading commands…</p> : null}
      {commandsError ? <p>{commandsError}</p> : null}
      {selectedDeviceId && !commandsLoading && !commandsError ? (
        commands.length > 0 ? (
          <>
            <p>Showing recent commands for {selectedDeviceId} ({commands.length} loaded)</p>
            <ul>
              {commands.map((command) => {
                const finished = command.finishedAt ? `Finished: ${command.finishedAt}` : 'In progress';
                const reason = command.reasonCode || command.outcome || '';
                return (
                  <li className="command-card-row" key={command.commandId}>
                    <div className="command-card-head">
                      <button
                        className="command-card-button"
                        type="button"
                        onClick={() => onSelectCommand(command.commandId)}
                        aria-pressed={command.commandId === selectedCommandId}
                      >
                        <strong>{command.commandType || '-'}</strong>
                      </button>
                      <span className={`command-state-badge state-${command.state || 'unknown'}`}>{command.state || '-'}</span>
                    </div>
                    <div className="command-card-meta-line">Submitted: {command.submittedAt || '-'}</div>
                    <div className="command-card-meta-line">Actor: {formatActor(command)}</div>
                    <div className="command-card-meta-line">Summary: {command.payloadSummary || '-'}</div>
                    <div className="command-card-meta-line">{reason ? `${finished} | Result: ${reason}` : finished}</div>
                  </li>
                );
              })}
            </ul>

            <h3>Command Audit</h3>
            {selectedCommandId ? <p>Selected command: {selectedCommandId}</p> : null}
            {commandAuditLoading ? <p>Loading command audit…</p> : null}
            {commandAuditError ? <p>{commandAuditError}</p> : null}
            {!commandAuditLoading && !commandAuditError ? (
              commandAudit.length > 0 ? (
                <ul className="command-audit-list">
                  {commandAudit.map((entry, index) => (
                    <li className="command-audit-entry" key={`${entry.eventType || 'event'}-${entry.ts || ''}-${index}`}>
                      <strong>{entry.eventType || 'event'}</strong> · <span>{entry.ts || '-'}</span> ·{' '}
                      <span>{entry.summary || '-'}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No audit entries found.</p>
              )
            ) : null}
          </>
        ) : (
          <p>No commands found.</p>
        )
      ) : null}
    </section>
  );
}
