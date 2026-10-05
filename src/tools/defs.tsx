import { PDFDocument } from 'pdf-lib'
import { PdfCanvas } from '../components/PdfCanvas'
import { mu } from '../lib/mupdfClient'
import type { Permission } from '../lib/mupdfOps'
import * as pt from '../lib/pageTools'
import { splitPdf } from '../lib/pageOps'
import { parsePageList } from '../lib/ranges'
import { rasterizeLine } from '../lib/rasterize'
import { fileToEmbeddableDataUrl } from '../lib/util'
import { Field, Segmented, fmtSize, outputName, type LoadedFile, type ToolDef } from './SimpleTool'

const MM = 72 / 25.4

/** optional page range input; empty = all pages */
function PagesField({ value, onChange, t, count }: { value: string; onChange: (v: string) => void; t: (k: string, v?: Record<string, string | number>) => string; count: number }) {
  return (
    <Field label={t('Pages')} hint={t('Leave empty for all {n} pages, or enter e.g. 1-3, 5', { n: count })}>
      <input className="input" value={value} placeholder={t('All pages')} onChange={(e) => onChange(e.target.value)} />
    </Field>
  )
}
const pagesOf = (range: string, f: LoadedFile) => (range.trim() ? parsePageList(range, f.pageCount) : undefined)

// ───────────────────────────────────────────────────────── compress

type CompressLevel = 'lossless' | 'balanced' | 'strong' | 'extreme'
export const compressTool: ToolDef<{ level: CompressLevel }> = {
  id: 'compress',
  title: 'Compress PDF',
  lead: 'Reduce file size by recompressing images and removing duplicate data.',
  icon: 'compress',
  action: 'Compress & download',
  defaults: { level: 'balanced' },
  Options: ({ value, set, t }) => (
    <Field
      label={t('Compression')}
      hint={t(
        {
          lossless: 'Keeps everything identical; removes unused and duplicate objects.',
          balanced: 'Recommended. Large images are resampled to good screen quality.',
          strong: 'Smallest file that keeps text selectable. Images get visibly softer.',
          extreme: 'Turns every page into a compressed image. Text is no longer selectable.',
        }[value.level],
      )}
    >
      <Segmented
        value={value.level}
        onChange={(level) => set({ level })}
        options={[
          ['lossless', t('Lossless')],
          ['balanced', t('Balanced')],
          ['strong', t('Strong')],
          ['extreme', t('Extreme')],
        ]}
      />
    </Field>
  ),
  run: async (f, o, t) => {
    let bytes: Uint8Array
    if (o.level === 'extreme') {
      const imgs = await mu.renderPages(f.bytes, { dpi: 110, format: 'jpeg', quality: 60 })
      const src = await PDFDocument.load(f.bytes, { ignoreEncryption: true })
      const out = await PDFDocument.create()
      for (let i = 0; i < imgs.length; i++) {
        const sp = src.getPage(i)
        const { width, height } = sp.getCropBox()
        const r = sp.getRotation().angle % 180
        const [w, h] = r ? [height, width] : [width, height]
        const img = await out.embedJpg(imgs[i])
        out.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h })
      }
      bytes = await out.save()
    } else {
      bytes = (await mu.compress(f.bytes, o.level)).bytes
    }
    const saved = 1 - bytes.length / f.bytes.length
    return {
      files: [{ name: outputName(f, 'compressed'), bytes }],
      note:
        saved > 0.005
          ? t('{a} → {b} (saved {p}%)', { a: fmtSize(f.bytes.length), b: fmtSize(bytes.length), p: Math.round(saved * 100) })
          : t('This PDF is already well optimised ({a}).', { a: fmtSize(f.bytes.length) }),
    }
  },
}

// ───────────────────────────────────────────────────────── protect / unlock

