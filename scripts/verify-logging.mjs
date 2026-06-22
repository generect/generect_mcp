// Самопроверка логирования MCP-сервера.
//
// Что делает: поднимает ФЕЙКОВЫЙ Generect API на localhost, запускает НАСТОЯЩИЙ
// MCP-сервер (dist/server.js) против него и шлёт ему такие же запросы, какие шлёт
// LLM. Реальный API-ключ НЕ нужен — ничего наружу не уходит.
//
// Запуск:
//   npm run build            # один раз, чтобы собрать dist/
//   node scripts/verify-logging.mjs
//
// Что ты должен увидеть: на каждый вызов инструмента — 4 строки лога
// (tool_call -> api_request -> api_response -> tool_result). Это и есть
// "что LLM прислала на вход" и "что мы вернули в LLM".

import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// 1. Фейковый Generect API. Записывает, что MCP-сервер ему прислал, и отвечает.
const received = [];
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    received.push({ path: req.url, auth: req.headers['authorization'], body: JSON.parse(body || '{}') });
    res.setHeader('content-type', 'application/json');
    if (req.url.includes('/leads/by_icp/')) {
      res.end(JSON.stringify({ amount: 1, leads: [{ full_name: 'Ada Lovelace', job_title: 'CTO', company_name: 'Analytical Co', company_industry: 'Software', location: 'United States', linkedin_url: 'https://linkedin.com/in/ada' }] }));
    } else if (req.url.includes('/companies/by_icp/')) {
      res.end(JSON.stringify({ amount: 1, companies: [{ name: 'Analytical Co', website: 'analytical.co', headcount_range: '11-50', industry: 'Software', location: 'United States' }] }));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
});

await new Promise((r) => mock.listen(0, r));
const base = `http://127.0.0.1:${mock.address().port}`;

// 2. Настоящий MCP-сервер, направленный на фейковый API, с фиктивным ключом.
const srv = spawn('node', ['dist/server.js'], {
  cwd: root,
  env: { ...process.env, GENERECT_API_BASE: base, GENERECT_API_KEY: 'dummy-key-not-real', MCP_LOG: '1' },
});

let logs = '';
srv.stderr.on('data', (d) => (logs += d)); // логи сервера идут в stderr
const send = (o) => srv.stdin.write(JSON.stringify(o) + '\n');

// 3. Имитируем клиента (LLM): рукопожатие + два вызова инструментов.
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'verify', version: '1' } } });
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
setTimeout(() => send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_leads', arguments: { job_title: 'CTO', locations: ['United States'], lead_industries: ['Software'], limit_by: 5 } } }), 300);
setTimeout(() => send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_companies', arguments: { industries: ['Software'], headcounts: ['11-50'], locations: ['United States'] } } }), 700);

// 4. Печатаем результат с подписями.
setTimeout(() => {
  const lines = logs.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const human = {
    tool_call: 'ВХОД  — что LLM прислала инструменту',
    api_request: 'ИСХОД — что мы отправили в Generect API (без токена!)',
    api_response: 'ОТВЕТ — статус и время ответа API',
    tool_result: 'ВЫХОД — что вернули обратно в LLM',
    tool_error: 'ОШИБКА инструмента',
    api_error: 'ОШИБКА запроса к API',
  };
  console.log('\n================= ЛОГИ MCP-СЕРВЕРА =================\n');
  for (const l of lines) {
    console.log(`[${human[l.event] || l.event}]  reqId=${l.reqId ?? '-'}`);
    console.log('   ' + JSON.stringify(l));
    console.log('');
  }

  const ok =
    lines.some((l) => l.event === 'tool_call' && l.input?.job_title === 'CTO') &&
    lines.some((l) => l.event === 'api_request' && l.body?.personas) &&
    lines.some((l) => l.event === 'tool_result' && /Ada Lovelace/.test(JSON.stringify(l.output)));

  console.log('================= ИТОГ =================');
  console.log(ok ? '✅ OK: вход и выход LLM логируются, запрос доходит до API.' : '❌ Что-то не так — логов неполный набор.');
  console.log('\nДля справки — что фейковый API реально получил от MCP-сервера:');
  console.log(JSON.stringify(received, null, 2));

  srv.kill();
  mock.close();
  process.exit(ok ? 0 : 1);
}, 1600);
