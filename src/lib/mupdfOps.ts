/**
 * Operations backed by MuPDF (WASM). Pure functions on bytes / plain data, so they can
 * run inside a Web Worker (see mupdf.worker.ts) and in Node tests.
 *
 * Coordinates: `URect` is [x0, y0, x1, y1] in PDF user space (y up). Text overlays use
 * top-down page coordinates relative to the crop box, like the editor.
 */
import * as mupdf from 'mupdf'

export type URect = [number, number, number, number]
type Matrix = [number, number, number, number, number, number]

const apply = (m: Matrix, x: number, y: number): [number, number] => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]]
function invert(m: Matrix): Matrix {
  const det = m[0] * m[3] - m[1] * m[2]
  const a = m[3] / det, b = -m[1] / det, c = -m[2] / det, d = m[0] / det
  return [a, b, c, d, -(m[4] * a + m[5] * c), -(m[4] * b + m[5] * d)]
}
function mapRect(m: Matrix, r: URect): URect {
  const pts = [apply(m, r[0], r[1]), apply(m, r[2], r[1]), apply(m, r[0], r[3]), apply(m, r[2], r[3])]
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1])
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

function open(bytes: Uint8Array, password?: string): mupdf.PDFDocument {
  const doc = new mupdf.PDFDocument(bytes)
  if (doc.needsPassword()) {
    if (!password || !doc.authenticatePassword(password)) {
      throw new Error(password ? 'WRONG_PASSWORD' : 'PASSWORD_REQUIRED')
    }
  }
  return doc
}
const save = (doc: mupdf.PDFDocument, opts = 'garbage,compress') => doc.saveToBuffer(opts).asUint8Array().slice()

// ---------------------------------------------------------------- redaction

export interface RedactRequest {
  /** 0-based page index */
  index: number
  rects: { rect: URect; mode: 'text' | 'all' }[]
}

/**
 * True redaction: removes the content under each rect from the page content stream.
 * 'text' removes glyphs only (used when retyping existing text, keeps the background);
 * 'all' also removes vector graphics and blanks image pixels.
 */
export function redact(bytes: Uint8Array, requests: RedactRequest[]): Uint8Array {
  const doc = open(bytes)
  for (const req of requests) {
    const page = doc.loadPage(req.index)
    const ctm = page.getTransform() as Matrix
    for (const mode of ['all', 'text'] as const) {
      const rects = req.rects.filter((r) => r.mode === mode)
      if (!rects.length) continue
      for (const r of rects) {
        const a = page.createAnnotation('Redact')
        a.setRect(mapRect(ctm, r.rect))
      }
      // black boxes off: the editor draws its own fill colour on top afterwards
      if (mode === 'all') page.applyRedactions(false, 2, 1, 0)
      else page.applyRedactions(false, 0, 0, 0)
    }
  }
  return save(doc)
}

// ---------------------------------------------------------------- text overlay (CJK etc.)

export interface OverlayItem {
  str: string
  /** left of the baseline, top-down page units */
  x: number
  y: number
  size: number
  color: [number, number, number]
  alpha: number
  /** counter-clockwise, degrees, as seen on the page */
  angle?: number
  /** stretch/squeeze horizontally so the text is exactly this wide (OCR layers) */
  width?: number
}
export interface OverlayPage {
  width: number
  height: number
  items: OverlayItem[]
}

let cjkFont: mupdf.Font | null = null
const font = () => (cjkFont ??= new mupdf.Font('zh-Hans')) // built-in Droid Sans Fallback: CJK + Latin

/** Whether the built-in Unicode font has a glyph for every character of each string. */
export function coverage(strs: string[]): boolean[] {
  const f = font()
  return strs.map((s) => [...s].every((ch) => /\s/.test(ch) || f.encodeCharacter(ch.codePointAt(0)!) > 0))
}

export function textWidth(str: string, size: number): number {
  const f = font()
  let w = 0
  for (const ch of str) w += f.advanceGlyph(f.encodeCharacter(ch.codePointAt(0)!))
  return w * size
}

/**
 * Lays out text with an embedded, subsetted Unicode font and returns a PDF with one page
 * per input page. The caller stamps those pages onto the real pages as form XObjects,
 * so the text stays selectable and searchable.
 */
export function textOverlay(pages: OverlayPage[]): Uint8Array {
  const f = font()
  const buf = new mupdf.Buffer()
  const writer = new mupdf.DocumentWriter(buf, 'pdf', '')
  for (const p of pages) {
    const dev = writer.beginPage([0, 0, p.width, p.height])
    for (const it of p.items) {
      if (!it.str) continue
      const natural = textWidth(it.str, it.size)
      const hs = it.width && natural > 0 ? it.width / natural : 1
      const t = ((it.angle ?? 0) * Math.PI) / 180
      const cos = Math.cos(t), sin = Math.sin(t)
      const s = it.size
      const text = new mupdf.Text()
      // glyph space is y-up, device space is y-down: flip, scale and rotate counter-clockwise
      text.showString(f, [s * hs * cos, -s * hs * sin, -s * sin, -s * cos, it.x, it.y], it.str)
      // alpha 0 (OCR layer) still writes the text, it is just not painted
      dev.fillText(text, [1, 0, 0, 1, 0, 0], mupdf.ColorSpace.DeviceRGB, it.color, Math.max(it.alpha, 0))
    }
    dev.close()
    writer.endPage()
  }
  writer.close()
  // copy out of WASM memory first: opening a document may grow (and detach) the heap
  const out = new mupdf.PDFDocument(buf.asUint8Array().slice())
  out.subsetFonts()
  return save(out)
}

