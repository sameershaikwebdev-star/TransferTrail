import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditPageUrl, fetchAccountStatement, formatStatementAmount, formatStatementBalance, navigationForRole, statementDirection, statementPageUrl } from '../src/lib/ledger.js';

test('posted statement amounts use signed account perspective and refused events are not presented as postings', () => {
  assert.equal(statementDirection({ status: 'POSTED', amountPaise: '-12345' }), 'Debit');
  assert.equal(statementDirection({ status: 'POSTED', amountPaise: '12345' }), 'Credit');
  assert.equal(statementDirection({ status: 'REFUSED', amountPaise: '12345' }), 'Not posted');
  assert.equal(formatStatementAmount({ amountPaise: '-12345' }), '-₹123.45');
  assert.equal(formatStatementBalance({ runningBalancePaise: '9007199254740991' }), '₹9,00,71,99,25,47,409.91');
});

test('statement cursor URL is opaque, encoded and passed through without event reordering', async () => {
  const cursor = 'eyJwb3NpdGlvbiI6IjEwMCJ9+/=';
  const url = new URL(statementPageUrl('account/id', { limit: 17, cursor }), 'https://example.test');
  assert.equal(url.pathname, '/api/accounts/account%2Fid/statement');
  assert.equal(url.searchParams.get('limit'), '17');
  assert.equal(url.searchParams.get('cursor'), cursor);
  const events = [{ id: 'second-in-time', amountPaise: '3' }, { id: 'first-in-time', amountPaise: '4' }];
  const returned = await fetchAccountStatement(async () => ({ events, nextCursor: 'next' }), 'account', { limit: 25 });
  assert.deepEqual(returned.events, events);
  assert.equal(returned.nextCursor, 'next');
});

test('audit pagination uses the existing page and perPage contract', () => {
  const url = new URL(auditPageUrl(3, 40), 'https://example.test');
  assert.equal(url.pathname, '/api/audit');
  assert.equal(url.searchParams.get('page'), '3');
  assert.equal(url.searchParams.get('perPage'), '40');
});

test('role navigation presents administrative, audit and onboarding pages only to intended roles', () => {
  assert.deepEqual(navigationForRole('ADMIN').map((item) => item.path), ['/dashboard', '/accounts', '/statements', '/admin/users', '/admin/onboarding', '/audit']);
  assert.equal(navigationForRole('AUDITOR').some((item) => item.path === '/audit'), true);
  assert.equal(navigationForRole('AUDITOR').some((item) => item.path.startsWith('/admin/')), false);
  assert.equal(navigationForRole('ACCOUNT_HOLDER').some((item) => item.path === '/audit'), false);
  assert.equal(navigationForRole('ACCOUNT_HOLDER').some((item) => item.path === '/account-requests'), true);
});
