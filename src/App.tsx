import { Suspense, lazy, useEffect, useState } from 'react'
import { Icon } from './components/Icon'
import { ToastProvider } from './components/Toast'
import { useI18n } from './i18n'

// the PDF engines are large: load each tool only when it is opened
const Editor = lazy(() => import('./editor/Editor').then((m) => ({ default: m.Editor })))
const MergeTool = lazy(() => import('./tools/MergeTool').then((m) => ({ default: m.MergeTool })))
const SplitTool = lazy(() => import('./tools/SplitTool').then((m) => ({ default: m.SplitTool })))
const OcrTool = lazy(() => import('./tools/OcrTool').then((m) => ({ default: m.OcrTool })))
const SimpleToolPage = lazy(() => import('./tools/SimpleToolPage'))

type Group = 'edit' | 'organize' | 'convert' | 'secure'
interface ToolEntry {
  route: string
  title: string
  text: string
  icon: string
  color: string
  group: Group
  render: () => React.ReactNode
}

const simple = (id: string) => () => <SimpleToolPage id={id} />
const editor = (mode: 'edit' | 'sign' | 'fill' | 'redact' | 'organize') => () => <Editor key={mode} mode={mode} />

export const TOOLS: ToolEntry[] = [
  { route: 'edit', title: 'Edit PDF', text: 'Change existing text, add text, images, shapes, links and comments.', icon: 'editText', color: '#e5484d', group: 'edit', render: editor('edit') },
  { route: 'sign', title: 'Sign PDF', text: 'Draw, type or upload a signature and place it anywhere.', icon: 'sign', color: '#3e63dd', group: 'edit', render: editor('sign') },
  { route: 'fill', title: 'Fill form', text: 'Fill in PDF forms, tick boxes and sign — flat forms too.', icon: 'form', color: '#0090ff', group: 'edit', render: editor('fill') },
  { route: 'redact', title: 'Redact PDF', text: 'Permanently delete sensitive text and images. Search & black out.', icon: 'redact', color: '#1c2024', group: 'edit', render: editor('redact') },
  { route: 'ocr', title: 'OCR PDF', text: 'Make scanned PDFs searchable and copyable. 中文 / English / 日本語…', icon: 'ocr', color: '#8e4ec6', group: 'edit', render: () => <OcrTool /> },
  { route: 'watermark', title: 'Add watermark', text: 'Stamp text or a logo across pages.', icon: 'watermark', color: '#0d74ce', group: 'edit', render: simple('watermark') },
  { route: 'page-numbers', title: 'Page numbers', text: 'Add page numbers, headers and footers.', icon: 'hash', color: '#12a594', group: 'edit', render: simple('page-numbers') },

  { route: 'merge', title: 'Merge PDF', text: 'Combine several PDFs and images into one file, in any order.', icon: 'merge', color: '#30a46c', group: 'organize', render: () => <MergeTool /> },
  { route: 'split', title: 'Split PDF', text: 'Extract pages or split a PDF by ranges or every N pages.', icon: 'split', color: '#f76b15', group: 'organize', render: () => <SplitTool /> },
  { route: 'organize', title: 'Organize pages', text: 'Reorder, rotate, duplicate, delete and insert pages visually.', icon: 'organize', color: '#d6409f', group: 'organize', render: editor('organize') },
  { route: 'rotate', title: 'Rotate PDF', text: 'Rotate all or selected pages.', icon: 'rotateR', color: '#ab4aba', group: 'organize', render: simple('rotate') },
  { route: 'delete-pages', title: 'Delete pages', text: 'Remove pages you don’t need.', icon: 'trash', color: '#ce2c31', group: 'organize', render: simple('delete-pages') },
  { route: 'crop', title: 'Crop PDF', text: 'Trim page margins.', icon: 'crop', color: '#978365', group: 'organize', render: simple('crop') },
  { route: 'n-up', title: 'N-up (pages per sheet)', text: 'Print 2, 4, 6 or 9 pages on one sheet.', icon: 'grid', color: '#5b5bd6', group: 'organize', render: simple('n-up') },

  { route: 'pdf-to-images', title: 'PDF to JPG / PNG', text: 'Convert pages to images.', icon: 'photo', color: '#ffb224', group: 'convert', render: simple('pdf-to-images') },
  { route: 'images-to-pdf', title: 'Images to PDF', text: 'Turn photos and scans into a PDF.', icon: 'file', color: '#f76b15', group: 'convert', render: () => <MergeTool key="img" imagesOnly /> },
  { route: 'pdf-to-text', title: 'PDF to text', text: 'Extract all text as a .txt file.', icon: 'textFile', color: '#687076', group: 'convert', render: simple('pdf-to-text') },
  { route: 'extract-images', title: 'Extract images', text: 'Save every embedded picture at full quality.', icon: 'image', color: '#29a383', group: 'convert', render: simple('extract-images') },
  { route: 'excel-to-pdf', title: 'Excel to PDF', text: 'Turn spreadsheets into PDF tables.', icon: 'grid', color: '#1f9d55', group: 'convert', render: simple('excel-to-pdf') },
  { route: 'word-to-pdf', title: 'Word to PDF', text: 'Turn Word documents into PDF.', icon: 'textFile', color: '#2b579a', group: 'convert', render: simple('word-to-pdf') },
  { route: 'pdf-to-excel', title: 'PDF to Excel', text: 'Extract tables into an .xlsx workbook.', icon: 'grid', color: '#0e7c3e', group: 'convert', render: simple('pdf-to-excel') },
  { route: 'pdf-to-word', title: 'PDF to Word', text: 'Extract text into an editable .docx file.', icon: 'textFile', color: '#185abd', group: 'convert', render: simple('pdf-to-word') },

  { route: 'compress', title: 'Compress PDF', text: 'Make PDFs smaller for email and upload.', icon: 'compress', color: '#30a46c', group: 'secure', render: simple('compress') },
  { route: 'protect', title: 'Protect PDF', text: 'Add a password (AES-256) and permissions.', icon: 'lock', color: '#1c2024', group: 'secure', render: simple('protect') },
  { route: 'unlock', title: 'Unlock PDF', text: 'Remove a password you know.', icon: 'unlock', color: '#687076', group: 'secure', render: simple('unlock') },
  { route: 'flatten', title: 'Flatten PDF', text: 'Burn forms and annotations into the page.', icon: 'layers', color: '#3e63dd', group: 'secure', render: simple('flatten') },
  { route: 'repair', title: 'Repair PDF', text: 'Fix damaged PDFs that won’t open.', icon: 'wrench', color: '#f76b15', group: 'secure', render: simple('repair') },
  { route: 'metadata', title: 'Edit metadata', text: 'Change or wipe title, author and keywords.', icon: 'info', color: '#0090ff', group: 'secure', render: simple('metadata') },
]

