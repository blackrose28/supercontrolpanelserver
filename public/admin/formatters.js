(function initAdminFormatters(global) {
  function formatBytes(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes < 0) {
      return '0 B';
    }
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let unitIndex = 0;
    let current = bytes;
    while (current >= 1024 && unitIndex < units.length - 1) {
      current /= 1024;
      unitIndex += 1;
    }
    return current.toFixed(current >= 10 || unitIndex === 0 ? 0 : 1) + ' ' + units[unitIndex];
  }

  function formatRate(value) {
    const bytesPerSecond = Number(value);
    if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
      return '-';
    }
    return formatBytes(bytesPerSecond) + '/s';
  }

  function formatEta(value) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < 0) {
      return '-';
    }
    if (seconds < 60) {
      return Math.round(seconds) + 's';
    }
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.round(seconds % 60);
    if (minutes < 60) {
      return minutes + 'm ' + remainingSeconds + 's';
    }
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return hours + 'h ' + remainingMinutes + 'm';
  }

  global.AdminFormatters = {
    formatBytes,
    formatRate,
    formatEta,
  };
})(window);
