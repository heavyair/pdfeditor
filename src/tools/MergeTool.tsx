import { useState } from 'react'
import { FileDrop } from '../components/FileDrop'
import { Icon } from '../components/Icon'
import { PdfCanvas } from '../components/PdfCanvas'
import { useToast } from '../components/Toast'
import { errorText, useT } from '../i18n'
import { mergePdfs, type ImagePageSize, type MergeInput } from '../lib/pageOps'
import { openPdf, pageInfo, type PDFDocumentProxy } from '../lib/pdfjs'
import { parsePageList } from '../lib/ranges'
import { downloadBytes, fileToEmbeddableDataUrl, readFileBytes, uid } from '../lib/util'

interface Item {
  id: string
  name: string
  kind: 'pdf' | 'image'
  bytes: Uint8Array
  pdf?: PDFDocumentProxy
  pageCount: number
  thumb: { width: number; height: number }
  src?: string
  range: string
}

export function MergeTool({ imagesOnly = false }: { imagesOnly?: boolean }) {
  const t = useT()
  const toast = useToast()
  const [pageSize, setPageSize] = useState<ImagePageSize>('a4')
  const [margin, setMargin] = useState(24)
  const [items, setItems] = useState<Item[]>([])
  const [busy, setBusy] = useState(false)
  const [dragFrom, setDragFrom] = useState<number | null>(null)

  const addFiles = async (files: File[]) => {
    setBusy(true)
    const added: Item[] = []
    for (const f of files) {
      try {
        if (f.type.startsWith('image/')) {
          const img = await fileToEmbeddableDataUrl(f)
          added.push({ id: uid(), name: f.name, kind: 'image', bytes: new Uint8Array(), pageCount: 1, thumb: { width: img.width, height: img.height }, src: img.src, range: '' })
        } else {
          const bytes = await readFileBytes(f)
          const pdf = await openPdf(bytes)
          const info = await pageInfo(pdf, 0)
          added.push({ id: uid(), name: f.name, kind: 'pdf', bytes, pdf, pageCount: pdf.numPages, thumb: info, range: '' })
        }
      } catch {
        toast(t('Could not read "{name}" (password protected or not a PDF/image)', { name: f.name }), 'error')
      }
    }
    setItems((xs) => [...xs, ...added])
    setBusy(false)
  }

  const move = (from: number, to: number) =>
    setItems((xs) => {
      if (to < 0 || to >= xs.length) return xs
      const next = [...xs]
      const [x] = next.splice(from, 1)
      next.splice(to, 0, x)
      return next
    })

  const merge = async () => {
    let inputs: MergeInput[]
    try {
      inputs = items.map((it) =>
        it.kind === 'image'
          ? { kind: 'image', bytes: it.bytes, src: it.src }
          : { kind: 'pdf', bytes: it.bytes, pages: parsePageList(it.range, it.pageCount) },
      )
    } catch (e) {
      toast(errorText(t, e), 'error')
      return
    }
    setBusy(true)
    try {
      const out = await mergePdfs(inputs, { pageSize, margin })
      downloadBytes(out, imagesOnly ? 'images.pdf' : 'merged.pdf')
      toast(t('Your PDF is ready'), 'success')
    } catch (e) {
      toast(t('Merge failed: {msg}', { msg: (e as Error).message }), 'error')
    } finally {
      setBusy(false)
    }
  }

  const total = items.reduce((n, it) => {
    try {
      return n + (it.kind === 'image' ? 1 : parsePageList(it.range, it.pageCount).length)
    } catch {
      return n
    }
  }, 0)

  return (
    <div className="tool-page">
      <h1>{t(imagesOnly ? 'Images to PDF' : 'Merge PDF')}</h1>
      <p className="lead">{t(imagesOnly ? 'Turn JPG, PNG, WebP or HEIC-converted photos into a PDF, one image per page. Drag to reorder.' : 'Combine PDFs and images into one document. Drag to reorder, optionally pick page ranges.')}</p>
      <FileDrop accept={imagesOnly ? 'image/*' : 'application/pdf,.pdf,image/*'} multiple compact={items.length > 0} title={busy ? t('Reading…') : items.length ? t('Add more files') : t(imagesOnly ? 'Choose images' : 'Choose PDF or image files')} hint={t('or drop them here')} onFiles={addFiles} />

      {items.length > 0 && (
        <>
          <div className="merge-list">
            {items.map((it, i) => {
              const s = 72 / Math.max(it.thumb.width, it.thumb.height)
              return (
                <div
                  key={it.id}
                  className={`merge-item ${dragFrom === i ? 'dragging' : ''}`}
                  draggable
                  onDragStart={() => setDragFrom(i)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => {
                    if (dragFrom !== null) move(dragFrom, i)
                    setDragFrom(null)
                  }}
                  onDragEnd={() => setDragFrom(null)}
                >
                  <span className="grip" aria-hidden="true">
                    <Icon name="grip" />
                  </span>
                  <span className="merge-index">{i + 1}</span>
                  <div className="merge-thumb">
                    {it.kind === 'pdf' ? (
                      <PdfCanvas pdf={it.pdf!} index={0} width={it.thumb.width} height={it.thumb.height} scale={s} />
                    ) : (
                      <img src={it.src} alt="" style={{ width: it.thumb.width * s, height: it.thumb.height * s }} />
                    )}
                  </div>
                  <div className="merge-meta">
                    <div className="merge-name" title={it.name}>{it.name}</div>
                    <div className="muted">{it.kind === 'pdf' ? t('{n} pages', { n: it.pageCount }) : t('Image → 1 page')}</div>
                  </div>
                  {it.kind === 'pdf' && (
                    <input
                      className="input range-input"
                      placeholder={t('All pages (e.g. 1-3, 5)')}
                      value={it.range}
                      onChange={(e) => setItems((xs) => xs.map((x) => (x.id === it.id ? { ...x, range: e.target.value } : x)))}
                      aria-label={t('Pages')}
                    />
                  )}
                  <div className="merge-actions">
                    <button className="icon-btn" onClick={() => move(i, i - 1)} disabled={i === 0} aria-label={t('Move up')}>
                      <Icon name="up" />
                    </button>
                    <button className="icon-btn" onClick={() => move(i, i + 1)} disabled={i === items.length - 1} aria-label={t('Move down')}>
                      <Icon name="down" />
                    </button>
                    <button className="icon-btn" onClick={() => setItems((xs) => xs.filter((x) => x.id !== it.id))} aria-label={t('Remove')}>
                      <Icon name="trash" />
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
          {items.some((it) => it.kind === 'image') && (
            <div className="row image-opts">
              <span className="label" style={{ margin: 0 }}>{t('Image pages')}</span>
              <div className="tabs segmented">
                {(
                  [
                    ['a4', 'A4'],
                    ['letter', 'Letter'],
                    ['fit', t('Fit image')],
                  ] as [ImagePageSize, string][]
                ).map(([v, l]) => (
                  <button key={v} className={pageSize === v ? 'active' : ''} onClick={() => setPageSize(v)}>
                    {l}
                  </button>
                ))}
              </div>
              <label className="check">
                <input type="checkbox" checked={margin > 0} onChange={(e) => setMargin(e.target.checked ? 24 : 0)} /> {t('Margin')}
              </label>
            </div>
          )}
          <div className="action-bar">
            <span className="muted">{t('{f} files · {n} pages', { f: items.length, n: total })}</span>
            <button className="btn ghost" onClick={() => setItems([])}>
              {t('Clear')}
            </button>
            <button className="btn primary" disabled={busy || (items.length < 2 && items[0]?.kind !== 'image')} onClick={merge}>
              <Icon name={imagesOnly ? 'file' : 'merge'} /> {t(imagesOnly ? 'Create PDF' : 'Merge & download')}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
