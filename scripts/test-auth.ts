#!/usr/bin/env tsx
/**
 * Test script for MCP HTTP server authentication
 * Usage: npm run test:auth -- [url] [generect-api-key]
 */

const serverUrl = process.argv[2] || 'http://localhost:3000/mcp';
const apiKey = process.argv[3] || '';

console.log(`Testing MCP server at: ${serverUrl}`);
console.log(`Using Generect API key: ${apiKey ? '***' + apiKey.slice(-8) : '(none)'}\n`);

const testRequest = {
  jsonrpc: '2.0',
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0.0' }
  },
  id: 1
};

const headers: Record<string, string> = {
  'Content-Type': 'application/json',
  'Accept': 'application/json, text/event-stream',
};

if (apiKey) {
  // Support both formats: with or without 'Token ' prefix
  const token = apiKey.startsWith('Token ') ? apiKey : `Token ${apiKey}`;
  headers['Authorization'] = `Bearer ${token}`;
}

console.log('Test 1: Sending initialize request...');
try {
  const response = await fetch(serverUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(testRequest)
  });

  console.log(`Status: ${response.status} ${response.statusText}`);
  console.log('Response headers:', Object.fromEntries(response.headers.entries()));

  const body = await response.text();
  console.log('Response body:', body);

  if (response.status === 200) {
    console.log('\n✅ Authentication successful!');
  } else if (response.status === 401) {
    console.log('\n❌ Authentication failed: Unauthorized');
  } else if (response.status === 403) {
    console.log('\n❌ Authentication failed: Forbidden (invalid key)');
  } else {
    console.log('\n⚠️  Unexpected status code');
  }
} catch (error) {
  console.error('❌ Request failed:', error);
  process.exit(1);
}

console.log('\nTest 2: Testing without auth key...');
try {
  const response = await fetch(serverUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream'
    },
    body: JSON.stringify(testRequest)
  });

  console.log(`Status: ${response.status} ${response.statusText}`);

  if (response.status === 401) {
    console.log('✅ Server correctly requires authentication');
  } else if (response.status === 200) {
    console.log('⚠️  Server allows unauthenticated requests (should require API key)');
  }
} catch (error) {
  console.error('Request failed:', error);
}
