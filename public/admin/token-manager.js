(function initAdminTokenManager(global) {
  function createTokenManager(deps) {
    const {
      escapeHtml,
      formatDateTime,
      adminApiScopes,
      csrfToken,
      setCurrentAdminApiTokens,
    } = deps;

    let revealedTokenIds = new Set();
    let tokenRevealTimers = new Map();

    function renderTokenScopes(scopes) {
      if (!Array.isArray(scopes) || !scopes.length) {
        return '<span class="token-empty">No scopes</span>';
      }
      return '<div class="token-scope-list">' + scopes.map((scope) =>
        '<span class="token-scope-pill">' + escapeHtml(scope) + '</span>'
      ).join('') + '</div>';
    }

    function maskTokenId(id) {
      if (!id || id.length <= 8) return '****';
      return '*'.repeat(id.length - 4) + id.slice(-4);
    }

    function toggleTokenReveal(tokenId) {
      if (revealedTokenIds.has(tokenId)) {
        revealedTokenIds.delete(tokenId);
        const timer = tokenRevealTimers.get(tokenId);
        if (timer) { clearTimeout(timer); tokenRevealTimers.delete(tokenId); }
      } else {
        revealedTokenIds.add(tokenId);
        const timer = setTimeout(() => {
          revealedTokenIds.delete(tokenId);
          tokenRevealTimers.delete(tokenId);
          const el = document.querySelector('[data-token-full="' + tokenId + '"]');
          if (el) { el.textContent = maskTokenId(tokenId); el.dataset.revealed = ''; }
        }, 30000);
        tokenRevealTimers.set(tokenId, timer);
      }
      const el = document.querySelector('[data-token-full="' + tokenId + '"]');
      if (el) {
        el.textContent = revealedTokenIds.has(tokenId) ? tokenId : maskTokenId(tokenId);
        el.dataset.revealed = revealedTokenIds.has(tokenId) ? '1' : '';
      }
    }

    function renderTokenRows(tokens) {
      if (!tokens.length) {
        return '';
      }
      return tokens.map((token) => {
        const revoked = !!token.revokedAt;
        const isRevealed = revealedTokenIds.has(token.tokenId);
        return '<tr>' +
          '<td>' + escapeHtml(token.label) + '<div style="color:#6b7280;margin-top:4px;"><span data-token-full="' + escapeHtml(token.tokenId) + '" data-revealed="' + (isRevealed ? '1' : '') + '" style="cursor:pointer;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;" class="token-masked" title="Click to ' + (isRevealed ? 'mask' : 'reveal') + '">' + escapeHtml(isRevealed ? token.tokenId : maskTokenId(token.tokenId)) + '</span></div></td>' +
          '<td>' + renderTokenScopes(token.scopes) + '</td>' +
          '<td>' + escapeHtml(formatDateTime(token.createdAt)) + '</td>' +
          '<td>' + escapeHtml(formatDateTime(token.expiresAt)) + '</td>' +
          '<td>' + escapeHtml(formatDateTime(token.lastUsedAt)) + '</td>' +
          '<td><span class="token-status ' + (revoked ? 'revoked' : 'active') + '">' + (revoked ? 'Revoked' : 'Active') + '</span></td>' +
          '<td><button type="button" data-token-id="' + escapeHtml(token.tokenId) + '"' + (revoked ? ' disabled' : '') + '>Revoke</button></td>' +
        '</tr>';
      }).join('');
    }

    function renderTokenScopeOptions() {
      const container = document.getElementById('token-scopes');
      container.innerHTML = adminApiScopes.map((scope) =>
        '<label><input type="checkbox" name="scope" value="' + escapeHtml(scope) + '"' +
          (scope === 'device:read' || scope === 'device:control' || scope === 'logs:read' ? ' checked' : '') +
        ' /> ' + escapeHtml(scope) + '</label>'
      ).join('');
    }

    function getSelectedTokenScopes() {
      return Array.from(document.querySelectorAll('#token-scopes input[name="scope"]:checked'))
        .map((input) => input.value);
    }

    function showCreatedToken(payload) {
      const container = document.getElementById('token-created');
      container.style.display = 'block';
      container.innerHTML =
        '<strong>Store this token now.</strong>' +
        '<div style="margin-bottom:8px;">Label: ' + escapeHtml(payload.label) + ' | Expires: ' + escapeHtml(formatDateTime(payload.expiresAt)) + '</div>' +
        '<div class="token-secret" id="token-secret-value">' + escapeHtml(payload.token) + '</div>' +
        '<button type="button" id="copy-token-btn" style="margin-top:8px;padding:6px 12px;background:#374151;color:white;border:none;border-radius:4px;cursor:pointer;">Copy token</button>' +
        '<span id="copy-token-msg" style="margin-left:8px;color:#059669;font-size:12px;display:none;">Copied!</span>';

      document.getElementById('copy-token-btn').addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(payload.token);
          document.getElementById('copy-token-msg').style.display = 'inline';
          setTimeout(() => {
            document.getElementById('copy-token-msg').style.display = 'none';
          }, 2000);
        } catch (e) {
          console.error('Failed to copy', e);
        }
      });
    }

    function renderAdminApiTokens(tokens) {
      if (typeof setCurrentAdminApiTokens === 'function') {
        setCurrentAdminApiTokens(tokens);
      }
      const empty = document.getElementById('tokens-empty');
      const table = document.getElementById('tokens-table');
      const body = document.getElementById('tokens-tbody');
      if (!tokens.length) {
        table.style.display = 'none';
        empty.style.display = 'block';
        empty.textContent = 'No admin API tokens have been created yet.';
        body.innerHTML = '';
        return;
      }
      body.innerHTML = renderTokenRows(tokens);
      empty.style.display = 'none';
      table.style.display = 'table';
    }

    async function refreshAdminApiTokens() {
      try {
        const response = await fetch('/admin/api-tokens');
        if (!response.ok) {
          throw new Error('Failed to load tokens');
        }
        renderAdminApiTokens(await response.json());
      } catch (error) {
        document.getElementById('tokens-empty').style.display = 'block';
        document.getElementById('tokens-empty').textContent = 'Failed to load admin API tokens.';
        document.getElementById('tokens-table').style.display = 'none';
      }
    }

    async function createAdminApiToken() {
      const label = document.getElementById('token-label').value.trim();
      const ttlDays = Number(document.getElementById('token-ttl-days').value);
      const scopes = getSelectedTokenScopes();
      const response = await fetch('/admin/api-tokens', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ csrfToken, label, ttlDays, scopes }),
      });
      if (!response.ok) {
        throw new Error(await response.text());
      }
      return response.json();
    }

    async function revokeAdminApiToken(tokenId) {
      const response = await fetch('/admin/api-tokens/' + encodeURIComponent(tokenId) + '/revoke', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ csrfToken }),
      });
      if (!response.ok) {
        throw new Error(await response.text());
      }
      return response.json();
    }

    return {
      renderTokenScopeOptions,
      getSelectedTokenScopes,
      showCreatedToken,
      renderAdminApiTokens,
      refreshAdminApiTokens,
      createAdminApiToken,
      revokeAdminApiToken,
      toggleTokenReveal,
    };
  }

  global.AdminTokenManager = {
    createTokenManager,
  };
})(window);
