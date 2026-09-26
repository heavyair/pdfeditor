import { PDFDocument } from 'pdf-lib'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FileDrop } from '../components/FileDrop'
import { Icon } from '../components/Icon'
import { useToast } from '../components/Toast'
import { exportPdf } from '../lib/exportPdf'
import { isPasswordError, openPdf, pageInfo, type PDFDocumentProxy } from '../lib/pdfjs'
import { rasterizeText } from '../lib/rasterize'
import type { Annot, PageModel, Tool } from '../lib/types'
import { baseName, downloadBytes, fileToEmbeddableDataUrl, readFileBytes, uid } from '../lib/util'
import { PageView, type EditorApi, type Pending, type ToolOpts } from './PageView'
import { PropsPanel } from './PropsPanel'
import { Sidebar } from './Sidebar'
import { SignatureModal } from './SignatureModal'

interface Source {
  id: string
  name: string
  bytes: Uint8Array
  pdf: PDFDocumentProxy
}

const TOOLS: { id: Tool | 'sign' | 'image'; label: string; icon: string; key?: string }[] = [
  { id: 'select', label: 'Select', icon: 'select', key: 'v' },
  { id: 'editText', label: 'Edit text', icon: 'editText', key: 'e' },
  { id: 'text', label: 'Add text', icon: 'text', key: 't' },
  { id: 'sign', label: 'Sign', icon: 'sign', key: 's' },
  { id: 'image', label: 'Image', icon: 'image', key: 'i' },
  { id: 'whiteout', label: 'Whiteout', icon: 'whiteout', key: 'w' },
  { id: 'highlight', label: 'Highlight', icon: 'highlight', key: 'h' },
  { id: 'rect', label: 'Rectangle', icon: 'rect', key: 'r' },
  { id: 'ellipse', label: 'Ellipse', icon: 'ellipse', key: 'o' },
  { id: 'draw', label: 'Draw', icon: 'draw', key: 'd' },
]

const ZOOMS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3]

async function loadSource(file: File): Promise<{ source: Source; pages: PageModel[]; encrypted: boolean }> {
  const bytes = await readFileBytes(file)
  let pdf: PDFDocumentProxy | null = null
  let password: string | undefined
  for (;;) {
    try {
      pdf = await openPdf(bytes, password)
      break
    } catch (e) {
      if (!isPasswordError(e)) throw new Error(`"${file.name}" is not a valid PDF`)
      const p = window.prompt(`"${file.name}" is password protected. Enter the password:`)
      if (p === null) throw new Error('Password required')
      password = p
    }
  }
  let encrypted = false
  try {
    await PDFDocument.load(bytes, { updateMetadata: false })
  } catch (e) {
    encrypted = /encrypt/i.test(String((e as Error)?.message ?? e))
  }
  const id = uid()
  const infos = await Promise.all(Array.from({ length: pdf.numPages }, (_, i) => pageInfo(pdf!, i)))
  const pages: PageModel[] = infos.map((info, i) => ({
    id: uid(),
    srcId: id,
    srcIndex: i,
    width: info.width,
    height: info.height,
    baseRotation: info.rotation,
    rotation: 0,
    annots: [],
  }))
  return { source: { id, name: file.name, bytes, pdf }, pages, encrypted }
}

const cloneAnnot = (a: Annot, dx = 0, dy = 0): Annot => ({ ...a, id: uid(), x: a.x + dx, y: a.y + dy })

