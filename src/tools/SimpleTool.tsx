import JSZip from 'jszip'
import { useEffect, useState, type ReactNode } from 'react'
import { FileDrop } from '../components/FileDrop'
import { Icon } from '../components/Icon'
import { PdfCanvas } from '../components/PdfCanvas'
import { useToast } from '../components/Toast'
import { errorText, useI18n, type T } from '../i18n'
import { isPasswordError, openPdf, pageInfo, type PDFDocumentProxy } from '../lib/pdfjs'
import { baseName, downloadBytes, readFileBytes } from '../lib/util'

export interface LoadedFile {
  name: string
  bytes: Uint8Array
  pageCount: number
  locked: boolean
  pdf: PDFDocumentProxy | null
  first: { width: number; height: number; rotation: number } | null
}

export interface OutputFile {
  name: string
  bytes: Uint8Array | Blob
  mime?: string
}

export interface RunResult {
  files: OutputFile[]
  /** a short line shown after processing, e.g. "Saved 45%" */
  note?: string
  /** text shown in a read-only box (PDF to text) */
  text?: string
}

export interface ToolDef<O> {
  id: string
  title: string
  lead: string
  icon: string
  action: string
  /** tools like Unlock accept password protected files */
  acceptsLocked?: boolean
  /** Repair accepts files pdf.js cannot open */
  acceptsBroken?: boolean
  /** file input accept attribute; default "application/pdf,.pdf" */
  accept?: string
  /** drop-zone title; default 'Choose a PDF file' */
  acceptTitle?: string
  /** skip pdf.js parsing for non-PDF inputs (e.g. .xlsx / .docx) */
  skipPdfParse?: boolean
  defaults: O | ((f: LoadedFile) => Promise<O>)
  Options?: (p: { value: O; set: (o: O) => void; file: LoadedFile; t: T }) => ReactNode
  validate?: (o: O, f: LoadedFile) => string | null
  run: (f: LoadedFile, o: O, t: T) => Promise<RunResult>
}

const fmtSize = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(2)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)
export { fmtSize }

export function outputName(f: LoadedFile, suffix: string, ext = 'pdf') {
  return `${baseName(f.name)}-${suffix}.${ext}`
}

export async function deliver(files: OutputFile[], zipName: string) {
  if (files.length === 1) {
    downloadBytes(files[0].bytes, files[0].name, files[0].mime)
    return
  }
  const zip = new JSZip()
  files.forEach((f) => zip.file(f.name, f.bytes))
  downloadBytes(await zip.generateAsync({ type: 'blob' }), zipName, 'application/zip')
}

export function SimpleTool<O>({ def }: { def: ToolDef<O> }) {
  const { t } = useI18n()
  const toast = useToast()
  const [file, setFile] = useState<LoadedFile | null>(null)
  const [opts, setOpts] = useState<O | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<RunResult | null>(null)

  useEffect(() => () => void file?.pdf?.loadingTask.destroy(), [file])

  const open = async (f: File) => {
    try {
      const bytes = await readFileBytes(f)
      let pdf: PDFDocumentProxy | null = null
      let locked = false
      let first: LoadedFile['first'] = null
      let pageCount = 0
      if (!def.skipPdfParse) {
        try {
          pdf = await openPdf(bytes)
        } catch (e) {
          if (!isPasswordError(e)) {
            if (!def.acceptsBroken) throw new Error(t('"{name}" is not a valid PDF', { name: f.name }))
          } else locked = true
          if (locked && !def.acceptsLocked) throw new Error(t('This PDF is password protected. Remove the password with the Unlock tool first.'))
        }
        first = pdf ? await pageInfo(pdf, 0) : null
        pageCount = pdf?.numPages ?? 0
      }
      const lf: LoadedFile = { name: f.name, bytes, pageCount, locked, pdf, first }
      const o = typeof def.defaults === 'function' ? await (def.defaults as (f: LoadedFile) => Promise<O>)(lf) : def.defaults
      setFile(lf)
      setOpts(o)
      setResult(null)
    } catch (e) {
      toast(errorText(t, e), 'error')
    }
  }

  const run = async () => {
    if (!file || opts === null) return
    const err = def.validate?.(opts, file)
    if (err) return toast(t(err), 'error')
    setBusy(true)
    try {
      const res = await def.run(file, opts, t)
      setResult(res)
      if (res.files.length) await deliver(res.files, `${baseName(file.name)}-${def.id}.zip`)
      toast(t('Done'), 'success')
    } catch (e) {
      console.error(e)
      toast(errorText(t, e), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="tool-page">
      <h1>{t(def.title)}</h1>
      <p className="lead">{t(def.lead)}</p>
      {!file || opts === null ? (
        <FileDrop accept={def.accept ?? 'application/pdf,.pdf'} title={def.acceptTitle ? t(def.acceptTitle) : t('Choose a PDF file')} hint={t('or drop it here · processed locally in your browser')} onFiles={(f) => open(f[0])} />
      ) : (
        <div className="simple-tool">
          <div className="st-file">
            <div className="st-thumb">
              {file.pdf && file.first ? (
                <PdfCanvas pdf={file.pdf} index={0} width={file.first.width} height={file.first.height} scale={90 / Math.max(file.first.width, file.first.height)} />
              ) : (
                <Icon name={file.locked ? 'lock' : def.icon} size={28} />
              )}
            </div>
            <div className="st-meta">
              <div className="merge-name">{file.name}</div>
              <div className="muted">
                {fmtSize(file.bytes.length)}
                {file.pageCount ? ` · ${t('{n} pages', { n: file.pageCount })}` : ''}
                {file.locked ? ` · ${t('password protected')}` : ''}
              </div>
            </div>
            <label className="link">
              {t('Choose another file')}
              <input type="file" accept={def.accept ?? 'application/pdf,.pdf'} hidden onChange={(e) => e.target.files?.[0] && open(e.target.files[0])} />
            </label>
          </div>
          {def.Options && <div className="st-options">{def.Options({ value: opts, set: setOpts, file, t })}</div>}
          <div className="action-bar">
            <span className="muted">{result?.note}</span>
            <button className="btn primary big" onClick={run} disabled={busy}>
              <Icon name={def.icon} /> {busy ? t('Working…') : t(def.action)}
            </button>
          </div>
          {result?.text !== undefined && (
            <div className="field">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <div className="label">{t('Extracted text')}</div>
                <button className="btn small" onClick={() => navigator.clipboard?.writeText(result.text ?? '').then(() => toast(t('Copied'), 'success'))}>
                  <Icon name="copy" size={15} /> {t('Copy')}
                </button>
              </div>
              <textarea className="input textarea result-text" readOnly value={result.text} rows={14} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ───────────────────────────── small form helpers shared by tool option panels

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="field">
      <div className="label">{label}</div>
      {children}
      {hint && <p className="tip">{hint}</p>}
    </div>
  )
}

export function Segmented<V extends string | number>({ value, options, onChange }: { value: V; options: [V, string][]; onChange: (v: V) => void }) {
  return (
    <div className="tabs segmented">
      {options.map(([v, label]) => (
        <button key={String(v)} type="button" className={value === v ? 'active' : ''} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  )
}
