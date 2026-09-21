import React, { Component, ReactNode } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import './styles.css';

class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return <div className="mobile-bg"><div className="mobile-frame"><div className="ticket-success"><span>!</span><h1>页面加载失败</h1><p>{this.state.error.message || '请返回活动平台重新打开预览。'}</p><button type="button" onClick={() => window.location.reload()}>重新加载</button></div></div></div>;
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><AppErrorBoundary><BrowserRouter><App /></BrowserRouter></AppErrorBoundary></React.StrictMode>,
);
