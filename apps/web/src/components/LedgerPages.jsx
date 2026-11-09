import { useEffect, useState } from 'react';
import { fetchAccounts, formatPaiseAsINR } from '../lib/accounts.js';
import { fetchAccountStatement, fetchAuditPage, fetchTransfer, formatStatementAmount, formatStatementBalance, statementDirection } from '../lib/ledger.js';

function dateTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Date unavailable' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function safeError(error, kind) {
  if (error?.status === 401) return 'Your session has expired. Sign in again to continue.';
  if (error?.status === 403) return kind === 'audit' ? 'Your current role cannot view audit records.' : 'You do not have permission to view this account.';
  if (error?.status === 404) return 'This record is unavailable or you no longer have permission to view it.';
  return error?.message || 'The request could not be completed. Please retry.';
}

export function StatementEvent({ event, currencyCode = 'INR', compact = false }) {
  const posted = event.status === 'POSTED';
  const direction = statementDirection(event);
  const kind = event.type[0] + event.type.slice(1).toLowerCase();
  return <article className={`statement-event ${compact ? 'statement-event-compact' : ''}`}>
    <span className={`statement-event-mark ${posted ? 'event-posted' : 'event-refused'}`} aria-hidden="true">{posted ? (direction === 'Credit' ? '↓' : '↑') : '!'}</span>
    <div className="statement-event-main">
      <div className="statement-event-title"><strong>{kind}</strong><span className={`event-status ${posted ? 'event-status-posted' : 'event-status-refused'}`}>{event.status}</span></div>
      <span className="statement-event-meta">{dateTime(event.timestamp)}{event.reference ? ` · Ref ${event.reference}` : ''}</span>
      {!compact && <div className="statement-event-extra"><span>{direction}</span><span>Actor role: {event.actor?.role ?? 'Unavailable'}</span>{event.refusalReason && <span>Reason: {event.refusalReason.replaceAll('_', ' ')}</span>}</div>}
    </div>
    <div className="statement-event-values"><strong className={posted && direction === 'Debit' ? 'amount-debit' : posted ? 'amount-credit' : ''}>{formatStatementAmount(event, currencyCode)}</strong><span>{posted ? `Balance ${formatStatementBalance(event, currencyCode)}` : `Balance unchanged · ${formatStatementBalance(event, currencyCode)}`}</span></div>
  </article>;
}

