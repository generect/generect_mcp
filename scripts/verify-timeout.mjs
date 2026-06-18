// Самопроверка таймаута MCP-сервера.
//
// Поднимает МЕДЛЕННЫЙ фейковый API (отвечает через 2 секунды) и проверяет:
//   1) с дефолтным таймаутом (300с) запрос УСПЕВАЕТ — ответ приходит;
//   2) если выставить GENERECT_TIMEOUT_MS=1000 (1с) — запрос ОБРЫВАЕТСЯ по таймауту.
// Это доказывает, что таймаут реально читается из окружения и работает.
//
// Запуск:  npm run build && node scripts/verify-timeout.mjs

import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DELAY_MS = 2000; // фейковый API "думает" 2 секунды

function startMock() {
  const mock = http.createServer((req, res) => {
    setTimeout(() => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ amount: 1, leads: [{ full_name: 'Slow Lead', linkedin_url: 'https://x' }] }));
    }, DELAY_MS);
  });
  return new Promise((r) => mock.listen(0, () => r(mock)));
}

// Один прогон: вызывает search_leads и возвращает текст результата, отданный в LLM.
function runOnce(base, timeoutEnv) {
  return new Promise((resolveRun) => {
    const env = { ...process.env, GENERECT_API_BASE: base, GENERECT_API_KEY: 'dummy', MCP_LOG: '0' };
    if (timeoutEnv != null) env.GENERECT_TIMEOUT_MS = String(timeoutEnv);
    const p = spawn('node', ['dist/server.js'], { cwd: root, env });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    const send = (o) => p.stdin.write(JSON.stringify(o) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    setTimeout(() => send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_leads', arguments: { job_title: 'CTO' } } }), 300);
    setTimeout(() => {
      const lines = out.trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const r = lines.find((l) => l.id === 2);
      p.kill();
      resolveRun(r?.result?.content?.[0]?.text ?? '(нет ответа)');
    }, DELAY_MS + 2000);
  });
}

const mock = await startMock();
const base = `http://127.0.0.1:${mock.address().port}`;

console.log(`Фейковый API отвечает за ${DELAY_MS} мс.\n`);

console.log('1) Дефолтный таймаут (300с) — должен УСПЕТЬ:');
const ok = await runOnce(base, undefined);
const passed1 = /Slow Lead/.test(ok);
console.log('   ' + ok.replace(/\n/g, ' ').slice(0, 120));
console.log('   => ' + (passed1 ? '✅ ответ получен' : '❌ не получен'));

console.log('\n2) Короткий таймаут GENERECT_TIMEOUT_MS=1000 (1с) — должен ОБОРВАТЬСЯ:');
const aborted = await runOnce(base, 1000);
const passed2 = /AbortError|aborted/i.test(aborted);
console.log('   ' + aborted.replace(/\n/g, ' ').slice(0, 160));
console.log('   => ' + (passed2 ? '✅ оборвался по таймауту (значит env читается)' : '❌ не оборвался'));

console.log('\n================= ИТОГ =================');
console.log(passed1 && passed2 ? '✅ Таймаут работает и управляется через GENERECT_TIMEOUT_MS.' : '❌ Что-то не так.');

mock.close();
process.exit(passed1 && passed2 ? 0 : 1);
