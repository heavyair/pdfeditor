import { Suspense, lazy, useEffect, useState } from 'react'
import { Icon } from './components/Icon'
import { ToastProvider } from './components/Toast'

// the PDF engines are large: load each tool only when it is opened
const Editor = lazy(() => import('./editor/Editor').then((m) => ({ default: m.Editor })))
const MergeTool = lazy(() => import('./tools/MergeTool').then((m) => ({ default: m.MergeTool })))
const SplitTool = lazy(() => import('./tools/SplitTool').then((m) => ({ default: m.SplitTool })))

type Route = 'home' | 'edit' | 'sign' | 'merge' | 'split'

const routeFromHash = (): Route => {
  const h = window.location.hash.replace(/^#\/?/, '')
  return (['edit', 'sign', 'merge', 'split'] as Route[]).includes(h as Route) ? (h as Route) : 'home'
}

const CARDS: { route: Route; title: string; text: string; icon: string; color: string }[] = [
  { route: 'edit', title: 'Edit PDF', text: 'Change existing text, add text, images, shapes, highlights and drawings.', icon: 'editText', color: '#e5484d' },
  { route: 'sign', title: 'Sign PDF', text: 'Draw, type or upload a signature and place it anywhere.', icon: 'sign', color: '#3e63dd' },
  { route: 'merge', title: 'Merge PDF', text: 'Combine several PDFs and images into one file, in any order.', icon: 'merge', color: '#30a46c' },
  { route: 'split', title: 'Split PDF', text: 'Extract pages or split a PDF by ranges or every N pages.', icon: 'split', color: '#f76b15' },
]

export default function App() {
  const [route, setRoute] = useState<Route>(routeFromHash)
  useEffect(() => {
    const on = () => setRoute(routeFromHash())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])

  return (
    <ToastProvider>
      <div className={`app route-${route}`}>
        <header className="topbar">
          <a href="#/" className="brand">
            <img src="/favicon.svg" alt="" width={26} height={26} />
            <span>
              Free<b>PDF</b>Editor
            </span>
          </a>
          <nav>
            {CARDS.map((c) => (
              <a key={c.route} href={`#/${c.route}`} className={route === c.route ? 'active' : ''}>
                {c.title}
              </a>
            ))}
          </nav>
          <span className="privacy-pill" title="All processing happens in your browser">
            <Icon name="lock" size={14} /> Files never leave your device
          </span>
        </header>

        <main>
          <Suspense fallback={<div className="loading">Loading…</div>}>
            {route === 'home' && <Home />}
            {route === 'edit' && <Editor key="edit" />}
            {route === 'sign' && <Editor key="sign" startWithSignature />}
            {route === 'merge' && <MergeTool />}
            {route === 'split' && <SplitTool />}
          </Suspense>
        </main>
      </div>
    </ToastProvider>
  )
}

function Home() {
  return (
    <div className="home">
      <section className="hero">
        <h1>Free online PDF editor</h1>
        <p>Edit text, add images and signatures, merge and split PDFs — free, no sign-up, no watermark. Everything runs in your browser, so your documents are never uploaded.</p>
        <a className="btn primary big" href="#/edit">
          <Icon name="upload" /> Open a PDF
        </a>
      </section>
      <section className="cards">
        {CARDS.map((c) => (
          <a key={c.route} className="card" href={`#/${c.route}`}>
            <span className="card-icon" style={{ background: c.color }}>
              <Icon name={c.icon} size={24} />
            </span>
            <h2>{c.title}</h2>
            <p>{c.text}</p>
          </a>
        ))}
      </section>
      <section className="features">
        <div>
          <h3>Private by design</h3>
          <p>PDFs are opened and rewritten locally with pdf.js and pdf-lib. No server ever sees your file.</p>
        </div>
        <div>
          <h3>Edit what's already there</h3>
          <p>Click any line of existing text to replace it. Use whiteout to hide anything else — images, stamps, numbers.</p>
        </div>
        <div>
          <h3>Organise pages</h3>
          <p>Reorder by drag and drop, rotate, duplicate, delete, insert blank pages or pages from another PDF.</p>
        </div>
      </section>
      <footer className="foot">Free PDF Editor · open source · works offline once loaded</footer>
    </div>
  )
}
