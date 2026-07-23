import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './status-app';

/**
 * React entry point.
 *
 * Mounts the dashboard App into the #root element served by
 * dist/index.html, wrapped in React StrictMode.
 */
createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <App />
    </StrictMode>,
);
