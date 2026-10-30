// services/api-gateway/server.js
// API Gateway, Reverse Proxy, JWT Validator, Circuit Breaker & Static UI Host

const express = require('express');
const cors = require('cors');
const http = require('http');
const path = require('path');
const jwt = require('jsonwebtoken');
const Logger = require('../../shared/logger');

const logger = new Logger('GATEWAY');
const app = express();
const PORT = process.env.PORT || 8080;
const JWT_SECRET = process.env.JWT_SECRET || 'apex-banking-jwt-super-secret-key-2026';

// Downstream Service Registry Map
const SERVICES = {
  auth: { url: 'http://localhost:8081', name: 'Auth & Identity Service', port: 8081, failures: 0, state: 'CLOSED' },
  accounts: { url: 'http://localhost:8082', name: 'Account & Card Service', port: 8082, failures: 0, state: 'CLOSED' },
  transactions: { url: 'http://localhost:8083', name: 'Transaction & Saga Service', port: 8083, failures: 0, state: 'CLOSED' },
  notifications: { url: 'http://localhost:8084', name: 'Notification Service', port: 8084, failures: 0, state: 'CLOSED' },
  fraud: { url: 'http://localhost:8085', name: 'Fraud & Risk Analytics Service', port: 8085, failures: 0, state: 'CLOSED' },
  events: { url: 'http://localhost:8086', name: 'Event Broker (Pub/Sub)', port: 8086, failures: 0, state: 'CLOSED' }
};

app.use(cors());
// Parse body for non-proxy endpoints, or buffer for proxied requests
app.use(express.json());