interface ProtectOpts {
  user: string
  confirm: string
  owner: string
  allow: Permission[]
}
const PERMS: [Permission, string][] = [
  ['print', 'Printing'],
  ['copy', 'Copying text and images'],
  ['edit', 'Editing'],
  ['annotate', 'Comments'],
  ['form', 'Filling forms'],
  ['assemble', 'Inserting, deleting and rotating pages'],
]
export const protectTool: ToolDef<ProtectOpts> = {
  id: 'protect',
  title: 'Protect PDF',
  lead: 'Encrypt the PDF with a password (AES-256) and restrict printing, copying or editing.',
  icon: 'lock',
  action: 'Encrypt & download',
  defaults: { user: '', confirm: '', owner: '', allow: ['print', 'copy', 'form', 'annotate'] },
  Options: ({ value, set, t }) => (
    <>
      <div className="grid2">
        <Field label={t('Password to open')}>
          <input className="input" type="password" autoComplete="new-password" value={value.user} onChange={(e) => set({ ...value, user: e.target.value })} />
        </Field>
        <Field label={t('Repeat password')}>
          <input className="input" type="password" autoComplete="new-password" value={value.confirm} onChange={(e) => set({ ...value, confirm: e.target.value })} />
        </Field>
      </div>
      <Field label={t('Owner password (optional)')} hint={t('Needed to change the permissions below. Leave empty to generate a random one.')}>
        <input className="input" type="password" autoComplete="new-password" value={value.owner} onChange={(e) => set({ ...value, owner: e.target.value })} />
      </Field>
      <Field label={t('Allow')}>
        <div className="chips">
          {PERMS.map(([p, label]) => (
            <label key={p} className={`chip ${value.allow.includes(p) ? 'on' : ''}`}>
              <input type="checkbox" checked={value.allow.includes(p)} onChange={(e) => set({ ...value, allow: e.target.checked ? [...value.allow, p] : value.allow.filter((x) => x !== p) })} />
              {t(label)}
            </label>
          ))}
        </div>
      </Field>
    </>
  ),
  validate: (o) => (!o.user && !o.owner ? 'Enter a password' : o.user !== o.confirm ? 'The passwords do not match' : null),
  run: async (f, o) => ({
    files: [{ name: outputName(f, 'protected'), bytes: await mu.encrypt(f.bytes, { userPassword: o.user, ownerPassword: o.owner, allow: o.allow }) }],
  }),
}

export const unlockTool: ToolDef<{ password: string }> = {
  id: 'unlock',
  title: 'Unlock PDF',
  lead: 'Remove the password and restrictions from a PDF you have the password for.',
  icon: 'unlock',
  action: 'Unlock & download',
  acceptsLocked: true,
  defaults: { password: '' },
  Options: ({ value, set, file, t }) =>
    file.locked ? (
      <Field label={t('Password')}>
        <input className="input" type="password" autoFocus value={value.password} onChange={(e) => set({ password: e.target.value })} />
      </Field>
    ) : (
      <p className="tip">{t('This file opens without a password. Unlocking removes any printing, copying or editing restrictions.')}</p>
    ),
  run: async (f, o) => ({ files: [{ name: outputName(f, 'unlocked'), bytes: await mu.decrypt(f.bytes, o.password) }] }),
}

// ───────────────────────────────────────────────────────── watermark

