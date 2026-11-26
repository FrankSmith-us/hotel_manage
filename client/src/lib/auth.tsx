import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { apiFetch, getToken, setToken } from './api';

export interface UserInfo {
  id: number;
  username: string;
  display_name: string;
  role: string;
  role_label: string;
  employee_id: number | null;
  hotel_id: number | null;
  region_id: number | null;
  hotel_name: string | null;
  hotel_code: string | null;
  region_name: string | null;
}

export interface DemoAccount {
  id: number;
  username: string;
  display_name: string;
  role: string;
  role_label: string;
  hotel_name: string | null;
  region_name: string | null;
}

interface AuthContextValue {
  user: UserInfo | null;
  loading: boolean;
  demoAccounts: DemoAccount[];
  demoSwitchEnabled: boolean;
  login: (username: string, password: string) => Promise<void>;
  switchDemoAccount: (username: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [demoAccounts, setDemoAccounts] = useState<DemoAccount[]>([]);
  const [demoSwitchEnabled, setDemoSwitchEnabled] = useState(false);

  const loadDemoAccounts = useCallback(async () => {
    try {
      const data = await apiFetch<{ enabled: boolean; accounts: DemoAccount[] }>('/api/auth/demo-accounts');
      setDemoSwitchEnabled(data.enabled);
      setDemoAccounts(data.accounts || []);
    } catch {
      setDemoSwitchEnabled(false);
    }
  }, []);

  useEffect(() => {
    (async () => {
      await loadDemoAccounts();
      const token = getToken();
      if (token) {
        try {
          const data = await apiFetch<{ user: UserInfo }>('/api/auth/me');
          setUser(data.user);
        } catch {
          setToken(null);
          setUser(null);
        }
      }
      setLoading(false);
    })();
  }, [loadDemoAccounts]);

  const login = async (username: string, password: string) => {
    const data = await apiFetch<{ token: string; user: UserInfo }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    setToken(data.token);
    setUser(data.user);
  };

  const switchDemoAccount = async (username: string) => {
    const data = await apiFetch<{ token: string; user: UserInfo }>('/api/auth/demo-switch', {
      method: 'POST',
      body: JSON.stringify({ username }),
    });
    setToken(data.token);
    setUser(data.user);
  };

  const logout = () => {
    setToken(null);
    setUser(null);
  };

  return (
    <AuthContext.Provider
      value={{ user, loading, demoAccounts, demoSwitchEnabled, login, switchDemoAccount, logout }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
