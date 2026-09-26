import * as mupdf from 'mupdf'
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { describe, expect, it } from 'vitest'
import * as ops from './mupdfOps'

async function textPdf(lines: [string, number][], rotate = 0): Promise<Uint8Array> {
  const d = await PDFDocument.create()
  const f = await d.embedFont(StandardFonts.Helvetica)
  const p = d.addPage([300, 400])
  for (const [s, y] of lines) p.drawText(s, { x: 20, y, size: 20, font: f })
  if (rotate) p.setRotation(degrees(rotate))
  return d.save()
}
async function texts(bytes: Uint8Array): Promise<string> {
  const pdf = await getDocument({ data: bytes.slice() }).promise
  const out: string[] = []
  for (let i = 1; i <= pdf.numPages; i++) {
    const tc = await (await pdf.getPage(i)).getTextContent()
    out.push(tc.items.map((it) => ('str' in it ? it.str : '')).join(''))
  }
  return out.join('\n')
}
function darkPixels(bytes: Uint8Array): number {
  const doc = mupdf.Document.openDocument(bytes, 'application/pdf')
  const pix = doc.loadPage(0).toPixmap([1, 0, 0, 1, 0, 0], mupdf.ColorSpace.DeviceRGB, false)
  const px = pix.getPixels()
  let n = 0
  for (let i = 0; i < px.length; i += 3) if (px[i] < 128) n++
  return n
}

describe('redact', () => {
  it('removes text under the rect, even on rotated pages', async () => {
    for (const rot of [0, 90]) {
      const src = await textPdf([['Secret 12345', 340], ['Keep me', 200]], rot)
      const out = ops.redact(src, [{ index: 0, rects: [{ rect: [15, 335, 250, 365], mode: 'text' }] }])
      const t = await texts(out)
      expect(t).not.toContain('Secret')
      expect(t).toContain('Keep me')
    }
  })
})

describe('textOverlay', () => {
  it('embeds CJK text that stays extractable', async () => {
    const overlay = ops.textOverlay([{ width: 300, height: 200, items: [{ str: '你好，世界 한국어', x: 20, y: 100, size: 18, color: [0, 0, 0], alpha: 1 }] }])
    expect(overlay.length).toBeLessThan(60_000) // subsetted
    expect(await texts(overlay)).toContain('你好，世界')
    expect(darkPixels(overlay)).toBeGreaterThan(50)
  })
  it('writes invisible text for alpha 0 (OCR layer)', async () => {
    const overlay = ops.textOverlay([{ width: 300, height: 200, items: [{ str: 'Invisible words', x: 20, y: 100, size: 18, color: [0, 0, 0], alpha: 0, width: 200 }] }])
    expect(await texts(overlay)).toContain('Invisible words')
    expect(darkPixels(overlay)).toBe(0)
  })
  it('reports glyph coverage', () => {
    expect(ops.coverage(['你好 abc', '😀'])).toEqual([true, false])
  })
})

describe('forms', () => {
  it('fills text, checkbox, radio and dropdown fields, with and without flattening', async () => {
    const d = await PDFDocument.create()
    const page = d.addPage([400, 400])
    const form = d.getForm()
    form.createTextField('name').addToPage(page, { x: 20, y: 340, width: 200, height: 24 })
    form.createCheckBox('agree').addToPage(page, { x: 20, y: 300, width: 16, height: 16 })
    const radio = form.createRadioGroup('size')
    radio.addOptionToPage('S', page, { x: 20, y: 260, width: 16, height: 16 })
    radio.addOptionToPage('L', page, { x: 60, y: 260, width: 16, height: 16 })
    const dd = form.createDropdown('country')
    dd.addOptions(['China', 'Japan'])
    dd.addToPage(page, { x: 20, y: 200, width: 120, height: 24 })
    const src = await d.save()

    const filled = ops.fillForm(src, { name: 'Ada 张三', agree: true, size: 'L', country: 'Japan' }, false)
    const f2 = (await PDFDocument.load(filled)).getForm()
    expect(f2.getTextField('name').getText()).toBe('Ada 张三')
    expect(f2.getCheckBox('agree').isChecked()).toBe(true)
    expect(f2.getRadioGroup('size').getSelected()).toBe('L')
    expect(f2.getDropdown('country').getSelected()).toEqual(['Japan'])

    const flat = ops.fillForm(src, { name: 'Ada Lovelace' }, true)
    expect((await PDFDocument.load(flat)).getForm().getFields()).toHaveLength(0)
    expect(await texts(flat)).toContain('Ada Lovelace')
  })
})

describe('search', () => {
  it('finds matches in PDF user space', async () => {
    const src = await textPdf([['Hello world', 340], ['hello again', 200]])
    const hits = ops.search(src, 'hello')
    expect(hits).toHaveLength(2)
    const [x0, y0, , y1] = hits[0].rects[0]
    expect(x0).toBeCloseTo(20, 0)
    expect(y0).toBeLessThan(345)
    expect(y1).toBeGreaterThan(345)
  })
})

describe('security', () => {
  it('encrypts with permissions and decrypts', async () => {
    const src = await textPdf([['Top secret', 340]])
    const enc = ops.encrypt(src, { userPassword: 'open', ownerPassword: 'owner', allow: ['print'] })
    expect(ops.needsPassword(enc)).toBe(true)
    const doc = new mupdf.PDFDocument(enc)
    expect(doc.authenticatePassword('open')).toBeGreaterThan(0)
    expect(doc.hasPermission('print')).toBe(true)
    expect(doc.hasPermission('copy')).toBe(false)
    expect(() => ops.decrypt(enc, 'nope')).toThrow('WRONG_PASSWORD')
    const dec = ops.decrypt(enc, 'open')
    expect(ops.needsPassword(dec)).toBe(false)
    expect(await texts(dec)).toContain('Top secret')
  })
})

describe('optimise & convert', () => {
  it('downsamples big images', async () => {
    const d = await PDFDocument.create()
    // 2400x2400 photo-like RGB image (gradient + noise) stored losslessly
    const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 2400, 2400], false)
    const px = pix.getPixels()
    let seed = 1
    for (let i = 0; i < px.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      px[i] = (((i / 3) % 2400) / 12 + (seed % 24)) & 255
    }
    const png = pix.asPNG()
    const img = await d.embedPng(png)
    d.addPage([600, 600]).drawImage(img, { x: 0, y: 0, width: 600, height: 600 })
    const src = await d.save()
    const res = ops.compress(src, 'balanced')
    expect(res.imagesResampled).toBe(1)
    expect(res.bytes.length).toBeLessThan(src.length / 2)
    const lossless = ops.compress(src, 'lossless')
    expect(lossless.bytes.length).toBeLessThanOrEqual(src.length)
  })
  it('renders pages and extracts text', async () => {
    const src = await textPdf([['Render me', 340]])
    const [png] = ops.renderPages(src, { dpi: 72, format: 'png' })
    expect([...png.slice(1, 4)].map((c) => String.fromCharCode(c)).join('')).toBe('PNG')
    expect(ops.extractText(src)[0]).toContain('Render me')
    expect(ops.repair(src).repaired).toBe(false)
  })
})