export function Editor({ startWithSignature }: { startWithSignature?: boolean }) {
  const toast = useToast()
  const [sources, setSources] = useState<Source[]>([])
  const [pages, setPagesState] = useState<PageModel[]>([])
  const [fileName, setFileName] = useState('document.pdf')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [tool, setTool] = useState<Tool>('select')
  const [zoom, setZoom] = useState(1)
  const [opts, setOpts] = useState<ToolOpts>({ color: '#000000', fontSize: 14, font: 'Helvetica', strokeWidth: 2 })
  const [selected, setSelected] = useState<{ pageId: string; annotId: string } | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [showSig, setShowSig] = useState(false)
  const [current, setCurrent] = useState(0)
  const [histSize, setHistSize] = useState<[number, number]>([0, 0])
  const pagesRef = useRef<PageModel[]>([])
  const history = useRef<{ past: PageModel[][]; future: PageModel[][] }>({ past: [], future: [] })
  const scroller = useRef<HTMLDivElement>(null)
  const imageInput = useRef<HTMLInputElement>(null)

  const setPages = useCallback((next: PageModel[]) => {
    pagesRef.current = next
    setPagesState(next)
  }, [])
  const checkpoint = useCallback(() => {
    history.current.past.push(pagesRef.current)
    if (history.current.past.length > 200) history.current.past.shift()
    history.current.future = []
    setHistSize([history.current.past.length, history.current.future.length])
  }, [])
  const commit = useCallback(
    (next: PageModel[]) => {
      checkpoint()
      setPages(next)
    },
    [checkpoint, setPages],
  )
  const undo = useCallback(() => {
    const h = history.current
    const prev = h.past.pop()
    if (!prev) return
    h.future.push(pagesRef.current)
    setPages(prev)
    setEditingId(null)
    setHistSize([history.current.past.length, history.current.future.length])
  }, [setPages])
  const redo = useCallback(() => {
    const h = history.current
    const next = h.future.pop()
    if (!next) return
    h.past.push(pagesRef.current)
    setPages(next)
    setHistSize([history.current.past.length, history.current.future.length])
  }, [setPages])

  const mapPage = useCallback(
    (pageId: string, fn: (p: PageModel) => PageModel) => pagesRef.current.map((p) => (p.id === pageId ? fn(p) : p)),
    [],
  )

  const fitWidth = useCallback((ps: PageModel[]) => {
    const el = scroller.current
    if (!el || !ps.length) return
    const maxW = Math.max(...ps.map((p) => ((p.baseRotation + p.rotation) % 180 ? p.height : p.width)))
    const z = Math.min(2, Math.max(0.3, (el.clientWidth - 48) / maxW))
    setZoom(Math.round(z * 100) / 100)
  }, [])

  const openFile = async (file: File) => {
    setLoading(true)
    try {
      const { source, pages: ps, encrypted } = await loadSource(file)
      sources.forEach((s) => s.pdf.loadingTask.destroy())
      setSources([source])
      history.current = { past: [], future: [] }
      setHistSize([0, 0])
      setPages(ps)
      setFileName(file.name)
      setSelected(null)
      setTool('select')
      if (encrypted) toast('This PDF is encrypted. Viewing works, but saving may fail or lose content.', 'error')
      requestAnimationFrame(() => fitWidth(ps))
      if (startWithSignature) setShowSig(true)
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setLoading(false)
    }
  }

  const insertPdf = async (file: File) => {
    try {
      const { source, pages: ps } = await loadSource(file)
      setSources((s) => [...s, source])
      const at = Math.min(current + 1, pagesRef.current.length)
      const next = [...pagesRef.current]
      next.splice(at, 0, ...ps)
      commit(next)
      toast(`Inserted ${ps.length} page${ps.length > 1 ? 's' : ''} from ${file.name}`, 'success')
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  const pdfFor = useCallback((srcId: string | null) => sources.find((s) => s.id === srcId)?.pdf ?? null, [sources])

  // ---------- API passed to page views ----------
  const api: EditorApi = useMemo(
    () => ({
      select: (pageId, annotId) => {
        setSelected(annotId ? { pageId, annotId } : null)
        if (!annotId) setEditingId(null)
      },
      setEditing: setEditingId,
      checkpoint,
      addAnnots: (pageId, annots, selectId, edit) => {
        commit(mapPage(pageId, (p) => ({ ...p, annots: [...p.annots, ...annots] })))
        if (selectId) setSelected({ pageId, annotId: selectId })
        if (edit && selectId) setEditingId(selectId)
      },
      updateAnnot: (pageId, annotId, patch) =>
        setPages(mapPage(pageId, (p) => ({ ...p, annots: p.annots.map((a) => (a.id === annotId ? ({ ...a, ...patch } as Annot) : a)) }))),
      removeAnnot: (pageId, annotId) => {
        commit(mapPage(pageId, (p) => ({ ...p, annots: p.annots.filter((a) => a.id !== annotId) })))
        setSelected((s) => (s?.annotId === annotId ? null : s))
        setEditingId((id) => (id === annotId ? null : id))
      },
      setTool,
      consumePending: () => {
        setPending(null)
        setTool('select')
      },
    }),
    [checkpoint, commit, mapPage, setPages],
  )

  const selectedAnnot = useMemo(() => {
    if (!selected) return null
    return pages.find((p) => p.id === selected.pageId)?.annots.find((a) => a.id === selected.annotId) ?? null
  }, [pages, selected])

  // ---------- page operations ----------
  const pageOps = {
    move: (from: number, to: number) => {
      const next = [...pagesRef.current]
      const [p] = next.splice(from, 1)
      next.splice(to, 0, p)
      commit(next)
    },
    rotate: (i: number, delta: number) => commit(pagesRef.current.map((p, k) => (k === i ? { ...p, rotation: (p.rotation + delta + 360) % 360 } : p))),
    remove: (i: number) => {
      if (pagesRef.current.length <= 1) return
      commit(pagesRef.current.filter((_, k) => k !== i))
      setSelected(null)
    },
    duplicate: (i: number) => {
      const next = [...pagesRef.current]
      const src = next[i]
      next.splice(i + 1, 0, { ...src, id: uid(), annots: src.annots.map((a) => cloneAnnot(a)) })
      commit(next)
    },
    addBlank: () => {
      const ref = pagesRef.current[current]
      const [w, h] = ref ? [ref.width, ref.height] : [595.28, 841.89]
      const next = [...pagesRef.current]
      next.splice(current + 1, 0, { id: uid(), srcId: null, srcIndex: 0, width: w, height: h, baseRotation: 0, rotation: ref?.rotation ?? 0, annots: [] })
      commit(next)
      requestAnimationFrame(() => goto(current + 1))
    },
  }

  const goto = (i: number) => {
    const el = scroller.current?.querySelectorAll<HTMLElement>('.page-outer')[i]
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    const mid = el.getBoundingClientRect().top + el.clientHeight / 3
    const nodes = el.querySelectorAll<HTMLElement>('.page-outer')
    let best = 0
    nodes.forEach((n, i) => {
      if (n.getBoundingClientRect().top <= mid) best = i
    })
    if (best !== current) setCurrent(best)
  }

  // ---------- selection actions ----------
  const updateSelected = (patch: Partial<Annot>) => {
    if (!selected) return
    checkpoint()
    api.updateAnnot(selected.pageId, selected.annotId, patch)
  }
  const deleteSelected = () => selected && api.removeAnnot(selected.pageId, selected.annotId)
  const duplicateSelected = () => {
    if (!selected || !selectedAnnot) return
    const copy = cloneAnnot(selectedAnnot, 12, 12)
    api.addAnnots(selected.pageId, [copy], copy.id)
  }
  const layerSelected = (dir: 'front' | 'back') => {
    if (!selected || !selectedAnnot) return
    commit(
      mapPage(selected.pageId, (p) => {
        const rest = p.annots.filter((a) => a.id !== selected.annotId)
        return { ...p, annots: dir === 'front' ? [...rest, selectedAnnot] : [selectedAnnot, ...rest] }
      }),
    )
  }

  // ---------- images & signatures ----------
  const startPlacing = (src: string, width: number, height: number, targetWidth: number) => {
    const w = Math.min(targetWidth, width)
    setPending({ src, w, h: (height / width) * w })
    setTool('place')
    setSelected(null)
  }
  const onImageFile = async (file: File) => {
    try {
      const img = await fileToEmbeddableDataUrl(file)
      startPlacing(img.src, img.width * 0.75, img.height * 0.75, 260)
    } catch {
      toast('That image format is not supported', 'error')
    }
  }

  const onToolClick = (id: Tool | 'sign' | 'image') => {
    setEditingId(null)
    if (id === 'sign') return setShowSig(true)
    if (id === 'image') return imageInput.current?.click()
    setPending(null)
    setTool(id)
    if (id !== 'select' && id !== 'editText') setSelected(null)
  }

  // ---------- keyboard & paste ----------
  useEffect(() => {
    const isField = (t: EventTarget | null) =>
      t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))
    const onKey = (e: KeyboardEvent) => {
      if (!pagesRef.current.length || showSig) return
      if (isField(e.target)) return
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
        return
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        redo()
        return
      }
      if (mod && e.key.toLowerCase() === 'd' && selected) {
        e.preventDefault()
        duplicateSelected()
        return
      }
      if (mod) return
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
        e.preventDefault()
        deleteSelected()
        return
      }
      if (e.key === 'Escape') {
        setPending(null)
        setSelected(null)
        setTool('select')
        return
      }
      if (e.key === 'Enter' && selectedAnnot?.type === 'text' && selected) {
        e.preventDefault()
        checkpoint()
        setEditingId(selected.annotId)
        return
      }
      if (e.key.startsWith('Arrow') && selected && selectedAnnot) {
        e.preventDefault()
        const step = e.shiftKey ? 10 : 1
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0
        updateSelected({ x: selectedAnnot.x + dx, y: selectedAnnot.y + dy })
        return
      }
      const t = TOOLS.find((x) => x.key === e.key.toLowerCase())
      if (t) onToolClick(t.id)
    }
    const onPaste = (e: ClipboardEvent) => {
      if (!pagesRef.current.length || isField(e.target)) return
      const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith('image/'))
      const f = item?.getAsFile()
      if (f) {
        e.preventDefault()
        onImageFile(f)
      }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('paste', onPaste)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('paste', onPaste)
    }
  })

  // warn before leaving with unsaved edits
  useEffect(() => {
    const onBefore = (e: BeforeUnloadEvent) => {
      if (history.current.past.length) e.preventDefault()
    }
    window.addEventListener('beforeunload', onBefore)
    return () => window.removeEventListener('beforeunload', onBefore)
  }, [])

  const save = async () => {
    setEditingId(null)
    setSaving(true)
    try {
      const bytes = await exportPdf(
        sources.map((s) => ({ id: s.id, bytes: s.bytes })),
        pagesRef.current,
        rasterizeText,
      )
      downloadBytes(bytes, `${baseName(fileName)}-edited.pdf`)
      toast('Your PDF is ready', 'success')
    } catch (e) {
      console.error(e)
      toast(`Could not save: ${(e as Error).message}`, 'error')
    } finally {
      setSaving(false)
    }
  }

  const zoomStep = (dir: 1 | -1) => {
    const i = ZOOMS.findIndex((z) => z >= zoom - 0.001)
    const next = dir > 0 ? ZOOMS.find((z) => z > zoom + 0.001) : [...ZOOMS].reverse().find((z) => z < zoom - 0.001)
    setZoom(next ?? ZOOMS[Math.max(0, i)])
  }

  if (!pages.length) {
    return (
      <div className="tool-page">
        <h1>{startWithSignature ? 'Sign a PDF' : 'Edit a PDF'}</h1>
        <p className="lead">
          {startWithSignature
            ? 'Draw, type or upload your signature and place it anywhere on the document.'
            : 'Change existing text, add text, images, signatures, shapes and drawings. Reorder, rotate and delete pages.'}
        </p>
        <FileDrop accept="application/pdf,.pdf" title={loading ? 'Opening…' : 'Choose a PDF file'} hint="or drop it here · processed locally in your browser" onFiles={(f) => openFile(f[0])} />
      </div>
    )
  }

  const [canUndo, canRedo] = [histSize[0] > 0, histSize[1] > 0]

  return (
    <div className="editor">
      <div className="toolbar">
        <div className="tool-group">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              className={`tool ${tool === t.id || (t.id === 'image' && tool === 'place' && !showSig) ? 'active' : ''}`}
              onClick={() => onToolClick(t.id)}
              title={`${t.label}${t.key ? ` (${t.key.toUpperCase()})` : ''}`}
            >
              <Icon name={t.icon} />
              <span>{t.label}</span>
            </button>
          ))}
        </div>
        <div className="tool-group right">
          <button className="icon-btn" onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)" aria-label="Undo">
            <Icon name="undo" />
          </button>
          <button className="icon-btn" onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Y)" aria-label="Redo">
            <Icon name="redo" />
          </button>
          <span className="sep" />
          <button className="icon-btn" onClick={() => zoomStep(-1)} title="Zoom out" aria-label="Zoom out">
            <Icon name="zoomOut" />
          </button>
          <button className="zoom-label" onClick={() => fitWidth(pagesRef.current)} title="Fit width">
            {Math.round(zoom * 100)}%
          </button>
          <button className="icon-btn" onClick={() => zoomStep(1)} title="Zoom in" aria-label="Zoom in">
            <Icon name="zoomIn" />
          </button>
          <span className="sep" />
          <button className="btn primary" onClick={save} disabled={saving}>
            <Icon name="download" /> {saving ? 'Saving…' : 'Download'}
          </button>
        </div>
      </div>

      {tool === 'place' && pending && (
        <div className="banner">
          Click on a page to place it.{' '}
          <button className="link" onClick={() => api.consumePending()}>
            Cancel
          </button>
        </div>
      )}

      <div className="editor-body">
        <Sidebar
          pages={pages}
          pdfFor={pdfFor}
          current={current}
          onGoto={goto}
          onMove={pageOps.move}
          onRotate={pageOps.rotate}
          onDelete={pageOps.remove}
          onDuplicate={pageOps.duplicate}
          onAddBlank={pageOps.addBlank}
          onInsertPdf={insertPdf}
        />
        <div className="pages" ref={scroller} onScroll={onScroll}>
          <div className="file-chip">
            <Icon name="file" size={15} /> {fileName} · {pages.length} page{pages.length > 1 ? 's' : ''}
            <label className="link">
              Open another
              <input
                type="file"
                accept="application/pdf,.pdf"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  e.target.value = ''
                  if (f && (!history.current.past.length || window.confirm('Discard your current edits?'))) openFile(f)
                }}
              />
            </label>
          </div>
          {pages.map((p) => (
            <PageView
              key={p.id}
              page={p}
              pdf={pdfFor(p.srcId)}
              zoom={zoom}
              tool={tool}
              opts={opts}
              pending={pending}
              selectedId={selected?.pageId === p.id ? selected.annotId : null}
              editingId={editingId}
              api={api}
            />
          ))}
        </div>
        <PropsPanel
          annot={selectedAnnot}
          tool={tool}
          opts={opts}
          setOpts={setOpts}
          onChange={updateSelected}
          onDelete={deleteSelected}
          onDuplicate={duplicateSelected}
          onLayer={layerSelected}
        />
      </div>

      <input
        ref={imageInput}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (f) onImageFile(f)
        }}
      />
      {showSig && (
        <SignatureModal
          onClose={() => setShowSig(false)}
          onUse={(s) => {
            setShowSig(false)
            startPlacing(s.src, s.width, s.height, 170)
          }}
        />
      )}
    </div>
  )
}
