/** Client-side Office <-> PDF conversions. Everything runs locally in the browser. */
import { PDFDocument } from 'pdf-lib'
import type { PDFDocumentProxy, TextItem } from 'pdfjs-dist/types/src/display/api'

export type PageSize = 'A4' | 'Letter'
export type Orientation = 'portrait' | 'landscape'

export interface OfficePdfOpts {
  page: PageSize
  orientation: Orientation
}

const PX_PER_MM = 96 / 25.4
const FONT = `-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC",sans-serif`

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function pageMetrics(o: OfficePdfOpts, marginMm = 12) {
  const base = o.page === 'A4' ? [210, 297] : [215.9, 279.4]
  const [wMm, hMm] = o.orientation === 'landscape' ? [base[1], base[0]] : base
  const w = Math.round(wMm * PX_PER_MM)
  const h = Math.round(hMm * PX_PER_MM)
  const m = Math.round(marginMm * PX_PER_MM)
  return { w, h, contentW: w - 2 * m, contentH: h - 2 * m, margin: m }
}

// ── HTML pagination: split block-level HTML into page-sized chunks ──────────

function paginateBlocks(blocks: string[], contentW: number, contentH: number): string[][] {
  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;left:-99999px;top:0;width:0;overflow:hidden;visibility:hidden;'
  document.body.appendChild(host)
  try {
    const meas = document.createElement('div')
    meas.style.cssText = `width:${contentW}px;font-family:${FONT};font-size:14px;line-height:1.6;color:#111;`
    host.appendChild(meas)
    const pages: string[][] = []
    let cur: string[] = []
    for (const b of blocks) {
      meas.innerHTML = cur.join('') + b
      if (meas.scrollHeight > contentH + 1 && cur.length > 0) {
        pages.push(cur)
        cur = [b]
        meas.innerHTML = b
      } else {
        cur.push(b)
      }
    }
    if (cur.length) pages.push(cur)
    return pages
  } finally {
    host.remove()
  }
}

// ── rasterize one HTML page -> JPEG bytes via SVG foreignObject ─────────────

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('render failed'))
    img.src = url
  })
}

