/**
 * Shared API helpers for Pebeto Creator's Hub dashboards.
 * 
 * Provides authentication, API fetching, formatting utilities,
 * and dashboard routing for all Pebeto platform components.
 * 
 * @version 2.0.0
 */

(function (global) {
  // ============================================
  // Constants & Configuration
  // ============================================
  
  const TOKEN_KEY = 'pebeto_token';
  const USER_KEY = 'pebeto_user';
  const REFRESH_TOKEN_KEY = 'pebeto_refresh_token';
  
  const CONFIG = {
    API_BASE: '', // Empty means relative paths; can be set to full URL if needed
    REQUEST_TIMEOUT: 30000, // 30 seconds
    MAX_RETRIES: 2,
    RETRY_DELAY: 1000,
    ENABLE_CACHING: true,
    CACHE_TTL: 60000, // 1 minute
  };
  
  // Simple in-memory cache
  const cache = new Map();
  
  // Pending requests deduplication
  const pendingRequests = new Map();
  
  // ============================================
  // Storage Helpers
  // ============================================
  
  function getToken() {
    return localStorage.getItem(TOKEN_KEY);
  }
  
  function getRefreshToken() {
    return localStorage.getItem(REFRESH_TOKEN_KEY);
  }
  
  function getUser() {
    try {
      const raw = localStorage.getItem(USER_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }
  
  function saveSession(token, user, refreshToken = null) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    if (refreshToken) {
      localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
    }
    // Dispatch event for other tabs/windows
    window.dispatchEvent(new CustomEvent('pebeto:session-changed', { detail: { user, isLoggedIn: true } }));
  }
  
  function clearSession() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem(REFRESH_TOKEN_KEY);
    localStorage.removeItem('userRole');
    
    // Clear cache on logout
    cache.clear();
    
    // Dispatch event for other tabs/windows
    window.dispatchEvent(new CustomEvent('pebeto:session-changed', { detail: { user: null, isLoggedIn: false } }));
  }
  
  function isLoggedIn() {
    return !!getToken() && !!getUser();
  }
  
  function logout(redirectTo = '/signup.html') {
    // Call logout endpoint if needed
    const token = getToken();
    if (token) {
      fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
      }).catch(() => {});
    }
    clearSession();
    window.location.href = redirectTo;
  }
  
  // ============================================
  // Authentication & Role Helpers
  // ============================================
  
  function requireRole(allowedRoles, loginPath) {
    const user = getUser();
    const token = getToken();
    
    if (!token || !user) {
      window.location.href = loginPath || '/signup.html?login=1';
      return null;
    }
    
    if (!allowedRoles.includes(user.role)) {
      // Redirect to appropriate dashboard based on role
      redirectToDashboard(user.role);
      return null;
    }
    
    return { user, token };
  }
  
  function redirectToDashboard(role) {
    const dashboardMap = {
      'admin': '/admin.html',
      'business': '/business.html',
      'creator': '/creator.html',
    };
    const url = dashboardMap[role] || '/signup.html';
    window.location.href = url;
  }
  
  function dashboardUrl(user, viewOnly = false) {
    const userId = user?._id || user?.id;
    const q = viewOnly && userId ? `?viewOnly=1&userId=${encodeURIComponent(userId)}` : '';
    
    const urlMap = {
      'business': '/business.html',
      'creator': '/creator.html',
      'admin': '/admin.html',
    };
    
    const baseUrl = urlMap[user?.role] || '/';
    return baseUrl + q;
  }
  
  // ============================================
  // Enhanced API Fetch with Retry, Timeout, Cache
  // ============================================
  
  async function apiFetch(path, options = {}) {
    const {
      method = 'GET',
      headers = {},
      body = null,
      isFormData = false,
      requireAuth = true,
      timeout = CONFIG.REQUEST_TIMEOUT,
      retries = CONFIG.MAX_RETRIES,
      useCache = false,
      cacheKey = null,
      onProgress = null,
    } = options;
    
    // Generate cache key
    const effectiveCacheKey = cacheKey || `${method}:${path}:${JSON.stringify(body)}`;
    
    // Check cache for GET requests
    if (useCache && method === 'GET' && CONFIG.ENABLE_CACHING) {
      const cached = cache.get(effectiveCacheKey);
      if (cached && Date.now() - cached.timestamp < CONFIG.CACHE_TTL) {
        return cached.data;
      }
    }
    
    // Deduplicate pending requests
    if (pendingRequests.has(effectiveCacheKey)) {
      return pendingRequests.get(effectiveCacheKey);
    }
    
    const requestPromise = executeFetch(path, { method, headers, body, isFormData, requireAuth, timeout, retries, onProgress });
    pendingRequests.set(effectiveCacheKey, requestPromise);
    
    try {
      const result = await requestPromise;
      
      // Cache successful GET responses
      if (useCache && method === 'GET' && CONFIG.ENABLE_CACHING) {
        cache.set(effectiveCacheKey, {
          data: result,
          timestamp: Date.now(),
        });
      }
      
      return result;
    } finally {
      pendingRequests.delete(effectiveCacheKey);
    }
  }
  
  async function executeFetch(path, { method, headers, body, isFormData, requireAuth, timeout, retries, onProgress }) {
    const token = getToken();
    const requestHeaders = { ...headers };
    
    // Set content-type for non-FormData requests
    if (!isFormData && !requestHeaders['Content-Type']) {
      requestHeaders['Content-Type'] = 'application/json';
    }
    
    if (requireAuth && token) {
      requestHeaders['Authorization'] = `Bearer ${token}`;
    }
    
    let requestBody = body;
    if (!isFormData && body && typeof body === 'object') {
      requestBody = JSON.stringify(body);
    }
    
    let lastError;
    let retryCount = 0;
    
    while (retryCount <= retries) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);
        
        let response;
        
        // Handle file upload with progress
        if (isFormData && onProgress && typeof XMLHttpRequest !== 'undefined') {
          response = await uploadWithProgress(path, requestBody, requestHeaders, onProgress, controller);
        } else {
          response = await fetch(CONFIG.API_BASE + path, {
            method,
            headers: requestHeaders,
            body: requestBody,
            signal: controller.signal,
          });
        }
        
        clearTimeout(timeoutId);
        
        // Parse response
        const contentType = response.headers.get('content-type');
        let data;
        if (contentType && contentType.includes('application/json')) {
          data = await response.json().catch(() => ({}));
        } else {
          data = await response.text().catch(() => '');
        }
        
        // Handle token refresh (401)
        if (response.status === 401 && requireAuth && token && retryCount === 0) {
          const refreshed = await refreshToken();
          if (refreshed) {
            retryCount++;
            continue; // Retry with new token
          }
        }
        
        if (!response.ok) {
          const err = new Error(data.message || data.error || `Request failed (${response.status})`);
          err.status = response.status;
          err.statusText = response.statusText;
          err.data = data;
          throw err;
        }
        
        return data;
        
      } catch (error) {
        lastError = error;
        
        // Don't retry on 4xx errors (except 401 which we handled)
        if (error.status && error.status >= 400 && error.status < 500 && error.status !== 401) {
          break;
        }
        
        // Don't retry on abort
        if (error.name === 'AbortError') {
          error.message = `Request timeout after ${timeout}ms`;
          break;
        }
        
        retryCount++;
        if (retryCount <= retries) {
          await new Promise(resolve => setTimeout(resolve, CONFIG.RETRY_DELAY * retryCount));
        }
      }
    }
    
    throw lastError;
  }
  
  // XMLHttpRequest for progress tracking on file uploads
  function uploadWithProgress(url, formData, headers, onProgress, controller) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      
      xhr.open('POST', CONFIG.API_BASE + url, true);
      
      // Set headers
      Object.keys(headers).forEach(key => {
        xhr.setRequestHeader(key, headers[key]);
      });
      
      // Track progress
      if (onProgress) {
        xhr.upload.addEventListener('progress', (e) => {
          if (e.lengthComputable) {
            const percent = Math.round((e.loaded / e.total) * 100);
            onProgress(percent);
          }
        });
      }
      
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const data = JSON.parse(xhr.responseText);
            resolve(data);
          } catch {
            resolve(xhr.responseText);
          }
        } else {
          let errorMsg = `Upload failed (${xhr.status})`;
          try {
            const data = JSON.parse(xhr.responseText);
            errorMsg = data.message || errorMsg;
          } catch {}
          reject(new Error(errorMsg));
        }
      };
      
      xhr.onerror = () => reject(new Error('Network error during upload'));
      xhr.onabort = () => reject(new Error('Upload cancelled'));
      
      // Handle abort from AbortController
      controller.signal.addEventListener('abort', () => {
        xhr.abort();
        reject(new Error('Upload aborted'));
      });
      
      xhr.send(formData);
    });
  }
  
  async function refreshToken() {
    const refreshToken = getRefreshToken();
    if (!refreshToken) return false;
    
    try {
      const response = await fetch(CONFIG.API_BASE + '/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      
      if (!response.ok) return false;
      
      const data = await response.json();
      if (data.token && data.user) {
        saveSession(data.token, data.user, data.refreshToken || refreshToken);
        return true;
      }
    } catch (error) {
      console.error('Token refresh failed:', error);
    }
    
    return false;
  }
  
  // ============================================
  // Cache Management
  // ============================================
  
  function clearCache(pattern = null) {
    if (!pattern) {
      cache.clear();
      return;
    }
    for (const [key] of cache) {
      if (key.includes(pattern)) {
        cache.delete(key);
      }
    }
  }
  
  function invalidateCacheForPath(path) {
    for (const [key] of cache) {
      if (key.includes(path)) {
        cache.delete(key);
      }
    }
  }
  
  // ============================================
  // Formatting Helpers
  // ============================================
  
  function formatUsd(amount) {
    const n = Number(amount) || 0;
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
    }).format(n);
  }
  
  function formatCurrency(amount, currency = 'USD', locale = 'en-US') {
    const n = Number(amount) || 0;
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: currency.toUpperCase(),
      minimumFractionDigits: 2,
    }).format(n);
  }
  
  function formatDate(iso, options = {}) {
    if (!iso) return '—';
    const opts = {
      dateStyle: 'medium',
      timeStyle: 'short',
      ...options,
    };
    try {
      return new Date(iso).toLocaleString(undefined, opts);
    } catch {
      return iso;
    }
  }
  
  function formatRelativeTime(iso) {
    if (!iso) return '—';
    const date = new Date(iso);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins} minute${diffMins === 1 ? '' : 's'} ago`;
    if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
    if (diffDays < 7) return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
    return formatDate(iso, { dateStyle: 'medium' });
  }
  
  function formatNumber(num) {
    if (num === undefined || num === null) return '0';
    const n = Number(num);
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return n.toString();
  }
  
  function truncate(str, maxLength = 100) {
    if (!str) return '';
    if (str.length <= maxLength) return str;
    return str.slice(0, maxLength - 3) + '...';
  }
  
  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
  
  // ============================================
  // User Display Helpers
  // ============================================
  
  function displayLabel(user) {
    if (!user) return 'User';
    if (user.role === 'business') return user.profile?.companyName || user.email || 'Brand';
    if (user.role === 'creator') return user.profile?.stageName || user.uniqueCode || user.email || 'Creator';
    return user.profile?.displayName || user.email || 'User';
  }
  
  function getInitials(name) {
    if (!name) return '?';
    return name
      .split(/\s+/)
      .map(word => word[0])
      .join('')
      .slice(0, 2)
      .toUpperCase();
  }
  
  // ============================================
  // Socket.io Helper
  // ============================================
  
  function getSocketAuth() {
    const token = getToken();
    return { token };
  }
  
  function initSocket(io, options = {}) {
    if (typeof io === 'undefined') {
      console.warn('Socket.io not available');
      return null;
    }
    
    const token = getToken();
    if (!token) {
      console.warn('No token available for socket connection');
      return null;
    }
    
    try {
      const socket = io({
        auth: { token },
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: 5,
        reconnectionDelay: 1000,
        ...options,
      });
      
      socket.on('connect_error', (err) => {
        console.error('Socket connection error:', err.message);
      });
      
      return socket;
    } catch (e) {
      console.error('Socket initialization failed:', e);
      return null;
    }
  }
  
  // ============================================
  // API Wrappers for Common Operations
  // ============================================
  
  async function getUserProfile() {
    return apiFetch('/api/user/profile');
  }
  
  async function updateUserProfile(profileData) {
    return apiFetch('/api/user/profile', {
      method: 'PUT',
      body: profileData,
    });
  }
  
  async function getWalletBalance(userId = null) {
    const query = userId ? `?userId=${userId}` : '';
    return apiFetch('/api/wallet/balance' + query);
  }
  
  // ============================================
  // Event Listeners for Session Changes
  // ============================================
  
  // Listen for session changes from other tabs
  window.addEventListener('storage', (event) => {
    if (event.key === TOKEN_KEY || event.key === USER_KEY) {
      const newToken = localStorage.getItem(TOKEN_KEY);
      const newUser = getUser();
      
      if (!newToken || !newUser) {
        window.dispatchEvent(new CustomEvent('pebeto:session-expired'));
      }
    }
  });
  
  // ============================================
  // Exports
  // ============================================
  
  global.PebetoApi = {
    // Constants
    TOKEN_KEY,
    USER_KEY,
    
    // Storage
    getToken,
    getUser,
    saveSession,
    clearSession,
    isLoggedIn,
    logout,
    
    // Auth
    requireRole,
    redirectToDashboard,
    dashboardUrl,
    refreshToken,
    
    // API
    apiFetch,
    clearCache,
    invalidateCacheForPath,
    
    // Formatting
    formatUsd,
    formatCurrency,
    formatDate,
    formatRelativeTime,
    formatNumber,
    truncate,
    escapeHtml,
    
    // User display
    displayLabel,
    getInitials,
    
    // Socket
    getSocketAuth,
    initSocket,
    
    // API Wrappers
    getUserProfile,
    updateUserProfile,
    getWalletBalance,
  };
})(window);