interface WmOpts {
  kind: 'text' | 'image'
  text: string
  image?: { src: string; width: number; height: number }
  size: number
  color: string
  opacity: number
  angle: number
  layout: 'center' | 'tile'
  imageScale: number
  range: string
}
export const watermarkTool: ToolDef<WmOpts> = {
  id: 'watermark',
  title: 'Add watermark',
  lead: 'Stamp text or a logo across your pages, centred or tiled.',
  icon: 'watermark',
  action: 'Add watermark & download',
  defaults: { kind: 'text', text: 'CONFIDENTIAL', size: 48, color: '#e5484d', opacity: 0.25, angle: 45, layout: 'center', imageScale: 0.4, range: '' },
  Options: ({ value, set, file, t }) => (
    <>
      <Segmented value={value.kind} onChange={(kind) => set({ ...value, kind })} options={[['text', t('Text')], ['image', t('Image')]]} />
      {value.kind === 'text' ? (
        <div className="grid2">
          <Field label={t('Text')}>
            <input className="input" value={value.text} onChange={(e) => set({ ...value, text: e.target.value })} />
          </Field>
          <Field label={t('Color')}>
            <input type="color" value={value.color} onChange={(e) => set({ ...value, color: e.target.value })} />
          </Field>
          <Field label={`${t('Size')} · ${value.size}`}>
            <input type="range" min={10} max={140} value={value.size} onChange={(e) => set({ ...value, size: +e.target.value })} />
          </Field>
        </div>
      ) : (
        <Field label={t('Image')}>
          <input
            type="file"
            accept="image/*"
            onChange={async (e) => {
              const fl = e.target.files?.[0]
              if (fl) set({ ...value, image: await fileToEmbeddableDataUrl(fl) })
            }}
          />
          {value.image && <img className="wm-preview" src={value.image.src} alt="" />}
          <input type="range" min={0.1} max={1} step={0.05} value={value.imageScale} onChange={(e) => set({ ...value, imageScale: +e.target.value })} aria-label={t('Size')} />
        </Field>
      )}
      <div className="grid2">
        <Field label={`${t('Opacity')} · ${Math.round(value.opacity * 100)}%`}>
          <input type="range" min={0.05} max={1} step={0.05} value={value.opacity} onChange={(e) => set({ ...value, opacity: +e.target.value })} />
        </Field>
        <Field label={`${t('Angle')} · ${value.angle}°`}>
          <input type="range" min={-90} max={90} step={5} value={value.angle} onChange={(e) => set({ ...value, angle: +e.target.value })} />
        </Field>
      </div>
      <Field label={t('Layout')}>
        <Segmented value={value.layout} onChange={(layout) => set({ ...value, layout })} options={[['center', t('Centered')], ['tile', t('Tiled')]]} />
      </Field>
      <PagesField value={value.range} onChange={(range) => set({ ...value, range })} t={t} count={file.pageCount} />
    </>
  ),
  validate: (o) => (o.kind === 'text' ? (o.text.trim() ? null : 'Enter the watermark text') : o.image ? null : 'Choose an image'),
  run: async (f, o) => ({
    files: [{ name: outputName(f, 'watermarked'), bytes: await pt.addWatermark(f.bytes, { ...o, pages: pagesOf(o.range, f) }, mu, rasterizeLine) }],
  }),
}

// ───────────────────────────────────────────────────────── page numbers

interface NumOpts {
  template: string
  position: pt.Position
  size: number
  margin: number
  startAt: number
  color: string
  range: string
}
export const numbersTool: ToolDef<NumOpts> = {
  id: 'page-numbers',
  title: 'Page numbers & header/footer',
  lead: 'Add page numbers or any header / footer text, e.g. "Page 3 of 10" or a date.',
  icon: 'hash',
  action: 'Add & download',
  defaults: { template: 'Page {n} of {total}', position: 'bottom-center', size: 10, margin: 24, startAt: 1, color: '#000000', range: '' },
  Options: ({ value, set, file, t }) => {
    const presets = ['{n}', 'Page {n} of {total}', '{n} / {total}', '第 {n} 页', '第 {n} 页，共 {total} 页', '- {n} -', '{file} · {date}']
    return (
      <>
        <Field label={t('Text')} hint={t('Placeholders: {n} page number, {total} page count, {date} today, {file} file name')}>
          <input className="input" value={value.template} onChange={(e) => set({ ...value, template: e.target.value })} />
          <div className="chips">
            {presets.map((p) => (
              <button key={p} type="button" className={`chip ${value.template === p ? 'on' : ''}`} onClick={() => set({ ...value, template: p })}>
                {pt.formatTemplate(p, 3, 10, 'file.pdf')}
              </button>
            ))}
          </div>
        </Field>
        <Field label={t('Position')}>
          <div className="pos-grid">
            {(['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right'] as pt.Position[]).map((p) => (
              <button key={p} type="button" className={value.position === p ? 'on' : ''} onClick={() => set({ ...value, position: p })} aria-label={p}>
                <span />
              </button>
            ))}
          </div>
        </Field>
        <div className="grid2">
          <Field label={`${t('Size')} · ${value.size}`}>
            <input type="range" min={6} max={36} value={value.size} onChange={(e) => set({ ...value, size: +e.target.value })} />
          </Field>
          <Field label={`${t('Margin')} · ${Math.round(value.margin / MM)} mm`}>
            <input type="range" min={6} max={80} value={value.margin} onChange={(e) => set({ ...value, margin: +e.target.value })} />
          </Field>
          <Field label={t('First number')}>
            <input className="input" type="number" value={value.startAt} onChange={(e) => set({ ...value, startAt: parseInt(e.target.value, 10) || 1 })} />
          </Field>
          <Field label={t('Color')}>
            <input type="color" value={value.color} onChange={(e) => set({ ...value, color: e.target.value })} />
          </Field>
        </div>
        <PagesField value={value.range} onChange={(range) => set({ ...value, range })} t={t} count={file.pageCount} />
      </>
    )
  },
  run: async (f, o) => ({
    files: [{ name: outputName(f, 'numbered'), bytes: await pt.addPageNumbers(f.bytes, { ...o, pages: pagesOf(o.range, f), fileName: f.name }, mu, rasterizeLine) }],
  }),
}