async function rasterizePage(innerHtml: string, w: number, h: number, scale: number): Promise<Uint8Array> {
  const root = `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${w}px;height:${h}px;background:#ffffff;overflow:hidden;box-sizing:border-box;">${innerHtml}</div>`
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><foreignObject x="0" y="0" width="${w}" height="${h}">${root}</foreignObject></svg>`
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }))
  try {
    const img = await loadImage(url)
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(w * scale)
    canvas.height = Math.round(h * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas unavailable')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', 0.92))
    if (!blob) throw new Error('rasterize failed')
    return new Uint8Array(await blob.arrayBuffer())
  } finally {
    URL.revokeObjectURL(url)
  }
}

export async function htmlPagesToPdf(pageHtmls: string[], o: OfficePdfOpts): Promise<Uint8Array> {
  const { w, h, margin } = pageMetrics(o)
  const pdf = await PDFDocument.create()
  const scale = 2 // ~192 dpi
  for (const inner of pageHtmls) {
    const jpg = await rasterizePage(`<div style="padding:${margin}px;">${inner}</div>`, w, h, scale)
    const img = await pdf.embedJpg(jpg)
    const page = pdf.addPage([w * (72 / 96), h * (72 / 96)])
    page.drawImage(img, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() })
  }
  return pdf.save()
}

// ── Excel -> PDF ───────────────────────────────────────────────────────────

interface SheetTable {
  name: string
  header: string[]
  rows: string[][]
  merges: { r: number; c: number; rs: number; cs: number }[]
  widths: number[] // px estimates per column
}

async function parseWorkbook(bytes: Uint8Array): Promise<SheetTable[]> {
  const XLSX = await import('xlsx')
  const wb = XLSX.read(bytes, { type: 'array' })
  return wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name]
    const aoa = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, raw: false, defval: '' }) as unknown as string[][]
    const range = XLSX.utils.decode_range(ws['!ref'] || 'A1')
    const nCols = range.e.c - range.s.c + 1
    const norm = aoa.map((r) => {
      const row = r.map((v) => String(v ?? ''))
      while (row.length < nCols) row.push('')
      return row.slice(0, nCols)
    })
    // drop fully empty trailing rows
    while (norm.length && norm[norm.length - 1].every((c) => !c.trim())) norm.pop()
    const merges = ((ws['!merges'] as { s: { r: number; c: number }; e: { r: number; c: number } }[]) || []).map((m) => ({
      r: m.s.r - range.s.r,
      c: m.s.c - range.s.c,
      rs: m.e.r - m.s.r + 1,
      cs: m.e.c - m.s.c + 1,
    }))
    const cols = (ws['!cols'] as { wch?: number }[]) || []
    const widths = Array.from({ length: nCols }, (_, c) => {
      if (cols[c]?.wch) return Math.round(cols[c].wch! * 7.2) + 14
      let mx = 8
      for (const row of norm) {
        const v = row[c] || ''
        let w = 0
        for (const ch of v) w += ch.charCodeAt(0) > 255 ? 2 : 1
        mx = Math.max(mx, w)
      }
      return Math.min(320, Math.round(mx * 3.9) + 16)
    })
    return { name, header: norm[0] || [], rows: norm.slice(1), merges, widths }
  })
}

function tablePageHtml(title: string, header: string[], rows: string[][], merges: SheetTable['merges'], widths: number[], firstPage: boolean): string {
  const totalW = widths.reduce((a, b) => a + b, 0)
  const colHtml = widths.map((w) => `<col style="width:${((w / totalW) * 100).toFixed(2)}%"/>`).join('')
  const covered = new Set<string>()
  for (const m of merges) for (let r = m.r; r < m.r + m.rs; r++) for (let c = m.c; c < m.c + m.cs; c++) if (r !== m.r || c !== m.c) covered.add(`${r}:${c}`)
  const mergeAt = new Map<string, { rs: number; cs: number }>()
  for (const m of merges) mergeAt.set(`${m.r}:${m.c}`, { rs: m.rs, cs: m.cs })
  const cell = (v: string, r: number, c: number, th: boolean) => {
    if (covered.has(`${r}:${c}`)) return ''
    const m = mergeAt.get(`${r}:${c}`)
    const span = m ? ` colspan="${m.cs}" rowspan="${m.rs}"` : ''
    const tag = th ? 'th' : 'td'
    const style = th ? 'background:#f1f3f5;font-weight:600;' : ''
    return `<${tag}${span} style="${style}border:1px solid #c9ced6;padding:6px 8px;text-align:left;vertical-align:top;word-break:break-word;">${esc(v)}</${tag}>`
  }
  const headHtml = `<thead><tr>${header.map((v, c) => cell(v, 0, c, true)).join('')}</tr></thead>`
  const bodyHtml = rows.map((row, i) => `<tr>${row.map((v, c) => cell(v, i + 1, c, false)).join('')}</tr>`).join('')
  return `${firstPage ? `<h2 style="font-size:17px;margin:0 0 10px;">${esc(title)}</h2>` : ''}<table style="border-collapse:collapse;table-layout:fixed;width:100%;font-size:12.5px;line-height:1.5;">${colHtml}${headHtml}<tbody>${bodyHtml}</tbody></table>`
}

function paginateTableRows(t: SheetTable, contentW: number, contentH: number): string[][] {
  // measure rows inside a real table for accurate heights
  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;left:-99999px;top:0;width:0;overflow:hidden;visibility:hidden;'
  document.body.appendChild(host)
  try {
    const meas = document.createElement('div')
    meas.style.cssText = `width:${contentW}px;font-family:${FONT};`
    host.appendChild(meas)
    const headRow = `<tr>${t.header.map((v) => `<th>${esc(v)}</th>`).join('')}</tr>`
    const rowHtmls = t.rows.map((row) => `<tr>${row.map((v) => `<td>${esc(v)}</td>`).join('')}</tr>`)
    const tableFor = (rows: string[]) =>
      `<table style="border-collapse:collapse;table-layout:fixed;width:100%;font-size:12.5px;line-height:1.5;"><thead>${headRow}</thead><tbody>${rows.join('')}</tbody></table>`
    const groups: string[][] = []
    let cur: string[] = []
    for (const rh of rowHtmls) {
      meas.innerHTML = tableFor([...cur, rh])
      if (meas.scrollHeight > contentH + 1 && cur.length > 0) {
        groups.push(cur)
        cur = [rh]
      } else {
        cur.push(rh)
      }
    }
    if (cur.length) groups.push(cur)
    return groups
  } finally {
    host.remove()
  }
}

export async function excelToPdf(bytes: Uint8Array, o: OfficePdfOpts): Promise<{ pdf: Uint8Array; sheets: number }> {
  const tables = await parseWorkbook(bytes)
  const { contentW, contentH } = pageMetrics(o)
  const pages: string[] = []
  for (const t of tables) {
    const groups = t.rows.length ? paginateTableRows(t, contentW, contentH) : [[]]
    let rowCursor = 0
    let firstPage = true
    for (const g of groups) {
      const srcRows = t.rows.slice(rowCursor, rowCursor + g.length)
      rowCursor += g.length
      pages.push(tablePageHtml(t.name, t.header, srcRows, t.merges, t.widths, firstPage))
      firstPage = false
    }
  }
  if (!pages.length) throw new Error('No data found in this workbook.')
  return { pdf: await htmlPagesToPdf(pages, o), sheets: tables.length }
}

// ── Word -> PDF ────────────────────────────────────────────────────────────

export async function wordToPdf(bytes: Uint8Array, o: OfficePdfOpts): Promise<Uint8Array> {
  const mammoth = (await import('mammoth')).default
  // copy to a clean ArrayBuffer (mammoth browser build expects `arrayBuffer`)
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const { value: html } = await mammoth.convertToHtml({ arrayBuffer: ab })
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html')
  const blocks = Array.from(doc.body.firstElementChild?.children || []).map((el) => el.outerHTML)
  if (!blocks.length) throw new Error('No readable content in this document.')
  const { contentW, contentH } = pageMetrics(o)
  const styled = blocks.map(
    (b) =>
      `<div style="margin:0 0 10px;">${b}</div>`,
  )
  const pages = paginateBlocks(styled, contentW, contentH)
  const pageHtmls = pages.map(
    (p) =>
      `<div style="font-family:${FONT};font-size:14px;line-height:1.7;color:#111;">${p.join('')}<style>table{border-collapse:collapse;width:100%;margin:8px 0;}td,th{border:1px solid #c9ced6;padding:5px 8px;font-size:13px;}img{max-width:100%;height:auto;}h1{font-size:22px;margin:14px 0 8px;}h2{font-size:19px;margin:12px 0 8px;}h3{font-size:16px;margin:10px 0 6px;}p{margin:0 0 10px;}ul,ol{margin:0 0 10px;padding-left:24px;}li{margin-bottom:4px;}</style></div>`,
  )
  return htmlPagesToPdf(pageHtmls, o)
}

