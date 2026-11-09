import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { apiRequest } from '../lib/api.js';

const STORAGE_KEY = 'balancevault.session.v1';
const AuthContext = createContext(null);

function readSession() {
  try {
    const value = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null');
    if (!value?.accessToken || !value?.user?.id || !value?.user?.email
      || !Number.isFinite(value?.expiresAt) || value.expiresAt <= Date.now()) {
      sessionStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return value;
  } catch {
    sessionStorage.removeItem(STORAGE_KEY);
    return null;
  }
}

export function AuthProvider({ children }) {
  const [session, setSession] = useState(readSession);
  const [accountRefreshVersion, setAccountRefreshVersion] = useState(0);
  const [selectedAccountId, setSelectedAccountId] = useState(null);

  const logout = useCallback(() => {
    sessionStorage.removeItem(STORAGE_KEY);
    setSession(null);
    setSelectedAccountId(null);
  }, []);

  const refreshAccounts = useCallback(() => setAccountRefreshVersion((version) => version + 1), []);
  const updateUser = useCallback((user) => setSession((current) => {
    if (!current) return current;
    const next = { ...current, user: { ...current.user, ...user } };
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    return next;
  }), []);

  const acceptAuthentication = useCallback((result) => {
    if (!result?.accessToken || !result?.user?.id || !result?.user?.email) {
      throw new Error('The server returned an invalid authentication response.');
    }
    const nextSession = {
      accessToken: result.accessToken,
      user: result.user,
      expiresAt: Date.now() + (Number(result.expiresIn) || 900) * 1000,
    };
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(nextSession));
    setSession(nextSession);
    return result.user;
  }, []);

  const login = useCallback(async ({ email, password }) => {
    const result = await apiRequest('/api/auth/login', {
      method: 'POST',
      body: { email: email.trim().toLowerCase(), password },
    });
    return acceptAuthentication(result);
  }, [acceptAuthentication]);

  const register = useCallback(async ({ name, email, password }) => {
    const result = await apiRequest('/api/auth/register', {
      method: 'POST',
      body: { name: name.trim(), email: email.trim().toLowerCase(), password },
    });
    return acceptAuthentication(result);
  }, [acceptAuthentication]);

  const acceptInvitation = useCallback(async ({ token, password }) => {
    const result = await apiRequest('/api/auth/accept-invitation', {
      method: 'POST',
      body: { token, password },
    });
    return acceptAuthentication(result);
  }, [acceptAuthentication]);

  const request = useCallback((path, options = {}) => apiRequest(path, {
    ...options,
    token: session?.accessToken,
    onUnauthorized: logout,
  }), [logout, session?.accessToken]);

  const value = useMemo(() => ({
    user: session?.user ?? null,
    accessToken: session?.accessToken ?? null,
    isAuthenticated: Boolean(session?.accessToken),
    login,
    register,
    acceptInvitation,
    logout,
    request,
    accountRefreshVersion,
    refreshAccounts,
    selectedAccountId,
    setSelectedAccountId,
    updateUser,
  }), [accountRefreshVersion, login, logout, refreshAccounts, register, request, selectedAccountId, session, updateUser]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