// ───────────────────────────────────────────────────────── rotate / delete / crop / n-up

export const rotateTool: ToolDef<{ angle: number; range: string }> = {
  id: 'rotate',
  title: 'Rotate PDF',
  lead: 'Rotate all or some pages by 90°, 180° or 270°.',
  icon: 'rotateR',
  action: 'Rotate & download',
  defaults: { angle: 90, range: '' },
  Options: ({ value, set, file, t }) => (
    <>
      <Field label={t('Rotation')}>
        <Segmented value={value.angle} onChange={(angle) => set({ ...value, angle })} options={[[90, t('90° clockwise')], [180, '180°'], [270, t('90° counter-clockwise')]]} />
      </Field>
      <PagesField value={value.range} onChange={(range) => set({ ...value, range })} t={t} count={file.pageCount} />
    </>
  ),
  run: async (f, o) => ({ files: [{ name: outputName(f, 'rotated'), bytes: await pt.rotatePages(f.bytes, o.angle, pagesOf(o.range, f)) }] }),
}

export const deletePagesTool: ToolDef<{ range: string }> = {
  id: 'delete-pages',
  title: 'Delete pages',
  lead: 'Remove pages you don’t need.',
  icon: 'trash',
  action: 'Delete & download',
  defaults: { range: '' },
  Options: ({ value, set, file, t }) => (
    <Field label={t('Pages to delete')} hint={t('e.g. 2, 5-7 (document has {n} pages)', { n: file.pageCount })}>
      <input className="input" autoFocus value={value.range} onChange={(e) => set({ range: e.target.value })} />
    </Field>
  ),
  validate: (o, f) => {
    if (!o.range.trim()) return 'Enter the pages to delete'
    const del = new Set(parsePageList(o.range, f.pageCount))
    return del.size >= f.pageCount ? 'You cannot delete every page' : null
  },
  run: async (f, o) => {
    const del = new Set(parsePageList(o.range, f.pageCount))
    const keep = Array.from({ length: f.pageCount }, (_, i) => i).filter((i) => !del.has(i))
    const [bytes] = await splitPdf(f.bytes, [keep])
    return { files: [{ name: outputName(f, 'trimmed'), bytes }] }
  },
}

