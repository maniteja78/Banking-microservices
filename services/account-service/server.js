// services/account-service/server.js
// Bank Account & Card Management Microservice

const express = require('express');
const cors = require('cors');
const JsonDatabase = require('../../shared/db');
const Logger = require('../../shared/logger');
const EventClient = require('../../shared/eventClient');

const logger = new Logger('ACCOUNT-SVC');
const db = new JsonDatabase('accounts');
const eventBus = new EventClient('ACCOUNT-SVC');
const app = express();
const PORT = process.env.PORT || 8082;

app.use(cors());
app.use(express.json());

// Correlation ID middleware
app.use((req, res, next) => {
  req.correlationId = req.headers['x-correlation-id'] || `corr-${Date.now()}`;
  res.setHeader('x-correlation-id', req.correlationId);
  next();
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'UP',
    service: 'account-service',
    port: PORT,
    uptime: process.uptime()
  });
});

// Helper to generate account number
function generateAccountNumber() {
  return '40' + Math.floor(10000000 + Math.random() * 90000000).toString();
}

// Helper to generate realistic card
function generateCard(accountNumber, cardholderName) {
  return {
    id: `card-${Math.random().toString(36).substr(2, 9)}`,
    accountNumber,
    cardNumber: '4532 ' + Math.floor(1000 + Math.random() * 9000) + ' ' + Math.floor(1000 + Math.random() * 9000) + ' ' + Math.floor(1000 + Math.random() * 9000),
    cardholderName: cardholderName || 'VALUED CUSTOMER',
    expiry: '09/29',
    cvv: Math.floor(100 + Math.random() * 900).toString(),
    type: 'VISA_PLATINUM_DEBIT',
    status: 'ACTIVE', // ACTIVE, FROZEN
    dailyLimit: 2500,
    onlinePurchases: true,
    internationalTransactions: false
  };
}

// Get all accounts for a specific user
app.get('/accounts/user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const accounts = await db.find(acc => acc.userId === userId);
    res.json(accounts);
  } catch (err) {
    logger.error('Failed to get user accounts: ' + err.message);
    res.status(500).json({ error: 'Failed to retrieve accounts' });
  }
});

// Get single account details by ID or Account Number
app.get('/accounts/:identifier', async (req, res) => {
  try {
    const { identifier } = req.params;
    const account = await db.findOne(acc => acc.id === identifier || acc.accountNumber === identifier);
    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }
    res.json(account);
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve account' });
  }
});

// Open new account
app.post('/accounts', async (req, res) => {
  try {
    const { userId, type = 'CHECKING', currency = 'USD', initialBalance = 0, holderName } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const accountNumber = generateAccountNumber();
    const card = type === 'CHECKING' ? generateCard(accountNumber, holderName) : null;

    const newAccount = await db.insert({
      userId,
      accountNumber,
      iban: `US64APEX${accountNumber}`,
      type, // CHECKING, SAVINGS, INVESTMENT
      currency,
      balance: parseFloat(initialBalance) || 0.0,
      holdBalance: 0.0,
      status: 'ACTIVE', // ACTIVE, FROZEN, CLOSED
      cards: card ? [card] : []
    });

    await eventBus.publish('ACCOUNT_CREATED', {
      accountId: newAccount.id,
      userId,
      accountNumber: newAccount.accountNumber,
      type: newAccount.type,
      balance: newAccount.balance
    }, req.correlationId);

    logger.info(`Opened new ${type} account ${accountNumber} for user ${userId}`, { correlationId: req.correlationId });
    res.status(201).json(newAccount);
  } catch (err) {
    logger.error('Failed to open account: ' + err.message);
    res.status(500).json({ error: 'Failed to create account' });
  }
});

// Atomic Debit (Called by Transaction Service / Saga)
app.post('/accounts/debit', async (req, res) => {
  try {
    const { accountNumber, amount, referenceId, reason } = req.body;
    const debitAmount = parseFloat(amount);

    if (!accountNumber || isNaN(debitAmount) || debitAmount <= 0) {
      return res.status(400).json({ error: 'Valid accountNumber and positive amount required' });
    }

    const account = await db.findOne(acc => acc.accountNumber === accountNumber || acc.id === accountNumber);
    if (!account) {
      return res.status(404).json({ error: `Account ${accountNumber} not found` });
    }

    if (account.status !== 'ACTIVE') {
      return res.status(403).json({ error: `Account ${accountNumber} is ${account.status}. Cannot process debit.` });
    }

    if (account.balance < debitAmount) {
      return res.status(422).json({
        error: 'Insufficient funds',
        currentBalance: account.balance,
        requestedAmount: debitAmount
      });
    }

    // Atomic update to avoid race conditions
    const updatedAccount = await db.atomicUpdate(account.id, (acc) => {
      if (acc.balance < debitAmount) {
        throw new Error('Insufficient funds');
      }
      return {
        ...acc,
        balance: Math.round((acc.balance - debitAmount) * 100) / 100
      };
    });

    logger.info(`Debited $${debitAmount} from ${accountNumber}. New balance: $${updatedAccount.balance}`, {
      correlationId: req.correlationId,
      referenceId
    });

    res.json({
      success: true,
      accountNumber: updatedAccount.accountNumber,
      previousBalance: account.balance,
      newBalance: updatedAccount.balance,
      debitAmount,
      referenceId
    });
  } catch (err) {
    logger.error('Debit operation failed: ' + err.message);
    res.status(400).json({ error: err.message });
  }
});