// ---------------------------------------------------------------- forms

export type FormValues = Record<string, string | boolean>

function onState(w: mupdf.PDFWidget): string | null {
  let on: string | null = null
  try {
    w.getObject().get('AP').get('N').forEach((_v, k) => {
      if (typeof k === 'string' && k !== 'Off') on = k
    })
  } catch {
    /* no appearance dictionary */
  }
  return on
}

/** Fill AcroForm fields by name (appearances are regenerated) and optionally flatten them. */
export function fillForm(bytes: Uint8Array, values: FormValues, flatten: boolean): Uint8Array {
  const doc = open(bytes)
  const done = new Set<string>()
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.loadPage(i)
    for (const w of page.getWidgets()) {
      const name = w.getName()
      if (!(name in values) || w.isReadOnly()) continue
      const v = values[name]
      try {
        if (w.isText()) {
          if (!done.has(name)) w.setTextValue(String(v ?? ''))
          done.add(name)
        } else if (w.isCheckbox()) {
          const checked = w.getValue() !== 'Off' && w.getValue() !== ''
          if (!done.has(name) && checked !== Boolean(v)) w.toggle()
          done.add(name)
        } else if (w.isRadioButton()) {
          const state = onState(w)
          // states may be indices into /Opt (pdf-lib and others do that)
          let label = state
          const opt = w.getObject().getInheritable('Opt')
          if (state && /^\d+$/.test(state) && opt.isArray()) label = opt.get(Number(state)).asString()
          if (state && (state === v || label === v) && w.getValue() !== state) w.toggle()
        } else if (w.isChoice()) {
          if (!done.has(name)) w.setChoiceValue(String(v ?? ''))
          done.add(name)
        }
        w.update()
      } catch {
        /* a broken field should not stop the others */
      }
    }
    page.update()
  }
  if (flatten) doc.bake(false, true)
  return save(doc)
}

/** Burn annotations and form fields into the page content. */
export function flatten(bytes: Uint8Array): Uint8Array {
  const doc = open(bytes)
  doc.bake(true, true)
  return save(doc)
}

// ---------------------------------------------------------------- search

export interface SearchHit {
  page: number
  /** one rect per line of the match, PDF user space */
  rects: URect[]
}

export function search(bytes: Uint8Array, needle: string, maxHits = 500): SearchHit[] {
  const doc = open(bytes)
  const hits: SearchHit[] = []
  for (let i = 0; i < doc.countPages() && hits.length < maxHits; i++) {
    const page = doc.loadPage(i)
    const inv = invert(page.getTransform() as Matrix)
    for (const quads of page.search(needle, 'ignore-case')) {
      hits.push({
        page: i,
        rects: quads.map((q) => {
          const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]]
          return mapRect(inv, [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)])
        }),
      })
    }
  }
  return hits
}

// ---------------------------------------------------------------- security

export type Permission = 'print' | 'copy' | 'edit' | 'annotate' | 'form' | 'assemble'
const PERM_BITS: Record<Permission, number> = { print: 4 | 2048, edit: 8, copy: 16 | 512, annotate: 32, form: 256, assemble: 1024 }

export function encrypt(bytes: Uint8Array, opts: { userPassword: string; ownerPassword: string; allow: Permission[] }): Uint8Array {
  for (const p of [opts.userPassword, opts.ownerPassword]) if (/[,]/.test(p)) throw new Error('PASSWORD_COMMA')
  const doc = open(bytes)
  const owner = opts.ownerPassword || opts.userPassword || Math.random().toString(36).slice(2) + Date.now().toString(36)
  // reserved bits 7-8 and 13-32 must be 1
  let p = 0xfffff0c0 | 0
  for (const a of opts.allow) p |= PERM_BITS[a]
  const o = [
    'garbage',
    'compress',
    'encrypt=aes-256',
    `owner-password=${owner}`,
    opts.userPassword ? `user-password=${opts.userPassword}` : '',
    `permissions=${p}`,
  ]
  return save(doc, o.filter(Boolean).join(','))
}

export function decrypt(bytes: Uint8Array, password: string): Uint8Array {
  const doc = new mupdf.PDFDocument(bytes)
  if (doc.needsPassword() && !doc.authenticatePassword(password)) throw new Error('WRONG_PASSWORD')
  return save(doc, 'garbage,compress,encrypt=none')
}

export function needsPassword(bytes: Uint8Array): boolean {
  return new mupdf.PDFDocument(bytes).needsPassword()
}

// ---------------------------------------------------------------- optimise

