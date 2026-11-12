import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatWidget } from './ChatWidget.js';
import './styles.css';

// An empty VITE_CHAT_API_URL, as copied from .env.example, means the default.
const configuredUrl = import.meta.env.VITE_CHAT_API_URL ?? '';
const apiUrl = configuredUrl === '' ? 'http://127.0.0.1:4100' : configuredUrl;
const root = document.getElementById('root');
if (root === null) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <ChatWidget apiUrl={apiUrl} instanceId="demo" />
  </StrictMode>,
);
