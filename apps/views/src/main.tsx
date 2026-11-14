import { createRoot } from 'react-dom/client';
import { ViewApp } from './app';
import './index.css';

// No StrictMode: its double mount would run the MCP Apps handshake twice against the host.
createRoot(document.getElementById('root')!).render(<ViewApp />);