// Atomic Credit (Called by Transaction Service / Saga or Reversal)
app.post('/accounts/credit', async (req, res) => {
  try {
    const { accountNumber, amount, referenceId, reason } = req.body;
    const creditAmount = parseFloat(amount);

    if (!accountNumber || isNaN(creditAmount) || creditAmount <= 0) {
      return res.status(400).json({ error: 'Valid accountNumber and positive amount required' });
    }

    const account = await db.findOne(acc => acc.accountNumber === accountNumber || acc.id === accountNumber);
    if (!account) {
      return res.status(404).json({ error: `Recipient account ${accountNumber} not found` });
    }

    if (account.status !== 'ACTIVE') {
      return res.status(403).json({ error: `Recipient account ${accountNumber} is ${account.status}` });
    }

    const updatedAccount = await db.atomicUpdate(account.id, (acc) => {
      return {
        ...acc,
        balance: Math.round((acc.balance + creditAmount) * 100) / 100
      };
    });

    logger.info(`Credited $${creditAmount} to ${accountNumber}. New balance: $${updatedAccount.balance}`, {
      correlationId: req.correlationId,
      referenceId
    });

    res.json({
      success: true,
      accountNumber: updatedAccount.accountNumber,
      previousBalance: account.balance,
      newBalance: updatedAccount.balance,
      creditAmount,
      referenceId
    });
  } catch (err) {
    logger.error('Credit operation failed: ' + err.message);
    res.status(400).json({ error: err.message });
  }
});

// Toggle Account Status (Freeze / Unfreeze)
app.post('/accounts/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body; // ACTIVE, FROZEN
    if (!['ACTIVE', 'FROZEN'].includes(status)) {
      return res.status(400).json({ error: 'Status must be ACTIVE or FROZEN' });
    }

    const updated = await db.update(id, { status });
    if (!updated) {
      return res.status(404).json({ error: 'Account not found' });
    }

    await eventBus.publish('ACCOUNT_STATUS_CHANGED', {
      accountId: id,
      accountNumber: updated.accountNumber,
      status
    }, req.correlationId);

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update account status' });
  }
});

// Toggle Card Freeze Status
app.post('/cards/:cardId/status', async (req, res) => {
  try {
    const { cardId } = req.params;
    const { status } = req.body; // ACTIVE, FROZEN

    const accounts = await db.getAll();
    let targetAccount = null;
    let targetCard = null;

    for (const acc of accounts) {
      if (acc.cards) {
        const c = acc.cards.find(card => card.id === cardId);
        if (c) {
          targetAccount = acc;
          targetCard = c;
          break;
        }
      }
    }

    if (!targetAccount || !targetCard) {
      return res.status(404).json({ error: 'Card not found' });
    }

    targetCard.status = status;
    const updatedCards = targetAccount.cards.map(c => c.id === cardId ? { ...c, status } : c);
    await db.update(targetAccount.id, { cards: updatedCards });

    logger.info(`Card ${cardId} status set to ${status}`, { correlationId: req.correlationId });

    res.json({ success: true, cardId, status });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update card status' });
  }
});

// Toggle Card Limits & Settings
app.post('/cards/:cardId/settings', async (req, res) => {
  try {
    const { cardId } = req.params;
    const { dailyLimit, onlinePurchases, internationalTransactions } = req.body;

    const accounts = await db.getAll();
    let targetAccount = null;

    for (const acc of accounts) {
      if (acc.cards?.some(c => c.id === cardId)) {
        targetAccount = acc;
        break;
      }
    }

    if (!targetAccount) return res.status(404).json({ error: 'Card not found' });

    const updatedCards = targetAccount.cards.map(c => {
      if (c.id === cardId) {
        return {
          ...c,
          dailyLimit: dailyLimit !== undefined ? Number(dailyLimit) : c.dailyLimit,
          onlinePurchases: onlinePurchases !== undefined ? Boolean(onlinePurchases) : c.onlinePurchases,
          internationalTransactions: internationalTransactions !== undefined ? Boolean(internationalTransactions) : c.internationalTransactions
        };
      }
      return c;
    });

    await db.update(targetAccount.id, { cards: updatedCards });
    res.json({ success: true, cards: updatedCards });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update card settings' });
  }
});

// Admin list all accounts
app.get('/accounts', async (req, res) => {
  try {
    const accounts = await db.getAll();
    res.json(accounts);
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve accounts' });
  }
});

// Auto-provision default accounts when USER_REGISTERED event is received
eventBus.subscribe('USER_REGISTERED', async (event) => {
  try {
    const { userId, fullName } = event.payload;
    logger.info(`Auto-provisioning accounts for new user ${userId}`);

    // Create Checking Account with $5,000 welcome credit
    const checkingAccNum = generateAccountNumber();
    await db.insert({
      userId,
      accountNumber: checkingAccNum,
      iban: `US64APEX${checkingAccNum}`,
      type: 'CHECKING',
      currency: 'USD',
      balance: 5000.00,
      holdBalance: 0.0,
      status: 'ACTIVE',
      cards: [generateCard(checkingAccNum, fullName)]
    });

    // Create Savings Account with $12,500
    const savingsAccNum = generateAccountNumber();
    await db.insert({
      userId,
      accountNumber: savingsAccNum,
      iban: `US64APEX${savingsAccNum}`,
      type: 'SAVINGS',
      currency: 'USD',
      balance: 12500.00,
      holdBalance: 0.0,
      status: 'ACTIVE',
      cards: []
    });

    logger.info(`Accounts created for ${fullName}`);
  } catch (err) {
    logger.error('Failed to auto-provision accounts: ' + err.message);
  }
});

const server = app.listen(PORT, () => {
  logger.info(`Account Service running on http://localhost:${PORT}`);
});

module.exports = { app, server };
