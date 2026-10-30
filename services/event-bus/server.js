// services/event-bus/server.js
// Centralized Event Broker / Pub-Sub Service for Microservices

const express = require('express');
const cors = require('cors');
const Logger = require('../../shared/logger');

const logger = new Logger('EVENT-BUS');
const app = express();
const PORT = process.env.PORT || 8086;

app.use(cors());
app.use(express.json());

// In-memory event stream history (bounded ring buffer)
const MAX_HISTORY = 200;
const eventHistory = [];
const sseClients = new Set();
let totalEventsCounter = 0;

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'UP',
    service: 'event-bus',
    port: PORT,
    activeSubscribers: sseClients.size,
    totalEvents: totalEventsCounter,
    uptime: process.uptime()
  });
});

// Publish an event
app.post('/publish', (req, res) => {
  const { topic, source, payload, correlationId } = req.body;

  if (!topic) {
    return res.status(400).json({ error: 'Topic is required' });
  }

  const event = {
    id: `evt-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
    topic,
    source: source || 'UNKNOWN',
    payload: payload || {},
    correlationId: correlationId || `corr-${Date.now()}`,
    timestamp: new Date().toISOString()
  };

  totalEventsCounter++;
  eventHistory.unshift(event);
  if (eventHistory.length > MAX_HISTORY) {
    eventHistory.pop();
  }

  logger.event(`Published [${topic}] from [${event.source}]`, {
    eventId: event.id,
    correlationId: event.correlationId
  });

  // Broadcast to all active SSE subscribers
  const eventDataString = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) {
    client.write(eventDataString);
  }

  res.status(202).json({
    acknowledged: true,
    eventId: event.id,
    subscribersNotified: sseClients.size
  });
});

// SSE Stream for microservices and Ops Dashboard
app.get('/events/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  sseClients.add(res);
  logger.info(`New subscriber connected (Total subscribers: ${sseClients.size})`);

  // Send initial connected ping
  res.write(`data: ${JSON.stringify({ topic: 'SYSTEM_CONNECTED', timestamp: new Date().toISOString() })}\n\n`);

  // Periodic heartbeat
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
    logger.info(`Subscriber disconnected (Remaining: ${sseClients.size})`);
  });
});

// Query recent events history
app.get('/events/history', (req, res) => {
  const { topic, limit = 50 } = req.query;
  let results = eventHistory;
  if (topic) {
    results = results.filter(e => e.topic === topic);
  }
  res.json({
    total: results.length,
    events: results.slice(0, parseInt(limit, 10))
  });
});

const server = app.listen(PORT, () => {
  logger.info(`Event Bus running on http://localhost:${PORT}`);
});

module.exports = { app, server };
