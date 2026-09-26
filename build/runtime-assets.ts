import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { Plugin } from 'vite'

/**
 * Engines load data files at runtime. We self-host them (no CDN needed, works offline):
 * - pdf.js: CMaps (CJK text with non-embedded fonts), standard fonts, WASM image decoders
 *   (JPEG 2000 / JBIG2, common in scans), ICC profiles  -> pdfjs/
 * - Tesseract OCR: worker, LSTM cores (plain / SIMD / relaxed SIMD) and language data -> tesseract/
 * Served from node_modules in dev, copied to the output folder on build.
 */
export const OCR_LANGS = ['eng', 'chi_sim', 'chi_tra', 'jpn', 'kor', 'fra', 'deu', 'spa', 'ita', 'por', 'rus', 'ara']

function files(): Map<string, string> {
  const m = new Map<string, string>()
  const nm = resolve('node_modules')
  const addDir = (from: string, to: string) => {
    for (const f of readdirSync(from)) {
      const p = join(from, f)
      if (statSync(p).isDirectory()) addDir(p, `${to}/${f}`)
      else if (!/^LICENSE|\.md$/.test(f)) m.set(`${to}/${f}`, p)
    }
  }
  for (const d of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) addDir(join(nm, 'pdfjs-dist', d), `pdfjs/${d}`)
  m.set('tesseract/worker.min.js', join(nm, 'tesseract.js/dist/worker.min.js'))
  for (const v of ['', '-simd', '-relaxedsimd']) {
    const name = `tesseract-core${v}-lstm.wasm.js`
    m.set(`tesseract/core/${name}`, join(nm, 'tesseract.js-core', name))
  }
  for (const l of OCR_LANGS) {
    const p = join(nm, '@tesseract.js-data', l, '4.0.0_best_int', `${l}.traineddata.gz`)
    if (existsSync(p)) m.set(`tesseract/lang/${l}.traineddata.gz`, p)
  }
  return m
}

const MIME: Record<string, string> = { '.wasm': 'application/wasm', '.js': 'text/javascript', '.gz': 'application/octet-stream' }

export function runtimeAssets(): Plugin {
  let outDir = 'dist'
  return {
    name: 'runtime-assets',
    configResolved(c) {
      outDir = resolve(c.root, c.build.outDir)
    },
    configureServer(server) {
      const map = files()
      server.middlewares.use((req, res, next) => {
        const path = decodeURIComponent((req.url ?? '').split('?')[0]).replace(/^\//, '')
        const src = map.get(path)
        if (!src) return next()
        res.setHeader('Content-Type', MIME[path.slice(path.lastIndexOf('.'))] ?? 'application/octet-stream')
        res.end(readFileSync(src))
      })
    },
    writeBundle() {
      for (const [to, from] of files()) {
        const dest = join(outDir, to)
        mkdirSync(dirname(dest), { recursive: true })
        copyFileSync(from, dest)
      }
    },
  }
}
