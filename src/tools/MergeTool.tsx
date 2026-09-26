import { useState } from 'react'
import { FileDrop } from '../components/FileDrop'
import { Icon } from '../components/Icon'
import { PdfCanvas } from '../components/PdfCanvas'
import { useToast } from '../components/Toast'
import { mergePdfs, type MergeInput } from '../lib/pageOps'
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

export function MergeTool() {
  const toast = useToast()
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
        toast(`Could not read "${f.name}" (password protected or not a PDF/image)`, 'error')
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
      toast((e as Error).message, 'error')
      return
    }
    setBusy(true)
    try {
      const out = await mergePdfs(inputs)
      downloadBytes(out, 'merged.pdf')
      toast('Merged PDF downloaded', 'success')
    } catch (e) {
      toast(`Merge failed: ${(e as Error).message}`, 'error')
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
      <h1>Merge PDF</h1>
      <p className="lead">Combine PDFs and images into one document. Drag to reorder, optionally pick page ranges.</p>
      <FileDrop accept="application/pdf,.pdf,image/*" multiple compact={items.length > 0} title={busy ? 'Reading…' : items.length ? 'Add more files' : 'Choose PDF or image files'} hint="or drop them here" onFiles={addFiles} />

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
                    <div className="muted">{it.kind === 'pdf' ? `${it.pageCount} page${it.pageCount > 1 ? 's' : ''}` : 'Image → 1 page'}</div>
                  </div>
                  {it.kind === 'pdf' && (
                    <input
                      className="input range-input"
                      placeholder={`All pages (e.g. 1-3, 5)`}
                      value={it.range}
                      onChange={(e) => setItems((xs) => xs.map((x) => (x.id === it.id ? { ...x, range: e.target.value } : x)))}
                      aria-label={`Pages of ${it.name}`}
                    />
                  )}
                  <div className="merge-actions">
                    <button className="icon-btn" onClick={() => move(i, i - 1)} disabled={i === 0} aria-label="Move up">
                      <Icon name="up" />
                    </button>
                    <button className="icon-btn" onClick={() => move(i, i + 1)} disabled={i === items.length - 1} aria-label="Move down">
                      <Icon name="down" />
                    </button>
                    <button className="icon-btn" onClick={() => setItems((xs) => xs.filter((x) => x.id !== it.id))} aria-label="Remove">
                      <Icon name="trash" />
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
          <div className="action-bar">
            <span className="muted">
              {items.length} file{items.length > 1 ? 's' : ''} · {total} page{total !== 1 ? 's' : ''}
            </span>
            <button className="btn ghost" onClick={() => setItems([])}>Clear</button>
            <button className="btn primary" disabled={busy || (items.length < 2 && items[0]?.kind !== 'image')} onClick={merge}>
              <Icon name="merge" /> Merge & download
            </button>
          </div>
        </>
      )}
    </div>
  )
}
