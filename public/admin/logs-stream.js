(function initAdminLogsStream(global) {
  function createLogsStream(deps) {
    const {
      formatPayload,
      getIsPaused,
      isAutoScrollEnabled,
      getSelectedDeviceId,
      setSelectedDeviceId,
      getCurrentDevices,
      getDeviceSortColumn,
      getDeviceSortDirection,
      getStreamConnectVersion,
      setStreamConnectVersion,
      getSelectedCommandId,
      getStream,
      setStream,
      getReconnectTimer,
      setReconnectTimer,
      clearReconnectTimer,
      closeStream,
      getActiveFilters,
      renderRows,
      sortDevices,
      detachCurrentPty,
      clearPtySelection,
      loadDeviceSummary,
      renderSummary,
      refreshCommands,
      startTransferStream,
      loadPtySessions,
      setPtyStatus,
      renderTransfers,
      closeTransferStream,
    } = deps;

    function appendLog(event) {
      const output = document.getElementById('logs-output');
      if (getIsPaused()) {
        return;
      }
      const atBottom =
        output.scrollHeight - output.scrollTop - output.clientHeight < 8;
      const next = document.createElement('div');
      next.className = 'log-entry log-' + String(event.type || 'unknown').replace(/[^a-z0-9_-]/gi, '-');

      const meta = document.createElement('div');
      meta.className = 'log-meta';
      meta.textContent = [
        event.ts,
        event.type,
        event.functionId || '-',
        event.sessionId || '-',
      ].join(' | ');

      const payload = document.createElement('pre');
      payload.className = 'log-payload';
      const payloadFormatter = formatPayload || formatPayloadFallback;
      payload.textContent = payloadFormatter(event.payload);

      next.appendChild(meta);
      next.appendChild(payload);
      output.appendChild(next);
      if (isAutoScrollEnabled() && atBottom) {
        output.scrollTop = output.scrollHeight;
      }
    }

    function formatPayloadFallback(payload) {
      if (payload == null) {
        return 'null';
      }
      if (typeof payload === 'string') {
        return payload;
      }
      try {
        return JSON.stringify(payload, null, 2);
      } catch {
        return String(payload);
      }
    }

    async function loadLogHistory(deviceId, filters) {
      const params = new URLSearchParams({
        deviceId,
        limit: '100',
      });
      if (filters.type) {
        params.set('type', filters.type);
      }
      if (filters.functionId) {
        params.set('functionId', filters.functionId);
      }
      if (filters.q) {
        params.set('q', filters.q);
      }
      const response = await fetch('/v1/logs?' + params.toString());
      if (!response.ok) {
        throw new Error('Failed to load log history');
      }
      return response.json();
    }

    async function exportLogs(deviceId, filters) {
      const params = new URLSearchParams({
        deviceId,
        limit: '5000',
      });
      if (filters.type) {
        params.set('type', filters.type);
      }
      if (filters.functionId) {
        params.set('functionId', filters.functionId);
      }
      if (filters.q) {
        params.set('q', filters.q);
      }
      const response = await fetch('/v1/logs/export?' + params.toString());
      if (!response.ok) {
        throw new Error('Failed to export logs');
      }
      return response.json();
    }

    function scheduleReconnect(deviceId) {
      if (!getSelectedDeviceId() || getSelectedDeviceId() !== deviceId) {
        return;
      }
      clearReconnectTimer();
      setReconnectTimer(window.setTimeout(() => {
        startLogStream(deviceId, { skipHistory: true });
      }, 2000));
    }

    async function startLogStream(deviceId, options = {}) {
      const { skipHistory = false } = options;
      const previousDeviceId = getSelectedDeviceId();
      const connectVersion = getStreamConnectVersion() + 1;
      setStreamConnectVersion(connectVersion);
      if (previousDeviceId && previousDeviceId !== deviceId) {
        await detachCurrentPty({ silent: true });
        clearPtySelection();
      }
      setSelectedDeviceId(deviceId);
      document.getElementById('devices-tbody').innerHTML = renderRows(sortDevices(getCurrentDevices(), getDeviceSortColumn(), getDeviceSortDirection()));

      closeStream();

      const output = document.getElementById('logs-output');
      const filters = getActiveFilters();
      if (!skipHistory) {
        output.textContent = '';
        document.getElementById('logs-status').textContent =
          'Loading telemetry history…';

        try {
          const summary = await loadDeviceSummary(deviceId);
          renderSummary(summary);
          await refreshCommands(deviceId);
          await startTransferStream(deviceId);
          try {
            await loadPtySessions(deviceId, { preserveSelection: false });
          } catch (error) {
            clearPtySelection();
            setPtyStatus('Failed to load PTY sessions.', true);
          }
          const history = await loadLogHistory(deviceId, filters);
          if (connectVersion !== getStreamConnectVersion()) {
            return;
          }
          output.textContent = '';
          if (!history.length) {
            output.innerHTML = '<span class="logs-empty">No telemetry matched the current filters.</span>';
          } else {
            for (const event of history) {
              appendLog(event);
            }
          }
        } catch (error) {
          if (connectVersion !== getStreamConnectVersion()) {
            return;
          }
          renderSummary(null);
          renderTransfers([]);
          closeTransferStream();
          clearPtySelection();
          output.innerHTML = '<span class="logs-empty">Failed to load telemetry history.</span>';
          document.getElementById('logs-status').textContent =
            'Failed to load telemetry history.';
          return;
        }
      }

      if (connectVersion !== getStreamConnectVersion()) {
        return;
      }
      document.getElementById('logs-status').textContent =
        'Connecting to telemetry stream…';

      const params = new URLSearchParams({
        deviceId,
        limit: '100',
      });
      if (filters.type) {
        params.set('type', filters.type);
      }
      if (filters.functionId) {
        params.set('functionId', filters.functionId);
      }
      if (filters.q) {
        params.set('q', filters.q);
      }
      const nextStream = new EventSource('/v1/logs/stream?' + params.toString());
      setStream(nextStream);
      nextStream.onopen = () => {
        if (connectVersion !== getStreamConnectVersion()) {
          return;
        }
        clearReconnectTimer();
        document.getElementById('logs-status').textContent =
          'Streaming telemetry for ' + deviceId + (filters.type || filters.functionId || filters.q ? ' with filters applied' : '');
      };
      nextStream.addEventListener('telemetry', (message) => {
        if (connectVersion !== getStreamConnectVersion()) {
          return;
        }
        const payload = JSON.parse(message.data);
        if (output.querySelector('.logs-empty')) {
          output.textContent = '';
        }
        appendLog(payload);
        if (payload.type === 'function-status' || payload.type === 'inventory') {
          loadDeviceSummary(deviceId)
            .then((summary) => renderSummary(summary))
            .catch(() => {});
          refreshCommands(deviceId, getSelectedCommandId()).catch(() => {});
        }
      });
      nextStream.onerror = () => {
        if (connectVersion !== getStreamConnectVersion()) {
          return;
        }
        document.getElementById('logs-status').textContent =
          'Telemetry stream disconnected. Reconnecting in 2 seconds…';
        closeStream();
        scheduleReconnect(deviceId);
      };
    }

    return {
      appendLog,
      formatPayload: formatPayload || formatPayloadFallback,
      loadLogHistory,
      exportLogs,
      scheduleReconnect,
      startLogStream,
    };
  }

  global.AdminLogsStream = {
    createLogsStream,
  };
})(window);
