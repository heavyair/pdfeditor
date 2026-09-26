// The legacy build ships polyfills for very recent JS APIs, so it works in browsers that are a few versions old
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PDFDocumentProxy, PDFPageProxy, TextItem } from 'pdfjs-dist/types/src/display/api'
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

export type { PDFDocumentProxy, PDFPageProxy }

export async function openPdf(bytes: Uint8Array, password?: string): Promise<PDFDocumentProxy> {
  // pdf.js transfers the buffer to its worker, so always hand it a copy
  return pdfjs.getDocument({ data: bytes.slice(), password }).promise
}

export function isPasswordError(e: unknown) {
  return (e as { name?: string })?.name === 'PasswordException'
}

export interface PageInfo {
  width: number
  height: number
  rotation: number
}

export async function pageInfo(pdf: PDFDocumentProxy, index: number): Promise<PageInfo> {
  const page = await pdf.getPage(index + 1)
  const vp = page.getViewport({ scale: 1, rotation: 0 })
  return { width: vp.width, height: vp.height, rotation: page.rotate }
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
