// services/auth-service/server.js
// Authentication & User Identity Microservice

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const JsonDatabase = require('../../shared/db');
const Logger = require('../../shared/logger');
const EventClient = require('../../shared/eventClient');

const logger = new Logger('AUTH-SVC');
const db = new JsonDatabase('auth');
const eventBus = new EventClient('AUTH-SVC');
const app = express();
const PORT = process.env.PORT || 8081;
const JWT_SECRET = process.env.JWT_SECRET || 'apex-banking-jwt-super-secret-key-2026';

app.use(cors());
app.use(express.json());

// Correlation ID & Request logging middleware
app.use((req, res, next) => {
  req.correlationId = req.headers['x-correlation-id'] || `corr-${Date.now()}`;
  res.setHeader('x-correlation-id', req.correlationId);
  next();
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'UP',
    service: 'auth-service',
    port: PORT,
    uptime: process.uptime()
  });
});

// Register new customer
app.post('/register', async (req, res) => {
  try {
    const { email, password, fullName, phone, transactionPin = '1234' } = req.body;

    if (!email || !password || !fullName) {
      return res.status(400).json({ error: 'Email, password, and full name are required' });
    }

    const existing = await db.findOne(u => u.email.toLowerCase() === email.toLowerCase());
    if (existing) {
      return res.status(409).json({ error: 'User with this email already exists' });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);
    const pinHash = await bcrypt.hash(transactionPin, salt);

    const newUser = await db.insert({
      email: email.toLowerCase(),
      passwordHash,
      pinHash,
      fullName,
      phone: phone || '+1 (555) 019-2834',
      role: 'customer',
      kycStatus: 'VERIFIED',
      status: 'ACTIVE'
    });

    const token = jwt.sign(
      { userId: newUser.id, email: newUser.email, role: newUser.role, fullName: newUser.fullName },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    // Notify microservices ecosystem of new user
    await eventBus.publish('USER_REGISTERED', {
      userId: newUser.id,
      email: newUser.email,
      fullName: newUser.fullName
    }, req.correlationId);

    logger.info(`Customer registered: ${newUser.email}`, { correlationId: req.correlationId });

    res.status(201).json({
      message: 'User registered successfully',
      token,
      user: {
        id: newUser.id,
        email: newUser.email,
        fullName: newUser.fullName,
        role: newUser.role,
        kycStatus: newUser.kycStatus
      }
    });
  } catch (err) {
    logger.error('Registration failed: ' + err.message);
    res.status(500).json({ error: 'Internal server error during registration' });
  }
});

// Login
app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = await db.findOne(u => u.email.toLowerCase() === email.toLowerCase());
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign(
      { userId: user.id, email: user.email, role: user.role, fullName: user.fullName },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    await eventBus.publish('USER_LOGGED_IN', {
      userId: user.id,
      email: user.email,
      ip: req.ip || '127.0.0.1'
    }, req.correlationId);

    logger.info(`User logged in: ${user.email}`, { correlationId: req.correlationId });

    res.json({
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
        kycStatus: user.kycStatus,
        phone: user.phone
      }
    });
  } catch (err) {
    logger.error('Login failed: ' + err.message);
    res.status(500).json({ error: 'Internal server error during login' });
  }
});

// Verify Transaction PIN
app.post('/verify-pin', async (req, res) => {
  try {
    const userId = req.body.userId || req.headers['x-user-id'];
    const pin = req.body.pin;
    if (!userId || !pin) {
      return res.status(400).json({ error: 'userId and pin are required' });
    }

    const user = await db.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const isPinValid = await bcrypt.compare(pin, user.pinHash);
    if (!isPinValid) {
      return res.status(403).json({ valid: false, error: 'Incorrect Transaction PIN' });
    }

    res.json({ valid: true, message: 'Transaction PIN verified' });
  } catch (err) {
    res.status(500).json({ error: 'PIN verification failed: ' + err.message });
  }
});

// Get User Profile
app.get('/profile/:id', async (req, res) => {
  try {
    const user = await db.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    const { passwordHash, pinHash, ...safeUser } = user;
    res.json(safeUser);
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve profile' });
  }
});

// List all users (Admin/Ops view)
app.get('/users', async (req, res) => {
  try {
    const users = await db.getAll();
    const safeUsers = users.map(({ passwordHash, pinHash, ...u }) => u);
    res.json(safeUsers);
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve users' });
  }
});

const server = app.listen(PORT, () => {
  logger.info(`Auth Service running on http://localhost:${PORT}`);
});

module.exports = { app, server };
