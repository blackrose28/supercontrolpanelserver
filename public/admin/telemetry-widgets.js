(function initAdminTelemetryWidgets(global) {
  function createTelemetryWidgets(deps) {
    const {
      escapeHtml,
      getCurrentDevices,
      getTelemetryColors,
      getTlmEvents,
      setTlmEvents,
      getTlmChart,
      setTlmChart,
    } = deps;

    function buildTlmDeviceDropdown() {
      const sel = document.getElementById('tlm-device-filter');
      const val = sel.value;
      sel.innerHTML = '<option value="">All devices</option>';
      (getCurrentDevices() || []).forEach((d) => {
        const opt = document.createElement('option');
        opt.value = d.id;
        opt.textContent = d.name || d.id;
        sel.appendChild(opt);
      });
      sel.value = val;
    }

    function renderTlmStats(stats) {
      const bar = document.getElementById('tlm-stats-bar');
      if (!stats || !stats.length) {
        bar.innerHTML = '';
        return;
      }
      bar.innerHTML = stats
        .map((s) => `<span class="tlm-stat-chip"><span class="stat-count">${s.count}</span> ${escapeHtml(s.type)}</span>`)
        .join('');
    }

    function renderTlmChart() {
      const container = document.getElementById('tlm-chart-container');
      const canvas = document.getElementById('tlm-chart');
      if (typeof Chart === 'undefined') {
        container.innerHTML = '<div class="tlm-chart-empty">Chart library not available</div>';
        return;
      }
      const tlmEvents = getTlmEvents();
      let tlmChartCtx = getTlmChart();
      if (!tlmEvents.length) {
        container.innerHTML = '<div class="tlm-chart-empty">No data to chart</div>';
        if (tlmChartCtx) {
          tlmChartCtx.destroy();
          tlmChartCtx = null;
          setTlmChart(null);
        }
        return;
      }
      if (tlmChartCtx) tlmChartCtx.destroy();

      const typeBuckets = {};
      tlmEvents.forEach((e) => {
        if (!typeBuckets[e.type]) typeBuckets[e.type] = 0;
        typeBuckets[e.type]++;
      });
      const labels = Object.keys(typeBuckets);
      const values = Object.values(typeBuckets);
      const colors = labels.map((l) => getTelemetryColors()[l] || '#9ca3af');

      tlmChartCtx = new Chart(canvas, {
        type: 'bar',
        data: { labels, datasets: [{ data: values, backgroundColor: colors, borderRadius: 4 }] },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { ticks: { font: { size: 11 } } },
            y: { beginAtZero: true, ticks: { font: { size: 11 } } },
          },
        },
      });
      setTlmChart(tlmChartCtx);
    }

    function tlmPreview(payload, type) {
      if (payload == null) return '—';
      const s = typeof payload === 'string' ? payload : JSON.stringify(payload);
      if (type === 'pty-output' && s.length > 120) return s.substring(0, 120) + '…';
      if (s.length > 200) return s.substring(0, 200) + '…';
      return s;
    }

    function deviceNameFor(deviceId) {
      const d = (getCurrentDevices() || []).find((dev) => dev.id === deviceId);
      return d ? (d.name || d.id) : deviceId;
    }

    function renderTlmTable() {
      const tbody = document.getElementById('tlm-tbody');
      const tlmEvents = getTlmEvents();
      if (!tlmEvents.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="tlm-empty">No telemetry matched the current filters.</td></tr>';
        return;
      }
      tbody.innerHTML = tlmEvents
        .map((e) => {
          const badgeClass = getTelemetryColors()[e.type] ? e.type.replace('_', '-') : '';
          return `<tr data-id="${escapeHtml(e.id)}">
            <td class="ts-cell">${escapeHtml(e.ts)}</td>
            <td class="device-cell">${escapeHtml(deviceNameFor(e.deviceId))}</td>
            <td class="type-cell"><span class="type-badge ${escapeHtml(badgeClass)}">${escapeHtml(e.type)}</span></td>
            <td class="type-cell">${escapeHtml(e.functionId || '—')}</td>
            <td class="preview-cell" title="${escapeHtml(typeof e.payload === 'string' ? e.payload : JSON.stringify(e.payload))}">${escapeHtml(tlmPreview(e.payload, e.type))}</td>
            <td><button class="expand-btn" onclick="toggleTlmDetail(this)" title="Toggle detail">▼</button></td>
          </tr>`;
        })
        .join('');
    }

    function toggleTlmDetail(btn) {
      const row = btn.closest('tr');
      const next = row.nextElementSibling;
      if (next && next.classList.contains('tlm-detail-row')) {
        next.remove();
        btn.textContent = '▼';
        return;
      }
      const id = row.dataset.id;
      const event = getTlmEvents().find((e) => e.id === id);
      if (!event) return;
      const detail = document.createElement('tr');
      detail.className = 'tlm-detail-row';
      detail.innerHTML = `<td colspan="6"><div class="tlm-detail-content">${escapeHtml(JSON.stringify(event, null, 2))}</div></td>`;
      row.after(detail);
      btn.textContent = '▲';
    }

    function exportTlm(format) {
      const tlmEvents = getTlmEvents();
      if (!tlmEvents.length) return;
      const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
      let blob;
      let name;
      if (format === 'csv') {
        const header = 'id,deviceId,type,functionId,sessionId,seq,ts,payload\n';
        const rows = tlmEvents.map((e) => [e.id, e.deviceId, e.type, e.functionId || '', e.sessionId || '', e.seq, e.ts, `"${JSON.stringify(e.payload).replace(/"/g, '""')}"`].join(','));
        blob = new Blob([header + rows.join('\n')], { type: 'text/csv' });
        name = `telemetry-${ts}.csv`;
      } else {
        blob = new Blob([JSON.stringify(tlmEvents, null, 2)], { type: 'application/json' });
        name = `telemetry-${ts}.json`;
      }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      URL.revokeObjectURL(a.href);
    }

    async function loadTelemetry() {
      const status = document.getElementById('tlm-status');
      const tbody = document.getElementById('tlm-tbody');
      status.textContent = 'Loading…';
      tbody.innerHTML = '<tr><td colspan="6" class="tlm-empty">Loading…</td></tr>';

      const params = new URLSearchParams();
      const deviceId = document.getElementById('tlm-device-filter').value;
      const type = document.getElementById('tlm-type-filter').value;
      const from = document.getElementById('tlm-from').value;
      const to = document.getElementById('tlm-to').value;
      const q = document.getElementById('tlm-text-filter').value.trim();

      if (deviceId) params.set('deviceId', deviceId);
      if (type) params.set('type', type);
      if (from) params.set('fromTs', new Date(from).toISOString());
      if (to) params.set('toTs', new Date(to).toISOString());
      if (q) params.set('q', q);
      params.set('limit', '1000');

      try {
        const resp = await fetch('/v1/telemetry?' + params.toString());
        if (!resp.ok) throw new Error(resp.statusText);
        const data = await resp.json();
        setTlmEvents(data.events || []);
        const tlmEvents = getTlmEvents();
        status.textContent = `Loaded ${tlmEvents.length} event${tlmEvents.length !== 1 ? 's' : ''}.`;
        renderTlmStats(data.stats || []);
        renderTlmChart();
        renderTlmTable();
      } catch (err) {
        status.textContent = 'Failed: ' + err.message;
        tbody.innerHTML = '<tr><td colspan="6" class="tlm-empty">Failed to load telemetry.</td></tr>';
        setTlmEvents([]);
      }
    }

    return {
      buildTlmDeviceDropdown,
      loadTelemetry,
      renderTlmStats,
      renderTlmChart,
      renderTlmTable,
      toggleTlmDetail,
      exportTlm,
    };
  }

  global.AdminTelemetryWidgets = {
    createTelemetryWidgets,
  };
})(window);
