import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles/tokens.css'
import './styles/app.css'
import './styles/chat.css'
import './styles/agent.css'
import './styles/work.css'
import './styles/controls.css'
import './styles/pages.css'
import './styles/settings.css'
import './styles/themes.css'
import './styles/code.css'
import './styles/pets.css'
import './styles/scheduler.css'
import './styles/extension.css'
import './styles/computer.css'
import './styles/models.css'

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>
)
