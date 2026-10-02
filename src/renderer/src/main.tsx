import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { CrashScreen, reportRendererErrors } from './components/CrashScreen'
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
import './styles/scheduler.css'
import './styles/extension.css'
import './styles/computer.css'
import './styles/models.css'
import './styles/workers.css'
import '@xterm/xterm/css/xterm.css'
import './styles/terminal.css'
import './styles/discord.css'
import './styles/channels.css'
import './styles/trading.css'
import './styles/email.css'

reportRendererErrors()

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <CrashScreen>
      <App />
    </CrashScreen>
  </StrictMode>
)
