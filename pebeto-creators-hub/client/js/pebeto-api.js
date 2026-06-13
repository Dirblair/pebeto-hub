/**
 * Pebeto API Client
 * Centralized API client for all Pebeto frontend applications
 */

const PEBBETO_API_BASE = 'https://pebeto-creators-hub.onrender.com';

class PebetoAPI {
  constructor() {
    this.token = localStorage.getItem('pebeto_token');
    this.user = JSON.parse(localStorage.getItem('pebeto_user') || 'null');
  }

  async request(endpoint, options = {}) {
    const url = `${PEBBETO_API_BASE}${endpoint}`;
    const headers = {
      'Content-Type': 'application/json',
      ...options.headers
    };
    
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    
    const response = await fetch(url, {
      ...options,
      headers
    });
    
    return response.json();
  }

  setToken(token) {
    this.token = token;
    localStorage.setItem('pebeto_token', token);
  }

  setUser(user) {
    this.user = user;
    localStorage.setItem('pebeto_user', JSON.stringify(user));
  }

  logout() {
    this.token = null;
    this.user = null;
    localStorage.clear();
    window.location.href = '/login.html';
  }

  // Auth endpoints
  async login(email, password) {
    const data = await this.request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password })
    });
    if (data.success && data.token) {
      this.setToken(data.token);
      this.setUser(data.user);
    }
    return data;
  }

  async register(email, password, role, profile) {
    return this.request('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, role, profile })
    });
  }

  // User endpoints
  async getUserProfile() {
    return this.request('/api/user/profile');
  }

  async updateUserProfile(profile) {
    return this.request('/api/user/profile', {
      method: 'PUT',
      body: JSON.stringify({ profile })
    });
  }

  // Wallet endpoints
  async getWalletBalance() {
    return this.request('/api/wallet/balance');
  }

  async getTransactions(page = 1, limit = 20) {
    return this.request(`/api/wallet/transactions?page=${page}&limit=${limit}`);
  }

  async sendTip(recipientUniqueCode, amount, currency = 'USD') {
    return this.request('/api/wallet/tip', {
      method: 'POST',
      body: JSON.stringify({ recipientUniqueCode, amount, currency })
    });
  }

  // Campaign endpoints
  async getCampaigns(page = 1, limit = 20, status = null) {
    let url = `/api/campaigns?page=${page}&limit=${limit}`;
    if (status) url += `&status=${status}`;
    return this.request(url);
  }

  async getCampaign(campaignId) {
    return this.request(`/api/campaigns/${campaignId}`);
  }

  async createCampaign(data) {
    return this.request('/api/campaigns', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  }

  async placeBid(campaignId, amount, proposal) {
    return this.request(`/api/campaigns/${campaignId}/bids`, {
      method: 'POST',
      body: JSON.stringify({ amount, proposal })
    });
  }

  async submitWork(campaignId, workUrl) {
    return this.request(`/api/campaigns/${campaignId}/submit`, {
      method: 'POST',
      body: JSON.stringify({ workUrl })
    });
  }

  // Community endpoints
  async getCommunityPosts(page = 1, limit = 20) {
    return this.request(`/api/community/posts?page=${page}&limit=${limit}`);
  }

  async createPost(caption, mediaFile) {
    const formData = new FormData();
    formData.append('caption', caption);
    formData.append('media', mediaFile);
    
    const token = this.token;
    const response = await fetch(`${PEBBETO_API_BASE}/api/community/posts`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: formData
    });
    return response.json();
  }

  async likePost(postId) {
    return this.request(`/api/community/posts/${postId}/like`, { method: 'POST' });
  }

  async commentOnPost(postId, text) {
    return this.request(`/api/community/posts/${postId}/comments`, {
      method: 'POST',
      body: JSON.stringify({ text })
    });
  }

  // Creator endpoints
  async getCreators(search = '', niche = '') {
    let url = `/api/creators?`;
    if (search) url += `search=${encodeURIComponent(search)}&`;
    if (niche) url += `niche=${encodeURIComponent(niche)}`;
    return this.request(url);
  }

  async getCreatorById(creatorId) {
    return this.request(`/api/creators/${creatorId}`);
  }

  async saveSocialLinks(tiktokUrl, youtubeUrl) {
    return this.request('/api/creator/social-links', {
      method: 'POST',
      body: JSON.stringify({ tiktokUrl, youtubeUrl })
    });
  }

  // Admin endpoints
  async getAdminMetrics() {
    return this.request('/api/admin/metrics');
  }

  async getAdminUsers(page = 1, limit = 20, role = null) {
    let url = `/api/admin/users?page=${page}&limit=${limit}`;
    if (role) url += `&role=${role}`;
    return this.request(url);
  }

  async updateUserStatus(userId, status, reason = null) {
    return this.request(`/api/admin/users/${userId}/status`, {
      method: 'PUT',
      body: JSON.stringify({ status, reason })
    });
  }
}

window.pebetoAPI = new PebetoAPI();
