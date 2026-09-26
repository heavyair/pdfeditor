import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import { PdfCanvas } from '../components/PdfCanvas'
import { BASELINE, CSS_FONT, LINE_HEIGHT, guessFont } from '../lib/fonts'
import { extractTextRuns, type PDFDocumentProxy, type TextRun } from '../lib/pdfjs'
import type { Annot, BoxAnnot, PageModel, TextAnnot, Tool } from '../lib/types'
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
}

type Draft =
  | { kind: 'box'; x0: number; y0: number; x1: number; y1: number }
  | { kind: 'draw'; points: [number, number][] }
  | null

const rot = (r: number) => (((r % 360) + 360) % 360) as 0 | 90 | 180 | 270

export function PageView({ page, pdf, zoom, tool, opts, pending, selectedId, editingId, api }: Props) {
  const outer = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [draft, setDraft] = useState<Draft>(null)
  const [ghost, setGhost] = useState<[number, number] | null>(null)
  const [runs, setRuns] = useState<TextRun[] | null>(null)
  const r = rot(page.rotation + page.baseRotation)
  const W = page.width * zoom
  const H = page.height * zoom
  const swapped = r === 90 || r === 270

  // load existing text runs for "Edit text" mode
  useEffect(() => {
    if (tool !== 'editText' || !pdf || runs) return
    let cancelled = false
    pdf
      .getPage(page.srcIndex + 1)
      .then(extractTextRuns)
      .then((x) => !cancelled && setRuns(x))
      .catch(() => !cancelled && setRuns([]))
    return () => {
      cancelled = true
    }
  }, [tool, pdf, page.srcIndex, runs])

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
        const a: TextAnnot = {
          id: uid(),
          type: 'text',
          x,
          y: y - opts.fontSize * 0.6,
          text: '',
          fontSize: opts.fontSize,
          color: opts.color,
          font: opts.font,
          bold: false,
          italic: false,
        }
        e.preventDefault()
        api.addAnnots(page.id, [a], a.id, true)
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
              {
                id: uid(),
                type: 'draw',
                x: bx,
                y: by,
                w: bw,
                h: bh,
                points: pts.map(([px, py]) => [(px - bx) / bw, (py - by) / bh]),
                color: opts.color,
                strokeWidth: opts.strokeWidth,
              },
            ])
          },
        )
        return
      }
      case 'whiteout':
      case 'highlight':
      case 'rect':
      case 'ellipse': {
        e.preventDefault()
        let d = { kind: 'box' as const, x0: x, y0: y, x1: x, y1: y }
        setDraft(d)
        const t = tool
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
              bw = t === 'highlight' ? 120 : 100
              bh = t === 'highlight' ? 16 : 50
              bx = x
              by = y - bh / 2
            }
            const id = uid()
            const base = { id, x: bx, y: by, w: Math.max(bw, 2), h: Math.max(bh, 2) }
            const a: BoxAnnot =
              t === 'whiteout'
                ? { ...base, type: 'rect', fill: '#ffffff', stroke: null, strokeWidth: 0, opacity: 1 }
                : t === 'highlight'
                  ? { ...base, type: 'rect', fill: '#ffe14d', stroke: null, strokeWidth: 0, opacity: 0.5, highlight: true }
                  : { ...base, type: t, fill: null, stroke: opts.color, strokeWidth: opts.strokeWidth, opacity: 1 }
            api.addAnnots(page.id, [a], id)
          },
        )
        return
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
      const probes = [
        px(run.x - 2, run.y + run.h / 2),
        px(run.x + run.w + 2, run.y + run.h / 2),
        px(run.x + run.w / 2, run.y - 1),
        px(run.x + run.w / 2, run.y + run.h + 1),
      ]
      const bg = [0, 1, 2].map((i) => probes.map((p) => p[i]).sort((a, b) => a - b)[2]) // upper-median
      const bx = Math.round(run.x * k)
      const by = Math.round(run.y * k)
      const bw = Math.max(1, Math.round(run.w * k))
      const bh = Math.max(1, Math.round(run.h * k))
      const data = ctx.getImageData(bx, by, bw, bh).data
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

  const editRun = (e: RPointerEvent, run: TextRun) => {
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
    }
    const text: TextAnnot = {
      id: uid(),
      type: 'text',
      x: run.x,
      y: run.baseline - BASELINE[f.font] * fontSize,
      text: run.str,
      fontSize,
      color: fg,
      ...f,
    }
    api.addAnnots(page.id, [cover, text], text.id, true)
  }

  const cursor =
    tool === 'select' ? 'default' : tool === 'text' ? 'text' : tool === 'place' ? 'copy' : tool === 'editText' ? 'default' : 'crosshair'

  return (
    <div
      ref={outer}
      className="page-outer"
      style={{ width: swapped ? H : W, height: swapped ? W : H }}
      data-page-id={page.id}
      onPointerMove={(e) => tool === 'place' && pending && setGhost(toLocal(e.clientX, e.clientY))}
      onPointerLeave={() => setGhost(null)}
    >
      <div
        className="page-inner"
        style={{ width: W, height: H, transform: `translate(-50%, -50%) rotate(${r}deg)`, cursor }}
        onPointerDown={onPagePointerDown}
      >
        <PdfCanvas pdf={pdf} index={page.srcIndex} width={page.width} height={page.height} scale={zoom} canvasRef={canvas} />

        {tool === 'editText' && runs && (
          <div className="runs-layer">
            {runs.map((run, i) => (
              <div
                key={i}
                className="run"
                title="Click to edit this text"
                style={{ left: run.x * zoom, top: run.y * zoom, width: run.w * zoom, height: run.h * zoom }}
                onPointerDown={(e) => editRun(e, run)}
              />
            ))}
          </div>
        )}

        <div className="annots-layer">
          {page.annots.map((a) => (
            <AnnotView
              key={a.id}
              a={a}
              zoom={zoom}
              interactive={tool === 'select' || tool === 'editText'}
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

        {draft?.kind === 'box' && (
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
            <polyline
              points={draft.points.map(([x, y]) => `${x * zoom},${y * zoom}`).join(' ')}
              fill="none"
              stroke={opts.color}
              strokeWidth={opts.strokeWidth * zoom}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
        {tool === 'place' && pending && ghost && (
          <img
            className="ghost"
            src={pending.src}
            alt=""
            style={{
              left: (ghost[0] - pending.w / 2) * zoom,
              top: (ghost[1] - pending.h / 2) * zoom,
              width: pending.w * zoom,
              height: pending.h * zoom,
            }}
          />
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

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
    const { w: w0, h: h0 } = a
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
    className: `annot annot-${a.type} ${selected ? 'selected' : ''} ${interactive ? 'interactive' : ''} ${editing ? 'editing' : ''}`,
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
  } else {
    const box = { left: a.x * zoom, top: a.y * zoom, width: a.w * zoom, height: a.h * zoom }
    if (a.type === 'image') {
      body = (
        <div {...common} style={box}>
          <img src={a.src} alt="" draggable={false} />
        </div>
      )
    } else if (a.type === 'draw') {
      body = (
        <div {...common} style={box}>
          <svg width="100%" height="100%" viewBox={`0 0 ${a.w} ${a.h}`} preserveAspectRatio="none" overflow="visible">
            <polyline
              points={a.points.map(([x, y]) => `${x * a.w},${y * a.h}`).join(' ')}
              fill="none"
              stroke={a.color}
              strokeWidth={a.strokeWidth}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
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
        />
      )
    }
  }

  return (
    <>
      {body}
      {selected && interactive && !editing && (
        <SelectionChrome a={a} zoom={zoom} onResize={startResize} onRemove={onRemove} />
      )}
    </>
  )
}

function SelectionChrome({
  a,
  zoom,
  onResize,
  onRemove,
}: {
  a: Annot
  zoom: number
  onResize: (e: RPointerEvent) => void
  onRemove: () => void
}) {
  const [size, setSize] = useState<[number, number] | null>(null)
  const isText = a.type === 'text'
  useEffect(() => {
    if (!isText) return
    // measure the rendered text element for the selection frame
    const el = document.querySelector<HTMLElement>(`[data-annot-id="${a.id}"]`)
    if (el) setSize([el.offsetWidth, el.offsetHeight])
  }, [a, zoom, isText])
  const w = isText ? (size?.[0] ?? 0) : a.w * zoom
  const h = isText ? (size?.[1] ?? 0) : a.h * zoom
  return (
    <div className="sel-frame" style={{ left: a.x * zoom, top: a.y * zoom, width: w, height: h }}>
      <button
        className="sel-del"
        title="Delete (Del)"
        aria-label="Delete"
        onPointerDown={(e) => {
          e.stopPropagation()
          onRemove()
        }}
      >
        ×
      </button>
      <div className="sel-handle" onPointerDown={onResize} title={isText ? 'Drag to change font size' : 'Drag to resize'} />
    </div>
  )
}
