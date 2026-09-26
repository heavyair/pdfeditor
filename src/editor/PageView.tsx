import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import { PdfCanvas } from '../components/PdfCanvas'
import { useT } from '../i18n'
import { BASELINE, CSS_FONT, LINE_HEIGHT, guessFont } from '../lib/fonts'
import { extractTextRuns, type PDFDocumentProxy, type TextRun } from '../lib/pdfjs'
import type { Annot, BoxAnnot, FormField, PageModel, TextAnnot, Tool } from '../lib/types'
import { rgbToHex, uid } from '../lib/util'

export interface ToolOpts {
  color: string
  fontSize: number
  font: TextAnnot['font']
  strokeWidth: number
}

export interface Pending {
  src: string
  w: number
  h: number
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface EditorApi {
  select: (pageId: string, annotId: string | null) => void
  setEditing: (annotId: string | null) => void
  /** push the current state onto the undo stack (call before a live edit) */
  checkpoint: () => void
  /** add annotations with an undo entry; optionally select / start editing one */
  addAnnots: (pageId: string, annots: Annot[], selectId?: string, edit?: boolean) => void
  /** live update, no undo entry */
  updateAnnot: (pageId: string, annotId: string, patch: Partial<Annot>) => void
  removeAnnot: (pageId: string, annotId: string) => void
  setTool: (t: Tool) => void
  consumePending: () => void
  setField: (srcId: string, name: string, value: string | boolean) => void
}

interface Props {
  page: PageModel
  pdf: PDFDocumentProxy | null
  zoom: number
  tool: Tool
  opts: ToolOpts
  pending: Pending | null
  selectedId: string | null
  editingId: string | null
  api: EditorApi
  formValues?: Record<string, string | boolean>
  hits?: Rect[]
  activeHit?: number
}

type Draft =
  | { kind: 'box'; x0: number; y0: number; x1: number; y1: number }
  | { kind: 'draw'; points: [number, number][] }
  | null

const rot = (r: number) => (((r % 360) + 360) % 360) as 0 | 90 | 180 | 270
const BOX_TOOLS: Tool[] = ['whiteout', 'redact', 'highlight', 'rect', 'ellipse', 'link']

interface Run extends TextRun {
  ocr?: boolean
}

export function PageView({ page, pdf, zoom, tool, opts, pending, selectedId, editingId, api, formValues, hits, activeHit }: Props) {
  const t = useT()
  const outer = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [draft, setDraft] = useState<Draft>(null)
  const [ghost, setGhost] = useState<[number, number] | null>(null)
  const [pdfRuns, setPdfRuns] = useState<TextRun[] | null>(null)
  const r = rot(page.rotation + page.baseRotation)
  const W = page.width * zoom
  const H = page.height * zoom
  const swapped = r === 90 || r === 270

  // load existing text runs for "Edit text" mode
  useEffect(() => {
    if (tool !== 'editText' || !pdf || pdfRuns) return
    let cancelled = false
    pdf
      .getPage(page.srcIndex + 1)
      .then(extractTextRuns)
      .then((x) => !cancelled && setPdfRuns(x))
      .catch(() => !cancelled && setPdfRuns([]))
    return () => {
      cancelled = true
    }
  }, [tool, pdf, page.srcIndex, pdfRuns])

  // scanned pages: fall back to OCR lines
  const runs: Run[] | null =
    pdfRuns && pdfRuns.length === 0 && page.ocr?.lines.length
      ? page.ocr.lines.map((l) => ({ str: l.text, x: l.x, y: l.y, w: l.w, h: l.h, baseline: l.y + l.h * 0.8, fontSize: l.h * 0.95, fontName: '', fontFamily: '', ocr: true }))
      : pdfRuns

  /** client coords -> unrotated page units */
  const toLocal = (clientX: number, clientY: number): [number, number] => {
    const rect = outer.current!.getBoundingClientRect()
    const dx = clientX - (rect.left + rect.width / 2)
    const dy = clientY - (rect.top + rect.height / 2)
    const a = (-r * Math.PI) / 180
    const ux = dx * Math.cos(a) - dy * Math.sin(a)
    const uy = dx * Math.sin(a) + dy * Math.cos(a)
    return [(ux + W / 2) / zoom, (uy + H / 2) / zoom]
  }

  /** generic drag helper: calls onMove with the delta in page units */
  const drag = (e: RPointerEvent, onMove: (dx: number, dy: number, x: number, y: number) => void, onUp?: () => void) => {
    const [sx, sy] = toLocal(e.clientX, e.clientY)
    const move = (ev: PointerEvent) => {
      const [x, y] = toLocal(ev.clientX, ev.clientY)
      onMove(x - sx, y - sy, x, y)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      onUp?.()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // ---------- page background interactions ----------
  const onPagePointerDown = (e: RPointerEvent) => {
    if (e.button !== 0) return
    const [x, y] = toLocal(e.clientX, e.clientY)
    switch (tool) {
      case 'select':
      case 'editText':
        api.select(page.id, null)
        return
      case 'text': {
        const a: TextAnnot = { id: uid(), type: 'text', x, y: y - opts.fontSize * 0.6, text: '', fontSize: opts.fontSize, color: opts.color, font: opts.font, bold: false, italic: false }
        e.preventDefault()
        api.addAnnots(page.id, [a], a.id, true)
        api.setTool('select')
        return
      }
      case 'note': {
        const id = uid()
        api.addAnnots(page.id, [{ id, type: 'note', x: x - 10, y: y - 10, text: '', color: '#ffd400' }], id)
        api.setTool('select')
        return
      }
      case 'place': {
        if (!pending) return
        const a: BoxAnnot = { id: uid(), type: 'image', x: x - pending.w / 2, y: y - pending.h / 2, w: pending.w, h: pending.h, src: pending.src }
        api.addAnnots(page.id, [a], a.id)
        api.consumePending()
        setGhost(null)
        return
      }
      case 'line':
      case 'arrow': {
        e.preventDefault()
        let d = { kind: 'box' as const, x0: x, y0: y, x1: x, y1: y }
        setDraft(d)
        const arrow = tool === 'arrow'
        drag(
          e,
          (_dx, _dy, px, py) => {
            d = { ...d, x1: px, y1: py }
            setDraft(d)
          },
          () => {
            setDraft(null)
            let w = d.x1 - d.x0
            let h = d.y1 - d.y0
            if (Math.hypot(w, h) < 4) [w, h] = [100, 0]
            const id = uid()
            api.addAnnots(page.id, [{ id, type: 'line', x: d.x0, y: d.y0, w, h, color: opts.color, strokeWidth: opts.strokeWidth, arrow }], id)
          },
        )
        return
      }
      case 'draw': {
        e.preventDefault()
        let pts: [number, number][] = [[x, y]]
        setDraft({ kind: 'draw', points: pts })
        drag(
          e,
          (_dx, _dy, px, py) => {
            pts = [...pts, [px, py]]
            setDraft({ kind: 'draw', points: pts })
          },
          () => {
            setDraft(null)
            if (pts.length < 2) return
            const xs = pts.map((p) => p[0])
            const ys = pts.map((p) => p[1])
            const bx = Math.min(...xs)
            const by = Math.min(...ys)
            const bw = Math.max(1, Math.max(...xs) - bx)
            const bh = Math.max(1, Math.max(...ys) - by)
            api.addAnnots(page.id, [
              { id: uid(), type: 'draw', x: bx, y: by, w: bw, h: bh, points: pts.map(([px, py]) => [(px - bx) / bw, (py - by) / bh]), color: opts.color, strokeWidth: opts.strokeWidth },
            ])
          },
        )
        return
      }
      default: {
        if (!BOX_TOOLS.includes(tool)) return
        e.preventDefault()
        let d = { kind: 'box' as const, x0: x, y0: y, x1: x, y1: y }
        setDraft(d)
        const tl = tool
        drag(
          e,
          (_dx, _dy, px, py) => {
            d = { ...d, x1: px, y1: py }
            setDraft(d)
          },
          () => {
            setDraft(null)
            let bx = Math.min(d.x0, d.x1)
            let by = Math.min(d.y0, d.y1)
            let bw = Math.abs(d.x1 - d.x0)
            let bh = Math.abs(d.y1 - d.y0)
            if (bw < 4 && bh < 4) {
              // a simple click creates a default sized shape
              bw = tl === 'highlight' || tl === 'redact' ? 120 : 100
              bh = tl === 'highlight' || tl === 'redact' ? 16 : tl === 'link' ? 20 : 50
              bx = x
              by = y - bh / 2
            }
            const id = uid()
            const base = { id, x: bx, y: by, w: Math.max(bw, 2), h: Math.max(bh, 2) }
            const shape = { stroke: null, strokeWidth: 0, opacity: 1 }
            const a: BoxAnnot =
              tl === 'whiteout'
                ? { ...base, type: 'rect', fill: '#ffffff', ...shape }
                : tl === 'redact'
                  ? { ...base, type: 'rect', fill: '#000000', ...shape, redact: 'all' }
                  : tl === 'highlight'
                    ? { ...base, type: 'rect', fill: '#ffe14d', ...shape, opacity: 0.5, highlight: true }
                    : tl === 'link'
                      ? { ...base, type: 'link', url: '' }
                      : { ...base, type: tl as 'rect' | 'ellipse', fill: null, stroke: opts.color, strokeWidth: opts.strokeWidth, opacity: 1 }
            api.addAnnots(page.id, [a], id)
          },
        )
      }
    }
  }

  // ---------- "Edit text": replace an existing text run ----------
  const sampleCanvas = (run: TextRun) => {
    const c = canvas.current
    const fallback = { bg: '#ffffff', fg: '#000000' }
    if (!c || !c.width) return fallback
    try {
      const k = c.width / page.width
      const ctx = c.getContext('2d', { willReadFrequently: true })!
      const px = (x: number, y: number) => {
        const d = ctx.getImageData(Math.max(0, Math.round(x * k)), Math.max(0, Math.round(y * k)), 1, 1).data
        return [d[0], d[1], d[2]]
      }
      const probes = [px(run.x - 2, run.y + run.h / 2), px(run.x + run.w + 2, run.y + run.h / 2), px(run.x + run.w / 2, run.y - 1), px(run.x + run.w / 2, run.y + run.h + 1)]
      const bg = [0, 1, 2].map((i) => probes.map((p) => p[i]).sort((a, b) => a - b)[2]) // upper-median
      const data = ctx.getImageData(Math.round(run.x * k), Math.round(run.y * k), Math.max(1, Math.round(run.w * k)), Math.max(1, Math.round(run.h * k))).data
      let best = 0
      let fg = [0, 0, 0]
      for (let i = 0; i < data.length; i += 4 * 3) {
        const dist = Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2])
        if (dist > best) {
          best = dist
          fg = [data[i], data[i + 1], data[i + 2]]
        }
      }
      return { bg: rgbToHex(bg[0], bg[1], bg[2]), fg: rgbToHex(fg[0], fg[1], fg[2]) }
    } catch {
      return fallback
    }
  }

  const editRun = (e: RPointerEvent, run: Run) => {
    e.stopPropagation()
    e.preventDefault()
    const { bg, fg } = sampleCanvas(run)
    const f = guessFont(run.fontName, run.fontFamily)
    const fontSize = Math.round(run.fontSize * 10) / 10
    const pad = Math.max(1, run.fontSize * 0.08)
    const cover: BoxAnnot = {
      id: uid(),
      type: 'rect',
      x: run.x - pad,
      y: run.y - pad,
      w: run.w + pad * 2,
      h: run.h + pad * 2,
      fill: bg,
      stroke: null,
      strokeWidth: 0,
      opacity: 1,
      // real text is deleted from the page on export; OCR text is pixels, so it is covered instead
      redact: run.ocr ? undefined : 'text',
    }
    const text: TextAnnot = { id: uid(), type: 'text', x: run.x, y: run.baseline - BASELINE[f.font] * fontSize, text: run.str, fontSize, color: fg, ...f }
    api.addAnnots(page.id, [cover, text], text.id, true)
  }

  const cursor = tool === 'select' || tool === 'editText' ? 'default' : tool === 'text' ? 'text' : tool === 'place' || tool === 'note' ? 'copy' : 'crosshair'
  const interactive = tool === 'select' || tool === 'editText'

  return (
    <div
      ref={outer}
      className="page-outer"
      style={{ width: swapped ? H : W, height: swapped ? W : H }}
      data-page-id={page.id}
      onPointerMove={(e) => tool === 'place' && pending && setGhost(toLocal(e.clientX, e.clientY))}
      onPointerLeave={() => setGhost(null)}
    >
      <div className="page-inner" style={{ width: W, height: H, transform: `translate(-50%, -50%) rotate(${r}deg)`, cursor }} onPointerDown={onPagePointerDown}>
        <PdfCanvas pdf={pdf} index={page.srcIndex} width={page.width} height={page.height} scale={zoom} canvasRef={canvas} />

        {tool === 'editText' && runs && (
          <div className="runs-layer">
            {runs.map((run, i) => (
              <div
                key={i}
                className={`run ${run.ocr ? 'ocr' : ''}`}
                title={t('Click to edit this text')}
                style={{ left: run.x * zoom, top: run.y * zoom, width: run.w * zoom, height: run.h * zoom }}
                onPointerDown={(e) => editRun(e, run)}
              />
            ))}
          </div>
        )}

        {hits && hits.length > 0 && (
          <div className="hits-layer">
            {hits.map((h, i) => (
              <div key={i} className={`hit ${activeHit === i ? 'active' : ''}`} style={{ left: h.x * zoom, top: h.y * zoom, width: h.w * zoom, height: h.h * zoom }} />
            ))}
          </div>
        )}

        <div className="annots-layer">
          {page.annots.map((a) => (
            <AnnotView
              key={a.id}
              a={a}
              zoom={zoom}
              interactive={interactive}
              selected={selectedId === a.id}
              editing={editingId === a.id}
              onSelect={() => api.select(page.id, a.id)}
              onStartEdit={() => {
                api.checkpoint()
                api.setEditing(a.id)
              }}
              onStopEdit={() => {
                api.setEditing(null)
                if (a.type === 'text' && !a.text.trim()) api.removeAnnot(page.id, a.id)
              }}
              onChange={(patch) => api.updateAnnot(page.id, a.id, patch)}
              onRemove={() => api.removeAnnot(page.id, a.id)}
              drag={drag}
              checkpoint={api.checkpoint}
            />
          ))}
        </div>

        {page.srcId && page.fields && page.fields.length > 0 && (
          <FormLayer fields={page.fields} zoom={zoom} values={formValues ?? {}} active={interactive} onChange={(n, v) => api.setField(page.srcId!, n, v)} />
        )}

        {draft?.kind === 'box' && (tool === 'line' || tool === 'arrow') && (
          <svg className="draft-svg" width={W} height={H}>
            <line x1={draft.x0 * zoom} y1={draft.y0 * zoom} x2={draft.x1 * zoom} y2={draft.y1 * zoom} stroke={opts.color} strokeWidth={opts.strokeWidth * zoom} strokeLinecap="round" />
          </svg>
        )}
        {draft?.kind === 'box' && tool !== 'line' && tool !== 'arrow' && (
          <div
            className={`draft ${tool}`}
            style={{
              left: Math.min(draft.x0, draft.x1) * zoom,
              top: Math.min(draft.y0, draft.y1) * zoom,
              width: Math.abs(draft.x1 - draft.x0) * zoom,
              height: Math.abs(draft.y1 - draft.y0) * zoom,
              borderRadius: tool === 'ellipse' ? '50%' : 0,
              borderColor: tool === 'rect' || tool === 'ellipse' ? opts.color : undefined,
            }}
          />
        )}
        {draft?.kind === 'draw' && (
          <svg className="draft-svg" width={W} height={H}>
            <polyline points={draft.points.map(([x, y]) => `${x * zoom},${y * zoom}`).join(' ')} fill="none" stroke={opts.color} strokeWidth={opts.strokeWidth * zoom} strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
        {tool === 'place' && pending && ghost && (
          <img
            className="ghost"
            src={pending.src}
            alt=""
            style={{ left: (ghost[0] - pending.w / 2) * zoom, top: (ghost[1] - pending.h / 2) * zoom, width: pending.w * zoom, height: pending.h * zoom }}
          />
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

function FormLayer({ fields, zoom, values, active, onChange }: { fields: FormField[]; zoom: number; values: Record<string, string | boolean>; active: boolean; onChange: (name: string, v: string | boolean) => void }) {
  return (
    <div className={`form-layer ${active ? 'active' : ''}`}>
      {fields.map((f, i) => {
        const style = { left: f.x * zoom, top: f.y * zoom, width: f.w * zoom, height: f.h * zoom, fontSize: Math.max(8, Math.min(f.h * 0.62, 13)) * zoom }
        const v = f.name in values ? values[f.name] : f.value
        const stop = (e: React.PointerEvent) => e.stopPropagation()
        const common = { className: `field field-${f.kind}`, style, disabled: f.readOnly, onPointerDown: stop, title: f.name }
        if (f.kind === 'checkbox') return <input key={i} {...common} type="checkbox" checked={Boolean(v)} onChange={(e) => onChange(f.name, e.target.checked)} />
        if (f.kind === 'radio')
          return <input key={i} {...common} type="radio" name={`${f.name}-${f.x}`} checked={v === f.exportValue} onChange={() => onChange(f.name, f.exportValue ?? '')} />
        if (f.kind === 'select')
          return (
            <select key={i} {...common} value={String(v ?? '')} onChange={(e) => onChange(f.name, e.target.value)}>
              <option value="" />
              {f.options?.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          )
        if (f.multiline) return <textarea key={i} {...common} value={String(v ?? '')} maxLength={f.maxLen || undefined} onChange={(e) => onChange(f.name, e.target.value)} />
        return <input key={i} {...common} type="text" value={String(v ?? '')} maxLength={f.maxLen || undefined} onChange={(e) => onChange(f.name, e.target.value)} />
      })}
    </div>
  )
}

interface AnnotProps {
  a: Annot
  zoom: number
  interactive: boolean
  selected: boolean
  editing: boolean
  onSelect: () => void
  onStartEdit: () => void
  onStopEdit: () => void
  onChange: (patch: Partial<Annot>) => void
  onRemove: () => void
  drag: (e: RPointerEvent, onMove: (dx: number, dy: number) => void, onUp?: () => void) => void
  checkpoint: () => void
}

function AnnotView({ a, zoom, interactive, selected, editing, onSelect, onStartEdit, onStopEdit, onChange, onRemove, drag, checkpoint }: AnnotProps) {
  const t = useT()
  const textRef = useRef<HTMLDivElement>(null)

  const startMove = (e: RPointerEvent) => {
    if (!interactive || editing || e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    onSelect()
    const ox = a.x
    const oy = a.y
    let moved = false
    drag(e, (dx, dy) => {
      if (!moved) {
        if (Math.abs(dx) * zoom < 2 && Math.abs(dy) * zoom < 2) return
        moved = true
        checkpoint()
      }
      onChange({ x: ox + dx, y: oy + dy })
    })
  }

  const startResize = (e: RPointerEvent) => {
    e.stopPropagation()
    e.preventDefault()
    checkpoint()
    if (a.type === 'text') {
      const lines = a.text.split('\n').length
      const h0 = lines * LINE_HEIGHT * a.fontSize
      const fs0 = a.fontSize
      drag(e, (_dx, dy) => onChange({ fontSize: Math.max(4, Math.round(fs0 * ((h0 + dy) / h0) * 2) / 2) }))
      return
    }
    if (a.type === 'note') return
    const { w: w0, h: h0 } = a
    if (a.type === 'line') {
      drag(e, (dx, dy) => onChange({ w: w0 + dx, h: h0 + dy }))
      return
    }
    const keepRatio = a.type === 'image'
    drag(e, (dx, dy) => {
      let w = Math.max(6, w0 + dx)
      let h = Math.max(6, h0 + dy)
      if (keepRatio) {
        const s = Math.max(w / w0, h / h0)
        w = w0 * s
        h = h0 * s
      }
      onChange({ w, h })
    })
  }

  useEffect(() => {
    if (editing && a.type === 'text' && textRef.current) {
      const el = textRef.current
      el.textContent = a.text
      el.focus()
      const range = document.createRange()
      range.selectNodeContents(el)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
    }
    // only when editing starts
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing])

  const common = {
    className: `annot annot-${a.type} ${selected ? 'selected' : ''} ${interactive ? 'interactive' : ''} ${editing ? 'editing' : ''} ${'redact' in a && a.redact ? `redact-${a.redact}` : ''}`,
    onPointerDown: startMove,
    'data-annot-id': a.id,
  }

  let body
  if (a.type === 'text') {
    const style = {
      left: a.x * zoom,
      top: a.y * zoom,
      fontSize: a.fontSize * zoom,
      lineHeight: LINE_HEIGHT,
      fontFamily: CSS_FONT[a.font],
      fontWeight: a.bold ? 700 : 400,
      fontStyle: a.italic ? 'italic' : 'normal',
      color: a.color,
    } as const
    body = editing ? (
      <div
        {...common}
        style={style}
        ref={textRef}
        contentEditable="plaintext-only"
        suppressContentEditableWarning
        spellCheck={false}
        onPointerDown={(e) => e.stopPropagation()}
        onInput={(e) => onChange({ text: (e.currentTarget.innerText ?? '').replace(/\n$/, '') })}
        onBlur={onStopEdit}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape') (e.currentTarget as HTMLElement).blur()
        }}
      />
    ) : (
      <div {...common} style={style} onDoubleClick={() => interactive && onStartEdit()}>
        {a.text || '​'}
      </div>
    )
  } else if (a.type === 'note') {
    body = (
      <div {...common} style={{ left: a.x * zoom, top: a.y * zoom, width: 20 * zoom, height: 20 * zoom, background: a.color }} title={a.text || t('Empty note')}>
        <svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="#5a4500" strokeWidth={1.8} strokeLinejoin="round">
          <path d="M5 5h14v10h-6l-4 4v-4H5z" />
        </svg>
      </div>
    )
  } else if (a.type === 'line') {
    const minX = Math.min(0, a.w), minY = Math.min(0, a.h)
    const pad = Math.max(8, a.strokeWidth * 4)
    const len = Math.hypot(a.w, a.h)
    const ang = Math.atan2(a.h, a.w)
    const head = Math.max(6, a.strokeWidth * 4)
    const hp = (da: number) => `${a.w - head * Math.cos(ang + da) - minX + pad},${a.h - head * Math.sin(ang + da) - minY + pad}`
    body = (
      <div {...common} style={{ left: (a.x + minX - pad) * zoom, top: (a.y + minY - pad) * zoom, width: (Math.abs(a.w) + pad * 2) * zoom, height: (Math.abs(a.h) + pad * 2) * zoom }}>
        <svg width="100%" height="100%" viewBox={`0 0 ${Math.abs(a.w) + pad * 2} ${Math.abs(a.h) + pad * 2}`}>
          <line x1={-minX + pad} y1={-minY + pad} x2={a.w - minX + pad - (a.arrow && len > head ? Math.cos(ang) * head * 0.8 : 0)} y2={a.h - minY + pad - (a.arrow && len > head ? Math.sin(ang) * head * 0.8 : 0)} stroke={a.color} strokeWidth={a.strokeWidth} strokeLinecap="round" />
          {a.arrow && <polygon points={`${a.w - minX + pad},${a.h - minY + pad} ${hp(0.45)} ${hp(-0.45)}`} fill={a.color} />}
        </svg>
      </div>
    )
  } else {
    const box = { left: a.x * zoom, top: a.y * zoom, width: a.w * zoom, height: a.h * zoom }
    if (a.type === 'image') {
      body = (
        <div {...common} style={box}>
          <img src={a.src} alt="" draggable={false} />
        </div>
      )
    } else if (a.type === 'link') {
      body = (
        <div {...common} style={box} title={a.url || t('Set the link address in the panel')}>
          <span className="link-label">{a.url ? (a.url.startsWith('#') ? t('Page {n}', { n: a.url.slice(1) }) : a.url) : '🔗'}</span>
        </div>
      )
    } else if (a.type === 'draw') {
      body = (
        <div {...common} style={box}>
          <svg width="100%" height="100%" viewBox={`0 0 ${a.w} ${a.h}`} preserveAspectRatio="none" overflow="visible">
            <polyline points={a.points.map(([x, y]) => `${x * a.w},${y * a.h}`).join(' ')} fill="none" stroke={a.color} strokeWidth={a.strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      )
    } else {
      body = (
        <div
          {...common}
          style={{
            ...box,
            background: a.fill ?? 'transparent',
            border: a.stroke ? `${a.strokeWidth * zoom}px solid ${a.stroke}` : 'none',
            borderRadius: a.type === 'ellipse' ? '50%' : 0,
            opacity: a.opacity,
            mixBlendMode: a.highlight ? 'multiply' : 'normal',
          }}
          title={a.redact === 'all' ? t('Redaction: the content under this box is permanently removed when you download') : undefined}
        />
      )
    }
  }

  return (
    <>
      {body}
      {selected && interactive && !editing && <SelectionChrome a={a} zoom={zoom} onResize={startResize} onRemove={onRemove} />}
    </>
  )
}

function SelectionChrome({ a, zoom, onResize, onRemove }: { a: Annot; zoom: number; onResize: (e: RPointerEvent) => void; onRemove: () => void }) {
  const t = useT()
  const [size, setSize] = useState<[number, number] | null>(null)
  const isText = a.type === 'text'
  useEffect(() => {
    if (!isText) return
    // measure the rendered text element for the selection frame
    const el = document.querySelector<HTMLElement>(`[data-annot-id="${a.id}"]`)
    if (el) setSize([el.offsetWidth, el.offsetHeight])
  }, [a, zoom, isText])
  let frame: Rect
  if (a.type === 'text') frame = { x: a.x * zoom, y: a.y * zoom, w: size?.[0] ?? 0, h: size?.[1] ?? 0 }
  else if (a.type === 'note') frame = { x: a.x * zoom, y: a.y * zoom, w: 20 * zoom, h: 20 * zoom }
  else if (a.type === 'line') frame = { x: Math.min(a.x, a.x + a.w) * zoom, y: Math.min(a.y, a.y + a.h) * zoom, w: Math.abs(a.w) * zoom, h: Math.abs(a.h) * zoom }
  else frame = { x: a.x * zoom, y: a.y * zoom, w: a.w * zoom, h: a.h * zoom }
  const handle =
    a.type === 'line'
      ? { left: (a.x + a.w) * zoom - frame.x - 6, top: (a.y + a.h) * zoom - frame.y - 6, right: 'auto', bottom: 'auto' }
      : undefined
  return (
    <div className={`sel-frame ${a.type === 'line' ? 'no-outline' : ''}`} style={{ left: frame.x, top: frame.y, width: frame.w, height: frame.h }}>
      <button
        className="sel-del"
        title={t('Delete (Del)')}
        aria-label={t('Delete')}
        onPointerDown={(e) => {
          e.stopPropagation()
          onRemove()
        }}
      >
        ×
      </button>
      {a.type !== 'note' && <div className="sel-handle" style={handle} onPointerDown={onResize} title={isText ? t('Drag to change font size') : t('Drag to resize')} />}
    </div>
  )
}
