// shared/eventClient.js
// Microservices Event Bus Client (Pub/Sub)
// Enables asynchronous, event-driven decoupling between microservices

const http = require('http');

class EventClient {
  constructor(serviceName, busUrl = 'http://localhost:8086') {
    this.serviceName = serviceName;
    this.busUrl = new URL(busUrl);
    this.subscriptions = new Map(); // topic -> Array of handlers
    this.connected = false;
  }

  /**
   * Publish an event to the event broker
   * @param {string} topic - e.g., 'TRANSACTION_COMPLETED', 'FRAUD_ALERT', 'ACCOUNT_OPENED'
   * @param {object} payload - Event payload data
   * @param {string} correlationId - Distributed tracing correlation ID
   */
  async publish(topic, payload, correlationId = null) {
    return new Promise((resolve, reject) => {
      const eventData = JSON.stringify({
        topic,
        source: this.serviceName,
        payload,
        correlationId: correlationId || `corr-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
        timestamp: new Date().toISOString()
      });

      const req = http.request({
        hostname: this.busUrl.hostname,
        port: this.busUrl.port,
        path: '/publish',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(eventData),
          'x-source-service': this.serviceName
        },
        timeout: 4000
      }, (res) => {
        let responseBody = '';
        res.on('data', chunk => responseBody += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(JSON.parse(responseBody || '{}'));
          } else {
            resolve({ error: `Event bus responded with ${res.statusCode}` });
          }
        });
      });

      req.on('error', (err) => {
        // Asynchronous resilience: don't crash caller if event bus is momentarily restarting
        console.warn(`[${this.serviceName}] EventBus publish warning: ${err.message}`);
        resolve({ warning: 'Event bus unreachable', error: err.message });
      });

      req.write(eventData);
      req.end();
    });
  }

  /**
   * Subscribe to specific topics via Event Bus SSE stream
   * @param {Array<string>} topics - Topics to listen to
   * @param {Function} handler - Callback(event)
   */
  subscribe(topics, handler) {
    const topicList = Array.isArray(topics) ? topics : [topics];
    
    topicList.forEach(t => {
      if (!this.subscriptions.has(t)) {
        this.subscriptions.set(t, []);
      }
      this.subscriptions.get(t).push(handler);
    });

    this._startSSEConnection();
  }

  _startSSEConnection() {
    if (this._sseConnecting) return;
    this._sseConnecting = true;

    const req = http.request({
      hostname: this.busUrl.hostname,
      port: this.busUrl.port,
      path: `/events/stream?service=${encodeURIComponent(this.serviceName)}`,
      method: 'GET',
      headers: {
        'Accept': 'text/event-stream',
        'Cache-Control': 'no-cache'
      }
    }, (res) => {
      this.connected = true;
      this._sseConnecting = false;

      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n\n');
        buffer = lines.pop(); // Keep unfinished tail

        for (const block of lines) {
          const match = block.match(/^data:\s*(.+)$/m);
          if (match) {
            try {
              const event = JSON.parse(match[1]);
              this._dispatch(event);
            } catch (e) {
              // Ignore non-json heartbeats
            }
          }
        }
      });

      res.on('end', () => {
        this.connected = false;
        setTimeout(() => this._startSSEConnection(), 3000);
      });
    });

    req.on('error', () => {
      this.connected = false;
      this._sseConnecting = false;
      setTimeout(() => this._startSSEConnection(), 3000);
    });

    req.end();
  }

  _dispatch(event) {
    const handlers = this.subscriptions.get(event.topic) || [];
    const wildcardHandlers = this.subscriptions.get('*') || [];
    [...handlers, ...wildcardHandlers].forEach(fn => {
      try {
        fn(event);
      } catch (err) {
        console.error(`[${this.serviceName}] Event handler error for ${event.topic}:`, err);
      }
    });
  }
}

module.exports = EventClient;