const GROUPS: [Group, string][] = [
  ['edit', 'Edit & sign'],
  ['organize', 'Organize'],
  ['convert', 'Convert'],
  ['secure', 'Optimize & secure'],
]
const NAV = ['edit', 'sign', 'merge', 'split', 'compress']

const routeFromHash = () => window.location.hash.replace(/^#\/?/, '').split('?')[0]

interface InstallPrompt extends Event {
  prompt: () => Promise<void>
}

export default function App() {
  const { t, lang, setLang } = useI18n()
  const [route, setRoute] = useState(routeFromHash)
  const [install, setInstall] = useState<InstallPrompt | null>(null)
  const [online, setOnline] = useState(navigator.onLine)
  useEffect(() => {
    const on = () => {
      setRoute(routeFromHash())
      window.scrollTo(0, 0)
    }
    const bip = (e: Event) => {
      e.preventDefault()
      setInstall(e as InstallPrompt)
    }
    const net = () => setOnline(navigator.onLine)
    window.addEventListener('hashchange', on)
    window.addEventListener('beforeinstallprompt', bip)
    window.addEventListener('online', net)
    window.addEventListener('offline', net)
    return () => {
      window.removeEventListener('hashchange', on)
      window.removeEventListener('beforeinstallprompt', bip)
      window.removeEventListener('online', net)
      window.removeEventListener('offline', net)
    }
  }, [])

  const tool = TOOLS.find((x) => x.route === route)
  const fullHeight = ['edit', 'sign', 'fill', 'redact', 'organize'].includes(route)

  return (
    <ToastProvider>
      <div className={`app ${fullHeight ? 'full' : ''}`}>
        <header className="topbar">
          <a href="#/" className="brand">
            <img src="favicon.svg" alt="" width={26} height={26} />
            <span>
              {lang === 'zh' ? (
                <>
                  免费<b>PDF</b>编辑器
                </>
              ) : (
                <>
                  Free<b>PDF</b>Editor
                </>
              )}
            </span>
          </a>
          <nav>
            {NAV.map((r) => {
              const x = TOOLS.find((y) => y.route === r)!
              return (
                <a key={r} href={`#/${r}`} className={route === r ? 'active' : ''}>
                  {t(x.title)}
                </a>
              )
            })}
            <a href="#/" className={!tool ? 'active' : ''}>
              {t('All tools')}
            </a>
          </nav>
          <div className="topbar-right">
            {!online && <span className="offline-pill">{t('Offline')}</span>}
            <span className="privacy-pill" title={t('All processing happens in your browser')}>
              <Icon name="lock" size={14} /> <span className="pill-text">{t('Files never leave your device')}</span>
            </span>
            {install && (
              <button
                className="btn small"
                onClick={async () => {
                  await install.prompt()
                  setInstall(null)
                }}
              >
                <Icon name="install" size={15} /> {t('Install app')}
              </button>
            )}
            <button className="btn small lang" onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')} title={lang === 'zh' ? 'Switch to English' : '切换到中文'}>
              <Icon name="globe" size={15} /> {lang === 'zh' ? 'EN' : '中文'}
            </button>
          </div>
        </header>

        <main>
          <Suspense fallback={<div className="loading">{t('Loading…')}</div>}>{tool ? tool.render() : <Home />}</Suspense>
        </main>
      </div>
    </ToastProvider>
  )
}

function Home() {
  const { t } = useI18n()
  return (
    <div className="home">
      <section className="hero">
        <h1>{t('Free online PDF editor')}</h1>
        <p>{t('Edit text, sign, fill forms, redact, OCR, merge, split and compress PDFs — free, no sign-up, no watermark. Everything runs in your browser, so your documents are never uploaded. Install it and it works offline.')}</p>
        <a className="btn primary big" href="#/edit">
          <Icon name="upload" /> {t('Open a PDF')}
        </a>
      </section>
      {GROUPS.map(([g, label]) => (
        <section key={g} className="tool-group-section">
          <h2>{t(label)}</h2>
          <div className="cards">
            {TOOLS.filter((x) => x.group === g).map((c) => (
              <a key={c.route} className="card" href={`#/${c.route}`}>
                <span className="card-icon" style={{ background: c.color }}>
                  <Icon name={c.icon} size={22} />
                </span>
                <div>
                  <h3>{t(c.title)}</h3>
                  <p>{t(c.text)}</p>
                </div>
              </a>
            ))}
          </div>
        </section>
      ))}
      <section className="features">
        <div>
          <h3>{t('Private by design')}</h3>
          <p>{t('PDFs are opened and rewritten locally with pdf.js, pdf-lib and MuPDF (WebAssembly). No server ever sees your file.')}</p>
        </div>
        <div>
          <h3>{t('Real editing, real redaction')}</h3>
          <p>{t('Rewritten and redacted text is deleted from the file, not just covered. Chinese, Japanese and Korean text is embedded as real, searchable text.')}</p>
        </div>
        <div>
          <h3>{t('Works offline')}</h3>
          <p>{t('Install the app from your browser. After the first visit every tool works without an internet connection.')}</p>
        </div>
      </section>
      <footer className="foot">{t('Free PDF Editor · open source · powered by pdf.js, pdf-lib, MuPDF and Tesseract')}</footer>
    </div>
  )
}


