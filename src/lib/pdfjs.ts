// The legacy build ships polyfills for very recent JS APIs, so it works in browsers that are a few versions old
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PDFDocumentProxy, PDFPageProxy, TextItem } from 'pdfjs-dist/types/src/display/api'
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
import type { FormField } from './types'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

export type { PDFDocumentProxy, PDFPageProxy }

// data files copied next to the app by build/pdfjs-assets.ts
const assets = new URL('pdfjs/', document.baseURI).href

export async function openPdf(bytes: Uint8Array, password?: string): Promise<PDFDocumentProxy> {
  return pdfjs.getDocument({
    // pdf.js transfers the buffer to its worker, so always hand it a copy
    data: bytes.slice(),
    password,
    cMapUrl: `${assets}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${assets}standard_fonts/`,
    wasmUrl: `${assets}wasm/`,
    iccUrl: `${assets}iccs/`,
  }).promise
}

export function isPasswordError(e: unknown) {
  return (e as { name?: string })?.name === 'PasswordException'
}

export interface PageInfo {
  width: number
  height: number
  rotation: number
  view: [number, number, number, number]
}

export async function pageInfo(pdf: PDFDocumentProxy, index: number): Promise<PageInfo> {
  const page = await pdf.getPage(index + 1)
  const vp = page.getViewport({ scale: 1, rotation: 0 })
  return { width: vp.width, height: vp.height, rotation: page.rotate, view: page.view as [number, number, number, number] }
}

interface WidgetData {
  subtype?: string
  fieldType?: string
  fieldName?: string
  rect: number[]
  fieldValue?: unknown
  checkBox?: boolean
  radioButton?: boolean
  pushButton?: boolean
  exportValue?: string
  buttonValue?: string
  options?: { exportValue?: string; displayValue?: string }[]
  multiLine?: boolean
  readOnly?: boolean
  hidden?: boolean
  maxLen?: number
}

/** Fillable AcroForm fields of a page, in editor coordinates. */
export async function extractFields(pdf: PDFDocumentProxy, index: number): Promise<FormField[]> {
  const page = await pdf.getPage(index + 1)
  const [vx0, , , vy1] = page.view
  const out: FormField[] = []
  for (const a of (await page.getAnnotations()) as WidgetData[]) {
    if (a.subtype !== 'Widget' || !a.fieldName || a.hidden || a.pushButton) continue
    const [x0, y0, x1, y1] = a.rect
    const box = { x: Math.min(x0, x1) - vx0, y: vy1 - Math.max(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) }
    if (a.fieldType === 'Tx') {
      out.push({ name: a.fieldName, kind: 'text', ...box, value: typeof a.fieldValue === 'string' ? a.fieldValue : '', multiline: a.multiLine, readOnly: a.readOnly, maxLen: a.maxLen })
    } else if (a.fieldType === 'Btn' && a.checkBox) {
      out.push({ name: a.fieldName, kind: 'checkbox', ...box, value: !!a.fieldValue && a.fieldValue !== 'Off', exportValue: a.exportValue, readOnly: a.readOnly })
    } else if (a.fieldType === 'Btn' && a.radioButton) {
      out.push({ name: a.fieldName, kind: 'radio', ...box, value: typeof a.fieldValue === 'string' ? a.fieldValue : '', exportValue: a.buttonValue, readOnly: a.readOnly })
    } else if (a.fieldType === 'Ch') {
      const v = Array.isArray(a.fieldValue) ? a.fieldValue[0] : a.fieldValue
      out.push({
        name: a.fieldName,
        kind: 'select',
        ...box,
        value: typeof v === 'string' ? v : '',
        options: (a.options ?? []).map((o) => ({ value: o.exportValue ?? o.displayValue ?? '', label: o.displayValue ?? o.exportValue ?? '' })),
        readOnly: a.readOnly,
      })
    }
  }
  return out
}

/** A run of existing text on the page, in unrotated page units (y down). */
export interface TextRun {
  str: string
  x: number
  y: number
  w: number
  h: number
  /** baseline y */
  baseline: number
  fontSize: number
  fontName: string
  fontFamily: string
}

export async function extractTextRuns(page: PDFPageProxy): Promise<TextRun[]> {
  const vp = page.getViewport({ scale: 1, rotation: 0 })
  const content = await page.getTextContent()
  const runs: TextRun[] = []
  for (const item of content.items as TextItem[]) {
    if (!('str' in item) || !item.str.trim()) continue
    const tx = pdfjs.Util.transform(vp.transform, item.transform)
    const fontSize = Math.hypot(tx[2], tx[3])
    // skip rotated / vertical text: whiteout-and-retype only works for horizontal runs
    if (Math.abs(tx[1]) > 0.01 * fontSize) continue
    const style = content.styles[item.fontName]
    let fontName = ''
    try {
      const f = page.commonObjs.get(item.fontName) as { name?: string } | undefined
      fontName = f?.name ?? ''
    } catch {
      /* font object not resolved yet */
    }
    const ascent = style?.ascent ?? 0.8
    const descent = style?.descent ?? -0.2
    const w = item.width * vp.scale
    runs.push({
      str: item.str,
      x: tx[4],
      y: tx[5] - fontSize * ascent,
      w,
      h: fontSize * (ascent - descent),
      baseline: tx[5],
      fontSize,
      fontName,
      fontFamily: style?.fontFamily ?? '',
    })
  }
  return runs
}
