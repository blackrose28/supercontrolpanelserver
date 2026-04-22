(function initAdminTransfersPanel(global) {
  function createTransfersPanel(deps) {
    const {
      escapeHtml,
      formatDateTime,
      formatBytes,
      formatRate,
      formatEta,
      defaultActionHintForReasonCode,
      humanizeReasonCode,
      getSelectedDeviceId,
      getCurrentTransfers,
      setCurrentTransfers,
      getFetchJsonOrThrow,
    } = deps;

    function canStopTransfer(record) {
      const state = String(record && record.state || '');
      return !!(
        record
        && record.transferId
        && record.sessionId
        && (state === 'queued' || state === 'starting' || state === 'running')
      );
    }

    function canForceRemoveTransfer(record) {
      const state = String(record && record.state || '');
      return !!(
        record
        && record.transferId
        && !record.sessionId
        && (state === 'queued' || state === 'starting' || state === 'running')
      );
    }

    function canDismissTransfer(record) {
      const state = String(record && record.state || '');
      return !!(
        record
        && record.transferId
        && (state === 'succeeded' || state === 'failed' || state === 'canceled')
      );
    }

    function canResumeTransfer(record) {
      const state = String(record && record.state || '');
      return !!(
        record
        && (state === 'failed' || state === 'canceled')
        && record.resumeSupported === true
        && typeof record.resumeToken === 'string'
        && record.resumeToken.trim()
        && Number.isFinite(Number(record.resumeOffsetBytes))
        && Number(record.resumeOffsetBytes) > 0
        && typeof record.tempPathHint === 'string'
        && record.tempPathHint.trim()
        && (record.direction === 'upload' || record.direction === 'download')
      );
    }

    function summarizeTransfer(record) {
      const direction = String(record && record.direction || 'transfer');
      const serverId = record && record.serverId ? String(record.serverId) : '-';
      const state = String(record && record.state || 'queued');
      const localPath = record && record.localPath ? String(record.localPath) : '-';
      const remotePath = record && record.remotePath ? String(record.remotePath) : '-';
      const percent = Number(record && record.percent);
      const safePercent = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null;
      const title = direction === 'upload' ? 'Upload → ' + serverId : 'Download ← ' + serverId;
      const facts = ['State: ' + state, 'Updated: ' + formatDateTime(record && record.updatedAt)];
      if (record && record.phase) facts.push('Phase: ' + String(record.phase));
      if (safePercent != null) facts.push('Progress: ' + safePercent.toFixed(safePercent >= 10 ? 0 : 1) + '%');
      else if (record && record.bytesTransferred) facts.push('Transferred: ' + formatBytes(record.bytesTransferred));
      if (record && record.throughputBps) facts.push('Rate: ' + formatRate(record.throughputBps));
      if (record && record.etaSec != null) facts.push('ETA: ' + formatEta(record.etaSec));

      const transferredBytes = record ? Number(record.bytesTransferred || 0) : 0;
      const hasVisibleProgress = safePercent != null || transferredBytes > 0;
      let progressLabel;
      if (safePercent != null) progressLabel = safePercent.toFixed(safePercent >= 10 ? 0 : 1) + '%';
      else if (record && record.bytesTotal) progressLabel = formatBytes(transferredBytes) + ' / ' + formatBytes(record.bytesTotal);
      else if (state === 'running') progressLabel = 'Live progress...';
      else progressLabel = formatBytes(transferredBytes);

      const progressWidth = safePercent != null ? safePercent : 0;
      const progressClass = !hasVisibleProgress && state === 'running' ? 'transfer-progress indeterminate' : 'transfer-progress';
      const message = record && record.message ? String(record.message) : '';
      const reasonCode = record && record.reasonCode ? String(record.reasonCode) : '';
      const actionHint = defaultActionHintForReasonCode(reasonCode);
      const reason = reasonCode
        ? humanizeReasonCode(reasonCode) + (record.reasonDetail ? ' ' + String(record.reasonDetail) : '') + (actionHint ? ' ' + actionHint : '')
        : '';

      const actionButtons = [];
      if (canStopTransfer(record)) actionButtons.push('<button type="button" data-transfer-action="stop" data-transfer-id="' + escapeHtml(record.transferId) + '">Stop</button>');
      else if (canForceRemoveTransfer(record)) actionButtons.push('<button type="button" data-transfer-action="force-remove" data-transfer-id="' + escapeHtml(record.transferId) + '">Force remove</button>');
      if (canResumeTransfer(record)) actionButtons.push('<button type="button" class="primary" data-transfer-action="resume" data-transfer-id="' + escapeHtml(record.transferId) + '">Resume</button>');
      if (canDismissTransfer(record)) actionButtons.push('<button type="button" data-transfer-action="dismiss" data-transfer-id="' + escapeHtml(record.transferId) + '">Dismiss</button>');
      const actions = actionButtons.length ? '<div class="transfer-actions">' + actionButtons.join('') + '</div>' : '';

      return '<div class="transfer-card ' + escapeHtml(state) + '">' +
        '<div class="transfer-card-head">' +
          '<div class="transfer-card-title">' + escapeHtml(title) + '</div>' +
          '<div class="transfer-card-meta">' + escapeHtml(progressLabel) + '</div>' +
        '</div>' +
        '<div class="transfer-path">Local <code>' + escapeHtml(localPath) + '</code></div>' +
        '<div class="transfer-path">Remote <code>' + escapeHtml(remotePath) + '</code></div>' +
        '<div class="' + progressClass + '"><div class="transfer-progress-bar" style="width:' + progressWidth + '%;"></div></div>' +
        '<div class="transfer-facts">' + facts.map((item) => '<span>' + escapeHtml(item) + '</span>').join('') + '</div>' +
        (message ? '<div class="transfer-card-meta" style="margin-top:8px;">' + escapeHtml(message) + '</div>' : '') +
        (reason ? '<div class="transfer-reason">' + escapeHtml(reason) + ' <span class="transfer-card-meta">(' + escapeHtml(reasonCode) + ')</span></div>' : '') +
        actions +
      '</div>';
    }

    function updateTransferToolbarState() {
      const button = document.getElementById('clear-finished-transfers');
      if (!button) return;
      const currentTransfers = typeof getCurrentTransfers === 'function' ? getCurrentTransfers() : [];
      const selectedDeviceId = typeof getSelectedDeviceId === 'function' ? getSelectedDeviceId() : null;
      const hasDismissible = currentTransfers.some((item) => canDismissTransfer(item));
      button.disabled = !selectedDeviceId || !hasDismissible;
    }

    function renderTransfers(items) {
      const selectedDeviceId = typeof getSelectedDeviceId === 'function' ? getSelectedDeviceId() : null;
      const next = Array.isArray(items)
        ? items.slice().sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime())
        : [];
      if (typeof setCurrentTransfers === 'function') setCurrentTransfers(next);
      const currentTransfers = typeof getCurrentTransfers === 'function' ? getCurrentTransfers() : next;
      const meta = document.getElementById('transfers-meta');
      const list = document.getElementById('transfers-list');
      if (!selectedDeviceId) {
        meta.textContent = 'Select a device to load recent transfer activity.';
        list.innerHTML = '<div class="transfer-empty">No device selected.</div>';
        return;
      }
      meta.textContent = currentTransfers.length
        ? 'Showing ' + currentTransfers.length + ' recent transfer(s) for ' + selectedDeviceId + '.'
        : 'No transfer activity recorded yet for ' + selectedDeviceId + '.';
      list.innerHTML = currentTransfers.length
        ? currentTransfers.map((item) => summarizeTransfer(item)).join('')
        : '<div class="transfer-empty">No transfer activity recorded yet for this device.</div>';
      updateTransferToolbarState();
    }

    function upsertTransfer(record) {
      if (!record || !record.transferId) return;
      const currentTransfers = typeof getCurrentTransfers === 'function' ? getCurrentTransfers() : [];
      const next = currentTransfers.filter((item) => item.transferId !== record.transferId);
      next.unshift(record);
      renderTransfers(next.slice(0, 50));
    }

    async function loadTransfers(deviceId) {
      const fetchJsonOrThrow = typeof getFetchJsonOrThrow === 'function' ? getFetchJsonOrThrow() : null;
      const params = new URLSearchParams({ deviceId, limit: '50' });
      if (!fetchJsonOrThrow) {
        throw new Error('fetchJsonOrThrow unavailable');
      }
      return fetchJsonOrThrow('/v1/file-transfers?' + params.toString());
    }

    return {
      canStopTransfer,
      canForceRemoveTransfer,
      canDismissTransfer,
      canResumeTransfer,
      summarizeTransfer,
      updateTransferToolbarState,
      renderTransfers,
      upsertTransfer,
      loadTransfers,
    };
  }

  global.AdminTransfersPanel = {
    createTransfersPanel,
  };
})(window);