// ── PDF -> Excel / Word (text geometry) ────────────────────────────────────

interface PdfItem {
  x: number
  y: number
  w: number
  h: number
  str: string
}

async function pageItems(pdf: PDFDocumentProxy, index: number): Promise<PdfItem[]> {
  const page = await pdf.getPage(index + 1)
  const tc = await page.getTextContent()
  const items: PdfItem[] = []
  for (const it of tc.items as TextItem[]) {
    if (!('str' in it) || !it.str.trim()) continue
    items.push({ x: it.transform[4], y: it.transform[5], w: it.width, h: it.height || 10, str: it.str })
  }
  return items
}

const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y)
  return s.length ? s[Math.floor(s.length / 2)] : 0
}

/** group items into lines (rows), top to bottom */
function toRows(items: PdfItem[]): PdfItem[][] {
  if (!items.length) return []
  const H = Math.max(4, median(items.map((i) => i.h)))
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x)
  const rows: PdfItem[][] = []
  for (const it of sorted) {
    const last = rows[rows.length - 1]
    if (last && Math.abs(last[0].y - it.y) <= H * 0.6) last.push(it)
    else rows.push([it])
  }
  for (const r of rows) r.sort((a, b) => a.x - b.x)
  return rows
}

/** split a row into cells by horizontal gaps */
function rowCells(row: PdfItem[], H: number): string[] {
  const cells: string[] = []
  let cur = ''
  let prevEnd = -Infinity
  const gapTol = Math.max(H * 0.7, 7)
  for (const it of row) {
    if (cur && it.x - prevEnd > gapTol) {
      cells.push(cur)
      cur = ''
    }
    cur += (cur && !cur.endsWith(' ') && !it.str.startsWith(' ') ? ' ' : '') + it.str
    prevEnd = it.x + it.w
  }
  if (cur.trim()) cells.push(cur)
  return cells.map((c) => c.trim())
}

