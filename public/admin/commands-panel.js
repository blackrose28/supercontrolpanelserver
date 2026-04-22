(function initAdminCommandsPanel(global) {
  function createCommandsPanel(deps) {
    const {
      escapeHtml,
      formatDateTime,
      formatPayload,
      getSelectedDeviceId,
      getCurrentCommands,
      setCurrentCommands,
      getSelectedCommandId,
      setSelectedCommandId,
    } = deps;

    function formatActor(command) {
      if (!command) {
        return '-';
      }
      if (command.actorType === 'admin_api_token') {
        return command.actorId ? 'API token ' + command.actorId : 'API token';
      }
      if (command.actorType === 'admin_env_token') {
        return 'Env token';
      }
      if (command.actorType === 'admin_session') {
        return 'Admin UI';
      }
      return command.actorType || '-';
    }

    function renderCommandAudit(command, items) {
      const container = document.getElementById('command-audit-content');
      if (!command) {
        container.innerHTML = '<div class="command-empty">Select a command to inspect audit entries.</div>';
        return;
      }
      if (!Array.isArray(items) || !items.length) {
        container.innerHTML =
          '<div class="command-empty">No audit entries stored yet for ' + escapeHtml(command.commandType) + '.</div>';
        return;
      }
      container.innerHTML = items.map((item) => {
        const klass = ['failed', 'succeeded', 'executing', 'canceled'].includes(String(item.eventType || ''))
          ? escapeHtml(String(item.eventType))
          : '';
        return '<div class="command-audit-entry ' + klass + '">' +
          '<div class="command-card-head">' +
            '<div class="command-card-title">' + escapeHtml(item.eventType || 'event') + '</div>' +
            '<div class="command-card-meta">' + escapeHtml(formatDateTime(item.ts)) + '</div>' +
          '</div>' +
          '<div class="command-card-meta">' + escapeHtml(item.summary || '-') + '</div>' +
          '<pre class="summary-pre" style="margin-top:8px;">' + escapeHtml(formatPayload(item.details)) + '</pre>' +
        '</div>';
      }).join('');
    }

    function renderCommands(commands) {
      const nextCommands = Array.isArray(commands) ? commands : [];
      if (typeof setCurrentCommands === 'function') {
        setCurrentCommands(nextCommands);
      }
      const currentCommands = typeof getCurrentCommands === 'function' ? getCurrentCommands() : nextCommands;
      const selectedDeviceId = typeof getSelectedDeviceId === 'function' ? getSelectedDeviceId() : null;
      const list = document.getElementById('commands-list');
      const meta = document.getElementById('commands-meta');
      meta.textContent = selectedDeviceId
        ? 'Showing recent commands for ' + selectedDeviceId + ' (' + currentCommands.length + ' loaded)'
        : 'Select a device to load recent commands and audit trail.';

      if (!selectedDeviceId) {
        list.innerHTML = '<div class="command-empty">No device selected.</div>';
        return;
      }

      if (!currentCommands.length) {
        list.innerHTML = '<div class="command-empty">No commands have been stored for this device yet.</div>';
        renderCommandAudit(null, []);
        return;
      }

      let selectedCommandId = typeof getSelectedCommandId === 'function' ? getSelectedCommandId() : null;
      if (!selectedCommandId || !currentCommands.some((item) => item.commandId === selectedCommandId)) {
        selectedCommandId = currentCommands[0].commandId;
        if (typeof setSelectedCommandId === 'function') {
          setSelectedCommandId(selectedCommandId);
        }
      }

      list.innerHTML = currentCommands.map((command) => {
        const selected = command.commandId === selectedCommandId;
        const finished = command.finishedAt ? 'Finished: ' + escapeHtml(formatDateTime(command.finishedAt)) : 'In progress';
        const reason = command.reasonCode || command.outcome || '';
        return '<button type="button" class="command-card ' + (selected ? 'selected' : '') + '" data-command-id="' + escapeHtml(command.commandId) + '">' +
          '<div class="command-card-head">' +
            '<div class="command-card-title">' + escapeHtml(command.commandType) + '</div>' +
            '<div class="command-state ' + escapeHtml(command.state) + '">' + escapeHtml(command.state) + '</div>' +
          '</div>' +
          '<div class="command-card-meta">Submitted: ' + escapeHtml(formatDateTime(command.submittedAt)) + '</div>' +
          '<div class="command-card-meta">Actor: ' + escapeHtml(formatActor(command)) + '</div>' +
          '<div class="command-card-meta">Summary: ' + escapeHtml(command.payloadSummary || '-') + '</div>' +
          '<div class="command-card-meta">' + finished + (reason ? ' | Result: ' + escapeHtml(reason) : '') + '</div>' +
        '</button>';
      }).join('');
    }

    async function loadCommands(deviceId) {
      const params = new URLSearchParams({ deviceId, limit: '20' });
      const response = await fetch('/v1/commands?' + params.toString());
      if (!response.ok) {
        throw new Error('Failed to load commands');
      }
      const payload = await response.json();
      return Array.isArray(payload && payload.items) ? payload.items : [];
    }

    async function loadCommandAudit(commandId) {
      const response = await fetch('/v1/commands/' + encodeURIComponent(commandId) + '/audit');
      if (!response.ok) {
        throw new Error('Failed to load command audit');
      }
      const payload = await response.json();
      return Array.isArray(payload && payload.items) ? payload.items : [];
    }

    async function refreshCommands(deviceId, preferredCommandId) {
      if (!deviceId) {
        if (typeof setSelectedCommandId === 'function') {
          setSelectedCommandId(null);
        }
        renderCommands([]);
        renderCommandAudit(null, []);
        return;
      }
      try {
        const commands = await loadCommands(deviceId);
        if (preferredCommandId && typeof setSelectedCommandId === 'function') {
          setSelectedCommandId(preferredCommandId);
        }
        renderCommands(commands);
        const currentCommands = typeof getCurrentCommands === 'function' ? getCurrentCommands() : commands;
        let selectedCommandId = typeof getSelectedCommandId === 'function' ? getSelectedCommandId() : null;
        const selectedCommand = currentCommands.find((item) => item.commandId === selectedCommandId) || currentCommands[0];
        if (!selectedCommand) {
          renderCommandAudit(null, []);
          return;
        }
        selectedCommandId = selectedCommand.commandId;
        if (typeof setSelectedCommandId === 'function') {
          setSelectedCommandId(selectedCommandId);
        }
        const audit = await loadCommandAudit(selectedCommandId);
        renderCommandAudit(selectedCommand, audit);
      } catch (error) {
        document.getElementById('commands-meta').textContent = 'Failed to load command history.';
        document.getElementById('commands-list').innerHTML = '<div class="command-empty">Failed to load command history.</div>';
        renderCommandAudit(null, []);
      }
    }

    function refreshCommandsSoon(deviceId, preferredCommandId) {
      Promise.resolve()
        .then(() => refreshCommands(deviceId, preferredCommandId))
        .catch((error) => {
          console.error('Failed to refresh command history', error);
        });
    }

    return {
      renderCommands,
      renderCommandAudit,
      loadCommands,
      loadCommandAudit,
      refreshCommands,
      refreshCommandsSoon,
    };
  }

  global.AdminCommandsPanel = {
    createCommandsPanel,
  };
})(window);
