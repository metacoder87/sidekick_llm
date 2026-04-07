import React from 'react';
import ReactDOM from 'react-dom/client';

import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import './styles.css';

window.addEventListener('error', (event) => {
  console.error('Window error:', event.error || event.message);
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled rejection:', event.reason || event);
});

if (import.meta.env.DEV) {
  console.info('Sidekick renderer booting.', {
    bridgeAvailable: Boolean(window.sidekick),
  });
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
