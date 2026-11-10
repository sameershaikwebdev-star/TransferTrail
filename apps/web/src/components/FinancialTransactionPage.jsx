import { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthContext.jsx';
import { ApiError } from '../lib/api.js';
import { fetchAccountBalance, fetchAccounts, formatPaiseAsINR } from '../lib/accounts.js';
import {
  clearPendingTransaction,
  createSubmissionGuard,
  createTransactionAttempt,
  formatPaiseForInput,
  parseInrToPaise,
  readPendingTransaction,
  savePendingTransaction,
} from '../lib/transactions.js';

const transactionDetails = {
  deposit: { type: 'DEPOSIT', title: 'Deposit', verb: 'deposit', endpoint: '/api/deposits', intro: 'Add funds to an eligible account.' },
  withdrawal: { type: 'WITHDRAWAL', title: 'Withdrawal', verb: 'withdraw', endpoint: '/api/withdrawals', intro: 'Move funds from an eligible account.' },
  transfer: { type: 'TRANSFER', title: 'Transfer', verb: 'transfer', endpoint: '/api/transfers', intro: 'Send funds from your account to any active TransferTrail account.' },
};

function initialAttempt(userId, type) {
  return readPendingTransaction(userId, type);
}

function getReason(error) {
  const reason = error?.payload?.reason;
  const messages = {
    insufficient_funds: 'The account does not have enough available funds for this withdrawal or transfer.',
    not_authorized: 'You do not have permission to perform this operation on the selected account.',
    role_forbidden: 'Your current role cannot initiate money movement.',
    account_unavailable: 'One of the selected accounts is unavailable for transactions.',
    account_inactive: 'Your user account is inactive. Sign in again or contact an administrator.',
    invalid_accounts: 'The selected account combination is not valid for this transaction.',
    clearing_account_unavailable: 'The transaction service is temporarily unavailable. No funds were moved.',
  };
  return messages[reason] ?? error?.message ?? 'The transaction could not be completed.';
}

export default function FinancialTransactionPage({ type, onNavigate }) {
  const details = transactionDetails[type];
  const { user, request, refreshAccounts, accountRefreshVersion, selectedAccountId, setSelectedAccountId } = useAuth();
  const [accounts, setAccounts] = useState([]);
  const [balances, setBalances] = useState({});
  const restoredAttempt = useMemo(() => initialAttempt(user.id, details.type), [user.id, details.type]);
  const [sourceAccountId, setSourceAccountId] = useState(
    restoredAttempt?.payload?.sourceAccountId ?? restoredAttempt?.payload?.accountId ?? selectedAccountId ?? '',
  );
  const [destinationAccountId, setDestinationAccountId] = useState(restoredAttempt?.payload?.destinationAccountId ?? '');
  const [destinationNumber, setDestinationNumber] = useState('');
  const [destinationLookup, setDestinationLookup] = useState(null);
  const [lookupBusy, setLookupBusy] = useState(false);
  const [lookupError, setLookupError] = useState('');
  const [amount, setAmount] = useState(restoredAttempt?.payload?.amountPaise ? formatPaiseForInput(restoredAttempt.payload.amountPaise) : '');
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [accountError, setAccountError] = useState('');
  const [amountError, setAmountError] = useState('');
  const [attempt, setAttempt] = useState(restoredAttempt);
  const [stage, setStage] = useState(restoredAttempt?.state === 'uncertain' || restoredAttempt?.state === 'conflict' ? 'result' : restoredAttempt ? 'review' : 'form');
  const [outcome, setOutcome] = useState(restoredAttempt?.state === 'uncertain'
    ? { kind: 'uncertain', message: 'This earlier request has no confirmed response. Retry the same request to check its original idempotent result.' }
    : restoredAttempt?.state === 'conflict'
      ? { kind: 'conflict', message: 'The server reported that this key was already used with a different request payload.' }
      : null);
  const [submitting, setSubmitting] = useState(false);
  const submissionGuard = useRef(createSubmissionGuard());

  useEffect(() => {
    const controller = new AbortController();
    setAccountsLoading(true);
    setAccountError('');
    fetchAccounts(request, { signal: controller.signal }).then(async (items) => {
      if (controller.signal.aborted) return;
      setAccounts(items);
      const savedAccount = restoredAttempt?.payload?.sourceAccountId ?? restoredAttempt?.payload?.accountId;
      const nextSource = savedAccount ?? (items.some((item) => item.id === selectedAccountId) ? selectedAccountId : items[0]?.id ?? '');
      if (!savedAccount && nextSource) setSourceAccountId(nextSource);
      if (!items.some((item) => item.id === selectedAccountId)) setSelectedAccountId(nextSource || null);

      const accountBalances = await Promise.all(items.map(async (account) => {
        try {
          const balance = await fetchAccountBalance(request, account.id, { signal: controller.signal });
          return [account.id, { balancePaise: String(balance.balancePaise), currencyCode: balance.currencyCode }];
        } catch (error) {
          if (error.name === 'AbortError') throw error;
          return [account.id, { error }];
        }
      }));
      if (!controller.signal.aborted) setBalances(Object.fromEntries(accountBalances));
    }).catch((error) => {
      if (error.name !== 'AbortError') {
        setAccountError(error.status === 403
          ? 'Your role does not permit this account operation.'
          : error.status === 401
            ? 'Your session has expired. Sign in again to continue.'
            : error.message || 'Accounts could not be loaded.');
      }
    }).finally(() => { if (!controller.signal.aborted) setAccountsLoading(false); });
    return () => controller.abort();
  }, [accountRefreshVersion, request, restoredAttempt, setSelectedAccountId, type]);

  const sourceAccount = accounts.find((account) => account.id === sourceAccountId);
  const destinationAccount = destinationLookup?.id === destinationAccountId
    ? destinationLookup
    : accounts.find((account) => account.id === destinationAccountId);
  const sourceBalance = balances[sourceAccountId];
  const destinationBalance = balances[destinationAccountId];
  const isTransfer = type === 'transfer';
  const isDeposit = type === 'deposit';

  // Restore the recipient details when a saved transfer is reopened after a reload.
  useEffect(() => {
    if (type !== 'transfer' || !destinationAccountId || destinationLookup || accountsLoading) return;
    if (accounts.some((account) => account.id === destinationAccountId)) return;
    let cancelled = false;
    request('/api/accounts/lookup', { method: 'POST', body: { accountId: destinationAccountId } })
      .then((result) => { if (!cancelled) setDestinationLookup(result.account); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [type, destinationAccountId, destinationLookup, accounts, accountsLoading, request]);

  async function lookupDestination() {
    const number = destinationNumber.trim();
    if (!number) { setLookupError('Enter the destination account number.'); return; }
    setLookupBusy(true);
    setLookupError('');
    try {
      const result = await request('/api/accounts/lookup', { method: 'POST', body: { accountNumber: number } });
      if (result.account.id === sourceAccountId) {
        setDestinationLookup(null);
        setDestinationAccountId('');
        setLookupError('Source and destination accounts must be different.');
      } else {
        setDestinationLookup(result.account);
        setDestinationAccountId(result.account.id);
      }
    } catch (err) {
      setDestinationLookup(null);
      setDestinationAccountId('');
      setLookupError(err.status === 404 ? 'No active account was found with that number.' : err.message || 'The account could not be looked up.');
    } finally {
      setLookupBusy(false);
    }
  }

  function resetForNewTransaction() {
    clearPendingTransaction(user.id, details.type);
    setAttempt(null);
    setOutcome(null);
    setAmount('');
    setAmountError('');
    setStage('form');
  }

  function reviewTransaction(event) {
    event.preventDefault();
    setAmountError('');
    let amountPaise;
    try {
      amountPaise = parseInrToPaise(amount);
    } catch (error) {
      setAmountError(error.message);
      return;
    }
    if (!sourceAccountId || !sourceAccount) {
      setAmountError('Choose an account returned by your account list.');
      return;
    }
    if (isTransfer && (!destinationAccountId || !destinationAccount)) {
      setAmountError('Enter a destination account number and select Find account first.');
      return;
    }
    if (isTransfer && sourceAccountId === destinationAccountId) {
      setAmountError('Source and destination accounts must be different.');
      return;
    }

    const payload = {
      type: details.type,
      ...(isDeposit ? { accountId: sourceAccountId } : {}),
      ...(type === 'withdrawal' ? { accountId: sourceAccountId } : {}),
      ...(isTransfer ? { sourceAccountId, destinationAccountId } : {}),
      amountPaise,
    };

    if (attempt?.state === 'uncertain' && attempt.payloadKey !== undefined) {
      setOutcome({ kind: 'uncertain', message: 'This request has an uncertain result. Retry the exact same details with its existing key before starting any other transaction.' });
      setStage('result');
      return;
    }

    try {
      const prepared = createTransactionAttempt(attempt, payload);
      savePendingTransaction(user.id, details.type, prepared);
      setAttempt(prepared);
      setOutcome(null);
      setStage('review');
    } catch {
      setAmountError('A secure transaction key could not be prepared. Check browser storage and use a supported secure browser.');
    }
  }

  async function submitPrepared(prepared = attempt) {
    if (!prepared || !submissionGuard.current.tryBegin()) return;
    setSubmitting(true);
    setOutcome(null);
    const inFlightAttempt = { ...prepared, state: 'uncertain' };
    try {
      // Persist the retry key before sending bytes. A reload or route change
      // during the request must restore an uncertain attempt, not a new draft.
      savePendingTransaction(user.id, details.type, inFlightAttempt);
      setAttempt(inFlightAttempt);
    } catch {
      setOutcome({ kind: 'error', message: 'The request was not sent because its idempotency key could not be saved safely.' });
      setStage('result');
      submissionGuard.current.finish();
      setSubmitting(false);
      return;
    }
    try {
      const { type: _type, ...body } = inFlightAttempt.payload;
      const result = await request(details.endpoint, {
        method: 'POST',
        body,
        headers: { 'Idempotency-Key': inFlightAttempt.idempotencyKey },
      });
      if (result.status !== 'POSTED' || !result.journalTransactionId) {
        const unexpected = new ApiError('The server response did not confirm a posted transaction.', 502, result);
        throw unexpected;
      }
      clearPendingTransaction(user.id, details.type);
      setAttempt(null);
      setOutcome({ kind: 'posted', result, payload: inFlightAttempt.payload });
      setStage('result');
      refreshAccounts();
    } catch (error) {
      if (error?.payload?.status === 'REFUSED') {
        clearPendingTransaction(user.id, details.type);
        setAttempt(null);
        setOutcome({ kind: 'refused', reason: error.payload.reason, message: getReason(error), payload: inFlightAttempt.payload, httpStatus: error.status });
        setStage('result');
        refreshAccounts();
      } else if (error?.payload?.error === 'idempotency_key_conflict') {
        const conflictAttempt = { ...inFlightAttempt, state: 'conflict' };
        try { savePendingTransaction(user.id, details.type, conflictAttempt); } catch { /* the conflict is still shown for this page */ }
        setAttempt(conflictAttempt);
        setOutcome({ kind: 'conflict', message: 'This idempotency key belongs to a different request. No new key was generated automatically.' });
        setStage('result');
      } else if (error instanceof ApiError && (error.status === 0 || error.status >= 500)) {
        const uncertainAttempt = { ...inFlightAttempt, state: 'uncertain' };
        try { savePendingTransaction(user.id, details.type, uncertainAttempt); } catch { /* keep the in-memory key available for same-page retry */ }
        setAttempt(uncertainAttempt);
        setOutcome({ kind: 'uncertain', message: 'The server did not confirm the result. The transaction may have completed. Retry this exact request with the same key; do not start a new transaction.' });
        setStage('result');
      } else {
        const retryableAttempt = { ...inFlightAttempt, state: 'review' };
        try { savePendingTransaction(user.id, details.type, retryableAttempt); } catch { /* in-memory retry uses the original key */ }
        setAttempt(retryableAttempt);
        setOutcome({ kind: 'error', message: error instanceof ApiError ? getReason(error) : 'The request could not be completed.', payload: inFlightAttempt.payload });
        setStage('result');
      }
    } finally {
      submissionGuard.current.finish();
      setSubmitting(false);
    }
  }

  const displayAmount = (paise) => formatPaiseAsINR(paise, 'INR');
  const sourceBalancePaise = sourceBalance && !sourceBalance.error ? BigInt(sourceBalance.balancePaise) : null;
  let exceedsBalance = false;
  try {
    exceedsBalance = (type === 'withdrawal' || isTransfer) && sourceBalancePaise !== null
      && amount.trim() !== '' && BigInt(parseInrToPaise(amount)) > sourceBalancePaise;
  } catch {
    // The field-level validation below describes malformed or out-of-range values.
  }

  return (
    <section className="transaction-page">
      <button className="back-link" onClick={() => onNavigate('/dashboard')}>← <span>Back to overview</span></button>
      <div className="transaction-page-heading"><span className="section-kicker">SECURE MONEY MOVEMENT</span><h1>{details.title}</h1><p>{details.intro}</p></div>

      {accountsLoading ? <div className="loading-row"><span className="spinner spinner-dark" />Loading permitted accounts</div>
        : accountError ? <div className="account-error-panel" role="alert"><span className="error-mark">!</span><div><strong>Accounts could not be loaded</strong><p>{accountError}</p></div><button className="button button-outline" onClick={() => refreshAccounts()}>Retry</button></div>
          : accounts.length === 0 ? <div className="empty-state transaction-empty"><strong>No accounts available</strong><p>Money movement requires an account returned by your account access list.</p></div>
            : stage === 'form' ? (
              <form className="transaction-form-card" onSubmit={reviewTransaction}>
                <div className="transaction-form-top"><span className="transaction-type-mark">{isDeposit ? '↓' : isTransfer ? '↗' : '↑'}</span><div><strong>{details.title} details</strong><small>Amounts are entered in Indian rupees (INR).</small></div></div>
                <div className={`transaction-fields ${isTransfer ? 'transaction-fields-transfer' : ''}`}>
                  <label className="field-label"><span>{isDeposit ? 'Deposit to account' : isTransfer ? 'From account' : 'Withdraw from account'}</span><select value={sourceAccountId} onChange={(event) => { setSourceAccountId(event.target.value); setSelectedAccountId(event.target.value); if (isTransfer && event.target.value === destinationAccountId) { setDestinationAccountId(''); setDestinationLookup(null); } }} required><option value="" disabled>Select an account</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.accountNumber} · {account.type}</option>)}</select></label>
                  {isTransfer && <div className="field-label"><label htmlFor="destination-number"><span>To account number</span></label><div style={{ display: 'flex', gap: '8px' }}><input id="destination-number" type="text" inputMode="numeric" autoComplete="off" maxLength={64} value={destinationNumber} placeholder="Enter account number" onChange={(event) => { setDestinationNumber(event.target.value); setDestinationLookup(null); setDestinationAccountId(''); setLookupError(''); }} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); lookupDestination(); } }} /><button type="button" className="button button-outline" onClick={lookupDestination} disabled={lookupBusy || destinationNumber.trim() === ''}>{lookupBusy ? 'Checking…' : 'Find account'}</button></div>{lookupError && <p role="alert" className="form-error">{lookupError}</p>}</div>}
                  <label className="field-label amount-field"><span>Amount</span><span className="amount-input-wrap"><span aria-hidden="true">₹</span><input type="text" inputMode="decimal" autoComplete="off" maxLength={24} value={amount} onChange={(event) => { setAmount(event.target.value); setAmountError(''); }} placeholder="0.00" aria-describedby="amount-help" required /></span><small id="amount-help" className="field-hint">Up to two decimal places. The server rechecks available funds before posting.</small></label>
                </div>
                {sourceAccount && <div className="selected-account-summary"><span className="account-summary-icon">{sourceAccount.type === 'BUSINESS' ? 'B' : 'P'}</span><div><strong>{sourceAccount.accountNumber}</strong><small>{sourceAccount.type} · {sourceAccount.status} · {sourceAccount.currencyCode}</small></div>{sourceBalance && !sourceBalance.error && <span className="summary-balance">{formatPaiseAsINR(sourceBalance.balancePaise, sourceBalance.currencyCode)}</span>}</div>}
                {isTransfer && destinationAccount && <div className="selected-account-summary destination-summary"><span className="account-summary-icon">{destinationAccount.type === 'BUSINESS' ? 'B' : 'P'}</span><div><strong>{destinationAccount.accountNumber}</strong><small>Recipient{destinationAccount.holderName ? ` · ${destinationAccount.holderName}` : ''} · {destinationAccount.status} · {destinationAccount.currencyCode}</small></div>{destinationBalance && !destinationBalance.error && <span className="summary-balance">{formatPaiseAsINR(destinationBalance.balancePaise, destinationBalance.currencyCode)}</span>}</div>}
                {sourceBalance?.error && <p className="balance-unavailable-note">The current balance could not be loaded. The server will validate the transaction.</p>}
                {exceedsBalance && <div className="balance-warning" role="status">The amount exceeds the displayed balance. The backend is authoritative and will refuse an overdraft.</div>}
                {amountError && <div className="form-error" role="alert"><span>!</span>{amountError}</div>}
                <div className="transaction-form-footer"><span><i /> All postings are confirmed by the secure ledger.</span><button className="button button-primary" type="submit">Review {details.verb}<span aria-hidden="true">→</span></button></div>
              </form>
            ) : stage === 'review' ? (
              <div className="transaction-review-card" role="region" aria-labelledby="transaction-review-title">
                <div className="review-topline"><span className="section-kicker">FINAL CHECK</span><span className="review-step">STEP 2 OF 2</span></div>
                <h2 id="transaction-review-title">Review your {details.verb}</h2><p className="review-description">Check the details carefully before sending this request to the ledger.</p>
                <div className="review-route"><ReviewParty label={isDeposit ? 'DEPOSIT TO' : 'FROM'} account={sourceAccount ?? accountFromPayload(accounts, attempt?.payload, 'source')} />{isTransfer ? <><span className="review-route-arrow">→</span><ReviewParty label="TRANSFER TO" account={destinationAccount ?? accountFromPayload(accounts, attempt?.payload, 'destination')} /></> : null}</div>
                <div className="review-amount"><span>AMOUNT</span><strong>{attempt?.payload?.amountPaise ? displayAmount(attempt.payload.amountPaise) : '—'}</strong></div>
                <div className="idempotency-note"><span className="idempotency-lock">✓</span><p>A unique request key is saved for this transaction. If the connection is interrupted, retrying uses the same key and payload.</p></div>
                <div className="review-actions"><button className="button button-outline" onClick={() => setStage('form')} disabled={submitting}>Back to edit</button><button className="button button-primary" onClick={() => submitPrepared()} disabled={submitting}>{submitting ? <><span className="spinner" />Submitting…</> : <>Confirm and submit <span aria-hidden="true">→</span></>}</button></div>
              </div>
            ) : <TransactionResult outcome={outcome} attempt={attempt} submitting={submitting} onRetry={() => submitPrepared(attempt)} onEdit={() => setStage('form')} onNew={resetForNewTransaction} accounts={accounts} destinationLookup={destinationLookup} onNavigate={onNavigate} />}

      <p className="transaction-security-note">No balance is changed in the browser. The backend authorizes each request, enforces idempotency, and confirms ledger postings.</p>
    </section>
  );
}