interface CropOpts {
  top: number
  right: number
  bottom: number
  left: number
  range: string
}
function CropPreview({ file, o }: { file: LoadedFile; o: CropOpts }) {
  if (!file.pdf || !file.first) return null
  const r = file.first.rotation % 360
  const swapped = r === 90 || r === 270
  const s = 220 / Math.max(file.first.width, file.first.height)
  const vw = (swapped ? file.first.height : file.first.width) * s
  const vh = (swapped ? file.first.width : file.first.height) * s
  return (
    <div className="crop-preview" style={{ width: vw, height: vh }}>
      <div className="thumb-rot" style={{ width: file.first.width * s, height: file.first.height * s, transform: `translate(-50%,-50%) rotate(${r}deg)` }}>
        <PdfCanvas pdf={file.pdf} index={0} width={file.first.width} height={file.first.height} scale={s} />
      </div>
      <div className="crop-box" style={{ left: o.left * MM * s, top: o.top * MM * s, right: o.right * MM * s, bottom: o.bottom * MM * s }} />
    </div>
  )
}
export const cropTool: ToolDef<CropOpts> = {
  id: 'crop',
  title: 'Crop PDF',
  lead: 'Trim page margins. Values are in millimetres, as the page is displayed.',
  icon: 'crop',
  action: 'Crop & download',
  defaults: { top: 10, right: 10, bottom: 10, left: 10, range: '' },
  Options: ({ value, set, file, t }) => (
    <div className="crop-layout">
      <CropPreview file={file} o={value} />
      <div>
        <div className="grid2">
          {(['top', 'bottom', 'left', 'right'] as const).map((k) => (
            <Field key={k} label={`${t({ top: 'Top', bottom: 'Bottom', left: 'Left', right: 'Right' }[k])} (mm)`}>
              <input className="input" type="number" min={0} value={value[k]} onChange={(e) => set({ ...value, [k]: Math.max(0, parseFloat(e.target.value) || 0) })} />
            </Field>
          ))}
        </div>
        <PagesField value={value.range} onChange={(range) => set({ ...value, range })} t={t} count={file.pageCount} />
      </div>
    </div>
  ),
  run: async (f, o) => ({
    files: [{ name: outputName(f, 'cropped'), bytes: await pt.cropPages(f.bytes, { top: o.top * MM, right: o.right * MM, bottom: o.bottom * MM, left: o.left * MM }, pagesOf(o.range, f)) }],
  }),
}

export const nupTool: ToolDef<{ per: 2 | 4 | 6 | 9; sheet: 'A4' | 'Letter' | 'auto' }> = {
  id: 'n-up',
  title: 'Multiple pages per sheet',
  lead: 'Put 2, 4, 6 or 9 pages on each sheet (N-up) to save paper when printing.',
  icon: 'grid',
  action: 'Create & download',
  defaults: { per: 2, sheet: 'A4' },
  Options: ({ value, set, t }) => (
    <>
      <Field label={t('Pages per sheet')}>
        <Segmented value={value.per} onChange={(per) => set({ ...value, per })} options={[[2, '2'], [4, '4'], [6, '6'], [9, '9']]} />
      </Field>
      <Field label={t('Sheet size')}>
        <Segmented value={value.sheet} onChange={(sheet) => set({ ...value, sheet })} options={[['A4', 'A4'], ['Letter', 'Letter'], ['auto', t('Same as pages')]]} />
      </Field>
    </>
  ),
  run: async (f, o) => ({ files: [{ name: outputName(f, `${o.per}-up`), bytes: await pt.nUp(f.bytes, o.per, o.sheet) }] }),
}

// ───────────────────────────────────────────────────────── metadata

export const metadataTool: ToolDef<pt.Metadata> = {
  id: 'metadata',
  title: 'Edit metadata',
  lead: 'View and change the title, author, subject and keywords stored in the PDF, or wipe them for privacy.',
  icon: 'info',
  action: 'Save & download',
  defaults: (f) => pt.readMetadata(f.bytes),
  Options: ({ value, set, t }) => (
    <>
      <div className="grid2">
        {(
          [
            ['title', 'Title'],
            ['author', 'Author'],
            ['subject', 'Subject'],
            ['keywords', 'Keywords'],
            ['creator', 'Creator application'],
            ['producer', 'Producer'],
          ] as [keyof pt.Metadata, string][]
        ).map(([k, label]) => (
          <Field key={k} label={t(label)}>
            <input className="input" value={value[k]} onChange={(e) => set({ ...value, [k]: e.target.value })} />
          </Field>
        ))}
      </div>
      <button type="button" className="btn small" onClick={() => set({ title: '', author: '', subject: '', keywords: '', creator: '', producer: '' })}>
        {t('Clear all fields')}
      </button>
    </>
  ),
  run: async (f, o) => ({ files: [{ name: outputName(f, 'metadata'), bytes: await pt.writeMetadata(f.bytes, o) }] }),
}

// ───────────────────────────────────────────────────────── convert

