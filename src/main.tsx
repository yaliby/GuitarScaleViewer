import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { isTauri } from '@tauri-apps/api/core';
import App from './App';
import { trace } from './services/debugLog';
import './index.css';

trace('boot', 'ui.mount', 'React UI mounting', {
  tauri: isTauri(),
  mode: import.meta.env.MODE,
  dev: import.meta.env.DEV,
}, 'start');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
