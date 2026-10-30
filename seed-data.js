// seed-data.js
// Seeds realistic initial data across all microservices' isolated databases

const bcrypt = require('bcryptjs');
const JsonDatabase = require('./shared/db');

async function seed() {
  console.log('🌱 Seeding Apex Internet Banking Microservices Databases...\n');

  const authDb = new JsonDatabase('auth');
  const accountDb = new JsonDatabase('accounts');
  const txnDb = new JsonDatabase('transactions');
  const notifDb = new JsonDatabase('notifications');
  const fraudDb = new JsonDatabase('fraud');

  // Clear existing collections
  await authDb.clear();
  await accountDb.clear();
  await txnDb.clear();
  await notifDb.clear();
  await fraudDb.clear();

  const salt = await bcrypt.genSalt(10);
  const commonPassHash = await bcrypt.hash('Password123!', salt);
  const adminPassHash = await bcrypt.hash('AdminSecret123!', salt);
  const pin1Hash = await bcrypt.hash('1234', salt);
  const pin2Hash = await bcrypt.hash('5678', salt);
  const adminPinHash = await bcrypt.hash('9999', salt);

  // 1. Seed Auth Users
  const john = await authDb.insert({
    id: 'usr-john-doe-001',
    email: 'john.doe@bank.com',
    passwordHash: commonPassHash,
    pinHash: pin1Hash,
    fullName: 'John Doe',
    phone: '+1 (555) 234-5678',
    role: 'customer',
    kycStatus: 'VERIFIED',
    status: 'ACTIVE'
  });

  const sarah = await authDb.insert({
    id: 'usr-sarah-connor-002',
    email: 'sarah.connor@bank.com',
    passwordHash: commonPassHash,
    pinHash: pin2Hash,
    fullName: 'Sarah Connor',
    phone: '+1 (555) 876-5432',
    role: 'customer',
    kycStatus: 'VERIFIED',
    status: 'ACTIVE'
  });

  const admin = await authDb.insert({
    id: 'usr-admin-003',
    email: 'admin@bank.com',
    passwordHash: adminPassHash,
    pinHash: adminPinHash,
    fullName: 'Chief Auditor Marcus Vance',
    phone: '+1 (555) 999-0000',
    role: 'admin',
    kycStatus: 'VERIFIED',
    status: 'ACTIVE'
  });

  console.log('  ✅ Auth Service: 3 users created (John Doe, Sarah Connor, Auditor Admin)');

  // 2. Seed Accounts & Cards
  const johnCheckingAcc = '4010882314';
  const johnSavingsAcc = '4088921105';
  const sarahCheckingAcc = '4055239912';

  await accountDb.insert({
    id: 'acc-john-chk',
    userId: john.id,
    accountNumber: johnCheckingAcc,
    iban: `US64APEX${johnCheckingAcc}`,
    type: 'CHECKING',
    currency: 'USD',
    balance: 18450.00,
    holdBalance: 0.0,
    status: 'ACTIVE',
    cards: [
      {
        id: 'card-john-01',
        accountNumber: johnCheckingAcc,
        cardNumber: '4532 8812 9043 7120',
        cardholderName: 'JOHN DOE',
        expiry: '08/29',
        cvv: '742',
        type: 'VISA_PLATINUM_DEBIT',
        status: 'ACTIVE',
        dailyLimit: 3000,
        onlinePurchases: true,
        internationalTransactions: true
      }
    ]
  });

  await accountDb.insert({
    id: 'acc-john-sav',
    userId: john.id,
    accountNumber: johnSavingsAcc,
    iban: `US64APEX${johnSavingsAcc}`,
    type: 'SAVINGS',
    currency: 'USD',
    balance: 34200.00,
    holdBalance: 0.0,
    status: 'ACTIVE',
    cards: []
  });

  await accountDb.insert({
    id: 'acc-sarah-chk',
    userId: sarah.id,
    accountNumber: sarahCheckingAcc,
    iban: `US64APEX${sarahCheckingAcc}`,
    type: 'CHECKING',
    currency: 'USD',
    balance: 9800.00,
    holdBalance: 0.0,
    status: 'ACTIVE',
    cards: [
      {
        id: 'card-sarah-01',
        accountNumber: sarahCheckingAcc,
        cardNumber: '5311 9420 1198 3341',
        cardholderName: 'SARAH CONNOR',
        expiry: '11/28',
        cvv: '319',
        type: 'MASTERCARD_GOLD_DEBIT',
        status: 'ACTIVE',
        dailyLimit: 2000,
        onlinePurchases: true,
        internationalTransactions: false
      }
    ]
  });

  console.log('  ✅ Account Service: 3 Bank Accounts & 2 Cards provisioned');

  // 3. Seed Transactions
  await txnDb.insert({
    referenceId: 'TXN-INITIAL-001',
    userId: john.id,
    senderUserId: 'EXTERNAL_PAYROLL',
    recipientUserId: john.id,
    fromAccount: 'CLEARING_HOUSE_ACH',
    toAccount: johnCheckingAcc,
    amount: 6500.00,
    currency: 'USD',
    description: 'Corporate Monthly Salary Direct Deposit',
    type: 'DEPOSIT',
    status: 'COMPLETED',
    createdAt: new Date(Date.now() - 86400000 * 3).toISOString()
  });

  await txnDb.insert({
    referenceId: 'TXN-INITIAL-002',
    userId: john.id,
    senderUserId: john.id,
    recipientUserId: sarah.id,
    fromAccount: johnCheckingAcc,
    toAccount: sarahCheckingAcc,
    amount: 450.00,
    currency: 'USD',
    description: 'Dinner & Weekend Trip Split',
    type: 'TRANSFER',
    status: 'COMPLETED',
    createdAt: new Date(Date.now() - 86400000 * 2).toISOString(),
    sagaSteps: [
      { step: 'VALIDATE_REQUEST', status: 'SUCCESS' },
      { step: 'FRAUD_EVALUATION', status: 'SUCCESS' },
      { step: 'DEBIT_SENDER', status: 'SUCCESS' },
      { step: 'CREDIT_RECIPIENT', status: 'SUCCESS' },
      { step: 'FINALIZE_LEDGER', status: 'SUCCESS' }
    ]
  });

  await txnDb.insert({
    referenceId: 'TXN-INITIAL-003',
    userId: john.id,
    senderUserId: john.id,
    recipientUserId: null,
    fromAccount: johnCheckingAcc,
    toAccount: 'MERCHANT_AMAZON_US',
    amount: 129.99,
    currency: 'USD',
    description: 'Tech Accessories Online Store',
    type: 'PAYMENT',
    status: 'COMPLETED',
    createdAt: new Date(Date.now() - 86400000 * 1).toISOString()
  });

  console.log('  ✅ Transaction Service: Initial transactions seeded with Saga states');

  // 4. Seed Notifications
  await notifDb.insert({
    userId: john.id,
    title: 'Salary Credited',
    message: 'Your monthly salary deposit of $6,500.00 from Payroll was credited to Checking Account (4010882314).',
    type: 'SUCCESS',
    category: 'TRANSACTION',
    isRead: true,
    channel: 'IN_APP_AND_SMS',
    createdAt: new Date(Date.now() - 86400000 * 3).toISOString()
  });

  await notifDb.insert({
    userId: john.id,
    title: 'Transfer Completed',
    message: 'Successfully sent $450.00 to Sarah Connor (4055239912).',
    type: 'SUCCESS',
    category: 'TRANSACTION',
    isRead: false,
    channel: 'IN_APP_AND_SMS',
    createdAt: new Date(Date.now() - 86400000 * 2).toISOString()
  });

  await notifDb.insert({
    userId: john.id,
    title: 'Security Alert: New Device Login',
    message: 'New sign-in detected from Chrome on Windows. If this was you, no action is needed.',
    type: 'INFO',
    category: 'SECURITY',
    isRead: false,
    channel: 'IN_APP',
    createdAt: new Date().toISOString()
  });

  console.log('  ✅ Notification Service: Welcome & activity alerts seeded');

  // 5. Seed Fraud Alerts
  await fraudDb.insert({
    transactionId: 'TXN-FLAG-DEMO-001',
    userId: john.id,
    fromAccount: johnCheckingAcc,
    toAccount: '4099999999',
    amount: 15000.00,
    riskScore: 75,
    decision: 'REVIEW_REQUIRED',
    flags: [
      { rule: 'HIGH_VALUE_ANOMALY', message: 'High value transaction ($15,000) flagged for AML compliance' }
    ],
    status: 'PENDING_REVIEW',
    createdAt: new Date(Date.now() - 3600000 * 4).toISOString()
  });

  console.log('  ✅ Fraud Service: Seeded AML risk rule alerts for compliance officer');
  console.log('\n🎉 Database initialization finished successfully!\n');
}

if (require.main === module) {
  seed().catch(console.error);
}

module.exports = seed;
