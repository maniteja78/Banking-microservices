// services/notification-service/server.js
// Real-time Customer Alerts & Multi-Channel Notification Microservice

const express = require('express');
const cors = require('cors');
const JsonDatabase = require('../../shared/db');
const Logger = require('../../shared/logger');
const EventClient = require('../../shared/eventClient');

const logger = new Logger('NOTIF-SVC');
const db = new JsonDatabase('notifications');
const eventBus = new EventClient('NOTIF-SVC');
const app = express();
const PORT = process.env.PORT || 8084;

app.use(cors());
app.use(express.json());

// Map of active SSE client streams: userId -> Set of res objects
const userStreams = new Map();

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'UP',
    service: 'notification-service',
    port: PORT,
    activeSubscribers: Array.from(userStreams.values()).reduce((sum, s) => sum + s.size, 0),
    uptime: process.uptime()
  });
});

// Real-Time SSE Stream for web clients
app.get('/notifications/stream/:userId', (req, res) => {
  const { userId } = req.params;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  if (!userStreams.has(userId)) {
    userStreams.set(userId, new Set());
  }
  userStreams.get(userId).add(res);

  logger.info(`Customer ${userId} connected to real-time notification stream`);

  // Initial handshake
  res.write(`data: ${JSON.stringify({ type: 'CONNECTED', message: 'Real-time alert stream active' })}\n\n`);

  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    if (userStreams.has(userId)) {
      userStreams.get(userId).delete(res);
      if (userStreams.get(userId).size === 0) {
        userStreams.delete(userId);
      }
    }
    logger.info(`Customer ${userId} disconnected from notifications`);
  });
});

// Helper to push notification to database and active client streams
async function dispatchNotification({ userId, title, message, type = 'INFO', category = 'GENERAL', data = {} }) {
  const notif = await db.insert({
    userId,
    title,
    message,
    type, // INFO, SUCCESS, WARNING, DANGER
    category, // TRANSACTION, SECURITY, ACCOUNT, SYSTEM
    isRead: false,
    data,
    channel: 'IN_APP_AND_SMS_SIMULATION',
    deliveredAt: new Date().toISOString()
  });

  logger.info(`Notification queued for user ${userId}: "${title}"`);

  // Push to connected UI streams
  const streams = userStreams.get(userId);
  if (streams && streams.size > 0) {
    const payload = `data: ${JSON.stringify(notif)}\n\n`;
    for (const client of streams) {
      client.write(payload);
    }
  }

  return notif;
}

// Fetch user notifications
app.get('/notifications/user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const notifs = await db.find(n => n.userId === userId);
    notifs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const unreadCount = notifs.filter(n => !n.isRead).length;

    res.json({
      total: notifs.length,
      unreadCount,
      notifications: notifs
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve notifications' });
  }
});

// Mark notification as read
app.post('/notifications/:id/read', async (req, res) => {
  try {
    const updated = await db.update(req.params.id, { isRead: true });
    if (!updated) return res.status(404).json({ error: 'Notification not found' });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update notification' });
  }
});

// Mark all as read
app.post('/notifications/read-all/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const notifs = await db.find(n => n.userId === userId && !n.isRead);
    for (const n of notifs) {
      await db.update(n.id, { isRead: true });
    }
    res.json({ success: true, count: notifs.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to mark notifications read' });
  }
});

// Subscribe to Domain Events from Event Bus
eventBus.subscribe('TRANSACTION_COMPLETED', async (event) => {
  const { senderUserId, recipientUserId, amount, type, referenceId, toAccount, fromAccount } = event.payload;

  if (senderUserId) {
    await dispatchNotification({
      userId: senderUserId,
      title: 'Transfer Completed',
      message: `Successfully transferred $${Number(amount).toLocaleString()} from ${fromAccount} to ${toAccount}.`,
      type: 'SUCCESS',
      category: 'TRANSACTION',
      data: { referenceId, amount }
    });
  }

  if (recipientUserId && recipientUserId !== senderUserId) {
    await dispatchNotification({
      userId: recipientUserId,
      title: 'Funds Received',
      message: `You received $${Number(amount).toLocaleString()} into your account ${toAccount}.`,
      type: 'SUCCESS',
      category: 'TRANSACTION',
      data: { referenceId, amount }
    });
  }
});

eventBus.subscribe('FRAUD_ALERT_RAISED', async (event) => {
  const { userId, amount, riskScore, decision, flags } = event.payload;
  await dispatchNotification({
    userId,
    title: '⚠️ Security Notice: Transaction Flagged',
    message: `A transfer of $${Number(amount).toLocaleString()} was paused for verification (Risk Score: ${riskScore}). Reason: ${flags?.[0]?.message || 'Automated security trigger'}.`,
    type: 'WARNING',
    category: 'SECURITY',
    data: { riskScore, decision }
  });
});

eventBus.subscribe('ACCOUNT_CREATED', async (event) => {
  const { userId, accountNumber, type } = event.payload;
  await dispatchNotification({
    userId,
    title: 'Account Activated',
    message: `Your new Apex ${type} Account (${accountNumber}) is now open and active.`,
    type: 'INFO',
    category: 'ACCOUNT',
    data: { accountNumber, type }
  });
});

const server = app.listen(PORT, () => {
  logger.info(`Notification Service running on http://localhost:${PORT}`);
});

module.exports = { app, server };