// Correlation ID & Request Logging
app.use((req, res, next) => {
  const correlationId = req.headers['x-correlation-id'] || `corr-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
  req.correlationId = correlationId;
  res.setHeader('x-correlation-id', correlationId);

  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    if (req.path.startsWith('/api/')) {
      logger.info(`${req.method} ${req.originalUrl} [${res.statusCode}] - ${duration}ms`, { correlationId });
    }
  });

  next();
});

// Simple Sliding Window Rate Limiter
const requestCounts = new Map();
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();

  const ip = req.ip || '127.0.0.1';
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxRequests = 200;

  const userRecord = requestCounts.get(ip) || { count: 0, resetTime: now + windowMs };
  if (now > userRecord.resetTime) {
    userRecord.count = 1;
    userRecord.resetTime = now + windowMs;
  } else {
    userRecord.count++;
  }
  requestCounts.set(ip, userRecord);

  if (userRecord.count > maxRequests) {
    logger.warn(`Rate limit exceeded for IP ${ip}`);
    return res.status(429).json({ error: 'Too many requests. Please slow down.' });
  }

  next();
});

// JWT Verification Middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required. Please log in.' });
  }

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired session token.' });
    }
    req.user = decoded;
    next();
  });
}

// Microservice Reverse Proxy Engine with Circuit Breaker
function createServiceProxy(serviceKey, targetPathRewriter = null) {
  return async (req, res) => {
    const service = SERVICES[serviceKey];
    if (!service) {
      return res.status(502).json({ error: `Unknown service key: ${serviceKey}` });
    }

    // Circuit Breaker Check
    if (service.state === 'OPEN') {
      const coolingTime = 10000; // 10s cooldown
      if (Date.now() - service.trippedAt < coolingTime) {
        return res.status(503).json({
          error: `Service ${service.name} is currently offline (Circuit Breaker Tripped).`,
          circuitState: 'OPEN'
        });
      } else {
        service.state = 'HALF_OPEN';
      }
    }

    const targetUrl = new URL(service.url);
    const fullPath = req.originalUrl.split('?')[0];
    const resolvedPath = targetPathRewriter ? targetPathRewriter(fullPath) : fullPath;
    const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';

    const headers = { ...req.headers };
    delete headers['host'];
    delete headers['content-length'];
    delete headers['content-type'];
    headers['host'] = `${targetUrl.hostname}:${targetUrl.port}`;
    headers['x-correlation-id'] = req.correlationId;

    if (req.user) {
      headers['x-user-id'] = req.user.userId;
      headers['x-user-role'] = req.user.role;
      headers['x-user-email'] = req.user.email;
    }

    const bodyBuffer = req.body && Object.keys(req.body).length > 0 ? Buffer.from(JSON.stringify(req.body)) : null;
    if (bodyBuffer) {
      headers['content-length'] = bodyBuffer.length;
      headers['content-type'] = 'application/json';
    }

    const proxyReq = http.request({
      hostname: targetUrl.hostname,
      port: targetUrl.port,
      path: resolvedPath + query,
      method: req.method,
      headers: headers,
      timeout: 8000
    }, (proxyRes) => {
      // Circuit Success
      if (service.state === 'HALF_OPEN') {
        service.state = 'CLOSED';
        service.failures = 0;
      }

      res.status(proxyRes.statusCode);
      for (const [key, val] of Object.entries(proxyRes.headers)) {
        res.setHeader(key, val);
      }
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      service.failures++;
      if (service.failures >= 3) {
        service.state = 'OPEN';
        service.trippedAt = Date.now();
        logger.error(`Circuit breaker TRIPPED for ${service.name} after 3 failures.`);
      }

      logger.error(`Proxy failure forwarding to ${service.name}: ${err.message}`);
      if (!res.headersSent) {
        res.status(502).json({
          error: `Bad Gateway: ${service.name} unavailable`,
          details: err.message,
          circuitState: service.state
        });
      }
    });

    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      if (!res.headersSent) {
        res.status(504).json({ error: `Gateway Timeout: ${service.name} took too long to reply` });
      }
    });

    if (bodyBuffer) {
      proxyReq.write(bodyBuffer);
    }
    proxyReq.end();
  };
}

// -------------------------------------------------------------------------
// REVERSE PROXY ROUTING RULES
// -------------------------------------------------------------------------

// Auth Service routes (Public login/register, protected profile)
app.use('/api/auth/register', createServiceProxy('auth', p => p.replace(/^\/api\/auth/, '')));
app.use('/api/auth/login', createServiceProxy('auth', p => p.replace(/^\/api\/auth/, '')));
app.use('/api/auth/verify-pin', authenticateToken, createServiceProxy('auth', p => p.replace(/^\/api\/auth/, '')));
app.use('/api/auth/profile', authenticateToken, createServiceProxy('auth', p => p.replace(/^\/api\/auth/, '')));
app.use('/api/auth/users', createServiceProxy('auth', p => p.replace(/^\/api\/auth/, '')));

// Account Service routes
app.use('/api/accounts', authenticateToken, createServiceProxy('accounts', p => p.replace(/^\/api/, '')));
app.use('/api/cards', authenticateToken, createServiceProxy('accounts', p => p.replace(/^\/api/, '')));

// Transaction Service routes
app.use('/api/transactions', authenticateToken, createServiceProxy('transactions', p => p.replace(/^\/api/, '')));

// Notification Service routes
app.use('/api/notifications/stream', createServiceProxy('notifications', p => p.replace(/^\/api/, '')));
app.use('/api/notifications', authenticateToken, createServiceProxy('notifications', p => p.replace(/^\/api/, '')));

// Fraud Service routes
app.use('/api/fraud', authenticateToken, createServiceProxy('fraud', p => p.replace(/^\/api/, '')));

// Event Bus routes (SSE Stream & History)
app.use('/api/events/stream', createServiceProxy('events', () => '/events/stream'));
app.use('/api/events', authenticateToken, createServiceProxy('events', p => p.replace(/^\/api/, '')));

// -------------------------------------------------------------------------
// SYSTEM TOPOLOGY & CLUSTER HEALTH (For Ops / Architect Dashboard)
// -------------------------------------------------------------------------
app.get('/api/system/topology', async (req, res) => {
  const results = {};

  const checkService = (key, service) => {
    return new Promise((resolve) => {
      const start = Date.now();
      const targetUrl = new URL(service.url);
      const req = http.request({
        hostname: targetUrl.hostname,
        port: targetUrl.port,
        path: '/health',
        method: 'GET',
        timeout: 2000
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          const latency = Date.now() - start;
          try {
            const parsed = JSON.parse(body || '{}');
            resolve({
              name: service.name,
              port: service.port,
              status: res.statusCode === 200 ? 'ONLINE' : 'DEGRADED',
              latencyMs: latency,
              circuitState: service.state,
              details: parsed
            });
          } catch (e) {
            resolve({
              name: service.name,
              port: service.port,
              status: 'DEGRADED',
              latencyMs: latency,
              circuitState: service.state
            });
          }
        });
      });

      req.on('error', (err) => {
        resolve({
          name: service.name,
          port: service.port,
          status: 'OFFLINE',
          latencyMs: null,
          circuitState: service.state,
          error: err.message
        });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({
          name: service.name,
          port: service.port,
          status: 'TIMEOUT',
          latencyMs: null,
          circuitState: service.state
        });
      });

      req.end();
    });
  };

  const checks = Object.keys(SERVICES).map(async (key) => {
    results[key] = await checkService(key, SERVICES[key]);
  });

  await Promise.all(checks);

  res.json({
    gateway: {
      name: 'API Gateway',
      port: PORT,
      status: 'ONLINE',
      uptime: process.uptime()
    },
    cluster: results,
    timestamp: new Date().toISOString()
  });
});

// Serve static frontend UI assets
app.use(express.static(path.join(__dirname, '..', '..', 'public')));

// Fallback to index.html for SPA client-side routing
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: `API route ${req.path} not found` });
  }
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'index.html'));
});

const server = app.listen(PORT, () => {
  logger.info(`=======================================================`);
  logger.info(`  APEX INTERNET BANKING - API GATEWAY ACTIVE`);
  logger.info(`  Public URL: http://localhost:${PORT}`);
  logger.info(`  System Topology: http://localhost:${PORT}/api/system/topology`);
  logger.info(`=======================================================`);
});

module.exports = { app, server };
