import './monaco-setup'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { initHighlighting } from './editor/highlight'
import './styles.css'
import '@xterm/xterm/css/xterm.css'

// VSCode-grade syntax highlighting (async; colors swap in once ready).
initHighlighting()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
