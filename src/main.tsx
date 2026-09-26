import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// signature fonts, self-hosted (no third-party requests, available offline)
import '@fontsource/dancing-script/latin-600.css'
import '@fontsource/great-vibes/latin-400.css'
import '@fontsource/caveat/latin-600.css'
import './index.css'
import App from './App.tsx'
import { I18nProvider } from './i18n.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>,
)

// offline support: the service worker is generated at build time (build/pwa-plugin.ts)
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}))
}
