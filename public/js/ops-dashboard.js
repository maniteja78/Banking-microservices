// public/js/ops-dashboard.js
// Microservices Telemetry, Saga Inspector & Event Bus Console

class OpsDashboard {
  constructor() {
    this.eventSource = null;
    this.terminalEl = document.getElementById('eventTerminal');
    this.topologyGridEl = document.getElementById('topologyGrid');
    this.sagaVisualizerEl = document.getElementById('sagaStepsStepper');
    this.sagaRefEl = document.getElementById('activeSagaRef');
    this.fraudTableBody = document.getElementById('fraudAlertsTableBody');
    this.usersTableBody = document.getElementById('usersTableBody');
    this.pingDisplayEl = document.getElementById('globalLatency');
    this.meshStatusPill = document.getElementById('globalMeshStatus');
    
    this.initEventListeners();
    this.startEventBusStream();
    this.loadTopology();
    this.loadFraudAlerts();
    this.loadUsersDirectory();

    // Auto-poll topology every 10 seconds
    setInterval(() => this.loadTopology(), 10000);
  }

  initEventListeners() {
    document.getElementById('refreshTopologyBtn')?.addEventListener('click', () => this.loadTopology());
    document.getElementById('refreshUsersBtn')?.addEventListener('click', () => this.loadUsersDirectory());
    document.getElementById('clearTerminalBtn')?.addEventListener('click', () => {
      if (this.terminalEl) this.terminalEl.innerHTML = '';
    });

    document.getElementById('testNormalSagaBtn')?.addEventListener('click', () => this.simulateNormalSaga());
    document.getElementById('testFailedSagaBtn')?.addEventListener('click', () => this.simulateCompensationSaga());
    document.getElementById('testFraudTriggerBtn')?.addEventListener('click', () => this.simulateFraudTrigger());
  }