export const toImagesTool: ToolDef<{ format: 'png' | 'jpeg'; dpi: number; range: string }> = {
  id: 'pdf-to-images',
  title: 'PDF to JPG / PNG',
  lead: 'Convert each page to an image. Several pages are downloaded as a ZIP.',
  icon: 'photo',
  action: 'Convert & download',
  defaults: { format: 'jpeg', dpi: 150, range: '' },
  Options: ({ value, set, file, t }) => (
    <>
      <Field label={t('Format')}>
        <Segmented value={value.format} onChange={(format) => set({ ...value, format })} options={[['jpeg', 'JPG'], ['png', 'PNG']]} />
      </Field>
      <Field label={t('Resolution')}>
        <Segmented value={value.dpi} onChange={(dpi) => set({ ...value, dpi })} options={[[72, t('72 dpi (screen)')], [150, '150 dpi'], [300, t('300 dpi (print)')]]} />
      </Field>
      <PagesField value={value.range} onChange={(range) => set({ ...value, range })} t={t} count={file.pageCount} />
    </>
  ),
  run: async (f, o) => {
    const pages = pagesOf(o.range, f) ?? Array.from({ length: f.pageCount }, (_, i) => i)
    const imgs = await mu.renderPages(f.bytes, { dpi: o.dpi, format: o.format, quality: 88, pages })
    const ext = o.format === 'png' ? 'png' : 'jpg'
    return { files: imgs.map((b, i) => ({ name: outputName(f, `page-${String(pages[i] + 1).padStart(3, '0')}`, ext), bytes: b, mime: `image/${o.format}` })) }
  },
}

export const toTextTool: ToolDef<Record<string, never>> = {
  id: 'pdf-to-text',
  title: 'PDF to text',
  lead: 'Extract all text as a plain .txt file. For scanned documents, run OCR first.',
  icon: 'textFile',
  action: 'Extract text',
  defaults: {},
  run: async (f, _o, t) => {
    const pages = await mu.extractText(f.bytes)
    const text = pages.map((p, i) => `${t('— Page {n} —', { n: i + 1 })}\n${p.trim()}\n`).join('\n')
    const empty = pages.every((p) => !p.trim())
    return {
      files: [{ name: outputName(f, 'text', 'txt'), bytes: new Blob([text], { type: 'text/plain;charset=utf-8' }), mime: 'text/plain' }],
      text,
      note: empty ? t('No text found. This looks like a scan: use OCR to recognize it.') : undefined,
    }
  },
}

export const extractImagesTool: ToolDef<Record<string, never>> = {
  id: 'extract-images',
  title: 'Extract images',
  lead: 'Save every picture embedded in the PDF at its original quality.',
  icon: 'image',
  action: 'Extract & download',
  defaults: {},
  run: async (f, _o, t) => {
    const imgs = await mu.extractImages(f.bytes)
    if (!imgs.length) return { files: [], note: t('No images found in this PDF.') }
    return { files: imgs.map((i) => ({ name: outputName(f, i.name.replace(/\.\w+$/, ''), i.name.split('.').pop()), bytes: i.bytes })), note: t('{n} images', { n: imgs.length }) }
  },
}

// ───────────────────────────────────────────────────────── office <-> pdf

interface OfficeOpts {
  page: 'A4' | 'Letter'
  orientation: 'portrait' | 'landscape'
}

const officeOptions = (value: OfficeOpts, set: (o: OfficeOpts) => void, t: (k: string) => string) => (
  <>
    <Field label={t('Page size')}>
      <Segmented value={value.page} onChange={(page) => set({ ...value, page })} options={[['A4', 'A4'], ['Letter', 'Letter']]} />
    </Field>
    <Field label={t('Orientation')}>
      <Segmented
        value={value.orientation}
        onChange={(orientation) => set({ ...value, orientation })}
        options={[['portrait', t('Portrait')], ['landscape', t('Landscape')]]}
      />
    </Field>
  </>
)

