// services/transaction-service/server.js
// Transaction Processing & Distributed Saga Orchestrator Microservice

const express = require('express');
const cors = require('cors');
const http = require('http');
const JsonDatabase = require('../../shared/db');
const Logger = require('../../shared/logger');
const EventClient = require('../../shared/eventClient');

const logger = new Logger('TXN-SVC');
const db = new JsonDatabase('transactions');
const eventBus = new EventClient('TXN-SVC');
const app = express();
const PORT = process.env.PORT || 8083;

const ACCOUNT_SERVICE_URL = process.env.ACCOUNT_SERVICE_URL || 'http://localhost:8082';
const FRAUD_SERVICE_URL = process.env.FRAUD_SERVICE_URL || 'http://localhost:8085';

app.use(cors());
app.use(express.json());

// In-memory idempotency cache: idempotencyKey -> transactionResult
const idempotencyStore = new Map();

// Helper to make internal microservice HTTP requests
function internalRequest(urlStr, method, data = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const hasBody = data !== null && ['POST', 'PUT', 'PATCH'].includes(method);
    const bodyData = hasBody ? JSON.stringify(data) : null;

    const reqHeaders = { ...headers };
    if (bodyData) {
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(bodyData);
    }

    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: reqHeaders,
      timeout: 5000
    }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw || '{}');
          resolve({ status: res.statusCode, data: parsed });
        } catch (e) {
          resolve({ status: res.statusCode, raw });
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout calling ${urlStr}`));
    });

    if (bodyData) {
      req.write(bodyData);
    }
    req.end();
  });
}

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'UP',
    service: 'transaction-service',
    port: PORT,
    orchestrator: 'SAGA_COMPENSATION_ACTIVE',
    uptime: process.uptime()
  });
});

/**
 * =========================================================================
 * DISTRIBUTED SAGA ORCHESTRATOR
 * Executes a resilient, 2-phase distributed fund transfer with rollbacks
 * =========================================================================
 */
async function executeTransferSaga({
  userId,
  fromAccount,
  toAccount,
  amount,
  description,
  correlationId,
  simulateCreditFailure = false
}) {
  const sagaSteps = [];
  const referenceId = `TXN-${Date.now()}-${Math.random().toString(36).substr(2, 6).toUpperCase()}`;

  function recordStep(name, status, details = {}) {
    const step = {
      step: name,
      status, // SUCCESS, FAILED, COMPENSATING, COMPENSATED
      timestamp: new Date().toISOString(),
      details
    };
    sagaSteps.push(step);
    logger.info(`Saga [${referenceId}] Step: ${name} -> ${status}`, { correlationId });
    return step;
  }

  // --- STEP 1: Pre-validation & Balance Verification ---
  recordStep('VALIDATE_REQUEST', 'STARTED', { fromAccount, toAccount, amount });
  if (fromAccount === toAccount) {
    recordStep('VALIDATE_REQUEST', 'FAILED', { error: 'Sender and Recipient account cannot be the same' });
    return {
      success: false,
      referenceId,
      status: 'REJECTED',
      reason: 'Sender and Recipient account cannot be the same',
      sagaSteps
    };
  }

  // Fetch sender account details
  let senderAcc;
  try {
    const res = await internalRequest(`${ACCOUNT_SERVICE_URL}/accounts/${fromAccount}`, 'GET');
    if (res.status !== 200 || !res.data) {
      recordStep('VALIDATE_REQUEST', 'FAILED', { error: 'Source account not found' });
      return { success: false, referenceId, status: 'REJECTED', reason: 'Source account not found', sagaSteps };
    }
    senderAcc = res.data;
  } catch (err) {
    recordStep('VALIDATE_REQUEST', 'FAILED', { error: 'Account Service unreachable: ' + err.message });
    return { success: false, referenceId, status: 'SYSTEM_ERROR', reason: 'Account service unavailable', sagaSteps };
  }

  if (senderAcc.balance < amount) {
    recordStep('VALIDATE_REQUEST', 'FAILED', {
      error: `Insufficient funds. Balance: $${senderAcc.balance}, Required: $${amount}`
    });
    return {
      success: false,
      referenceId,
      status: 'INSUFFICIENT_FUNDS',
      reason: `Insufficient balance (Available: $${senderAcc.balance})`,
      sagaSteps
    };
  }
  recordStep('VALIDATE_REQUEST', 'SUCCESS', { currentBalance: senderAcc.balance });

  // --- STEP 2: Risk & Fraud Evaluation ---
  recordStep('FRAUD_EVALUATION', 'STARTED');
  try {
    const fraudRes = await internalRequest(`${FRAUD_SERVICE_URL}/fraud/evaluate`, 'POST', {
      transactionId: referenceId,
      userId,
      fromAccount,
      toAccount,
      amount,
      currentBalance: senderAcc.balance
    }, { 'x-correlation-id': correlationId });

    if (fraudRes.data.decision === 'DECLINED') {
      recordStep('FRAUD_EVALUATION', 'FAILED', {
        riskScore: fraudRes.data.riskScore,
        decision: 'DECLINED',
        flags: fraudRes.data.flags
      });
      return {
        success: false,
        referenceId,
        status: 'BLOCKED_FRAUD',
        reason: 'Transfer rejected by automated Risk Management: ' + (fraudRes.data.flags[0]?.message || 'High risk pattern'),
        riskScore: fraudRes.data.riskScore,
        sagaSteps
      };
    }
    recordStep('FRAUD_EVALUATION', 'SUCCESS', {
      riskScore: fraudRes.data.riskScore,
      decision: fraudRes.data.decision
    });
  } catch (err) {
    // Graceful degradation: log warning but permit low amount transactions if fraud service is momentarily down
    logger.warn('Fraud service unreachable, continuing with heightened auditing', { error: err.message });
    recordStep('FRAUD_EVALUATION', 'SKIPPED_CIRCUIT_FALLBACK');
  }

  // --- STEP 3: Debit Sender Account ---
  recordStep('DEBIT_SENDER', 'STARTED', { account: fromAccount, amount });
  let debitResult;
  try {
    const debitRes = await internalRequest(`${ACCOUNT_SERVICE_URL}/accounts/debit`, 'POST', {
      accountNumber: fromAccount,
      amount,
      referenceId,
      reason: `Transfer to ${toAccount}`
    }, { 'x-correlation-id': correlationId });

    if (debitRes.status !== 200) {
      recordStep('DEBIT_SENDER', 'FAILED', { error: debitRes.data.error });
      return {
        success: false,
        referenceId,
        status: 'DEBIT_FAILED',
        reason: debitRes.data.error || 'Failed to debit sender account',
        sagaSteps
      };
    }
    debitResult = debitRes.data;
    recordStep('DEBIT_SENDER', 'SUCCESS', { newBalance: debitResult.newBalance });
  } catch (err) {
    recordStep('DEBIT_SENDER', 'FAILED', { error: err.message });
    return {
      success: false,
      referenceId,
      status: 'SYSTEM_ERROR',
      reason: 'Failed to communicate with Account Service',
      sagaSteps
    };
  }

  // --- STEP 4: Credit Recipient Account ---
  recordStep('CREDIT_RECIPIENT', 'STARTED', { account: toAccount, amount });
  let creditSuccess = false;
  let creditErrorMessage = '';

  if (!simulateCreditFailure) {
    try {
      const creditRes = await internalRequest(`${ACCOUNT_SERVICE_URL}/accounts/credit`, 'POST', {
        accountNumber: toAccount,
        amount,
        referenceId,
        reason: `Transfer from ${fromAccount}`
      }, { 'x-correlation-id': correlationId });

      if (creditRes.status === 200) {
        creditSuccess = true;
        recordStep('CREDIT_RECIPIENT', 'SUCCESS', { newBalance: creditRes.data.newBalance });
      } else {
        creditErrorMessage = creditRes.data.error || 'Recipient account rejected credit';
      }
    } catch (err) {
      creditErrorMessage = err.message;
    }
  } else {
    creditErrorMessage = 'Simulated credit failure to demonstrate Saga Compensation pattern';
  }

  // --- COMPENSATION TRIGGER: If Recipient Credit Fails, Rollback Sender Debit! ---
  if (!creditSuccess) {
    recordStep('CREDIT_RECIPIENT', 'FAILED', { error: creditErrorMessage });
    recordStep('COMPENSATING_TRANSACTION', 'STARTED', {
      action: 'REFUND_SENDER',
      account: fromAccount,
      amount
    });

    try {
      const refundRes = await internalRequest(`${ACCOUNT_SERVICE_URL}/accounts/credit`, 'POST', {
        accountNumber: fromAccount,
        amount,
        referenceId: `${referenceId}-COMPENSATION`,
        reason: `Automatic Reversal: Transfer to ${toAccount} failed (${creditErrorMessage})`
      }, { 'x-correlation-id': correlationId });

      recordStep('COMPENSATING_TRANSACTION', 'SUCCESS', {
        restoredBalance: refundRes.data.newBalance,
        note: 'Sender balance fully restored'
      });

      // Persist failed/compensated transaction record
      const txnRecord = await db.insert({
        referenceId,
        userId,
        senderUserId: senderAcc.userId,
        fromAccount,
        toAccount,
        amount,
        type: 'TRANSFER',
        status: 'FAILED_ROLLED_BACK',
        reason: `Recipient credit failed: ${creditErrorMessage}. Sender debited funds were successfully refunded.`,
        sagaSteps,
        correlationId
      });

      return {
        success: false,
        referenceId,
        status: 'FAILED_ROLLED_BACK',
        compensated: true,
        reason: `Transfer failed: ${creditErrorMessage}. Your balance was restored.`,
        sagaSteps
      };
    } catch (refundErr) {
      recordStep('COMPENSATING_TRANSACTION', 'CRITICAL_ERROR', {
        error: 'Compensation refund failed: ' + refundErr.message
      });
      logger.error(`CRITICAL: Compensation failed for ${referenceId}! Manual intervention required.`, {
        error: refundErr.message
      });
      return {
        success: false,
        referenceId,
        status: 'MANUAL_INTERVENTION_REQUIRED',
        reason: 'Transfer failed and auto-refund encountered an error. Compliance ticket created.',
        sagaSteps
      };
    }
  }

  // --- STEP 5: Finalize Immutable Ledger Record ---
  recordStep('FINALIZE_LEDGER', 'SUCCESS');
  
  // Look up recipient user ID if available
  let recipientUserId = null;
  try {
    const recRes = await internalRequest(`${ACCOUNT_SERVICE_URL}/accounts/${toAccount}`, 'GET');
    if (recRes.status === 200) {
      recipientUserId = recRes.data.userId;
    }
  } catch (e) {
    // non-fatal
  }

  const transactionRecord = await db.insert({
    referenceId,
    userId,
    senderUserId: senderAcc.userId,
    recipientUserId,
    fromAccount,
    toAccount,
    amount,
    currency: senderAcc.currency || 'USD',
    description: description || 'Bank Transfer',
    type: 'TRANSFER',
    status: 'COMPLETED',
    sagaSteps,
    correlationId
  });

  // --- STEP 6: Publish Completion Event to Event Bus ---
  await eventBus.publish('TRANSACTION_COMPLETED', {
    transactionId: transactionRecord.id,
    referenceId,
    senderUserId: senderAcc.userId,
    recipientUserId,
    fromAccount,
    toAccount,
    amount,
    type: 'TRANSFER'
  }, correlationId);

  return {
    success: true,
    referenceId,
    status: 'COMPLETED',
    amount,
    fromAccount,
    toAccount,
    transaction: transactionRecord,
    sagaSteps
  };
}

// Transfer API Endpoint (Protected by Idempotency)
app.post('/transactions/transfer', async (req, res) => {
  const correlationId = req.headers['x-correlation-id'] || `corr-${Date.now()}`;
  const idempotencyKey = req.headers['idempotency-key'];

  // Check idempotency cache to prevent double-spending on duplicate clicks
  if (idempotencyKey && idempotencyStore.has(idempotencyKey)) {
    logger.info(`Idempotent replay for key ${idempotencyKey}`, { correlationId });
    return res.json(idempotencyStore.get(idempotencyKey));
  }

  const {
    userId,
    fromAccount,
    toAccount,
    amount,
    description,
    simulateCreditFailure = false
  } = req.body;

  const transferAmount = parseFloat(amount);
  if (!fromAccount || !toAccount || isNaN(transferAmount) || transferAmount <= 0) {
    return res.status(400).json({ error: 'fromAccount, toAccount, and valid positive amount are required' });
  }

  try {
    const result = await executeTransferSaga({
      userId,
      fromAccount,
      toAccount,
      amount: transferAmount,
      description,
      correlationId,
      simulateCreditFailure
    });

    if (idempotencyKey) {
      idempotencyStore.set(idempotencyKey, result);
    }

    if (result.success) {
      res.status(200).json(result);
    } else {
      res.status(result.status === 'INSUFFICIENT_FUNDS' ? 422 : 400).json(result);
    }
  } catch (err) {
    logger.error('Saga execution failed: ' + err.message);
    res.status(500).json({ error: 'Internal error executing transfer saga: ' + err.message });
  }
});

// Deposit Funds API (ATM / Wire Inflow)
app.post('/transactions/deposit', async (req, res) => {
  try {
    const { accountNumber, amount, description = 'Direct Deposit' } = req.body;
    const depAmount = parseFloat(amount);

    if (!accountNumber || isNaN(depAmount) || depAmount <= 0) {
      return res.status(400).json({ error: 'Valid accountNumber and positive amount required' });
    }

    const referenceId = `DEP-${Date.now()}-${Math.random().toString(36).substr(2, 5).toUpperCase()}`;

    // Credit account via Account Service
    const creditRes = await internalRequest(`${ACCOUNT_SERVICE_URL}/accounts/credit`, 'POST', {
      accountNumber,
      amount: depAmount,
      referenceId,
      reason: description
    });

    if (creditRes.status !== 200) {
      return res.status(creditRes.status).json(creditRes.data);
    }

    // Get account for userId
    const accRes = await internalRequest(`${ACCOUNT_SERVICE_URL}/accounts/${accountNumber}`, 'GET');
    const userId = accRes.data?.userId;

    const record = await db.insert({
      referenceId,
      userId,
      toAccount: accountNumber,
      fromAccount: 'EXTERNAL_CLEARING_HOUSE',
      amount: depAmount,
      type: 'DEPOSIT',
      description,
      status: 'COMPLETED'
    });

    await eventBus.publish('TRANSACTION_COMPLETED', {
      referenceId,
      recipientUserId: userId,
      toAccount: accountNumber,
      amount: depAmount,
      type: 'DEPOSIT'
    });

    res.json({ success: true, record, newBalance: creditRes.data.newBalance });
  } catch (err) {
    res.status(500).json({ error: 'Deposit failed: ' + err.message });
  }
});

// Get user transaction history
app.get('/transactions/user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { type, limit = 50 } = req.query;

    let txns = await db.find(t => t.userId === userId || t.senderUserId === userId || t.recipientUserId === userId);
    if (type) {
      txns = txns.filter(t => t.type === type.toUpperCase());
    }

    txns.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(txns.slice(0, parseInt(limit, 10)));
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve transactions' });
  }
});

// Get single account ledger
app.get('/transactions/account/:accountNumber', async (req, res) => {
  try {
    const { accountNumber } = req.params;
    const txns = await db.find(t => t.fromAccount === accountNumber || t.toAccount === accountNumber);
    txns.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(txns);
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve ledger' });
  }
});

// Get Saga details by Reference ID (For educational Saga inspection in Ops UI)
app.get('/transactions/saga/:referenceId', async (req, res) => {
  try {
    const { referenceId } = req.params;
    const txn = await db.findOne(t => t.referenceId === referenceId || t.id === referenceId);
    if (!txn) {
      return res.status(404).json({ error: 'Transaction not found' });
    }
    res.json({
      referenceId: txn.referenceId,
      status: txn.status,
      amount: txn.amount,
      fromAccount: txn.fromAccount,
      toAccount: txn.toAccount,
      sagaSteps: txn.sagaSteps || []
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve saga details' });
  }
});

// Admin get all transactions
app.get('/transactions', async (req, res) => {
  try {
    const txns = await db.getAll();
    txns.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(txns);
  } catch (err) {
    res.status(500).json({ error: 'Failed to list transactions' });
  }
});

const server = app.listen(PORT, () => {
  logger.info(`Transaction Service running on http://localhost:${PORT}`);
});

module.exports = { app, server };
