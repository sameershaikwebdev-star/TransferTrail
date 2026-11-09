export async function fetchAccounts(request, options) {
  const result = await request('/api/accounts', options);
  return Array.isArray(result.accounts) ? result.accounts : [];
}

export async function fetchAccount(request, accountId, options) {
  const result = await request(`/api/accounts/${encodeURIComponent(accountId)}`, options);
  return result.account;
}

export async function fetchAccountBalance(request, accountId, options) {
  return request(`/api/accounts/${encodeURIComponent(accountId)}/balance`, options);
}

export async function createCustomerAccount(request, values) {
  const result = await request('/api/accounts', { method: 'POST', body: values });
  return result.account;
}

// Keep paise as BigInt throughout formatting. Converting the amount to Number
// would lose integer precision for sufficiently large PostgreSQL BIGINT values.
export function formatPaiseAsINR(value, currencyCode = 'INR') {
  let paise;
  try {
    paise = BigInt(value);
  } catch {
    return 'Balance unavailable';
  }

  const negative = paise < 0n;
  const absolutePaise = negative ? -paise : paise;
  const rupees = absolutePaise / 100n;
  const remainder = String(absolutePaise % 100n).padStart(2, '0');
  const groupedRupees = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(rupees);
  const symbol = currencyCode === 'INR' ? '₹' : `${currencyCode} `;
  return `${negative ? '-' : ''}${symbol}${groupedRupees}.${remainder}`;
}

export function formatAccountDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Date unavailable';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date);
}
