import JSZip from 'jszip'
import { useMemo, useState } from 'react'
import { FileDrop } from '../components/FileDrop'
import { Icon } from '../components/Icon'
import { PdfCanvas } from '../components/PdfCanvas'
import { useToast } from '../components/Toast'
import { errorText, useT } from '../i18n'
import { splitPdf } from '../lib/pageOps'
import { openPdf, pageInfo, type PDFDocumentProxy } from '../lib/pdfjs'
import { chunkPages, describeGroup, parseRangeGroups } from '../lib/ranges'
import { baseName, downloadBytes, readFileBytes } from '../lib/util'

type Mode = 'select' | 'ranges' | 'every' | 'single'

interface Doc {
  name: string
  bytes: Uint8Array
  pdf: PDFDocumentProxy
  sizes: { width: number; height: number; rotation: number }[]
}

export function SplitTool() {
  const t = useT()
  const toast = useToast()
  const [doc, setDoc] = useState<Doc | null>(null)
  const [mode, setMode] = useState<Mode>('select')
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [ranges, setRanges] = useState('')
  const [every, setEvery] = useState(2)
  const [busy, setBusy] = useState(false)

  const open = async (f: File) => {
    try {
      const bytes = await readFileBytes(f)
      const pdf = await openPdf(bytes)
      const sizes = await Promise.all(Array.from({ length: pdf.numPages }, (_, i) => pageInfo(pdf, i)))
      doc?.pdf.loadingTask.destroy()
      setDoc({ name: f.name, bytes, pdf, sizes })
      setPicked(new Set())
      const half = Math.ceil(pdf.numPages / 2)
      setRanges(pdf.numPages > 1 ? `${describeGroup(chunkPages(half, half)[0])}, ${half + 1 === pdf.numPages ? half + 1 : `${half + 1}-${pdf.numPages}`}` : '1')
    } catch {
      toast(t('Could not open "{name}"', { name: f.name }), 'error')
    }
  }

  const n = doc?.sizes.length ?? 0
  const plan = useMemo((): { groups: number[][]; error?: string } => {
    if (!doc) return { groups: [] }
    try {
      switch (mode) {
        case 'select':
          return { groups: picked.size ? [[...picked].sort((a, b) => a - b)] : [] }
        case 'ranges':
          return { groups: parseRangeGroups(ranges, n) }
        case 'every':
          return { groups: chunkPages(n, Math.max(1, every)) }
        case 'single':
          return { groups: chunkPages(n, 1) }
      }
    } catch (e) {
      return { groups: [], error: (e as Error).message }
    }
  }, [doc, mode, picked, ranges, every, n])

  // which output file each page ends up in, for colouring thumbnails
  const pageGroup = useMemo(() => {
    const m = new Map<number, number>()
    plan.groups.forEach((g, gi) => g.forEach((p) => !m.has(p) && m.set(p, gi)))
    return m
  }, [plan])

  const run = async () => {
    if (!doc || !plan.groups.length) return
    setBusy(true)
    try {
      const outs = await splitPdf(doc.bytes, plan.groups)
      const base = baseName(doc.name)
      if (outs.length === 1) {
        downloadBytes(outs[0], `${base}-pages-${describeGroup(plan.groups[0])}.pdf`)
      } else {
        const zip = new JSZip()
        outs.forEach((b, i) => zip.file(`${base}-${String(i + 1).padStart(2, '0')}-pages-${describeGroup(plan.groups[i])}.pdf`, b))
        downloadBytes(await zip.generateAsync({ type: 'blob' }), `${base}-split.zip`, 'application/zip')
      }
      toast(t('Created {n} PDF files', { n: outs.length }), 'success')
    } catch (e) {
      toast(t('Split failed: {msg}', { msg: (e as Error).message }), 'error')
    } finally {
      setBusy(false)
    }
  }

  if (!doc) {
    return (
      <div className="tool-page">
        <h1>{t('Split PDF')}</h1>
        <p className="lead">{t('Extract pages or split one PDF into several files by ranges, every N pages, or one file per page.')}</p>
        <FileDrop accept="application/pdf,.pdf" title={t('Choose a PDF file')} hint={t('or drop it here')} onFiles={(f) => open(f[0])} />
      </div>
    )
  }

  const toggle = (i: number) => {
    if (mode !== 'select') return
    setPicked((s) => {
      const next = new Set(s)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }

  return (
    <div className="tool-page wide">
      <h1>{t('Split PDF')}</h1>
      <div className="split-head">
        <span className="file-chip static">
          <Icon name="file" size={15} /> {doc.name} · {t('{n} pages', { n })}
        </span>
        <label className="link">
          {t('Choose another file')}
          <input type="file" accept="application/pdf,.pdf" hidden onChange={(e) => e.target.files?.[0] && open(e.target.files[0])} />
        </label>
      </div>

      <div className="tabs">
        {(
          [
            ['select', 'Extract selected pages'],
            ['ranges', 'By ranges'],
            ['every', 'Every N pages'],
            ['single', 'One file per page'],
          ] as [Mode, string][]
        ).map(([m, label]) => (
          <button key={m} className={mode === m ? 'active' : ''} onClick={() => setMode(m)}>
            {t(label)}
          </button>
        ))}
      </div>

      <div className="split-options">
        {mode === 'select' && (
          <>
            <span className="muted">{t('Click pages to select them. {n} selected.', { n: picked.size })}</span>
            <button className="btn small ghost" onClick={() => setPicked(new Set(Array.from({ length: n }, (_, i) => i)))}>{t('Select all')}</button>
            <button className="btn small ghost" onClick={() => setPicked(new Set())}>{t('Clear')}</button>
          </>
        )}
        {mode === 'ranges' && (
          <>
            <input className="input" style={{ minWidth: 260 }} value={ranges} onChange={(e) => setRanges(e.target.value)} placeholder={t('e.g. 1-3, 4-6, 7')} aria-label={t('Page ranges')} />
            <span className="muted">{t('Each comma-separated range becomes a separate PDF.')}</span>
          </>
        )}
        {mode === 'every' && (
          <>
            <span>{t('Split every')}</span>
            <input className="input" type="number" min={1} max={n} value={every} onChange={(e) => setEvery(parseInt(e.target.value, 10) || 1)} style={{ width: 80 }} aria-label={t('Pages per file')} />
            <span>{t('pages')}</span>
          </>
        )}
        {mode === 'single' && <span className="muted">{t('Every page becomes its own PDF.')}</span>}
        {plan.error && <span className="error-text">{errorText(t, new Error(plan.error))}</span>}
      </div>

      <div className="split-grid">
        {doc.sizes.map((s, i) => {
          const g = pageGroup.get(i)
          const scale = 130 / Math.max(s.width, s.height)
          const r = s.rotation % 360
          const swapped = r === 90 || r === 270
          return (
            <button
              key={i}
              className={`split-page ${g !== undefined ? 'in' : 'out'} ${mode === 'select' ? 'pickable' : ''}`}
              style={{ ['--g' as string]: g !== undefined ? `var(--g${g % 6})` : undefined }}
              onClick={() => toggle(i)}
            >
              <div className="thumb-img" style={{ width: (swapped ? s.height : s.width) * scale, height: (swapped ? s.width : s.height) * scale }}>
                <div className="thumb-rot" style={{ width: s.width * scale, height: s.height * scale, transform: `translate(-50%,-50%) rotate(${r}deg)` }}>
                  <PdfCanvas pdf={doc.pdf} index={i} width={s.width} height={s.height} scale={scale} />
                </div>
              </div>
              <span className="split-num">
                {i + 1}
                {g !== undefined && mode !== 'select' && <em> → {t('file {n}', { n: g + 1 })}</em>}
              </span>
              {mode === 'select' && picked.has(i) && (
                <span className="split-check">
                  <Icon name="check" size={14} />
                </span>
              )}
            </button>
          )
        })}
      </div>

      <div className="action-bar sticky">
        <span className="muted">
          {plan.groups.length ? t(plan.groups.length > 1 ? '{n} output files (ZIP)' : '1 output file', { n: plan.groups.length }) : t('Nothing selected')}
        </span>
        <button className="btn primary" disabled={busy || !plan.groups.length} onClick={run}>
          <Icon name="split" /> {busy ? t('Working…') : t('Split & download')}
        </button>
      </div>
    </div>
  )
}
