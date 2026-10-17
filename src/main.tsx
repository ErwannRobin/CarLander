import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/base.css';
import App from './App';

// @react-three/fiber 9 still constructs THREE.Clock internally, which three r186 flags as deprecated
// once per canvas. Nothing in this codebase uses Clock; keep the console clean of that upstream notice.
const warn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].startsWith('THREE.Clock: This module has been deprecated')) return;
  warn(...args);
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
