import { useState } from 'react'
import { Icon } from '../components/Icon'
import { PdfCanvas } from '../components/PdfCanvas'
import type { PDFDocumentProxy } from '../lib/pdfjs'
import type { PageModel } from '../lib/types'
import { useT } from '../i18n'

const THUMB_W = 120

interface Props {
  pages: PageModel[]
  pdfFor: (srcId: string | null) => PDFDocumentProxy | null
  current: number
  onGoto: (i: number) => void
  onMove: (from: number, to: number) => void
  onRotate: (i: number, delta: number) => void
  onDelete: (i: number) => void
  onDuplicate: (i: number) => void
  onAddBlank: () => void
  onInsertPdf: (f: File) => void
}

export function Sidebar({ pages, pdfFor, current, onGoto, onMove, onRotate, onDelete, onDuplicate, onAddBlank, onInsertPdf }: Props) {
  const t = useT()
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null)

  return (
    <aside className="sidebar">
      <div className="thumbs">
        {pages.map((p, i) => {
          const r = (((p.baseRotation + p.rotation) % 360) + 360) % 360
          const scale = THUMB_W / Math.max(p.width, p.height)
          const w = p.width * scale
          const h = p.height * scale
          const swapped = r === 90 || r === 270
          return (
            <div
              key={p.id}
              className={`thumb ${i === current ? 'current' : ''} ${dropAt === i && dragFrom !== null && dragFrom !== i ? 'drop-target' : ''}`}
              draggable
              onDragStart={(e) => {
                setDragFrom(i)
                e.dataTransfer.effectAllowed = 'move'
              }}
              onDragOver={(e) => {
                e.preventDefault()
                setDropAt(i)
              }}
              onDragEnd={() => {
                setDragFrom(null)
                setDropAt(null)
              }}
              onDrop={(e) => {
                e.preventDefault()
                if (dragFrom !== null && dragFrom !== i) onMove(dragFrom, i)
                setDragFrom(null)
                setDropAt(null)
              }}
              onClick={() => onGoto(i)}
            >
              <div className="thumb-img" style={{ width: swapped ? h : w, height: swapped ? w : h }}>
                <div className="thumb-rot" style={{ width: w, height: h, transform: `translate(-50%,-50%) rotate(${r}deg)` }}>
                  <PdfCanvas pdf={pdfFor(p.srcId)} index={p.srcIndex} width={p.width} height={p.height} scale={scale} />
                  {p.annots.length > 0 && <span className="thumb-badge" title={t('Page has edits')} />}
                </div>
              </div>
              <div className="thumb-num">{i + 1}</div>
              <div className="thumb-actions" onClick={(e) => e.stopPropagation()}>
                <button title={t('Rotate left')} aria-label={t('Rotate left')} onClick={() => onRotate(i, -90)}>
                  <Icon name="rotateL" size={14} />
                </button>
                <button title={t('Rotate right')} aria-label={t('Rotate right')} onClick={() => onRotate(i, 90)}>
                  <Icon name="rotateR" size={14} />
                </button>
                <button title={t('Duplicate page')} aria-label={t('Duplicate page')} onClick={() => onDuplicate(i)}>
                  <Icon name="copy" size={14} />
                </button>
                <button title={t('Delete page')} aria-label={t('Delete page')} disabled={pages.length <= 1} onClick={() => onDelete(i)}>
                  <Icon name="trash" size={14} />
                </button>
              </div>
            </div>
          )
        })}
      </div>
      <div className="sidebar-foot">
        <button className="btn small" onClick={onAddBlank}>
          <Icon name="plus" size={15} /> {t('Blank page')}
        </button>
        <label className="btn small">
          <Icon name="file" size={15} /> {t('Insert PDF')}
          <input
            type="file"
            accept="application/pdf,.pdf"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (f) onInsertPdf(f)
            }}
          />
        </label>
      </div>
    </aside>
  )
}
