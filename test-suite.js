// test-suite.js
// Automated Integration & Saga Pattern Test Suite

const http = require('http');

const GATEWAY_URL = 'http://localhost:8080';

function makeRequest(path, method = 'GET', body = null, token = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(GATEWAY_URL + path);
    const bodyStr = body ? JSON.stringify(body) : null;

    const headers = {
      'Content-Type': 'application/json',
      'x-correlation-id': `test-${Date.now()}`
    };

    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);

    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers,
      timeout: 6000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data || '{}') });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout on ${path}`)); });

    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function runTests() {
  console.log('\n================================================================');
  console.log('🧪 RUNNING APEX INTERNET BANKING MICROSERVICES TEST SUITE');
  console.log('================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✅ PASS: ${message}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${message}`);
      failed++;
    }
  }

  try {
    // 1. Topology & Gateway Health Check
    console.log('[Test Group 1: Service Mesh Topology & Gateway Health]');
    const topoRes = await makeRequest('/api/system/topology');
    assert(topoRes.status === 200, 'Gateway /api/system/topology is reachable');
    assert(topoRes.data.gateway?.status === 'ONLINE', 'API Gateway status is ONLINE');
    
    const services = ['auth', 'accounts', 'transactions', 'notifications', 'fraud', 'events'];
    services.forEach(svc => {
      const isOnline = topoRes.data.cluster?.[svc]?.status === 'ONLINE';
      assert(isOnline, `Microservice [${svc}] is healthy & responding`);
    });

    // 2. Auth Service: Login & JWT issuance
    console.log('\n[Test Group 2: Identity & Authentication]');
    const loginRes = await makeRequest('/api/auth/login', 'POST', {
      email: 'john.doe@bank.com',
      password: 'Password123!'
    });
    assert(loginRes.status === 200, 'User login succeeds with HTTP 200');
    assert(Boolean(loginRes.data.token), 'JWT access token issued');
    const token = loginRes.data.token;
    const userId = loginRes.data.user?.id;

    // PIN Verification
    const pinRes = await makeRequest('/api/auth/verify-pin', 'POST', { pin: '1234' }, token);
    assert(pinRes.data?.valid === true, 'Transaction PIN "1234" correctly validated');

    // 3. Account Service: Balance Inquiries
    console.log('\n[Test Group 3: Account & Balance Management]');
    const accsRes = await makeRequest(`/api/accounts/user/${userId}`, 'GET', null, token);
    assert(accsRes.status === 200, 'User accounts retrieved');
    assert(Array.isArray(accsRes.data) && accsRes.data.length >= 2, 'User has Checking & Savings accounts');
    
    const johnChecking = accsRes.data.find(a => a.type === 'CHECKING');
    const initialJohnBalance = johnChecking.balance;
    console.log(`     ℹ️ John's Initial Checking Balance: $${initialJohnBalance}`);

    // 4. Saga Orchestrator: Fund Transfer
    console.log('\n[Test Group 4: Distributed Saga Orchestrator - Fund Transfer]');
    const transferAmount = 100.00;
    const transferRes = await makeRequest('/api/transactions/transfer', 'POST', {
      fromAccount: johnChecking.accountNumber,
      toAccount: '4055239912', // Sarah Connor
      amount: transferAmount,
      description: 'Automated Test Transfer'
    }, token);

    if (transferRes.status !== 200) {
      console.log('     ⚠️ transferRes output:', JSON.stringify(transferRes.data));
    }

    assert(transferRes.status === 200, 'Transfer Saga executed with HTTP 200');
    assert(transferRes.data.status === 'COMPLETED', 'Transfer finalized as COMPLETED');
    assert(Array.isArray(transferRes.data.sagaSteps), 'Saga steps recorded');
    
    const steps = transferRes.data.sagaSteps.map(s => s.step);
    assert(steps.includes('VALIDATE_REQUEST'), 'Saga Step 1: VALIDATE_REQUEST executed');
    assert(steps.includes('FRAUD_EVALUATION'), 'Saga Step 2: FRAUD_EVALUATION executed');
    assert(steps.includes('DEBIT_SENDER'), 'Saga Step 3: DEBIT_SENDER executed');
    assert(steps.includes('CREDIT_RECIPIENT'), 'Saga Step 4: CREDIT_RECIPIENT executed');
    assert(steps.includes('FINALIZE_LEDGER'), 'Saga Step 5: FINALIZE_LEDGER executed');

    // Verify balance deduction
    const accsAfter = await makeRequest(`/api/accounts/user/${userId}`, 'GET', null, token);
    const johnCheckingAfter = accsAfter.data.find(a => a.type === 'CHECKING');
    assert(johnCheckingAfter.balance === initialJohnBalance - transferAmount, `Sender balance accurately debited by $${transferAmount}`);

    // 5. Distributed Saga Compensation: Rollback Test
    console.log('\n[Test Group 5: Saga Compensation & Automated Rollback]');
    const preCompBalance = johnCheckingAfter.balance;
    const failedSagaRes = await makeRequest('/api/transactions/transfer', 'POST', {
      fromAccount: johnChecking.accountNumber,
      toAccount: '4055239912',
      amount: 200.00,
      description: 'Simulated Credit Failure',
      simulateCreditFailure: true
    }, token);

    assert(failedSagaRes.data?.status === 'FAILED_ROLLED_BACK', 'Failed transaction detected & marked FAILED_ROLLED_BACK');
    assert(failedSagaRes.data?.compensated === true, 'Compensating transaction executed');

    // Verify sender balance was refunded
    const accsAfterComp = await makeRequest(`/api/accounts/user/${userId}`, 'GET', null, token);
    const johnCheckingAfterComp = accsAfterComp.data.find(a => a.type === 'CHECKING');
    assert(johnCheckingAfterComp.balance === preCompBalance, 'Sender balance 100% restored after compensation refund');

    // 6. Fraud & Risk Detection Service
    console.log('\n[Test Group 6: Fraud & AML Risk Heuristics]');
    const fraudRes = await makeRequest('/api/transactions/transfer', 'POST', {
      fromAccount: johnChecking.accountNumber,
      toAccount: '4099999999', // Blacklisted
      amount: 15000.00,
      description: 'Blacklist Wire Test'
    }, token);

    assert(fraudRes.status === 400 || fraudRes.status === 422, 'Suspicious transfer rejected by Gateway/Saga');
    assert(fraudRes.data?.status === 'BLOCKED_FRAUD', 'Transfer explicitly flagged as BLOCKED_FRAUD');

    // 7. Notification Service
    console.log('\n[Test Group 7: Notifications Dispatch]');
    const notifRes = await makeRequest(`/api/notifications/user/${userId}`, 'GET', null, token);
    assert(notifRes.status === 200, 'Notifications endpoint active');
    assert(notifRes.data.notifications?.length > 0, 'Notifications created and retrieved for user');

    console.log('\n================================================================');
    console.log(`📊 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log('================================================================\n');

    process.exit(failed > 0 ? 1 : 0);
  } catch (err) {
    console.error('❌ Test suite execution error:', err);
    process.exit(1);
  }
}

if (require.main === module) {
  runTests();
}

module.exports = runTests;
