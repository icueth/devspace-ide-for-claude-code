import React from 'react';
import ReactDOM from 'react-dom/client';

import App from './App';
import './index.css';

// Bundled fonts. JetBrains Mono covers Latin/Cyrillic/Greek (programming
// glyphs); Sarabun covers Thai (designed by Cadson Demak — tighter
// metrics than macOS Sukhumvit Set so vowels เ/ไ/ใ/แ don't drift away
// from their base consonant in a monospace cell). Browser CSS routes
// each char to whichever bundled font has the matching unicode-range.
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/700.css';
import '@fontsource/sarabun/400.css';
import '@fontsource/sarabun/700.css';

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