const toNumber = (s: string): string | number => {
  const t = s.replace(/[\s,]*(?=$)/, '').trim()
  return /^-?[\d,]*\.?\d+$/.test(t) ? Number(t.replace(/,/g, '')) : s
}

export async function pdfToExcel(pdf: PDFDocumentProxy): Promise<{ xlsx: Uint8Array; pages: number }> {
  const XLSX = await import('xlsx')
  const wb = XLSX.utils.book_new()
  for (let i = 0; i < pdf.numPages; i++) {
    const items = await pageItems(pdf, i)
    const H = Math.max(4, median(items.map((x) => x.h)))
    const grid = toRows(items).map((r) => rowCells(r, H).map(toNumber))
    const maxCols = Math.max(1, ...grid.map((r) => r.length))
    const norm = grid.map((r) => {
      while (r.length < maxCols) r.push('')
      return r
    })
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(norm.length ? norm : [['']]), `Page ${i + 1}`)
  }
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as Uint8Array
  return { xlsx: out instanceof Uint8Array ? out : new Uint8Array(out), pages: pdf.numPages }
}

export async function pdfToWord(pdf: PDFDocumentProxy): Promise<{ docx: Blob; pages: number }> {
  const { Document, Packer, Paragraph, TextRun } = await import('docx')
  const children: InstanceType<typeof Paragraph>[] = []
  for (let i = 0; i < pdf.numPages; i++) {
    const items = await pageItems(pdf, i)
    const rows = toRows(items)
    const H = Math.max(4, median(items.map((x) => x.h)))
    // merge rows into paragraphs by vertical gaps
    let para: string[] = []
    let prevY = Infinity
    const flush = () => {
      if (para.length) children.push(new Paragraph({ children: [new TextRun(para.join(' '))] }))
      para = []
    }
    for (const r of rows) {
      const line = r.map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim()
      const gap = prevY - r[0].y
      if (para.length && gap > H * 1.7) flush()
      if (line) para.push(line)
      prevY = r[0].y
    }
    flush()
    if (i < pdf.numPages - 1) children.push(new Paragraph({ children: [new TextRun({ text: '', break: 1 })] }))
  }
  if (!children.length) throw new Error('No text found in this PDF. It may be a scan: use OCR first.')
  const doc = new Document({ sections: [{ children }] })
  return { docx: await Packer.toBlob(doc), pages: pdf.numPages }
}
