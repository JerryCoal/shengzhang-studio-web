import { useEffect, useState } from 'react';
import { api } from './api';
import App from './App';
import LocalAuth from './LocalAuth';

export default function BackendAuth() {
  const [status, setStatus] = useState<'loading' | 'profiles' | 'legacy' | 'error'>('loading');
  const [username, setUsername] = useState(''); const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [remembered, setRemembered] = useState<{ id: string; username: string }[]>([]);
  const [rememberSupported, setRememberSupported] = useState(false);
  const loadRemembered = async () => { const value = await api<{ supported: boolean; users: { id: string; username: string }[] }>('/profiles/remembered'); setRemembered(value.users); setRememberSupported(value.supported); };
  useEffect(() => { if (status === 'profiles' && !username) void loadRemembered().catch(() => {}); }, [status, username]);
  useEffect(() => {
    let active = true;
    const locked = () => { sessionStorage.removeItem('studio-session'); setUsername(''); };
    window.addEventListener('studio-auth-required', locked);
    void (async () => {
      try {
        const health = await api<{ authMode?: string }>('/health');
        if (!active) return;
        if (health.authMode !== 'profiles') { setStatus('legacy'); return; }
        if (sessionStorage.getItem('studio-session')) {
          try { const identity = await api<{ username: string }>('/profiles/session'); if (active) setUsername(identity.username); }
          catch { sessionStorage.removeItem('studio-session'); }
        }
        if (active) setStatus('profiles');
      } catch { if (active) { setStatus('error'); setError('本地服务暂时没有响应。请确认 Windows 应用正在运行，然后重试。'); } }
    })();
    return () => { active = false; window.removeEventListener('studio-auth-required', locked); };
  }, [retry]);
  if (status === 'loading') return <div className="boot-screen">正在连接本地工作区…</div>;
  if (status === 'error') return <div className="boot-screen"><h2>暂时无法连接工作区</h2><p>{error}</p><button className="button primary" onClick={() => { setStatus('loading'); setRetry(retry + 1); }}>重新连接</button></div>;
  if (status === 'legacy') return <App/>;
  const authenticate = async (mode: 'login' | 'register', name: string, password: string, remember = false) => {
    const result = await api<{ token: string; username: string }>(`/profiles/${mode}`, 'POST', { username: name, password, remember });
    sessionStorage.setItem('studio-session', result.token); setUsername(result.username); return result.username;
  };
  const logout = async () => { await api('/profiles/logout', 'POST'); sessionStorage.removeItem('studio-session'); localStorage.removeItem('studio-project'); setUsername(''); };
  const quick = async (id: string) => { const value = await api<{ token: string; username: string }>('/profiles/quick', 'POST', { id }); sessionStorage.setItem('studio-session', value.token); setUsername(value.username); return value.username; };
  const forget = async (id: string) => { await api(`/profiles/remembered/${id}`, 'DELETE'); await loadRemembered(); };
  return <LocalAuth backend={{ username, authenticate, logout, remembered, rememberSupported, quick, forget }}/>;
}
