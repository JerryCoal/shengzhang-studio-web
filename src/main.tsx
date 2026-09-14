import React, { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import './readability.css';
import './workflow.css';
import { IS_WEB, LOCAL_DATA } from './api';
const WebAuth = lazy(() => import('./WebAuth'));
const LocalAuth = lazy(() => import('./LocalAuth'));
const BackendAuth = lazy(() => import('./BackendAuth'));

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: boolean }> {
  state = { error: false };
  static getDerivedStateFromError() { return { error: true }; }
  render() { return this.state.error ? <div className="boot-screen"><h2>页面遇到一点问题</h2><p>已保存的项目仍在。刷新后继续。</p><button className="button primary" onClick={() => location.reload()}>重新打开</button></div> : this.props.children; }
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><ErrorBoundary><Suspense fallback={<div className="boot-screen">正在打开本地工作区…</div>}>{IS_WEB ? <WebAuth/> : LOCAL_DATA ? <LocalAuth/> : <BackendAuth/>}</Suspense></ErrorBoundary></React.StrictMode>);
if (import.meta.env.PROD && 'serviceWorker' in navigator && !location.protocol.startsWith('capacitor')) navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {});