export function StatementPage({ request, selectedAccountId, setSelectedAccountId }) {
  const [accounts, setAccounts] = useState(null);
  const [accountId, setAccountId] = useState('');
  const [events, setEvents] = useState([]);
  const [account, setAccount] = useState(null);
  const [nextCursor, setNextCursor] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    fetchAccounts(request, { signal: controller.signal }).then((items) => {
      setAccounts(items);
      const initialId = items.some((item) => item.id === selectedAccountId) ? selectedAccountId : items[0]?.id ?? '';
      setAccountId((current) => items.some((item) => item.id === current) ? current : initialId);
      if (initialId) setSelectedAccountId(initialId);
    }).catch((err) => { if (err.name !== 'AbortError') setError(safeError(err, 'statement')); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [request, retry, selectedAccountId, setSelectedAccountId]);

  useEffect(() => {
    if (!accountId) { setEvents([]); setAccount(null); setNextCursor(null); return undefined; }
    const controller = new AbortController();
    setLoading(true); setError(''); setEvents([]); setNextCursor(null);
    fetchAccountStatement(request, accountId, { signal: controller.signal, limit: 25 }).then((result) => {
      setAccount(result.account); setEvents(result.events); setNextCursor(result.nextCursor);
    }).catch((err) => { if (err.name !== 'AbortError') setError(safeError(err, 'statement')); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [accountId, request, retry]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true); setError('');
    try {
      const result = await fetchAccountStatement(request, accountId, { limit: 25, cursor: nextCursor });
      setEvents((current) => [...current, ...result.events]);
      setNextCursor(result.nextCursor);
    } catch (err) { if (err.name !== 'AbortError') setError(safeError(err, 'statement')); }
    finally { setLoadingMore(false); }
  }

  return <section className="section-block full-page-block ledger-page">
    <div className="page-title-row"><div><span className="section-kicker">LEDGER</span><h1>Account statements</h1><p>Posted entries and recorded refusals in the order supplied by the ledger.</p></div></div>
    {accounts?.length > 0 && <label className="statement-account-select"><span>Choose account</span><select value={accountId} onChange={(event) => { setAccountId(event.target.value); setSelectedAccountId(event.target.value); }}>{accounts.map((item) => <option key={item.id} value={item.id}>{item.accountNumber} · {item.type} · {item.currencyCode}</option>)}</select></label>}
    {error && <div className="ledger-error" role="alert"><span>{error}</span><button className="button button-outline" onClick={() => setRetry((value) => value + 1)}>Retry</button></div>}
    {loading && <div className="loading-row"><span className="spinner spinner-dark" />Loading statement</div>}
    {!loading && !error && accounts?.length === 0 && <div className="empty-state"><strong>No accounts available</strong><p>Statements are available for accounts you can view.</p></div>}
    {!loading && !error && account && <><div className="statement-account-summary"><div><span className="section-kicker">{account.type}</span><strong>{account.accountNumber}</strong></div><span>{account.currencyCode}</span></div>
      {events.length === 0 ? <div className="empty-state"><strong>No statement events</strong><p>Posted entries and refused attempts will appear here.</p></div> : <div className="statement-list">{events.map((event) => <StatementEvent key={`${event.status}:${event.id}`} event={event} currencyCode={account.currencyCode} />)}</div>}
      {nextCursor && <div className="ledger-load-more"><button className="button button-outline" onClick={loadMore} disabled={loadingMore}>{loadingMore ? <><span className="spinner spinner-dark" />Loading more…</> : 'Load more'}</button></div>}
    </>}
  </section>;
}

export function TransferDetailsPage({ request, transferId, onNavigate }) {
  const [transfer, setTransfer] = useState(null); const [error, setError] = useState(''); const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setError(''); setTransfer(null);
    fetchTransfer(request, transferId, { signal: controller.signal }).then(setTransfer).catch((err) => { if (err.name !== 'AbortError') setError(safeError(err, 'transfer')); });
    return () => controller.abort();
  }, [request, transferId, retry]);
  const debit = transfer?.entries.find((entry) => BigInt(entry.amountPaise) < 0n);
  return <section className="section-block full-page-block ledger-page"><button className="back-link" onClick={() => onNavigate('/statements')}>← <span>Back to statements</span></button><div className="page-title-row"><div><span className="section-kicker">TRANSFER DETAILS</span><h1>Transfer</h1><p>Details returned by the BalanceVault transfer API.</p></div></div>
    {error && <div className="ledger-error" role="alert"><span>{error}</span><button className="button button-outline" onClick={() => setRetry((value) => value + 1)}>Retry</button></div>}
    {!transfer && !error && <div className="loading-row"><span className="spinner spinner-dark" />Loading transfer</div>}
    {transfer && <><div className="transfer-detail-summary"><div><span>Transaction ID</span><strong className="break-id">{transfer.id}</strong></div><div><span>Type</span><strong>{transfer.type}</strong></div><div><span>Status</span><strong className="event-status event-status-posted">{transfer.status}</strong></div><div><span>Amount</span><strong>{debit ? formatPaiseAsINR(BigInt(debit.amountPaise) * -1n, debit.account.currencyCode) : 'Unavailable'}</strong></div><div><span>Created</span><strong>{dateTime(transfer.createdAt)}</strong></div></div><h2 className="ledger-subheading">Account entries</h2><div className="transfer-entry-list">{transfer.entries.map((entry) => <article key={entry.account.id}><div><strong>{entry.account.accountNumber}</strong><span>{entry.account.type} · {entry.account.currencyCode}</span></div><strong>{formatPaiseAsINR(entry.amountPaise, entry.account.currencyCode)}</strong></article>)}</div></>}
  </section>;
}

export function AuditPage({ request }) {
  const [page, setPage] = useState(1); const [result, setResult] = useState(null); const [error, setError] = useState(''); const [loading, setLoading] = useState(true); const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    fetchAuditPage(request, page, 25, { signal: controller.signal }).then(setResult).catch((err) => { if (err.name !== 'AbortError') setError(safeError(err, 'audit')); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [page, request, retry]);
  return <section className="section-block full-page-block ledger-page"><div className="page-title-row"><div><span className="section-kicker">ADMINISTRATION</span><h1>Audit log</h1><p>Recorded actions with sensitive metadata redacted by the backend.</p></div></div>
    {error && <div className="ledger-error" role="alert"><span>{error}</span><button className="button button-outline" onClick={() => setRetry((value) => value + 1)}>Retry</button></div>}
    {loading && <div className="loading-row"><span className="spinner spinner-dark" />Loading audit events</div>}
    {!loading && !error && result?.events.length === 0 && <div className="empty-state"><strong>No audit events yet</strong><p>Recorded actions will appear here.</p></div>}
    {!loading && !error && result?.events.length > 0 && <><div className="audit-list">{result.events.map((event) => <article className="audit-row audit-row-detailed" key={event.id}><span className="audit-icon" aria-hidden="true">↗</span><div className="audit-main"><strong>{event.action.replaceAll('_', ' ').toLowerCase()}</strong><span>{event.entityType} · {event.actor.email} · {event.actor.role}</span><small className="audit-entity-id">Entity ID: {event.entityId}</small>{event.metadata != null && <pre className="audit-metadata">{JSON.stringify(event.metadata, null, 2)}</pre>}</div><time dateTime={event.createdAt}>{dateTime(event.createdAt)}</time></article>)}</div><div className="audit-pagination"><button className="button button-outline" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>Previous</button><span>Page {result.page}</span><button className="button button-outline" disabled={!result.hasMore} onClick={() => setPage((value) => value + 1)}>Next</button></div></>}
  </section>;
}