function ReviewParty({ label, account }) {
  return <div className="review-party"><span>{label}</span><strong>{account?.accountNumber ?? 'Selected account'}</strong><small>{account ? `${account.holderName ? `${account.holderName} · ` : ''}${account.type} · ${account.currencyCode}` : 'Account details unavailable'}</small></div>;
}

function accountFromPayload(accounts, payload, side) {
  const id = side === 'destination' ? payload?.destinationAccountId : payload?.sourceAccountId ?? payload?.accountId;
  return accounts.find((account) => account.id === id);
}

function TransactionResult({ outcome, attempt, submitting, onRetry, onEdit, onNew, accounts, destinationLookup, onNavigate }) {
  if (!outcome) return <div className="transaction-result-card"><div className="loading-row"><span className="spinner spinner-dark" />Preparing transaction result</div></div>;
  const posted = outcome.kind === 'posted';
  const refused = outcome.kind === 'refused';
  const uncertain = outcome.kind === 'uncertain';
  const conflict = outcome.kind === 'conflict';
  const payload = outcome.payload ?? attempt?.payload;
  const amountPaise = outcome.result?.amountPaise ?? payload?.amountPaise;
  const reference = outcome.result?.journalTransactionId;
  const typeName = payload?.type === 'DEPOSIT' ? 'Deposit' : payload?.type === 'WITHDRAWAL' ? 'Withdrawal' : 'Transfer';

  return <section className={`transaction-result-card result-${outcome.kind}`} aria-live="polite" aria-labelledby="transaction-result-title">
    <span className={`result-mark ${posted ? 'result-mark-success' : refused ? 'result-mark-refused' : 'result-mark-pending'}`}>{posted ? '✓' : refused ? '!' : uncertain ? '…' : conflict ? '!' : '×'}</span>
    <span className="section-kicker">{posted ? 'LEDGER CONFIRMATION' : refused ? 'REQUEST REFUSED' : uncertain ? 'CONFIRMATION PENDING' : conflict ? 'IDEMPOTENCY CONFLICT' : 'REQUEST ERROR'}</span>
    <h2 id="transaction-result-title">{posted ? 'Transaction posted' : refused ? 'Transaction was not posted' : uncertain ? 'Result not confirmed' : conflict ? 'Request key conflict' : 'Transaction could not be completed'}</h2>
    <p className="result-message">{outcome.message ?? outcome.reason}</p>
    {(posted || refused) && <div className="result-receipt"><div><span>Type</span><strong>{typeName}</strong></div><div><span>Account</span><strong>{describeAccounts(payload, accounts, destinationLookup)}</strong></div><div><span>Amount</span><strong>{amountPaise ? formatPaiseAsINR(amountPaise) : '—'}</strong></div><div><span>Status</span><strong className={posted ? 'posted-text' : 'refused-text'}>{posted ? 'POSTED' : 'REFUSED'}</strong></div>{reference && <div><span>Journal reference</span><strong className="receipt-reference">{reference}</strong></div>}{outcome.reason && <div><span>Reason</span><strong>{outcome.reason.replaceAll('_', ' ')}</strong></div>}</div>}
    {uncertain && <div className="uncertain-warning"><strong>Do not create another request.</strong><span>Use “Retry same request” to check the original result. The original key and exact payload are retained.</span></div>}
    {conflict && <div className="uncertain-warning"><strong>No replacement key was created.</strong><span>Starting a new transaction is a separate money movement request. Continue only if that is intentional.</span></div>}
    <div className="result-actions">
      {uncertain && <button className="button button-primary" onClick={onRetry} disabled={submitting}>{submitting ? <><span className="spinner" />Checking…</> : 'Retry same request'}</button>}
      {outcome.kind === 'error' && <button className="button button-outline" onClick={onEdit}>Edit details</button>}
      {(posted || refused || conflict || outcome.kind === 'error') && <button className="button button-outline" onClick={onNew}>Start another transaction</button>}
      {posted && payload?.type === 'TRANSFER' && reference && accounts.some((account) => account.id === payload.destinationAccountId) && <button className="button button-primary" onClick={() => onNavigate(`/transfers/${encodeURIComponent(reference)}`)}>View transfer details</button>}
      {(posted || refused) && <span className="result-confirmed-note">{posted ? 'Confirmed by the backend.' : 'Refusal recorded by the backend.'}</span>}
    </div>
  </section>;
}

function describeAccounts(payload, accounts, destinationLookup) {
  const sourceId = payload?.sourceAccountId ?? payload?.accountId;
  const destinationId = payload?.destinationAccountId;
  const source = accounts.find((account) => account.id === sourceId)?.accountNumber ?? 'Account';
  if (!destinationId) return source;
  const destination = accounts.find((account) => account.id === destinationId)?.accountNumber
    ?? (destinationLookup?.id === destinationId ? destinationLookup.accountNumber : 'Account');
  return `${source} → ${destination}`;
}