export const excelToPdfTool: ToolDef<OfficeOpts> = {
  id: 'excel-to-pdf',
  title: 'Excel to PDF',
  lead: 'Convert spreadsheets (.xlsx, .xls, .csv) to PDF. Each worksheet becomes nicely formatted table pages.',
  icon: 'grid',
  action: 'Convert & download',
  accept: '.xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv',
  acceptTitle: 'Choose a spreadsheet file',
  skipPdfParse: true,
  defaults: { page: 'A4', orientation: 'landscape' },
  Options: ({ value, set, t }) => officeOptions(value, set, t),
  run: async (f, o, t) => {
    const { excelToPdf } = await import('../lib/office')
    const { pdf, sheets } = await excelToPdf(f.bytes, o)
    return { files: [{ name: outputName(f, 'converted'), bytes: pdf }], note: t('{n} worksheets converted', { n: sheets }) }
  },
}

export const wordToPdfTool: ToolDef<OfficeOpts> = {
  id: 'word-to-pdf',
  title: 'Word to PDF',
  lead: 'Convert Word documents (.docx) to PDF, keeping text, tables, lists and images.',
  icon: 'textFile',
  action: 'Convert & download',
  accept: '.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  acceptTitle: 'Choose a Word file',
  skipPdfParse: true,
  defaults: { page: 'A4', orientation: 'portrait' },
  Options: ({ value, set, t }) => officeOptions(value, set, t),
  run: async (f, o) => {
    const { wordToPdf } = await import('../lib/office')
    const pdf = await wordToPdf(f.bytes, o)
    return { files: [{ name: outputName(f, 'converted'), bytes: pdf }] }
  },
}

export const pdfToExcelTool: ToolDef<Record<string, never>> = {
  id: 'pdf-to-excel',
  title: 'PDF to Excel',
  lead: 'Extract tables and text into an .xlsx workbook — one worksheet per page. Best with text-based PDFs.',
  icon: 'grid',
  action: 'Convert & download',
  defaults: {},
  run: async (f, _o, t) => {
    if (!f.pdf) throw new Error(t('"{name}" is not a valid PDF', { name: f.name }))
    const { pdfToExcel } = await import('../lib/office')
    const { xlsx, pages } = await pdfToExcel(f.pdf)
    return {
      files: [{ name: outputName(f, 'converted', 'xlsx'), bytes: xlsx, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }],
      note: t('{n} pages converted', { n: pages }),
    }
  },
}

export const pdfToWordTool: ToolDef<Record<string, never>> = {
  id: 'pdf-to-word',
  title: 'PDF to Word',
  lead: 'Extract text into an editable .docx document, keeping reading order and page breaks. Best with text-based PDFs.',
  icon: 'textFile',
  action: 'Convert & download',
  defaults: {},
  run: async (f, _o, t) => {
    if (!f.pdf) throw new Error(t('"{name}" is not a valid PDF', { name: f.name }))
    const { pdfToWord } = await import('../lib/office')
    const { docx, pages } = await pdfToWord(f.pdf)
    return {
      files: [{ name: outputName(f, 'converted', 'docx'), bytes: docx, mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }],
      note: t('{n} pages converted', { n: pages }),
    }
  },
}

// ───────────────────────────────────────────────────────── flatten / repair

export const flattenTool: ToolDef<Record<string, never>> = {
  id: 'flatten',
  title: 'Flatten PDF',
  lead: 'Merge form fields, comments and annotations into the page so they can no longer be edited.',
  icon: 'layers',
  action: 'Flatten & download',
  defaults: {},
  run: async (f) => ({ files: [{ name: outputName(f, 'flattened'), bytes: await mu.flatten(f.bytes) }] }),
}

export const repairTool: ToolDef<Record<string, never>> = {
  id: 'repair',
  title: 'Repair PDF',
  lead: 'Rebuild a damaged or corrupted PDF so it opens again.',
  icon: 'wrench',
  action: 'Repair & download',
  acceptsBroken: true,
  defaults: {},
  run: async (f, _o, t) => {
    const r = await mu.repair(f.bytes)
    return { files: [{ name: outputName(f, 'repaired'), bytes: r.bytes }], note: r.repaired ? t('Errors were found and repaired.') : t('No structural errors found; the file was cleaned and rewritten.') }
  },
}
