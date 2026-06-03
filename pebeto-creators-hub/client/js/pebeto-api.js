/**
 * Shared API helpers for Pebeto Creator's Hub dashboards.
 */
(function (global) {
  const TOKEN_KEY = 'pebeto_token';
  const USER_KEY = 'pebeto_user';

  function getToken() {
    return localStorage.getItem(TOKEN_KEY);
  }

  function getUser() {
    try {
      return JSON.parse(localStorage.getItem(USER_KEY) || 'null');
    } catch {
      return null;
    }
  }

  function saveSession(token, user) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  }

  function clearSession() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  }

  function requireRole(allowedRoles, loginPath) {
    const user = getUser();
    const token = getToken();
    if (!token || !user) {
      window.location.href = loginPath || '/signup.html?login=1';
      return null;
    }
    if (!allowedRoles.includes(user.role)) {
      if (user.role === 'business') window.location.href = '/business/business.html';
      else if (user.role === 'creator') window.location.href = '/creator/creator.html';
      else if (user.role === 'admin') window.location.href = '/admin/admin.html';
      else window.location.href = '/signup.html';
      return null;
    }
    return { user, token };
  }

  async function apiFetch(path, options = {}) {
    const token = getToken();
    const headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(path, { ...options, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.message || `Request failed (${res.status})`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function formatUsd(amount) {
    const n = Number(amount) || 0;
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
    }).format(n);
  }

  function formatDate(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  }

  function displayLabel(user) {
    if (!user) return 'User';
    if (user.role === 'business') return user.profile?.companyName || user.email;
    if (user.role === 'creator') return user.profile?.stageName || user.uniqueCode || user.email;
    return user.profile?.displayName || user.email;
  }

  function dashboardUrl(user, viewOnly) {
    const q = viewOnly ? '?viewOnly=1&userId=' + encodeURIComponent(user._id || user.id) : '';
    if (user.role === 'business') return '/business/business.html' + q;
    if (user.role === 'creator') return '/creator/creator.html' + q;
    return '/admin/admin.html';
  }

  global.PebetoApi = {
    TOKEN_KEY,
    USER_KEY,
    getToken,
    getUser,
    saveSession,
    clearSession,
    requireRole,
    apiFetch,
    formatUsd,
    formatDate,
    displayLabel,
    dashboardUrl,
  };
})(window);