  // Connect to Event Bus Server-Sent Events (SSE) Stream
  startEventBusStream() {
    if (this.eventSource) this.eventSource.close();

    this.eventSource = new EventSource('/api/events/stream');

    this.eventSource.onopen = () => {
      this.logTerminal('[SYSTEM] Connected to Centralized Event Broker (Port 8086). SSE Active.', 'system');
    };

    this.eventSource.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data);
        this.renderEventInTerminal(parsed);
      } catch (e) {
        // Heartbeat or raw text
      }
    };

    this.eventSource.onerror = () => {
      // Reconnection handled automatically by browser EventSource
    };
  }

  renderEventInTerminal(event) {
    if (!this.terminalEl) return;
    if (event.topic === 'SYSTEM_CONNECTED') return;

    let cssClass = 'event-tx';
    if (event.topic.includes('FRAUD') || event.topic.includes('BLOCKED')) cssClass = 'event-fraud';
    if (event.topic.includes('AUTH') || event.topic.includes('USER')) cssClass = 'event-auth';

    const time = new Date(event.timestamp || Date.now()).toLocaleTimeString();
    const line = document.createElement('div');
    line.className = `terminal-line ${cssClass}`;
    line.innerHTML = `[${time}] <strong>[${event.source}]</strong> -> <strong>${event.topic}</strong>: ${JSON.stringify(event.payload || {})}`;

    this.terminalEl.appendChild(line);
    this.terminalEl.scrollTop = this.terminalEl.scrollHeight;
  }

  logTerminal(text, type = 'system') {
    if (!this.terminalEl) return;
    const line = document.createElement('div');
    line.className = `terminal-line ${type}`;
    line.textContent = text;
    this.terminalEl.appendChild(line);
    this.terminalEl.scrollTop = this.terminalEl.scrollHeight;
  }

  // Fetch and render System Topology
  async loadTopology() {
    try {
      const data = await window.api.getSystemTopology();
      this.renderTopologyGrid(data);

      // Update global latency badge
      const cluster = data.cluster || {};
      const latencies = Object.values(cluster).map(s => s.latencyMs).filter(Boolean);
      const avgLatency = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 2;
      
      if (this.pingDisplayEl) this.pingDisplayEl.textContent = `${avgLatency}ms`;
      
      const allOnline = Object.values(cluster).every(s => s.status === 'ONLINE');
      if (this.meshStatusPill) {
        this.meshStatusPill.classList.toggle('degraded', !allOnline);
      }
    } catch (err) {
      console.warn('Topology fetch warning:', err.message);
    }
  }

  renderTopologyGrid(data) {
    if (!this.topologyGridEl) return;

    const cluster = data.cluster || {};
    const serviceNodes = Object.entries(cluster).map(([key, s]) => {
      const isOnline = s.status === 'ONLINE';
      return `
        <div class="service-node">
          <div class="node-head">
            <span class="node-badge">${key.toUpperCase()}-SVC</span>
            <span class="node-status ${isOnline ? 'online' : 'offline'}">${s.status}</span>
          </div>
          <h4>${s.name}</h4>
          <div class="node-meta">
            <span>Port: ${s.port}</span>
            <span class="latency">${s.latencyMs !== null ? s.latencyMs + 'ms' : 'N/A'}</span>
          </div>
          <div class="node-routes">
            Circuit: <strong>${s.circuitState || 'CLOSED'}</strong> • Failures: ${s.details?.failures || 0}
          </div>
        </div>
      `;
    }).join('');

    // Prepend API Gateway
    const gatewayHtml = `
      <div class="service-node gateway-node">
        <div class="node-head">
          <span class="node-badge">REVERSE PROXY</span>
          <span class="node-status online">ONLINE</span>
        </div>
        <h4>API Gateway</h4>
        <div class="node-meta">
          <span>Port: 8080</span>
          <span class="latency">1ms</span>
        </div>
        <div class="node-routes">
          <code>/api/*</code> • JWT • Circuit Breaker • Rate Limiter
        </div>
      </div>
    `;

    this.topologyGridEl.innerHTML = gatewayHtml + serviceNodes;
  }

  // Render Saga Steps Flow
  renderSagaSteps(referenceId, steps) {
    if (this.sagaRefEl) this.sagaRefEl.textContent = referenceId;
    if (!this.sagaVisualizerEl) return;

    if (!steps || steps.length === 0) {
      this.sagaVisualizerEl.innerHTML = '<div class="step-placeholder">No steps recorded.</div>';
      return;
    }

    const html = steps.map((s, index) => {
      let icon = '✅';
      if (s.status === 'FAILED') icon = '❌';
      if (s.status === 'COMPENSATING' || s.status === 'COMPENSATED') icon = '🔄';

      return `
        <div class="saga-step-row ${s.status}">
          <span class="step-num">${index + 1}.</span>
          <span>${icon} <strong>${s.step}</strong>: ${s.status}</span>
          ${s.details?.error ? `<span class="text-danger">(${s.details.error})</span>` : ''}
          ${s.details?.note ? `<span class="text-accent">(${s.details.note})</span>` : ''}
          <span class="step-time">${new Date(s.timestamp || Date.now()).toLocaleTimeString()}</span>
        </div>
      `;
    }).join('');

    this.sagaVisualizerEl.innerHTML = html;
  }

  // Simulation 1: Clean Transfer
  async simulateNormalSaga() {
    try {
      window.app?.showToast('Executing clean Saga transfer ($150)...', 'INFO');
      const res = await window.api.transferFunds({
        fromAccount: '4010882314', // John's checking
        toAccount: '4055239912',   // Sarah's checking
        amount: 150.00,
        description: 'Test Clean Saga Transfer'
      });
      this.renderSagaSteps(res.referenceId, res.sagaSteps);
      window.app?.showToast('Saga completed successfully! Ledger updated.', 'SUCCESS');
      window.app?.refreshUserData();
      this.loadFraudAlerts();
    } catch (err) {
      window.app?.showToast(`Saga failed: ${err.message}`, 'ERROR');
    }
  }

  // Simulation 2: Trigger Failure & Auto Compensation Rollback
  async simulateCompensationSaga() {
    try {
      window.app?.showToast('Simulating transfer with Recipient Credit Failure...', 'WARNING');
      const res = await window.api.transferFunds({
        fromAccount: '4010882314',
        toAccount: '4055239912',
        amount: 250.00,
        description: 'Simulated Credit Failure to test Compensation',
        simulateCreditFailure: true
      });
      this.renderSagaSteps(res.referenceId, res.sagaSteps);
      window.app?.showToast('Compensation executed! Debited funds were auto-refunded to sender.', 'WARNING');
      window.app?.refreshUserData();
    } catch (err) {
      // Even on error, response has saga steps
      if (err.sagaSteps) {
        this.renderSagaSteps(err.referenceId, err.sagaSteps);
      }
      window.app?.showToast('Compensation Rollback triggered as expected!', 'WARNING');
      window.app?.refreshUserData();
    }
  }

  // Simulation 3: Trigger AML Fraud Alert
  async simulateFraudTrigger() {
    try {
      window.app?.showToast('Initiating $15,000 High-Value Transfer to trigger AML Heuristics...', 'WARNING');
      const res = await window.api.transferFunds({
        fromAccount: '4010882314',
        toAccount: '4099999999', // Watchlist target
        amount: 15000.00,
        description: 'High Value Suspicious Wire'
      });
      this.renderSagaSteps(res.referenceId, res.sagaSteps);
    } catch (err) {
      window.app?.showToast(`Fraud Rule Triggered! Transfer Blocked: ${err.message}`, 'ERROR');
      this.loadFraudAlerts();
      window.app?.refreshUserData();
    }
  }

  // Load and render AML Fraud Alerts
  async loadFraudAlerts() {
    if (!this.fraudTableBody) return;
    try {
      const alerts = await window.api.getFraudAlerts();
      if (!alerts || alerts.length === 0) {
        this.fraudTableBody.innerHTML = '<tr><td colspan="7" class="text-dim text-center">No fraud alerts detected.</td></tr>';
        return;
      }

      this.fraudTableBody.innerHTML = alerts.slice(0, 10).map(a => {
        const flagText = a.flags?.map(f => f.rule).join(', ') || 'N/A';
        const isDeclined = a.decision === 'DECLINED';
        const isApproved = a.decision === 'APPROVED';

        return `
          <tr>
            <td><code>${a.id ? a.id.slice(0, 10) : 'N/A'}</code></td>
            <td><code>${a.fromAccount || 'N/A'}</code></td>
            <td><code>${a.toAccount || 'N/A'}</code></td>
            <td>$${Number(a.amount).toLocaleString()}</td>
            <td><strong>${a.riskScore}/100</strong></td>
            <td><span class="badge-neutral">${flagText}</span></td>
            <td>
              <span class="status-badge ${isDeclined ? 'FAILED_ROLLED_BACK' : (isApproved ? 'COMPLETED' : 'BLOCKED_FRAUD')}">
                ${a.decision}
              </span>
            </td>
          </tr>
        `;
      }).join('');
    } catch (err) {
      console.warn('Failed to load fraud alerts:', err.message);
    }
  }

  // Load and render Users Database (data/auth.json)
  async loadUsersDirectory() {
    if (!this.usersTableBody) return;
    try {
      const users = await window.api.getUsers();
      if (!users || users.length === 0) {
        this.usersTableBody.innerHTML = '<tr><td colspan="7" class="text-dim text-center">No users in database.</td></tr>';
        return;
      }

      this.usersTableBody.innerHTML = users.map(u => {
        const isCustomer = u.role === 'customer';
        const roleBadge = isCustomer 
          ? '<span class="status-badge COMPLETED">Customer</span>' 
          : '<span class="status-badge BLOCKED_FRAUD">Bank Auditor</span>';

        const dateStr = u.createdAt 
          ? new Date(u.createdAt).toLocaleDateString() + ' ' + new Date(u.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          : 'N/A';

        return `
          <tr>
            <td><code>${u.id}</code></td>
            <td><strong>${u.fullName}</strong></td>
            <td>${u.email}</td>
            <td class="text-dim">${u.phone || 'N/A'}</td>
            <td>${roleBadge}</td>
            <td><span class="badge-neutral">${u.kycStatus || 'VERIFIED'}</span></td>
            <td class="text-dim">${dateStr}</td>
          </tr>
        `;
      }).join('');
    } catch (err) {
      console.warn('Failed to load users directory:', err.message);
    }
  }
}

window.opsDashboard = new OpsDashboard();
