import './bridge';
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import 'pdfjs-dist/web/pdf_viewer.css';
import './style.css';
createRoot(document.getElementById('root')!).render(<App />);

