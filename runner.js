// runner.js
// Apex Internet Banking Microservices Orchestrator & Multi-Process Runner

const { fork, execSync } = require('child_process');
const http = require('http');
const path = require('path');

const SERVICES = [
  { name: 'EVENT-BUS', script: 'services/event-bus/server.js', port: 8086 },
  { name: 'AUTH-SVC', script: 'services/auth-service/server.js', port: 8081 },
  { name: 'ACCOUNT-SVC', script: 'services/account-service/server.js', port: 8082 },
  { name: 'FRAUD-SVC', script: 'services/fraud-service/server.js', port: 8085 },
  { name: 'NOTIF-SVC', script: 'services/notification-service/server.js', port: 8084 },
  { name: 'TXN-SVC', script: 'services/transaction-service/server.js', port: 8083 },
  { name: 'GATEWAY', script: 'services/api-gateway/server.js', port: 8080 }
];

// Clean up any lingering processes on ports 8080-8086 before starting
function freePorts() {
  SERVICES.forEach(({ port }) => {
    try {
      if (process.platform === 'win32') {
        execSync(`powershell -NoProfile -Command "$p = (Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue).OwningProcess; if ($p) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }"`, { stdio: 'ignore' });
      } else {
        execSync(`lsof -ti:${port} | xargs kill -9 2>/dev/null || true`, { stdio: 'ignore' });
      }
    } catch (e) {}
  });
}

freePorts();

const children = [];

function checkHealth(port) {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: 'localhost',
      port,
      path: '/health',
      method: 'GET',
      timeout: 1000
    }, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

async function waitForAllHealthy(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const statuses = await Promise.all(SERVICES.map(s => checkHealth(s.port)));
    if (statuses.every(Boolean)) {
      return true;
    }
    await new Promise(r => setTimeout(r, 600));
  }
  return false;
}

console.log('================================================================');
console.log('       🚀 STARTING APEX INTERNET BANKING MICROSERVICES MESH     ');
console.log('================================================================');

// Launch services in order (Event Bus first, then domain services, then Gateway)
SERVICES.forEach(({ name, script, port }) => {
  const scriptPath = path.resolve(__dirname, script);
  const child = fork(scriptPath, [], {
    silent: false,
    env: { ...process.env, PORT: port }
  });

  child.on('error', (err) => {
    console.error(`❌ [${name}] Process error:`, err);
  });

  child.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) {
      console.warn(`⚠️ [${name}] Exited with code ${code} (signal ${signal})`);
    }
  });

  children.push(child);
});

// Wait for all to be ready and print success banner
waitForAllHealthy().then((allUp) => {
  if (allUp) {
    console.log('\n================================================================');
    console.log('  🌟 ALL 7 MICROSERVICES ARE LIVE & HEALTHY!');
    console.log('================================================================');
    console.log('  🌐 Internet Banking Web UI:  http://localhost:8080');
    console.log('  📊 Service Mesh Topology:   http://localhost:8080/api/system/topology');
    console.log('  📡 Event Bus Stream:        http://localhost:8086/events/stream');
    console.log('----------------------------------------------------------------');
    console.log('  🔑 Demo Credentials:');
    console.log('     • John Doe:     john.doe@bank.com     | Password: Password123! (PIN: 1234)');
    console.log('     • Sarah Connor: sarah.connor@bank.com | Password: Password123! (PIN: 5678)');
    console.log('     • Auditor:      admin@bank.com        | Password: AdminSecret123! (PIN: 9999)');
    console.log('================================================================\n');
  } else {
    console.warn('⚠️ Some services took longer than expected to report healthy.');
  }
});

// Graceful multi-process shutdown
function shutdown() {
  console.log('\n🛑 Gracefully stopping all microservice processes...');
  children.forEach(child => {
    try {
      child.kill('SIGINT');
    } catch (e) {}
  });
  setTimeout(() => process.exit(0), 1000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
