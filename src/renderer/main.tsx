import React from 'react';
import ReactDOM from 'react-dom/client';

import App from './App';
import './index.css';

console.log('[renderer] boot start', {
  hasDevspace: typeof (window as unknown as { devspace?: unknown }).devspace !== 'undefined',
});

window.addEventListener('error', (e) => {
  console.error('[renderer] window.error', e.message, e.filename, e.lineno);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[renderer] unhandledrejection', e.reason);
});

try {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
  console.log('[renderer] react mounted');
} catch (err) {
  console.error('[renderer] mount error', err);
  const root = document.getElementById('root');
  if (root) {
    root.innerHTML = `<pre style="color:#f88;padding:1rem;font-family:monospace">Renderer mount failed:\n${String(err)}</pre>`;
  }
}
