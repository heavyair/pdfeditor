import type { PDFDocumentProxy } from './pdfjs'
import type { OcrWord } from './types'

export const OCR_LANGS: { code: string; label: string }[] = [
  { code: 'eng', label: 'English' },
  { code: 'chi_sim', label: '简体中文' },
  { code: 'chi_tra', label: '繁體中文' },
  { code: 'jpn', label: '日本語' },
  { code: 'kor', label: '한국어' },
  { code: 'fra', label: 'Français' },
  { code: 'deu', label: 'Deutsch' },
  { code: 'spa', label: 'Español' },
  { code: 'ita', label: 'Italiano' },
  { code: 'por', label: 'Português' },
  { code: 'rus', label: 'Русский' },
  { code: 'ara', label: 'العربية' },
]

export const defaultOcrLangs = (uiLang: string) => (uiLang === 'zh' ? ['chi_sim', 'eng'] : ['eng'])

const CJK = '\\u2e80-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef\\u3000-\\u303f'
const HAS_CJK = new RegExp(`[${CJK}]`)

/** Tesseract separates CJK characters with spaces; drop those. */
export const tidy = (s: string) => s.replace(new RegExp(`([${CJK}])\\s+(?=[${CJK}])`, 'g'), '$1').trim()

/** Render one page to a canvas at roughly `dpi` (capped to keep memory reasonable). */
export async function renderForOcr(pdf: PDFDocumentProxy, index: number, dpi = 220): Promise<{ canvas: HTMLCanvasElement; scale: number }> {
  const page = await pdf.getPage(index + 1)
  const base = page.getViewport({ scale: 1, rotation: 0 })
  const scale = Math.min(dpi / 72, 4200 / Math.max(base.width, base.height))
  const vp = page.getViewport({ scale, rotation: 0 })
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(vp.width)
  canvas.height = Math.round(vp.height)
  await page.render({ canvas, viewport: vp, background: '#ffffff' }).promise
  return { canvas, scale }
}

export interface OcrEngine {
  recognize(canvas: HTMLCanvasElement, scale: number): Promise<{ words: OcrWord[]; lines: OcrWord[]; text: string }>
  terminate(): Promise<void>
}

/**
 * Tesseract (WASM) in a worker. Engine and language data are self-hosted (build/runtime-assets.ts)
 * and cached by the service worker the first time they are used, so OCR then works offline.
 */
export async function createOcr(langs: string[], onProgress?: (p: number, status: string) => void): Promise<OcrEngine> {
  const { createWorker } = await import('tesseract.js')
  const base = new URL('tesseract/', document.baseURI).href
  let fail: (e: Error) => void = () => {}
  const failed = new Promise<never>((_, reject) => (fail = reject))
  const timeout = setTimeout(() => fail(new Error('The OCR engine did not start. Check your connection and try again.')), 120_000)
  const worker = await Promise.race([
    createWorker(langs, 1, {
      workerPath: `${base}worker.min.js`,
      corePath: `${base}core/`,
      langPath: `${base}lang`,
      logger: (m) => onProgress?.(m.progress, m.status),
      errorHandler: (e) => fail(e instanceof Error ? e : new Error(String(e))),
    }),
    failed,
  ]).finally(() => clearTimeout(timeout))
  return {
    async recognize(canvas, scale) {
      const { data } = await worker.recognize(canvas, {}, { blocks: true, text: true })
      const words: OcrWord[] = []
      const lines: OcrWord[] = []
      const box = (b: { x0: number; y0: number; x1: number; y1: number }) => ({ x: b.x0 / scale, y: b.y0 / scale, w: (b.x1 - b.x0) / scale, h: (b.y1 - b.y0) / scale })
      for (const block of data.blocks ?? []) {
        for (const para of block.paragraphs) {
          for (const line of para.lines) {
            const lt = tidy(line.text)
            if (lt && line.confidence > 25) lines.push({ text: lt, ...box(line.bbox) })
            // text layer: CJK lines go in whole (no spaces between characters when copied),
            // other scripts word by word for precise selection
            if (lt && HAS_CJK.test(lt)) {
              if (line.confidence > 20) words.push({ text: lt, ...box(line.bbox) })
              continue
            }
            for (const w of line.words) {
              const wt = tidy(w.text)
              if (wt && w.confidence > 20) words.push({ text: wt, ...box(w.bbox) })
            }
          }
        }
      }
      return { words, lines, text: tidy(data.text ?? '') }
    },
    terminate: () => worker.terminate().then(() => {}),
  }
}
