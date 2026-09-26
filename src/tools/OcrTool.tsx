import { useState } from 'react'
import { FileDrop } from '../components/FileDrop'
import { Icon } from '../components/Icon'
import { useToast } from '../components/Toast'
import { errorText, useI18n } from '../i18n'
import { exportPdf } from '../lib/exportPdf'
import { mu } from '../lib/mupdfClient'
import { OCR_LANGS, createOcr, defaultOcrLangs, renderForOcr } from '../lib/ocr'
import { isPasswordError, openPdf, pageInfo, type PDFDocumentProxy } from '../lib/pdfjs'
import type { PageModel } from '../lib/types'
import { baseName, downloadBytes, readFileBytes, uid } from '../lib/util'
import { fmtSize } from './SimpleTool'

export function OcrTool() {
  const { t, lang } = useI18n()
  const toast = useToast()
  const [file, setFile] = useState<{ name: string; bytes: Uint8Array; pdf: PDFDocumentProxy } | null>(null)
  const [langs, setLangs] = useState<string[]>(defaultOcrLangs(lang))
  const [skipText, setSkipText] = useState(true)
  const [progress, setProgress] = useState<{ done: number; total: number; status: string } | null>(null)
  const [text, setText] = useState<string | null>(null)

  const open = async (f: File) => {
    try {
      const bytes = await readFileBytes(f)
      const pdf = await openPdf(bytes)
      setFile({ name: f.name, bytes, pdf })
      setText(null)
    } catch (e) {
      toast(isPasswordError(e) ? t('This PDF is password protected. Remove the password with the Unlock tool first.') : errorText(t, e), 'error')
    }
  }

  const run = async () => {
    if (!file) return
    const n = file.pdf.numPages
    setProgress({ done: 0, total: n, status: 'loading engine' })
    let engine
    try {
      let done = 0
      engine = await createOcr(langs, (_p, status) => setProgress({ done, total: n, status }))
      const pages: PageModel[] = []
      const texts: string[] = []
      for (let i = 0; i < n; i++) {
        const info = await pageInfo(file.pdf, i)
        const pm: PageModel = { id: uid(), srcId: 's', srcIndex: i, width: info.width, height: info.height, view: info.view, baseRotation: info.rotation, rotation: 0, annots: [] }
        const tc = await (await file.pdf.getPage(i + 1)).getTextContent()
        const hasText = tc.items.some((it) => 'str' in it && it.str.trim())
        if (!(skipText && hasText)) {
          setProgress({ done, total: n, status: 'recognizing text' })
          const { canvas, scale } = await renderForOcr(file.pdf, i)
          const res = await engine.recognize(canvas, scale)
          pm.ocr = { words: res.words, lines: res.lines }
          texts.push(`${t('— Page {n} —', { n: i + 1 })}\n${res.text}`)
        } else {
          texts.push(`${t('— Page {n} —', { n: i + 1 })}\n${tc.items.map((it) => ('str' in it ? it.str + (it.hasEOL ? '\n' : '') : '')).join('')}`)
        }
        done++
        setProgress({ done, total: n, status: 'recognizing text' })
        pages.push(pm)
      }
      setProgress({ done: n, total: n, status: 'building PDF' })
      const out = await exportPdf([{ id: 's', bytes: file.bytes }], pages, { engine: mu })
      downloadBytes(out, `${baseName(file.name)}-ocr.pdf`)
      setText(texts.join('\n\n'))
      toast(t('Searchable PDF downloaded ({size})', { size: fmtSize(out.length) }), 'success')
    } catch (e) {
      toast(t('OCR failed: {msg}', { msg: errorText(t, e) }), 'error')
    } finally {
      await engine?.terminate()
      setProgress(null)
    }
  }

  return (
    <div className="tool-page">
      <h1>{t('OCR: make scans searchable')}</h1>
      <p className="lead">{t('Recognize text in scanned PDFs and add an invisible text layer, so you can search, select and copy it. Supports Chinese, English, Japanese, Korean and more.')}</p>
      {!file ? (
        <FileDrop accept="application/pdf,.pdf" title={t('Choose a PDF file')} hint={t('or drop it here · processed locally in your browser')} onFiles={(f) => open(f[0])} />
      ) : (
        <div className="simple-tool">
          <div className="st-file">
            <div className="st-meta">
              <div className="merge-name">{file.name}</div>
              <div className="muted">
                {fmtSize(file.bytes.length)} · {t('{n} pages', { n: file.pdf.numPages })}
              </div>
            </div>
            <label className="link">
              {t('Choose another file')}
              <input type="file" accept="application/pdf,.pdf" hidden onChange={(e) => e.target.files?.[0] && open(e.target.files[0])} />
            </label>
          </div>
          <div className="st-options">
            <div className="field">
              <div className="label">{t('Document languages')}</div>
              <div className="chips">
                {OCR_LANGS.map((l) => (
                  <label key={l.code} className={`chip ${langs.includes(l.code) ? 'on' : ''}`}>
                    <input type="checkbox" checked={langs.includes(l.code)} disabled={!!progress} onChange={(e) => setLangs((xs) => (e.target.checked ? [...xs, l.code] : xs.filter((x) => x !== l.code)))} />
                    {l.label}
                  </label>
                ))}
              </div>
              <p className="tip">{t('Language data is downloaded once (2–15 MB each) and cached for offline use.')}</p>
            </div>
            <label className="check">
              <input type="checkbox" checked={skipText} onChange={(e) => setSkipText(e.target.checked)} /> {t('Skip pages that already contain text')}
            </label>
          </div>
          {progress && (
            <div className="progress">
              <div className="progress-bar" style={{ width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%` }} />
              <span>
                {t('Page {a} of {b}', { a: Math.min(progress.done + 1, progress.total), b: progress.total })} · {t(progress.status)}
              </span>
            </div>
          )}
          <div className="action-bar">
            <span />
            <button className="btn primary big" disabled={!!progress || !langs.length} onClick={run}>
              <Icon name="ocr" /> {progress ? t('Recognizing…') : t('Run OCR & download')}
            </button>
          </div>
          {text !== null && (
            <div className="field">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <div className="label">{t('Recognized text')}</div>
                <button className="btn small" onClick={() => navigator.clipboard?.writeText(text).then(() => toast(t('Copied'), 'success'))}>
                  <Icon name="copy" size={15} /> {t('Copy')}
                </button>
              </div>
              <textarea className="input textarea result-text" readOnly value={text} rows={14} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
