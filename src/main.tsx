import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './state/auth';
import { AppProvider } from './state/app';
import { CausalProvider } from './state/causal';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      <AuthProvider>
        <AppProvider>
          <CausalProvider>
            <App />
          </CausalProvider>
        </AppProvider>
      </AuthProvider>
    </HashRouter>
  </React.StrictMode>,
);
