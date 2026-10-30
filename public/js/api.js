// public/js/api.js
// Client API Gateway Client for Apex Internet Banking

const API_BASE = '/api';

class ApiClient {
  constructor() {
    this.token = localStorage.getItem('apex_jwt_token') || null;
    this.currentUser = JSON.parse(localStorage.getItem('apex_user') || 'null');
  }

  setSession(token, user) {
    this.token = token;
    this.currentUser = user;
    if (token) {
      localStorage.setItem('apex_jwt_token', token);
      localStorage.setItem('apex_user', JSON.stringify(user));
    } else {
      localStorage.removeItem('apex_jwt_token');
      localStorage.removeItem('apex_user');
    }
  }

  async request(endpoint, options = {}) {
    const url = `${API_BASE}${endpoint}`;
    const headers = {
      'Content-Type': 'application/json',
      'x-correlation-id': `web-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
      ...(options.headers || {})
    };

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    try {
      const res = await fetch(url, {
        ...options,
        headers
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(data.error || data.reason || `HTTP Error ${res.status}`);
      }

      return data;
    } catch (err) {
      console.error(`API Error [${endpoint}]:`, err.message);
      throw err;
    }
  }

  // --- Auth APIs ---
  async login(email, password) {
    const data = await this.request('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password })
    });
    this.setSession(data.token, data.user);
    return data;
  }

  async register({ fullName, email, password, phone, transactionPin }) {
    const data = await this.request('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ fullName, email, password, phone, transactionPin })
    });
    this.setSession(data.token, data.user);
    return data;
  }

  logout() {
    this.setSession(null, null);
  }

  async getUsers() {
    return this.request('/auth/users');
  }

  async verifyPin(pin) {
    return this.request('/auth/verify-pin', {
      method: 'POST',
      body: JSON.stringify({ userId: this.currentUser?.id, pin })
    });
  }

  // --- Account & Card APIs ---
  async getAccounts(userId = this.currentUser?.id) {
    return this.request(`/accounts/user/${userId}`);
  }

  async openAccount(type, initialBalance = 0) {
    return this.request('/accounts', {
      method: 'POST',
      body: JSON.stringify({
        userId: this.currentUser?.id,
        type,
        initialBalance,
        holderName: this.currentUser?.fullName
      })
    });
  }

  async toggleCardLock(cardId, status) {
    return this.request(`/cards/${cardId}/status`, {
      method: 'POST',
      body: JSON.stringify({ status })
    });
  }

  async updateCardSettings(cardId, settings) {
    return this.request(`/cards/${cardId}/settings`, {
      method: 'POST',
      body: JSON.stringify(settings)
    });
  }

  // --- Transaction & Saga APIs ---
  async transferFunds({ fromAccount, toAccount, amount, description, simulateCreditFailure = false }) {
    const idempotencyKey = `idemp-${Date.now()}-${Math.random().toString(36).substr(2, 7)}`;
    return this.request('/transactions/transfer', {
      method: 'POST',
      headers: {
        'idempotency-key': idempotencyKey
      },
      body: JSON.stringify({
        userId: this.currentUser?.id,
        fromAccount,
        toAccount,
        amount,
        description,
        simulateCreditFailure
      })
    });
  }

  async depositFunds({ accountNumber, amount, description }) {
    return this.request('/transactions/deposit', {
      method: 'POST',
      body: JSON.stringify({
        accountNumber,
        amount,
        description
      })
    });
  }

  async getTransactions(userId = this.currentUser?.id, type = null) {
    const query = type ? `?type=${type}` : '';
    return this.request(`/transactions/user/${userId}${query}`);
  }

  async getSagaDetails(referenceId) {
    return this.request(`/transactions/saga/${referenceId}`);
  }

  // --- Notification APIs ---
  async getNotifications(userId = this.currentUser?.id) {
    return this.request(`/notifications/user/${userId}`);
  }

  async markAllNotificationsRead(userId = this.currentUser?.id) {
    return this.request(`/notifications/read-all/${userId}`, { method: 'POST' });
  }

  // --- Ops & Topology APIs ---
  async getSystemTopology() {
    return this.request('/system/topology');
  }

  async getFraudAlerts() {
    return this.request('/fraud/alerts');
  }

  async resolveFraudAlert(alertId, resolution) {
    return this.request(`/fraud/alerts/${alertId}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ resolution })
    });
  }
}

window.api = new ApiClient();
