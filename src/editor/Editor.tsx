import { PDFDocument } from 'pdf-lib'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FileDrop } from '../components/FileDrop'
import { Icon } from '../components/Icon'
import { useToast } from '../components/Toast'
import { errorText, useI18n } from '../i18n'
import { exportPdf } from '../lib/exportPdf'
import { mu } from '../lib/mupdfClient'
import type { FormValues } from '../lib/mupdfOps'
import { createOcr, renderForOcr } from '../lib/ocr'
import { extractFields, isPasswordError, openPdf, pageInfo, type PDFDocumentProxy } from '../lib/pdfjs'
import { rasterizeLine } from '../lib/rasterize'
import { STAMPS, renderStamp } from '../lib/stamps'
import type { Annot, PageModel, Tool } from '../lib/types'
import { baseName, downloadBytes, fileToEmbeddableDataUrl, readFileBytes, uid } from '../lib/util'
import { Menu } from './Menu'
import { OcrModal, type OcrRequest } from './OcrModal'
import { PageView, type EditorApi, type Pending, type Rect, type ToolOpts } from './PageView'
import { PropsPanel } from './PropsPanel'
import { Sidebar } from './Sidebar'
import { SignatureModal } from './SignatureModal'

interface Source {
  id: string
  name: string
  bytes: Uint8Array
  pdf: PDFDocumentProxy
}

type ToolId = Tool | 'sign' | 'image'
const MAIN_TOOLS: { id: ToolId; label: string; icon: string; key: string }[] = [
  { id: 'select', label: 'Select', icon: 'select', key: 'v' },
  { id: 'editText', label: 'Edit text', icon: 'editText', key: 'e' },
  { id: 'text', label: 'Add text', icon: 'text', key: 't' },
  { id: 'sign', label: 'Sign', icon: 'sign', key: 's' },
  { id: 'image', label: 'Image', icon: 'image', key: 'i' },
]
const MARK_TOOLS: { id: ToolId; label: string; icon: string; key: string }[] = [
  { id: 'whiteout', label: 'Whiteout', icon: 'whiteout', key: 'w' },
  { id: 'redact', label: 'Redact', icon: 'redact', key: 'x' },
  { id: 'highlight', label: 'Highlight', icon: 'highlight', key: 'h' },
  { id: 'draw', label: 'Draw', icon: 'draw', key: 'd' },
  { id: 'link', label: 'Link', icon: 'link', key: 'k' },
  { id: 'note', label: 'Comment', icon: 'note', key: 'c' },
]
const SHAPE_TOOLS: { id: Tool; label: string; icon: string; key: string }[] = [
  { id: 'rect', label: 'Rectangle', icon: 'rect', key: 'r' },
  { id: 'ellipse', label: 'Ellipse', icon: 'ellipse', key: 'o' },
  { id: 'line', label: 'Line', icon: 'line', key: 'l' },
  { id: 'arrow', label: 'Arrow', icon: 'arrow', key: 'a' },
]
const ALL_TOOLS = [...MAIN_TOOLS, ...MARK_TOOLS, ...SHAPE_TOOLS]
const ZOOMS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3]

export type EditorMode = 'edit' | 'sign' | 'fill' | 'redact' | 'organize'

const cloneAnnot = (a: Annot, dx = 0, dy = 0): Annot => ({ ...a, id: uid(), x: a.x + dx, y: a.y + dy })

