// services/fraud-service/server.js
// Real-time Fraud Detection & Risk Analytics Microservice

const express = require('express');
const cors = require('cors');
const JsonDatabase = require('../../shared/db');
const Logger = require('../../shared/logger');
const EventClient = require('../../shared/eventClient');

const logger = new Logger('FRAUD-SVC');
const db = new JsonDatabase('fraud');
const eventBus = new EventClient('FRAUD-SVC');
const app = express();
const PORT = process.env.PORT || 8085;

app.use(cors());
app.use(express.json());

// In-memory velocity tracking: userId -> Array of timestamps
const userVelocity = new Map();

// Configurable fraud thresholds
const RULES = {
  HIGH_VALUE_THRESHOLD: 10000,
  CRITICAL_VALUE_THRESHOLD: 50000,
  VELOCITY_WINDOW_SECONDS: 60,
  VELOCITY_MAX_TXNS: 3,
  MAX_BALANCE_DRAIN_PERCENT: 90
};

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'UP',
    service: 'fraud-service',
    port: PORT,
    rules: RULES,
    uptime: process.uptime()
  });
});

// Evaluate Transaction Risk (Synchronous evaluation called by Saga Orchestrator)
app.post('/fraud/evaluate', async (req, res) => {
  try {
    const {
      transactionId,
      userId,
      fromAccount,
      toAccount,
      amount,
      currentBalance,
      recipientBank
    } = req.body;

    const transferAmount = parseFloat(amount);
    let riskScore = 5; // Base low risk
    const flags = [];

    // Rule 1: High Value Threshold
    if (transferAmount >= RULES.CRITICAL_VALUE_THRESHOLD) {
      riskScore += 90;
      flags.push({
        rule: 'CRITICAL_AMOUNT_LIMIT',
        message: `Transfer amount ($${transferAmount.toLocaleString()}) exceeds automated threshold ($${RULES.CRITICAL_VALUE_THRESHOLD.toLocaleString()})`
      });
    } else if (transferAmount >= RULES.HIGH_VALUE_THRESHOLD) {
      riskScore += 45;
      flags.push({
        rule: 'HIGH_VALUE_ANOMALY',
        message: `High value transaction ($${transferAmount.toLocaleString()}) flagged for AML review`
      });
    }

    // Rule 2: Velocity Check
    const now = Date.now();
    const timestamps = userVelocity.get(userId) || [];
    const recent = timestamps.filter(t => now - t < RULES.VELOCITY_WINDOW_SECONDS * 1000);
    recent.push(now);
    userVelocity.set(userId, recent);

    if (recent.length > RULES.VELOCITY_MAX_TXNS) {
      riskScore += 40;
      flags.push({
        rule: 'HIGH_VELOCITY',
        message: `${recent.length} transactions initiated within ${RULES.VELOCITY_WINDOW_SECONDS} seconds`
      });
    }

    // Rule 3: Balance Drain
    if (currentBalance && currentBalance > 0) {
      const drainPercent = (transferAmount / currentBalance) * 100;
      if (drainPercent >= RULES.MAX_BALANCE_DRAIN_PERCENT && transferAmount > 2000) {
        riskScore += 25;
        flags.push({
          rule: 'RAPID_BALANCE_DRAIN',
          message: `Attempting to transfer ${drainPercent.toFixed(1)}% of total account balance`
        });
      }
    }

    // Rule 4: Suspicious recipient simulation
    if (toAccount === '4099999999' || toAccount === 'FRAUD_TEST') {
      riskScore = 100;
      flags.push({
        rule: 'BLACKLISTED_RECIPIENT',
        message: 'Recipient account is on regulatory watch list'
      });
    }

    // Determine Decision
    let decision = 'APPROVED';
    if (riskScore >= 80) {
      decision = 'DECLINED';
    } else if (riskScore >= 50) {
      decision = 'REVIEW_REQUIRED';
    }

    // Record evaluation in Fraud database
    const fraudRecord = await db.insert({
      transactionId: transactionId || `eval-${Date.now()}`,
      userId,
      fromAccount,
      toAccount,
      amount: transferAmount,
      riskScore,
      decision,
      flags,
      status: decision === 'APPROVED' ? 'RESOLVED_AUTO' : 'PENDING_REVIEW'
    });

    if (decision !== 'APPROVED') {
      logger.warn(`High Risk detected for user ${userId}: Score ${riskScore}, Decision ${decision}`, {
        flags: flags.map(f => f.rule)
      });

      await eventBus.publish('FRAUD_ALERT_RAISED', {
        fraudRecordId: fraudRecord.id,
        userId,
        amount: transferAmount,
        riskScore,
        decision,
        flags
      });
    } else {
      logger.info(`Transaction evaluated clean: Score ${riskScore} for $${transferAmount}`);
    }

    res.json({
      evaluationId: fraudRecord.id,
      riskScore,
      decision,
      flags,
      passed: decision === 'APPROVED'
    });
  } catch (err) {
    logger.error('Fraud evaluation error: ' + err.message);
    res.status(500).json({ error: 'Fraud evaluation error' });
  }
});

// Get all fraud alerts for Bank Auditor & Ops Dashboard
app.get('/fraud/alerts', async (req, res) => {
  try {
    const alerts = await db.getAll();
    res.json(alerts.reverse());
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve fraud alerts' });
  }
});

// Resolve fraud alert (Admin approve/reject)
app.post('/fraud/alerts/:id/resolve', async (req, res) => {
  try {
    const { id } = req.params;
    const { resolution, reviewerNotes } = req.body; // APPROVED_BY_ADMIN, REJECTED_BY_ADMIN

    const updated = await db.update(id, {
      status: resolution,
      reviewerNotes: reviewerNotes || 'Reviewed by Compliance Officer',
      resolvedAt: new Date().toISOString()
    });

    if (!updated) {
      return res.status(404).json({ error: 'Alert not found' });
    }

    logger.info(`Fraud alert ${id} resolved as ${resolution}`);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: 'Failed to resolve alert' });
  }
});

// View rules
app.get('/fraud/rules', (req, res) => {
  res.json(RULES);
});

const server = app.listen(PORT, () => {
  logger.info(`Fraud & Risk Service running on http://localhost:${PORT}`);
});

module.exports = { app, server };