export interface CompressResult {
  bytes: Uint8Array
  imagesResampled: number
}

/**
 * lossless: rewrite with object deduplication, stream compression, object streams.
 * balanced / strong: additionally down-sample large images to JPEG.
 */
export function compress(bytes: Uint8Array, level: 'lossless' | 'balanced' | 'strong'): CompressResult {
  const doc = open(bytes)
  let resampled = 0
  if (level !== 'lossless') {
    const maxSide = level === 'balanced' ? 1800 : 1100
    const quality = level === 'balanced' ? 75 : 55
    const n = doc.countObjects()
    for (let i = 1; i < n; i++) {
      try {
        const o = doc.newIndirect(i)
        if (!o.isStream() || o.get('Subtype').toString() !== '/Image') continue
        if (o.get('ImageMask').valueOf() === true || o.get('BitsPerComponent').valueOf() === 1) continue
        const img = doc.loadImage(o)
        const w = img.getWidth(), h = img.getHeight()
        const s = Math.min(1, maxSide / Math.max(w, h))
        const alreadyJpeg = o.get('Filter').toString().includes('DCT')
        if (s >= 1 && alreadyJpeg) continue
        const nw = Math.max(1, Math.round(w * s)), nh = Math.max(1, Math.round(h * s))
        const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, nw, nh], false)
        pix.clear(255)
        const dev = new mupdf.DrawDevice([1, 0, 0, 1, 0, 0], pix)
        dev.fillImage(img, [nw, 0, 0, nh, 0, 0], 1)
        dev.close()
        const jpg = pix.asJPEG(quality)
        if (jpg.length >= o.readRawStream().asUint8Array().length) continue
        o.writeRawStream(jpg)
        o.put('Filter', doc.newName('DCTDecode'))
        o.put('Width', nw)
        o.put('Height', nh)
        o.put('ColorSpace', doc.newName('DeviceRGB'))
        o.put('BitsPerComponent', 8)
        o.delete('DecodeParms')
        o.delete('Decode')
        resampled++
      } catch (e) {
        /* unsupported image: leave it untouched */
        if (typeof process !== 'undefined' && process.env?.MUPDF_DEBUG) console.error(e)
      }
    }
  }
  let out: Uint8Array
  try {
    out = save(doc, 'garbage=deduplicate,compress,compress-fonts,compress-images,clean,objstms')
  } catch {
    out = save(doc, 'garbage,compress')
  }
  return { bytes: out.length < bytes.length ? out : bytes, imagesResampled: resampled }
}

export function repair(bytes: Uint8Array): { bytes: Uint8Array; repaired: boolean } {
  const doc = new mupdf.PDFDocument(bytes)
  const repaired = doc.wasRepaired()
  return { bytes: save(doc, 'garbage,compress,clean'), repaired }
}

// ---------------------------------------------------------------- render / text

export function renderPages(
  bytes: Uint8Array,
  opts: { dpi: number; format: 'png' | 'jpeg'; quality?: number; pages?: number[]; password?: string },
): Uint8Array[] {
  const doc = open(bytes, opts.password)
  const list = opts.pages ?? Array.from({ length: doc.countPages() }, (_, i) => i)
  return list.map((i) => {
    const page = doc.loadPage(i)
    const s = opts.dpi / 72
    const pix = page.toPixmap([s, 0, 0, s, 0, 0], mupdf.ColorSpace.DeviceRGB, false, true)
    return (opts.format === 'png' ? pix.asPNG() : pix.asJPEG(opts.quality ?? 85)).slice()
  })
}

export function extractText(bytes: Uint8Array): string[] {
  const doc = open(bytes)
  const out: string[] = []
  for (let i = 0; i < doc.countPages(); i++) out.push(doc.loadPage(i).toStructuredText('preserve-whitespace').asText())
  return out
}

/** Every embedded image (JPEGs are returned untouched, others as PNG). Tiny images are skipped. */
export function extractImages(bytes: Uint8Array, minSize = 32): { name: string; bytes: Uint8Array }[] {
  const doc = open(bytes)
  const out: { name: string; bytes: Uint8Array }[] = []
  const n = doc.countObjects()
  for (let i = 1; i < n; i++) {
    try {
      const o = doc.newIndirect(i)
      if (!o.isStream() || o.get('Subtype').toString() !== '/Image') continue
      const img = doc.loadImage(o)
      if (img.getWidth() < minSize || img.getHeight() < minSize) continue
      const filter = o.get('Filter').toString()
      if (filter === '/DCTDecode' && !o.get('SMask').isStream()) {
        out.push({ name: `image-${out.length + 1}.jpg`, bytes: o.readRawStream().asUint8Array().slice() })
      } else {
        const pix = img.toPixmap()
        const rgb = pix.getNumberOfComponents() - pix.getAlpha() === 4 ? pix.convertToColorSpace(mupdf.ColorSpace.DeviceRGB, true) : pix
        out.push({ name: `image-${out.length + 1}.png`, bytes: rgb.asPNG().slice() })
      }
    } catch {
      /* skip unsupported images */
    }
  }
  return out
}
