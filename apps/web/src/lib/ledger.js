import { formatPaiseAsINR } from './accounts.js';

export function statementDirection(event) {
  if (event.status !== 'POSTED') return 'Not posted';
  const amount = BigInt(event.amountPaise);
  if (amount > 0n) return 'Credit';
  if (amount < 0n) return 'Debit';
  return '—';
}

export function formatStatementAmount(event, currencyCode = 'INR') {
  return formatPaiseAsINR(event.amountPaise, currencyCode);
}

export function formatStatementBalance(event, currencyCode = 'INR') {
  return formatPaiseAsINR(event.runningBalancePaise, currencyCode);
}

export function statementPageUrl(accountId, { limit = 25, cursor } = {}) {
  const query = new URLSearchParams({ limit: String(limit) });
  if (cursor) query.set('cursor', cursor);
  return `/api/accounts/${encodeURIComponent(accountId)}/statement?${query}`;
}

export function auditPageUrl(page = 1, perPage = 25) {
  return `/api/audit?${new URLSearchParams({ page: String(page), perPage: String(perPage) })}`;
}

export function navigationForRole(role) {
  return [
    { path: '/dashboard', label: 'Overview', icon: 'grid' },
    { path: '/accounts', label: 'Accounts', icon: 'cards' },
    { path: '/statements', label: 'Statements', icon: 'activity' },
    ...(role === 'ACCOUNT_HOLDER' ? [{ path: '/account-requests', label: 'Account request', icon: 'plus' }] : []),
    ...(role === 'ADMIN' ? [
      { path: '/admin/users', label: 'User management', icon: 'building' },
      { path: '/admin/onboarding', label: 'Onboarding', icon: 'cards' },
      { path: '/audit', label: 'Audit log', icon: 'shield' },
    ] : role === 'AUDITOR' ? [{ path: '/audit', label: 'Audit log', icon: 'shield' }] : []),
  ];
}

export async function fetchAccountStatement(request, accountId, options = {}) {
  return request(statementPageUrl(accountId, options), { signal: options.signal });
}

export async function fetchAuditPage(request, page = 1, perPage = 25, options = {}) {
  return request(auditPageUrl(page, perPage), { signal: options.signal });
}

export async function fetchTransfer(request, id, options = {}) {
  const result = await request(`/api/transfers/${encodeURIComponent(id)}`, options);
  return result.transfer;
}
