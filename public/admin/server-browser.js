(function initAdminServerBrowser(global) {
  function createServerBrowser(deps) {
    const {
      escapeHtml,
      csrfToken,
      getSelectedDeviceId,
      getSelectedSummary,
      getSelectedTunnelRestartServerId,
      setSelectedTunnelRestartServerId,
      getServerPickerAction,
      setServerPickerAction,
      getServerPickerSubmitting,
      setServerPickerSubmitting,
      getCurrentBrowserSessionId,
      setCurrentBrowserSessionId,
      getCurrentBrowserServerId,
      setCurrentBrowserServerId,
      getCurrentBrowserRootPath,
      setCurrentBrowserRootPath,
      getCurrentBrowserCurrentPath,
      setCurrentBrowserCurrentPath,
      getCurrentBrowserSelectedPath,
      setCurrentBrowserSelectedPath,
      getCurrentBrowserSelectedEntry,
      setCurrentBrowserSelectedEntry,
      getCurrentBrowserEntries,
      setCurrentBrowserEntries,
      fetchJsonOrThrow,
      startTransfer,
      refreshCommandsSoon,
      describeApiError,
      getTransferLocalPath,
      getTransferRemotePath,
      setTransferRemotePath,
      getTransferOptions,
      setTransferOverwritePolicy,
    } = deps;

    function getInventoryServers() {
      const selectedSummary = getSelectedSummary();
      return Array.isArray(selectedSummary && selectedSummary.inventory && selectedSummary.inventory.servers)
        ? selectedSummary.inventory.servers
        : [];
    }

    function getRestartTunnelCandidates() {
      return getInventoryServers().filter((server) => String(server.connectionMethod || '').toLowerCase() === 'boundary');
    }

    function getRestartSshCandidates() {
      return getInventoryServers();
    }

    function closeServerPicker() {
      setSelectedTunnelRestartServerId(null);
      setServerPickerAction(null);
      setServerPickerSubmitting(false);
      document.getElementById('server-picker-backdrop').classList.remove('open');
      document.getElementById('server-picker-backdrop').setAttribute('aria-hidden', 'true');
      document.getElementById('server-picker-list').innerHTML = '';
      document.getElementById('server-picker-confirm').disabled = true;
      document.getElementById('server-picker-confirm').textContent = 'Confirm';
    }

    function renderServerPickerOptions(servers) {
      const list = document.getElementById('server-picker-list');
      if (!servers.length) {
        list.innerHTML = '<div class="server-picker-empty">No Boundary servers are available in the selected device inventory yet. Request inventory first.</div>';
        document.getElementById('server-picker-confirm').disabled = true;
        return;
      }
      list.innerHTML = servers.map((server) => {
        const title = escapeHtml(server.name || server.id || 'Unnamed server');
        const id = escapeHtml(server.id || '');
        const host = escapeHtml(server.host || '');
        const os = escapeHtml(server.os || 'unknown');
        const sshUser = escapeHtml(server.sshUser || '');
        return '<button type="button" class="server-picker-item" data-server-id="' + id + '">' +
          '<div class="server-picker-item-title">' + title + '</div>' +
          '<div class="server-picker-item-meta">ID: ' + id + '</div>' +
          '<div class="server-picker-item-meta">Host: ' + host + ' | OS: ' + os + (sshUser ? ' | SSH user: ' + sshUser : '') + '</div>' +
        '</button>';
      }).join('');
      document.getElementById('server-picker-confirm').disabled =
        !getSelectedTunnelRestartServerId() || getServerPickerSubmitting();
    }

    function openServerPicker(servers, options) {
      setSelectedTunnelRestartServerId(null);
      setServerPickerAction(options && options.action ? options.action : null);
      setServerPickerSubmitting(false);
      document.getElementById('server-picker-title').textContent = options && options.title ? options.title : 'Restart server action';
      document.getElementById('server-picker-note').textContent = options && options.note ? options.note : 'Choose a server from the selected device inventory.';
      document.getElementById('server-picker-confirm').textContent = options && options.confirmLabel ? options.confirmLabel : 'Restart action';
      renderServerPickerOptions(servers);
      document.getElementById('server-picker-backdrop').classList.add('open');
      document.getElementById('server-picker-backdrop').setAttribute('aria-hidden', 'false');
    }

    function setRemoteBrowserStatus(message, isError) {
      const el = document.getElementById('remote-browser-status');
      el.textContent = message || '';
      el.classList.toggle('error', !!isError);
    }

    function updateRemoteBrowserActionState() {
      const selected = getCurrentBrowserEntries().find((entry) => entry.path === getCurrentBrowserSelectedPath()) || null;
      setCurrentBrowserSelectedEntry(selected);
      document.getElementById('remote-browser-open-folder').disabled = !(selected && selected.kind === 'directory');
      document.getElementById('remote-browser-delete').disabled = !selected;
      document.getElementById('remote-browser-use-selected').disabled = !selected;
      document.getElementById('remote-browser-use-current').disabled = !getCurrentBrowserCurrentPath();
    }

    function renderRemoteBrowserEntries(entries) {
      setCurrentBrowserEntries(Array.isArray(entries) ? entries : []);
      const list = document.getElementById('remote-browser-list');
      document.getElementById('remote-browser-path').value = getCurrentBrowserCurrentPath() || '';
      const currentBrowserEntries = getCurrentBrowserEntries();
      const currentBrowserSelectedPath = getCurrentBrowserSelectedPath();
      if (!currentBrowserEntries.length) {
        list.innerHTML = '<div class="remote-browser-empty">This folder is empty.</div>';
        updateRemoteBrowserActionState();
        return;
      }
      list.innerHTML = currentBrowserEntries.map((entry) => {
        const selected = entry.path === currentBrowserSelectedPath;
        const kind = String(entry.kind || 'other');
        return '<button type="button" class="remote-browser-item ' + (selected ? 'selected' : '') + '" data-path="' + escapeHtml(entry.path || '') + '" data-kind="' + escapeHtml(kind) + '">' +
          '<div class="remote-browser-item-name">' + escapeHtml(entry.name || entry.path || '-') + '</div>' +
          '<div class="remote-browser-item-meta">' + escapeHtml(kind) + ' • ' + escapeHtml(entry.path || '') + '</div>' +
        '</button>';
      }).join('');
      updateRemoteBrowserActionState();
    }

    async function openRemoteBrowserSession(deviceId, serverId) {
      return fetchJsonOrThrow('/v1/file-ops/remote-browser/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csrfToken, deviceId, serverId }),
      });
    }

    async function listRemoteBrowserChildren(deviceId, browserSessionId, path) {
      return fetchJsonOrThrow('/v1/file-ops/remote-browser/list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csrfToken, deviceId, browserSessionId, path }),
      });
    }

    async function createRemoteBrowserDirectory(deviceId, browserSessionId, path) {
      return fetchJsonOrThrow('/v1/file-ops/remote-browser/mkdir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csrfToken, deviceId, browserSessionId, path }),
      });
    }

    async function deleteRemoteBrowserPath(deviceId, browserSessionId, path, recursive) {
      return fetchJsonOrThrow('/v1/file-ops/remote-browser/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csrfToken, deviceId, browserSessionId, path, recursive }),
      });
    }

    async function closeRemoteBrowserSession(deviceId, browserSessionId) {
      return fetchJsonOrThrow('/v1/file-ops/remote-browser/close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csrfToken, deviceId, browserSessionId }),
      });
    }

    async function refreshRemoteBrowser(path) {
      if (!getSelectedDeviceId() || !getCurrentBrowserSessionId()) {
        return;
      }
      const targetPath = (path || getCurrentBrowserCurrentPath() || getCurrentBrowserRootPath() || '').trim();
      if (!targetPath) {
        return;
      }
      setRemoteBrowserStatus('Loading ' + targetPath + '…');
      const payload = await listRemoteBrowserChildren(getSelectedDeviceId(), getCurrentBrowserSessionId(), targetPath);
      setCurrentBrowserCurrentPath(typeof payload.path === 'string' && payload.path ? payload.path : targetPath);
      setCurrentBrowserSelectedPath(null);
      setCurrentBrowserSelectedEntry(null);
      renderRemoteBrowserEntries(Array.isArray(payload.entries) ? payload.entries : []);
      setRemoteBrowserStatus('Browsing ' + getCurrentBrowserCurrentPath());
    }

    async function initiateRemoteTransfer(direction) {
      if (!getSelectedDeviceId() || !getCurrentBrowserServerId()) {
        return;
      }
      const localPath = getTransferLocalPath();
      const remotePath = getTransferRemotePath();
      if (!localPath) {
        setRemoteBrowserStatus('Local path is required.', true);
        return;
      }
      if (!remotePath) {
        setRemoteBrowserStatus('Remote path is required.', true);
        return;
      }
      const options = getTransferOptions();
      const selectedEntry = getCurrentBrowserSelectedEntry();
      if (options.overwritePolicy === 'prompt' && direction === 'upload' && selectedEntry && selectedEntry.kind !== 'directory' && selectedEntry.path === remotePath) {
        const confirmed = window.confirm(
          'The selected remote path already exists. Start upload anyway and let the agent prompt/decline overwrite as needed?',
        );
        if (!confirmed) {
          setRemoteBrowserStatus('Upload canceled before overwrite-sensitive start.', false);
          return;
        }
      }
      const payload = {
        serverId: getCurrentBrowserServerId(),
        browserSessionId: getCurrentBrowserSessionId(),
        localPath,
        remotePath,
        overwritePolicy: options.overwritePolicy,
        recursive: options.recursive,
        verifyChecksum: options.verifyChecksum,
        followSymlinks: options.followSymlinks,
        preserveMtime: options.preserveMtime,
        preserveMode: options.preserveMode,
        rateLimitKbps: Number.isFinite(options.rateLimitKbps) && options.rateLimitKbps > 0 ? options.rateLimitKbps : null,
      };
      try {
        setRemoteBrowserStatus('Starting ' + direction + ' transfer…');
        const result = await startTransfer(getSelectedDeviceId(), direction, payload);
        refreshCommandsSoon(getSelectedDeviceId(), result && result.command && result.command.commandId);
        const transferId = result && result.command && result.command.payload && result.command.payload.transferId
          ? String(result.command.payload.transferId)
          : null;
        document.getElementById('summary-meta').textContent =
          'Started ' + direction + ' transfer' + (transferId ? ' ' + transferId : '') + ' at ' + new Date().toISOString();
        setRemoteBrowserStatus(
          'Started ' + direction + ' transfer' + (transferId ? ' (' + transferId + ')' : '') + '. Monitor progress in File transfer history.',
          false,
        );
      } catch (error) {
        const detail = describeApiError(error);
        if (detail && detail.code === 'path_already_exists') {
          setTransferOverwritePolicy('force');
          setRemoteBrowserStatus(
            detail.message + ' Switched “If destination exists” to Overwrite existing destination so you can retry immediately, or change it to Skip.',
            true,
          );
          document.getElementById('transfer-overwrite-policy').focus();
          return;
        }
        setRemoteBrowserStatus(detail.message, true);
      }
    }

    async function showRemoteBrowser(serverId) {
      setCurrentBrowserServerId(serverId);
      setCurrentBrowserSelectedPath(null);
      setCurrentBrowserSelectedEntry(null);
      document.getElementById('remote-browser-backdrop').classList.add('open');
      document.getElementById('remote-browser-backdrop').setAttribute('aria-hidden', 'false');
      document.getElementById('remote-browser-list').innerHTML = '<div class="remote-browser-empty">Opening remote browser…</div>';
      setRemoteBrowserStatus('Opening remote browser…');
      try {
        const payload = await openRemoteBrowserSession(getSelectedDeviceId(), serverId);
        setCurrentBrowserSessionId(typeof payload.browserSessionId === 'string' ? payload.browserSessionId : null);
        setCurrentBrowserRootPath(typeof payload.rootPath === 'string' ? payload.rootPath : '/');
        setCurrentBrowserCurrentPath(getCurrentBrowserRootPath());
        setTransferRemotePath(getCurrentBrowserRootPath() || '');
        await refreshRemoteBrowser(getCurrentBrowserRootPath());
      } catch (error) {
        await closeRemoteBrowserModal();
        throw error;
      }
    }

    async function closeRemoteBrowserModal() {
      const browserSessionId = getCurrentBrowserSessionId();
      setCurrentBrowserSessionId(null);
      setCurrentBrowserServerId(null);
      setCurrentBrowserRootPath(null);
      setCurrentBrowserCurrentPath(null);
      setCurrentBrowserSelectedPath(null);
      setCurrentBrowserSelectedEntry(null);
      setCurrentBrowserEntries([]);
      document.getElementById('remote-browser-backdrop').classList.remove('open');
      document.getElementById('remote-browser-backdrop').setAttribute('aria-hidden', 'true');
      document.getElementById('remote-browser-list').innerHTML = '<div class="remote-browser-empty">No remote browser session open.</div>';
      document.getElementById('remote-browser-path').value = '';
      setTransferRemotePath('');
      setRemoteBrowserStatus('Choose a server to open the remote browser.');
      updateRemoteBrowserActionState();
      if (getSelectedDeviceId() && browserSessionId) {
        try {
          await closeRemoteBrowserSession(getSelectedDeviceId(), browserSessionId);
        } catch (error) {
          console.error('Failed to close remote browser session', error);
        }
      }
    }

    return {
      getRestartTunnelCandidates,
      getRestartSshCandidates,
      closeServerPicker,
      renderServerPickerOptions,
      openServerPicker,
      setRemoteBrowserStatus,
      updateRemoteBrowserActionState,
      renderRemoteBrowserEntries,
      createRemoteBrowserDirectory,
      deleteRemoteBrowserPath,
      refreshRemoteBrowser,
      initiateRemoteTransfer,
      showRemoteBrowser,
      closeRemoteBrowserModal,
    };
  }

  global.AdminServerBrowser = {
    createServerBrowser,
  };
})(window);