export function Editor({ mode = 'edit' }: { mode?: EditorMode }) {
  const toast = useToast()
  const { t, lang } = useI18n()
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
  const [formValues, setFormValues] = useState<Record<string, FormValues>>({})
  const [flattenForms, setFlattenForms] = useState(false)
  const [search, setSearch] = useState<{ open: boolean; query: string; busy: boolean; hits: { pageId: string; rects: Rect[] }[]; active: number } | null>(null)
  const [ocr, setOcr] = useState<{ progress: { done: number; total: number; status: string } | null } | null>(null)
  const pagesRef = useRef<PageModel[]>([])
  const history = useRef<{ past: PageModel[][]; future: PageModel[][] }>({ past: [], future: [] })
  const scroller = useRef<HTMLDivElement>(null)
  const imageInput = useRef<HTMLInputElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)

  const syncHist = () => setHistSize([history.current.past.length, history.current.future.length])
  const setPages = useCallback((next: PageModel[]) => {
    pagesRef.current = next
    setPagesState(next)
  }, [])
  const checkpoint = useCallback(() => {
    history.current.past.push(pagesRef.current)
    if (history.current.past.length > 200) history.current.past.shift()
    history.current.future = []
    syncHist()
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
    syncHist()
  }, [setPages])
  const redo = useCallback(() => {
    const h = history.current
    const next = h.future.pop()
    if (!next) return
    h.past.push(pagesRef.current)
    setPages(next)
    syncHist()
  }, [setPages])

  const mapPage = useCallback((pageId: string, fn: (p: PageModel) => PageModel) => pagesRef.current.map((p) => (p.id === pageId ? fn(p) : p)), [])

  const fitWidth = useCallback((ps: PageModel[]) => {
    const el = scroller.current
    if (!el || !ps.length) return
    const maxW = Math.max(...ps.map((p) => ((p.baseRotation + p.rotation) % 180 ? p.height : p.width)))
    const z = Math.min(2, Math.max(0.3, (el.clientWidth - 48) / maxW))
    setZoom(Math.round(z * 100) / 100)
  }, [])

  /** Open a PDF; encrypted files are decrypted locally (with the password when needed) so they can be saved. */
  const loadSource = async (file: File): Promise<{ source: Source; pages: PageModel[] }> => {
    let bytes = await readFileBytes(file)
    let password: string | undefined
    for (;;) {
      try {
        const probe = await openPdf(bytes, password)
        probe.loadingTask.destroy()
        break
      } catch (e) {
        if (!isPasswordError(e)) throw new Error(t('"{name}" is not a valid PDF', { name: file.name }))
        const p = window.prompt(t('"{name}" is password protected. Enter the password:', { name: file.name }))
        if (p === null) throw new Error(t('Password required'))
        password = p
      }
    }
    let encrypted = !!password
    if (!encrypted) {
      try {
        await PDFDocument.load(bytes, { updateMetadata: false })
      } catch (e) {
        encrypted = /encrypt/i.test(String((e as Error)?.message ?? e))
      }
    }
    if (encrypted) bytes = await mu.decrypt(bytes, password ?? '')
    const pdf = await openPdf(bytes)
    const id = uid()
    const infos = await Promise.all(Array.from({ length: pdf.numPages }, (_, i) => pageInfo(pdf, i)))
    const fields = await Promise.all(Array.from({ length: pdf.numPages }, (_, i) => extractFields(pdf, i).catch(() => [])))
    const ps: PageModel[] = infos.map((info, i) => ({
      id: uid(),
      srcId: id,
      srcIndex: i,
      width: info.width,
      height: info.height,
      view: info.view,
      baseRotation: info.rotation,
      rotation: 0,
      annots: [],
      fields: fields[i].length ? fields[i] : undefined,
    }))
    return { source: { id, name: file.name, bytes, pdf }, pages: ps }
  }

  const openFile = async (file: File) => {
    setLoading(true)
    try {
      const { source, pages: ps } = await loadSource(file)
      sources.forEach((s) => s.pdf.loadingTask.destroy())
      setSources([source])
      history.current = { past: [], future: [] }
      syncHist()
      setPages(ps)
      setFormValues({})
      setSearch(null)
      setFileName(file.name)
      setSelected(null)
      setTool(mode === 'redact' ? 'redact' : 'select')
      requestAnimationFrame(() => fitWidth(ps))
      if (mode === 'sign') setShowSig(true)
      if (mode === 'redact') setSearch({ open: true, query: '', busy: false, hits: [], active: 0 })
      const nFields = ps.reduce((n, p) => n + (p.fields?.length ?? 0), 0)
      if (nFields) toast(t('This PDF has {n} fillable form fields.', { n: nFields }), 'info')
      else if (mode === 'fill') toast(t('No fillable fields found: use "Add text" and the ✓ stamps to fill it in.'), 'info')
    } catch (e) {
      toast(errorText(t, e), 'error')
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
      toast(t('Inserted {n} pages from {name}', { n: ps.length, name: file.name }), 'success')
    } catch (e) {
      toast(errorText(t, e), 'error')
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
      updateAnnot: (pageId, annotId, patch) => setPages(mapPage(pageId, (p) => ({ ...p, annots: p.annots.map((a) => (a.id === annotId ? ({ ...a, ...patch } as Annot) : a)) }))),
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
      setField: (srcId, name, value) => setFormValues((fv) => ({ ...fv, [srcId]: { ...fv[srcId], [name]: value } })),
    }),
    [checkpoint, commit, mapPage, setPages],
  )

  const selectedAnnot = useMemo(() => {
    if (!selected) return null
    return pages.find((p) => p.id === selected.pageId)?.annots.find((a) => a.id === selected.annotId) ?? null
  }, [pages, selected])

  // ---------- page operations ----------
  const goto = (i: number) => {
    const el = scroller.current?.querySelectorAll<HTMLElement>('.page-outer')[i]
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
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
    reverse: () => commit([...pagesRef.current].reverse()),
    rotateAll: (delta: number) => commit(pagesRef.current.map((p) => ({ ...p, rotation: (p.rotation + delta + 360) % 360 }))),
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

  // ---------- images, signatures, stamps ----------
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
      toast(t('That image format is not supported'), 'error')
    }
  }
  const addDate = () => {
    const p = pagesRef.current[current]
    if (!p) return
    const id = uid()
    api.addAnnots(p.id, [{ id, type: 'text', x: p.width / 2 - 30, y: p.height / 3, text: new Date().toLocaleDateString(lang === 'zh' ? 'zh-CN' : undefined), fontSize: 12, color: '#000000', font: 'Helvetica', bold: false, italic: false }], id)
    setTool('select')
  }

  const onToolClick = (id: ToolId) => {
    setEditingId(null)
    if (id === 'sign') return setShowSig(true)
    if (id === 'image') return imageInput.current?.click()
    setPending(null)
    setTool(id)
    if (id !== 'select' && id !== 'editText') setSelected(null)
  }

  // ---------- search & redact ----------
  const runSearch = async (query: string) => {
    if (!query.trim()) return setSearch((s) => (s ? { ...s, hits: [], active: 0 } : s))
    setSearch((s) => ({ open: true, query, busy: true, hits: s?.hits ?? [], active: 0 }))
    try {
      const hits: { pageId: string; rects: Rect[] }[] = []
      for (const src of sources) {
        const found = await mu.search(src.bytes, query)
        for (const pm of pagesRef.current) {
          if (pm.srcId !== src.id || !pm.view) continue
          for (const h of found.filter((f) => f.page === pm.srcIndex)) {
            hits.push({
              pageId: pm.id,
              rects: h.rects.map(([x0, y0, x1, y1]) => ({ x: x0 - pm.view![0], y: pm.view![3] - y1, w: x1 - x0, h: y1 - y0 })),
            })
          }
        }
      }
      // keep document order
      const order = new Map(pagesRef.current.map((p, i) => [p.id, i]))
      hits.sort((a, b) => order.get(a.pageId)! - order.get(b.pageId)! || a.rects[0].y - b.rects[0].y)
      setSearch({ open: true, query, busy: false, hits, active: 0 })
      if (hits.length) gotoHit(hits, 0)
    } catch (e) {
      setSearch((s) => (s ? { ...s, busy: false } : s))
      toast(errorText(t, e), 'error')
    }
  }
  const gotoHit = (hits: { pageId: string; rects: Rect[] }[], i: number) => {
    const idx = pagesRef.current.findIndex((p) => p.id === hits[i]?.pageId)
    if (idx >= 0) goto(idx)
  }
  const markHits = (kind: 'redact' | 'highlight') => {
    if (!search?.hits.length) return
    const byPage = new Map<string, Annot[]>()
    for (const h of search.hits) {
      const list = byPage.get(h.pageId) ?? []
      for (const r of h.rects) {
        const pad = kind === 'redact' ? 1 : 0.5
        list.push(
          kind === 'redact'
            ? { id: uid(), type: 'rect', x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2, fill: '#000000', stroke: null, strokeWidth: 0, opacity: 1, redact: 'all' }
            : { id: uid(), type: 'rect', x: r.x, y: r.y, w: r.w, h: r.h, fill: '#ffe14d', stroke: null, strokeWidth: 0, opacity: 0.5, highlight: true },
        )
      }
      byPage.set(h.pageId, list)
    }
    commit(pagesRef.current.map((p) => (byPage.has(p.id) ? { ...p, annots: [...p.annots, ...byPage.get(p.id)!] } : p)))
    toast(kind === 'redact' ? t('Marked {n} matches for redaction. They are removed when you download.', { n: search.hits.length }) : t('Highlighted {n} matches', { n: search.hits.length }), 'success')
    setSearch((s) => (s ? { ...s, hits: [] } : s))
  }
  const hitsByPage = useMemo(() => {
    const m = new Map<string, { rects: Rect[]; active?: number }>()
    search?.hits.forEach((h, i) => {
      const e = m.get(h.pageId) ?? { rects: [] }
      if (i === search.active) e.active = e.rects.length
      e.rects.push(...h.rects)
      m.set(h.pageId, e)
    })
    return m
  }, [search])

  // ---------- OCR ----------
  const startOcr = async (req: OcrRequest) => {
    const targets: number[] = []
    for (let i = 0; i < pagesRef.current.length; i++) {
      const p = pagesRef.current[i]
      const pdf = pdfFor(p.srcId)
      if (!pdf) continue
      if (req.scope === 'current' && i !== current) continue
      if (req.scope === 'empty') {
        const tc = await (await pdf.getPage(p.srcIndex + 1)).getTextContent()
        if (tc.items.some((it) => 'str' in it && it.str.trim())) continue
      }
      targets.push(i)
    }
    if (!targets.length) {
      setOcr(null)
      toast(t('All pages already contain text. Choose "All pages" to run OCR anyway.'), 'info')
      return
    }
    setOcr({ progress: { done: 0, total: targets.length, status: 'loading engine' } })
    let engine
    try {
      let done = 0
      engine = await createOcr(req.langs, (_p, status) => setOcr({ progress: { done, total: targets.length, status } }))
      const results = new Map<string, NonNullable<PageModel['ocr']>>()
      for (const i of targets) {
        const p = pagesRef.current[i]
        setOcr({ progress: { done, total: targets.length, status: 'recognizing text' } })
        const { canvas, scale } = await renderForOcr(pdfFor(p.srcId)!, p.srcIndex)
        const res = await engine.recognize(canvas, scale)
        results.set(p.id, { words: res.words, lines: res.lines })
        done++
      }
      commit(pagesRef.current.map((p) => (results.has(p.id) ? { ...p, ocr: results.get(p.id) } : p)))
      const words = [...results.values()].reduce((n, r) => n + r.words.length, 0)
      toast(t('Recognized {n} words on {p} pages. The text is searchable in the downloaded PDF.', { n: words, p: results.size }), 'success')
    } catch (e) {
      toast(t('OCR failed: {msg}', { msg: errorText(t, e) }), 'error')
    } finally {
      await engine?.terminate()
      setOcr(null)
    }
  }

  // ---------- keyboard & paste ----------
  useEffect(() => {
    // typing targets swallow shortcuts; checkboxes, radios and buttons don't
    const isField = (el: EventTarget | null) =>
      el instanceof HTMLElement &&
      (el.isContentEditable || ['TEXTAREA', 'SELECT'].includes(el.tagName) || (el instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'range', 'color', 'file'].includes(el.type)))
    const onKey = (e: KeyboardEvent) => {
      if (!pagesRef.current.length || showSig || ocr) return
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setSearch((s) => ({ open: true, query: s?.query ?? '', busy: false, hits: s?.hits ?? [], active: s?.active ?? 0 }))
        requestAnimationFrame(() => searchInput.current?.select())
        return
      }
      if (isField(e.target)) return
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
      const tl = ALL_TOOLS.find((x) => x.key === e.key.toLowerCase())
      if (tl) onToolClick(tl.id)
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
        { engine: mu, rasterize: rasterizeLine, formValues, flattenForms },
      )
      downloadBytes(bytes, `${baseName(fileName)}-edited.pdf`)
      toast(t('Your PDF is ready'), 'success')
    } catch (e) {
      console.error(e)
      toast(t('Could not save: {msg}', { msg: errorText(t, e) }), 'error')
    } finally {
      setSaving(false)
    }
  }

  const zoomStep = (dir: 1 | -1) => {
    const i = ZOOMS.findIndex((z) => z >= zoom - 0.001)
    const next = dir > 0 ? ZOOMS.find((z) => z > zoom + 0.001) : [...ZOOMS].reverse().find((z) => z < zoom - 0.001)
    setZoom(next ?? ZOOMS[Math.max(0, i)])
  }

  const titles: Record<EditorMode, [string, string]> = {
    edit: ['Edit a PDF', 'Change existing text, add text, images, signatures, shapes, links and comments. Reorder, rotate and delete pages.'],
    sign: ['Sign a PDF', 'Draw, type or upload your signature and place it anywhere on the document.'],
    fill: ['Fill a PDF form', 'Type into fillable fields, tick boxes and sign. Works for flat forms too with text and ✓ stamps.'],
    redact: ['Redact a PDF', 'Permanently remove sensitive text and images. Search for words to black them out everywhere at once.'],
    organize: ['Organize pages', 'Drag to reorder, rotate, duplicate or delete pages, insert blank pages or pages from another PDF.'],
  }

  if (!pages.length) {
    return (
      <div className="tool-page">
        <h1>{t(titles[mode][0])}</h1>
        <p className="lead">{t(titles[mode][1])}</p>
        <FileDrop accept="application/pdf,.pdf" title={loading ? t('Opening…') : t('Choose a PDF file')} hint={t('or drop it here · processed locally in your browser')} onFiles={(f) => openFile(f[0])} />
      </div>
    )
  }

  const [canUndo, canRedo] = [histSize[0] > 0, histSize[1] > 0]
  const formCount = pages.reduce((n, p) => n + (p.fields?.length ?? 0), 0)
  const shapeActive = SHAPE_TOOLS.find((s) => s.id === tool)

  return (
    <div className="editor">
      <div className="toolbar">
        <div className="tool-group">
          {MAIN_TOOLS.map((tl) => (
            <button key={tl.id} className={`tool ${tool === tl.id || (tl.id === 'image' && tool === 'place' && !showSig) ? 'active' : ''}`} onClick={() => onToolClick(tl.id)} title={`${t(tl.label)} (${tl.key.toUpperCase()})`}>
              <Icon name={tl.icon} />
              <span>{t(tl.label)}</span>
            </button>
          ))}
          <Menu label={t('Stamp')} icon="stamp">
            {(close) => (
              <>
                {STAMPS.map((s) => {
                  const label = lang === 'zh' ? s.zh : s.en
                  return (
                    <button
                      key={s.id}
                      className="menu-item"
                      style={{ color: s.color }}
                      onClick={() => {
                        const img = renderStamp(s, label, s.kind === 'badge')
                        startPlacing(img.src, img.w, img.h, img.w)
                        close()
                      }}
                    >
                      {label}
                    </button>
                  )
                })}
                <button
                  className="menu-item"
                  onClick={() => {
                    addDate()
                    close()
                  }}
                >
                  📅 {t("Today's date")}
                </button>
              </>
            )}
          </Menu>
          <span className="sep" />
          {MARK_TOOLS.map((tl) => (
            <button key={tl.id} className={`tool ${tool === tl.id ? 'active' : ''}`} onClick={() => onToolClick(tl.id)} title={`${t(tl.label)} (${tl.key.toUpperCase()})`}>
              <Icon name={tl.icon} />
              <span>{t(tl.label)}</span>
            </button>
          ))}
          <Menu label={shapeActive ? t(shapeActive.label) : t('Shapes')} icon={shapeActive?.icon ?? 'shapes'} active={!!shapeActive}>
            {(close) =>
              SHAPE_TOOLS.map((s) => (
                <button
                  key={s.id}
                  className="menu-item"
                  onClick={() => {
                    onToolClick(s.id)
                    close()
                  }}
                >
                  <Icon name={s.icon} size={16} /> {t(s.label)} <kbd>{s.key.toUpperCase()}</kbd>
                </button>
              ))
            }
          </Menu>
        </div>
        <div className="tool-group right">
          <button className={`icon-btn ${search?.open ? 'on' : ''}`} onClick={() => setSearch((s) => (s?.open ? null : { open: true, query: '', busy: false, hits: [], active: 0 }))} title={t('Search & redact (Ctrl+F)')} aria-label={t('Search')}>
            <Icon name="search" />
          </button>
          <button className="icon-btn" onClick={() => setOcr({ progress: null })} title={t('Recognize text (OCR)')} aria-label="OCR">
            <Icon name="ocr" />
          </button>
          <Menu label="" icon="organize" title={t('Page tools')}>
            {(close) => (
              <>
                <button className="menu-item" onClick={() => (pageOps.rotateAll(90), close())}>
                  <Icon name="rotateR" size={16} /> {t('Rotate all pages')}
                </button>
                <button className="menu-item" onClick={() => (pageOps.reverse(), close())}>
                  <Icon name="reverse" size={16} /> {t('Reverse page order')}
                </button>
                <button className="menu-item" onClick={() => (pageOps.addBlank(), close())}>
                  <Icon name="plus" size={16} /> {t('Insert blank page')}
                </button>
              </>
            )}
          </Menu>
          <span className="sep" />
          <button className="icon-btn" onClick={undo} disabled={!canUndo} title={t('Undo (Ctrl+Z)')} aria-label={t('Undo')}>
            <Icon name="undo" />
          </button>
          <button className="icon-btn" onClick={redo} disabled={!canRedo} title={t('Redo (Ctrl+Y)')} aria-label={t('Redo')}>
            <Icon name="redo" />
          </button>
          <span className="sep" />
          <button className="icon-btn" onClick={() => zoomStep(-1)} title={t('Zoom out')} aria-label={t('Zoom out')}>
            <Icon name="zoomOut" />
          </button>
          <button className="zoom-label" onClick={() => fitWidth(pagesRef.current)} title={t('Fit width')}>
            {Math.round(zoom * 100)}%
          </button>
          <button className="icon-btn" onClick={() => zoomStep(1)} title={t('Zoom in')} aria-label={t('Zoom in')}>
            <Icon name="zoomIn" />
          </button>
          <span className="sep" />
          <button className="btn primary" onClick={save} disabled={saving}>
            <Icon name="download" /> {saving ? t('Saving…') : t('Download')}
          </button>
        </div>
      </div>

      {search?.open && (
        <form
          className="searchbar"
          onSubmit={(e) => {
            e.preventDefault()
            runSearch(search.query)
          }}
        >
          <Icon name="search" size={16} />
          <input ref={searchInput} className="input" autoFocus placeholder={t('Find text in the document…')} value={search.query} onChange={(e) => setSearch({ ...search, query: e.target.value })} />
          <button className="btn small" type="submit" disabled={search.busy}>
            {search.busy ? t('Searching…') : t('Find')}
          </button>
          {search.hits.length > 0 && (
            <>
              <span className="muted">{t('{a} of {b}', { a: search.active + 1, b: search.hits.length })}</span>
              <button type="button" className="icon-btn" aria-label={t('Previous')} onClick={() => { const i = (search.active - 1 + search.hits.length) % search.hits.length; setSearch({ ...search, active: i }); gotoHit(search.hits, i) }}>
                <Icon name="up" size={16} />
              </button>
              <button type="button" className="icon-btn" aria-label={t('Next')} onClick={() => { const i = (search.active + 1) % search.hits.length; setSearch({ ...search, active: i }); gotoHit(search.hits, i) }}>
                <Icon name="down" size={16} />
              </button>
              <button type="button" className="btn small" onClick={() => markHits('highlight')}>
                <Icon name="highlight" size={15} /> {t('Highlight all')}
              </button>
              <button type="button" className="btn small danger-solid" onClick={() => markHits('redact')}>
                <Icon name="redact" size={15} /> {t('Redact all')}
              </button>
            </>
          )}
          {!search.busy && search.query && search.hits.length === 0 && <span className="muted">{t('No matches yet — press Enter to search')}</span>}
          <button type="button" className="icon-btn close" aria-label={t('Close')} onClick={() => setSearch(null)}>
            <Icon name="x" size={16} />
          </button>
        </form>
      )}

      {tool === 'place' && pending && (
        <div className="banner">
          {t('Click on a page to place it.')}{' '}
          <button className="link" onClick={() => api.consumePending()}>
            {t('Cancel')}
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
            <Icon name="file" size={15} /> {fileName} · {t('{n} pages', { n: pages.length })}
            <label className="link">
              {t('Open another')}
              <input
                type="file"
                accept="application/pdf,.pdf"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  e.target.value = ''
                  if (f && (!history.current.past.length || window.confirm(t('Discard your current edits?')))) openFile(f)
                }}
              />
            </label>
          </div>
          {pages.map((p) => {
            const h = hitsByPage.get(p.id)
            return (
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
                formValues={p.srcId ? formValues[p.srcId] : undefined}
                hits={h?.rects}
                activeHit={h?.active}
              />
            )
          })}
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
          formCount={formCount}
          flattenForms={flattenForms}
          setFlattenForms={setFlattenForms}
          pageCount={pages.length}
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
      {ocr && <OcrModal progress={ocr.progress} onClose={() => setOcr(null)} onStart={startOcr} />}
    </div>
  )
}
