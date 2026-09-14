import { useEffect, useState } from 'react';
import LocalAuth from './LocalAuth';
import { forgetLocalUser, localUsername, lockLocalWorkspace, loginLocal, quickLoginLocal, registerLocal, rememberedLocalUsers, rememberLocalUser } from './local-vault';

export default function WebAuth() {
  const [username, setUsername] = useState(localUsername), [remembered, setRemembered] = useState<{ id: string; username: string }[]>([]);
  const reload = async () => setRemembered(await rememberedLocalUsers());
  useEffect(() => { const locked = () => { setUsername(''); void reload().catch(() => {}); }; window.addEventListener('studio-local-locked', locked); void reload().catch(() => {}); return () => window.removeEventListener('studio-local-locked', locked); }, []);
  return <LocalAuth backend={{ username, remembered, rememberSupported: true,
    authenticate: async (mode, name, password, remember) => { const result = await (mode === 'register' ? registerLocal : loginLocal)(name, password); if (remember) { try { await rememberLocalUser(); } catch { lockLocalWorkspace(); throw new Error('此浏览器无法保存快捷登录。用户已保留，请取消自动登录后用密码进入。'); } } setUsername(result); return result; },
    logout: async () => { lockLocalWorkspace(); setUsername(''); },
    quick: async id => { const result = await quickLoginLocal(id); setUsername(result); return result; },
    forget: async id => { await forgetLocalUser(id); await reload(); },
  }}/>;
}
