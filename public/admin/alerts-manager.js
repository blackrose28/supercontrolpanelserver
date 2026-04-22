(function initAdminAlertsManager(global) {
  function createAlertsManager(deps) {
    const {
      csrfToken,
      escapeHtml,
      formatDateTime,
      getCurrentDevices,
      getDismissedAlertIds,
      setDismissedAlertIds,
    } = deps;

    function getConnectedCount() {
      const devices = typeof getCurrentDevices === 'function' ? getCurrentDevices() : [];
      return Array.isArray(devices) ? devices.filter((d) => d.status === 'connected').length : 0;
    }

    async function refreshAlerts(elements) {
      const { alertsBadge, alertsPanelList, alertsDeviceSummary } = elements;
      try {
        const resp = await fetch('/admin/v1/alerts', { credentials: 'same-origin' });
        if (!resp.ok) return;
        const data = await resp.json();
        const dismissed = typeof getDismissedAlertIds === 'function' ? getDismissedAlertIds() : new Set();
        const alerts = (data.alerts || []).filter((a) => !dismissed.has(a.id));

        alertsBadge.textContent = alerts.length;
        alertsBadge.style.display = alerts.length > 0 ? 'block' : 'none';

        const connected = getConnectedCount();
        const errors = alerts.filter((a) => a.severity === 'critical').length;
        alertsDeviceSummary.textContent = errors > 0
          ? '\u{1F534} ' + errors + ' ' + (errors === 1 ? 'error' : 'errors') + ', ' + connected + ' connected'
          : '\u{1F7E2} ' + connected + ' connected';

        if (alerts.length === 0) {
          alertsPanelList.innerHTML = '<div class="alerts-empty-panel">No active alerts.</div>';
          return;
        }

        alertsPanelList.innerHTML = alerts.map((a) => {
          return '<div class="alerts-panel-item" data-id="' + a.id + '">' +
            '<div class="alerts-panel-dot ' + a.severity + '"></div>' +
            '<div class="alerts-panel-content">' +
              '<div class="alerts-panel-item-title">' + escapeHtml(a.title) + '</div>' +
              '<div class="alerts-panel-item-text">' + escapeHtml(a.text) + '</div>' +
              '<div class="alerts-panel-item-meta">' + escapeHtml(a.deviceId) + ' · ' + formatDateTime(a.ts) + '</div>' +
            '</div>' +
          '</div>';
        }).join('');

        alertsPanelList.querySelectorAll('.alerts-panel-item').forEach((item) => {
          item.addEventListener('click', async () => {
            const id = item.dataset.id;
            const next = new Set(typeof getDismissedAlertIds === 'function' ? getDismissedAlertIds() : []);
            next.add(id);
            if (typeof setDismissedAlertIds === 'function') {
              setDismissedAlertIds(next);
            }
            localStorage.setItem('dismissedAlerts', JSON.stringify([...next]));
            item.style.opacity = '0.4';
            try {
              await fetch('/admin/v1/alerts/dismiss', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ csrfToken, alertId: id }),
                credentials: 'same-origin',
              });
            } catch {
              // best-effort
            }
            item.remove();
            const remaining = alertsPanelList.querySelectorAll('.alerts-panel-item').length;
            alertsBadge.textContent = remaining;
            alertsBadge.style.display = remaining > 0 ? 'block' : 'none';
            if (remaining === 0) {
              alertsPanelList.innerHTML = '<div class="alerts-empty-panel">No active alerts.</div>';
            }
          });
        });
      } catch (e) {
        console.error('Failed to load alerts', e);
      }
    }

    function setupHandlers(elements, refreshFn) {
      const { alertsBtn, alertsPanel, clearAlertsBtn } = elements;
      clearAlertsBtn?.addEventListener('click', () => {
        if (typeof setDismissedAlertIds === 'function') {
          setDismissedAlertIds(new Set());
        }
        localStorage.removeItem('dismissedAlerts');
        refreshFn();
      });

      alertsBtn?.addEventListener('click', (e) => {
        e.preventDefault();
        alertsPanel.classList.toggle('open');
      });

      document.addEventListener('click', (e) => {
        const t = e.target;
        if (!alertsPanel.contains(t) && !alertsBtn.contains(t)) {
          alertsPanel.classList.remove('open');
        }
      });
    }

    return {
      refreshAlerts,
      setupHandlers,
    };
  }

  global.AdminAlertsManager = {
    createAlertsManager,
  };
})(window);
