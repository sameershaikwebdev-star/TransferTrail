import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fetchAccounts, fetchAccount, fetchAccountBalance, createCustomerAccount } from '../src/lib/accounts.js';
import { fetchTransfer, fetchAccountStatement, fetchAuditPage } from '../src/lib/ledger.js';

// Node has no Vite import.meta.env. Substitute only that build-time object;
// execute the unchanged API client for transport and response checks.
const source = (await readFile(new URL('../src/lib/api.js', import.meta.url), 'utf8')).replaceAll('import.meta.env', '({})');
const { apiRequest, ApiError, getBackendStatus } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

const originals = new WeakMap();
function stubFetch(t, implementation) {
  if (!originals.has(t)) {
    originals.set(t, globalThis.fetch);
    t.after(() => { globalThis.fetch = originals.get(t); originals.delete(t); });
  }
  globalThis.fetch = implementation;
}

test('transfer transport preserves bearer authorization, JSON payload and original idempotency key', async (t) => {
  const body = { sourceAccountId: 'source', destinationAccountId: 'destination', amountPaise: 12345 };
  stubFetch(t, async (url, options) => {
    assert.equal(url, 'http://localhost:3001/api/transfers');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.get('Authorization'), 'Bearer test-token');
    assert.equal(options.headers.get('Idempotency-Key'), 'original-key');
    assert.equal(options.headers.get('Content-Type'), 'application/json');
    assert.deepEqual(JSON.parse(options.body), body);
    return Response.json({ status: 'POSTED', journalTransactionId: 'journal-1' }, { status: 201 });
  });
  const result = await apiRequest('/api/transfers', { method: 'POST', body, token: 'test-token', headers: { 'Idempotency-Key': 'original-key' } });
  assert.equal(result.journalTransactionId, 'journal-1');
});

test('401 expires authenticated session; refused payload is retained for the UI', async (t) => {
  let expired = 0;
  stubFetch(t, async () => Response.json({ error: 'Session expired' }, { status: 401 }));
  await assert.rejects(apiRequest('/api/accounts', { token: 'expired', onUnauthorized: () => expired++ }), (e) => e instanceof ApiError && e.status === 401);
  assert.equal(expired, 1);
  stubFetch(t, async () => Response.json({ status: 'REFUSED', reason: 'insufficient_funds' }, { status: 422 }));
  await assert.rejects(apiRequest('/api/transfers', { method: 'POST' }), (e) => e.status === 422 && e.payload.status === 'REFUSED' && e.payload.reason === 'insufficient_funds');
});

test('network failures and 5xx remain distinguishable from a confirmed refusal', async (t) => {
  stubFetch(t, async () => { throw new TypeError('offline'); });
  await assert.rejects(apiRequest('/api/transfers'), (e) => e instanceof ApiError && e.status === 0);
  stubFetch(t, async () => new Response('<html>unavailable</html>', { status: 503 }));
  await assert.rejects(apiRequest('/api/transfers'), (e) => e.status === 503 && e.message === 'The request could not be completed.');
});

test('cancellation propagates and readiness reports unavailable responses', async (t) => {
  const abort = new DOMException('Aborted', 'AbortError');
  stubFetch(t, async () => { throw abort; });
  await assert.rejects(apiRequest('/api/accounts'), (e) => e === abort);
  await assert.rejects(getBackendStatus(), (e) => e === abort);
  stubFetch(t, async (url) => { assert.equal(url, 'http://localhost:3001/api/ready'); return new Response('', { status: 503 }); });
  assert.equal(await getBackendStatus(), false);
});

test('account and ledger clients consume the documented response wrappers and encoded IDs', async () => {
  const calls = [];
  const request = async (path, options) => {
    calls.push({ path, options });
    if (path === '/api/accounts' && options?.method === 'POST') return { account: { id: 'created' } };
    if (path === '/api/accounts') return { accounts: [{ id: 'a' }] };
    if (path.endsWith('/balance')) return { balancePaise: '500', currencyCode: 'INR' };
    if (path.includes('/statement?')) return { account: { id: 'a' }, events: [], nextCursor: null };
    if (path.startsWith('/api/transfers/')) return { transfer: { id: 't' } };
    if (path.startsWith('/api/audit')) return { events: [], page: 2 };
    return { account: { id: 'a' } };
  };
  assert.equal((await fetchAccounts(request))[0].id, 'a');
  assert.equal((await fetchAccount(request, 'a/b')).id, 'a');
  assert.equal((await fetchAccountBalance(request, 'a/b')).balancePaise, '500');
  assert.equal((await createCustomerAccount(request, { accountNumber: 'TT1' })).id, 'created');
  assert.equal((await fetchTransfer(request, 't/x')).id, 't');
  assert.deepEqual((await fetchAccountStatement(request, 'a/b', { cursor: '+/=' })).events, []);
  assert.equal((await fetchAuditPage(request, 2)).page, 2);
  assert.equal(calls[1].path, '/api/accounts/a%2Fb');
  assert.equal(calls[2].path, '/api/accounts/a%2Fb/balance');
  assert.equal(calls[4].path, '/api/transfers/t%2Fx');
  assert.deepEqual(calls[3].options.body, { accountNumber: 'TT1' });
  assert.equal(new URL(calls[5].path, 'http://test').searchParams.get('cursor'), '+/=');
});
