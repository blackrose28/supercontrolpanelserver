(function initAdminPtyPanel(global) {
  function createPtyPanel(deps) {
    const {
      getSelectedDeviceId,
      getCurrentPtySessions,
      setCurrentPtySessions,
      getCurrentPtySessionId,
      setCurrentPtySessionId,
      setCurrentPtyAttached,
      getPtyOutputBuffers,
      getPtyTerminal,
      sanitizePtyDisplayText,
      debugPty,
      sendPtyMessage,
      sortPtySessions,
      renderPtySessionSelect,
      renderPtySessionMeta,
      updatePtyControls,
      syncPtySizeInputs,
      applyPtyTerminalSize,
      formatDateTime,
    } = deps;

    function getSelectedPtySession() {
      return getCurrentPtySessions().find((item) => item.sessionId === getCurrentPtySessionId()) || null;
    }

    function isAdminSessionAttached(session) {
      return !!session && session.attachedActorType === 'admin_session';
    }

    function setPtyStatus(message, isError = false) {
      const node = document.getElementById('pty-status');
      node.textContent = message;
      node.classList.toggle('error', !!isError);
    }

    async function sendTerminalData(data) {
      const session = getSelectedPtySession();
      if (!getSelectedDeviceId() || !session || !isAdminSessionAttached(session) || !data) {
        debugPty('sendTerminalData skipped', {
          selectedDeviceId: getSelectedDeviceId(),
          sessionId: session && session.sessionId,
          attached: isAdminSessionAttached(session),
          hasData: !!data,
        });
        return;
      }
      if (session.recordingEnabled && !session.recordingConsentAt) {
        debugPty('sendTerminalData blocked pending recording consent', {
          sessionId: session.sessionId,
        });
        setPtyStatus('Acknowledge recording before sending PTY input.', true);
        return;
      }
      try {
        debugPty('sendTerminalData outbound', {
          deviceId: getSelectedDeviceId(),
          sessionId: session.sessionId,
          length: data.length,
          preview: JSON.stringify(String(data).slice(0, 20)),
        });
        await sendPtyMessage('pty_write', {
          deviceId: getSelectedDeviceId(),
          sessionId: session.sessionId,
          data,
        });
      } catch (error) {
        setPtyStatus('Failed to write PTY input.', true);
      }
    }

    function setPtyOutput(sessionId, text) {
      if (!sessionId) {
        return;
      }
      getPtyOutputBuffers().set(sessionId, String(text || ''));
      if (getCurrentPtySessionId() === sessionId) {
        renderPtyOutput();
      }
    }

    function appendPtyOutput(sessionId, chunk) {
      if (!sessionId || typeof chunk !== 'string' || !chunk.length) {
        return;
      }
      const nextValue = (getPtyOutputBuffers().get(sessionId) || '') + chunk;
      getPtyOutputBuffers().set(sessionId, nextValue);
      if (getCurrentPtySessionId() === sessionId) {
        const terminal = getPtyTerminal();
        if (terminal) {
          terminal.write(chunk);
        } else {
          renderPtyOutput();
          const output = document.getElementById('pty-output');
          output.scrollTop = output.scrollHeight;
        }
      }
    }

    function renderPtyOutput() {
      const output = document.getElementById('pty-output');
      const currentPtySessionId = getCurrentPtySessionId();
      const value = currentPtySessionId ? (getPtyOutputBuffers().get(currentPtySessionId) || '') : '';
      debugPty('renderPtyOutput', {
        sessionId: currentPtySessionId,
        hasValue: !!value,
        valueLength: value.length,
        windowTerminal: typeof window.Terminal,
      });
      if (!value) {
        const terminal = currentPtySessionId ? getPtyTerminal() : deps.getExistingPtyTerminal();
        if (terminal) {
          output.classList.toggle('empty', !currentPtySessionId);
          terminal.reset();
          if (!currentPtySessionId) {
            terminal.write('No PTY output yet.');
          }
          return;
        }
        output.textContent = currentPtySessionId ? 'No PTY output yet for this session.' : 'No PTY output yet.';
        output.classList.toggle('empty', !currentPtySessionId);
        return;
      }
      const terminal = getPtyTerminal();
      if (terminal) {
        output.classList.remove('empty');
        terminal.reset();
        terminal.write(value);
        return;
      }
      output.textContent = sanitizePtyDisplayText(value);
      output.classList.remove('empty');
    }

    function syncPtySelectionState() {
      const session = getSelectedPtySession();
      setCurrentPtyAttached(isAdminSessionAttached(session));
      renderPtySessionSelect();
      renderPtySessionMeta();
      syncPtySizeInputs(session);
      renderPtyOutput();
      applyPtyTerminalSize(session);
      updatePtyControls();
    }

    async function loadPtySessions(deviceId, options = {}) {
      const { preserveSelection = true } = options;
      if (!deviceId) {
        setCurrentPtySessions([]);
        setCurrentPtySessionId(null);
        setCurrentPtyAttached(false);
        syncPtySelectionState();
        return [];
      }
      const response = await fetch('/v1/devices/' + encodeURIComponent(deviceId) + '/pty-sessions');
      if (!response.ok) {
        throw new Error('Failed to load PTY sessions');
      }
      const payload = await response.json();
      setCurrentPtySessions(sortPtySessions(payload && payload.items));
      const currentPtySessions = getCurrentPtySessions();
      if (!preserveSelection || !currentPtySessions.some((item) => item.sessionId === getCurrentPtySessionId())) {
        setCurrentPtySessionId(currentPtySessions.length ? currentPtySessions[0].sessionId : null);
      }
      syncPtySelectionState();
      return currentPtySessions;
    }

    function clearPtySelection() {
      setCurrentPtySessions([]);
      setCurrentPtySessionId(null);
      setCurrentPtyAttached(false);
      syncPtySelectionState();
    }

    return {
      getSelectedPtySession,
      isAdminSessionAttached,
      setPtyStatus,
      sendTerminalData,
      setPtyOutput,
      appendPtyOutput,
      renderPtyOutput,
      syncPtySelectionState,
      loadPtySessions,
      clearPtySelection,
    };
  }

  global.AdminPtyPanel = {
    createPtyPanel,
  };
})(window);
