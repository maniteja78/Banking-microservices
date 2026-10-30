// test-runner.js
// Boots the microservices cluster, runs all integration tests, and cleanly shuts down

const { fork } = require('child_process');
const http = require('http');
const path = require('path');

function checkGateway(port = 8080) {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: 'localhost',
      port,
      path: '/api/system/topology',
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

async function run() {
  console.log('🚀 Spawning microservices mesh for testing...');
  const runner = fork(path.resolve(__dirname, 'runner.js'), [], { silent: true });

  // Wait for Gateway to be UP
  let isUp = false;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 600));
    isUp = await checkGateway(8080);
    if (isUp) break;
  }

  if (!isUp) {
    console.error('❌ Microservices failed to start within 12s');
    runner.kill('SIGINT');
    process.exit(1);
  }

  console.log('✅ Microservices are UP! Running test-suite.js...\n');
  const runTests = require('./test-suite.js');

  try {
    await runTests();
  } finally {
    console.log('Cleaning up microservices processes...');
    runner.kill('SIGINT');
  }
}

run().catch(err => {
  console.error('Test runner fatal error:', err);
  process.exit(1);
});
