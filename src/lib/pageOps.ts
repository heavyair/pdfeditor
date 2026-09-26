import { PDFDocument } from 'pdf-lib'
import { dataUrlToBytes } from './util'

export interface MergeInput {
  kind: 'pdf' | 'image'
  bytes: Uint8Array
  /** 0-based pages to take (pdf only); undefined = all */
  pages?: number[]
  /** image data URL (png/jpeg) for kind === 'image' */
  src?: string
  width?: number
  height?: number
}

/** Merge PDFs (optionally a subset of pages each) and images (one page per image). */
export async function mergePdfs(inputs: MergeInput[]): Promise<Uint8Array> {
  const out = await PDFDocument.create()
  for (const input of inputs) {
    if (input.kind === 'image') {
      const src = input.src!
      const bytes = dataUrlToBytes(src)
      const img = /^data:image\/jpe?g/i.test(src) ? await out.embedJpg(bytes) : await out.embedPng(bytes)
      // fit image on an A4 page with a margin, keeping orientation
      const landscape = img.width > img.height
      const [pw, ph] = landscape ? [841.89, 595.28] : [595.28, 841.89]
      const margin = 24
      const s = Math.min((pw - 2 * margin) / img.width, (ph - 2 * margin) / img.height, 1)
      const w = img.width * s
      const h = img.height * s
      const page = out.addPage([pw, ph])
      page.drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h })
      continue
    }
    const src = await PDFDocument.load(input.bytes, { ignoreEncryption: true })
    const indices = input.pages ?? src.getPageIndices()
    const copied = await out.copyPages(src, indices)
    copied.forEach((p) => out.addPage(p))
  }
  return out.save()
}

/** Create one new PDF per page group. */
export async function splitPdf(bytes: Uint8Array, groups: number[][]): Promise<Uint8Array[]> {
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true })
  const results: Uint8Array[] = []
  for (const g of groups) {
    const out = await PDFDocument.create()
    const copied = await out.copyPages(src, g)
    copied.forEach((p) => out.addPage(p))
    results.push(await out.save())
  }
  return results
}

export async function pageCount(bytes: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true })
  return doc.getPageCount()
}
