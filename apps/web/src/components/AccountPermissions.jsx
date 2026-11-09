import { useEffect, useState } from 'react';

const capabilities = [
  ['canDeposit', 'Deposit'],
  ['canWithdraw', 'Withdraw'],
  ['canTransfer', 'Transfer'],
];

function permissionValues(permission) {
  return Object.fromEntries(capabilities.map(([key]) => [key, permission[key]]));
}

export default function AccountPermissions({ accountId, request }) {
  const [open, setOpen] = useState(false);
  const [version, setVersion] = useState(0);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setData(null);
    setError('');
    request(`/api/admin/accounts/${accountId}/permissions`, { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setData(result); })
      .catch((err) => { if (err.name !== 'AbortError') setError(err.message); });
    return () => controller.abort();
  }, [accountId, request, open, version]);

  function reload() {
    setData(null);
    setVersion((value) => value + 1);
  }

  return <div className="account-permissions">
    <button className="button button-outline" type="button" aria-expanded={open}
      aria-controls={`permissions-${accountId}`} onClick={() => { setData(null); setOpen((value) => !value); }}>
      {open ? 'Close permissions' : 'Manage permissions'}
    </button>
    {open && <section id={`permissions-${accountId}`} aria-label="Account permissions" className="permissions-panel">
      <h3>Transaction permissions</h3>
      <p>Choose which transactions each assigned holder can perform on this account.</p>
      {error && <div role="alert" className="form-error">{error}</div>}
      {!data && !error && <p role="status">Loading permissions…</p>}
      {error && <button className="button button-outline" type="button" onClick={reload}>Reload permissions</button>}
      {data?.permissions.length === 0 && <p>No account holders with viewing access are assigned.</p>}
      {data?.permissions.map((permission) => <HolderPermissions
        key={`${version}-${permission.userId}`}
        accountId={accountId} permission={permission} request={request}
        accountActive={data.account.status === 'ACTIVE'}
        onReload={reload}
      />)}
    </section>}
  </div>;
}

function HolderPermissions({ accountId, permission, request, accountActive, onReload }) {
  const [saved, setSaved] = useState(() => permissionValues(permission));
  const [draft, setDraft] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [needsReload, setNeedsReload] = useState(false);
  const [adminPassword, setAdminPassword] = useState('');
  const editable = accountActive && permission.user.isActive;
  const dirty = capabilities.some(([key]) => draft[key] !== saved[key]);

  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await request(`/api/admin/accounts/${accountId}/permissions/${permission.userId}`, {
        method: 'PATCH',
        body: { ...draft, expected: saved, adminPassword },
      });
      const current = permissionValues(result);
      setSaved(current);
      setDraft(current);
      setAdminPassword('');
      setMessage(result.changed ? 'Permissions saved and recorded in the audit log.' : 'Permissions are already up to date.');
    } catch (err) {
      setError(err.message || 'Permissions could not be saved. Reload to check their current state.');
      setAdminPassword('');
      // A wrong password or throttle is retryable in place; other failures need a reload.
      if (err.status !== 403 && err.status !== 429) setNeedsReload(true);
      else if (err.message && !/password|attempts/i.test(err.message)) setNeedsReload(true);
    } finally {
      setBusy(false);
    }
  }

  return <form onSubmit={save} className="holder-permissions">
    <strong>{permission.user.fullName || permission.user.email}</strong>
    <p>{permission.user.email}</p>
    {!editable && <p>This account and holder must both be active to change permissions.</p>}
    <fieldset disabled={!editable || busy || needsReload}>
      <legend>Allowed transactions</legend>
      <div className="permission-options">
        {capabilities.map(([key, label]) => <label key={key}>
          <input type="checkbox" checked={draft[key]} onChange={(event) => {
            setDraft((current) => ({ ...current, [key]: event.target.checked }));
            setMessage('');
          }} />
          <span>{label}</span>
        </label>)}
      </div>
    </fieldset>
    <label className="field-label">
      <span>Confirm with your administrator password</span>
      <input type="password" autoComplete="current-password" value={adminPassword}
        onChange={(event) => setAdminPassword(event.target.value)} disabled={!editable || busy || needsReload} />
    </label>
    {error && <p role="alert" className="form-error">{error}</p>}
    {message && <p role="status">{message}</p>}
    <div className="permission-actions">
      <button type="submit" className="button button-primary" disabled={!editable || busy || !dirty || needsReload || adminPassword.length === 0}>
        {busy ? 'Saving…' : 'Save permissions'}
      </button>
      <button type="button" className="button button-outline" disabled={busy} onClick={onReload}>Reload permissions</button>
    </div>
  </form>;
}
