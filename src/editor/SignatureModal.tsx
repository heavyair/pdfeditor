import { useEffect, useRef, useState } from 'react'
import { Icon } from '../components/Icon'
import { fileToEmbeddableDataUrl, loadImage } from '../lib/util'

export interface SignatureResult {
  src: string
  width: number
  height: number
}

const STORE_KEY = 'free-pdf-editor:signatures'
const INK = ['#111111', '#1f3fbf', '#c0262d']
const SCRIPT_FONTS = ['Dancing Script', 'Great Vibes', 'Caveat']

function loadSaved(): SignatureResult[] {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || '[]')
  } catch {
    return []
  }
}
function storeSaved(list: SignatureResult[]) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(list.slice(0, 6)))
  } catch {
    /* storage full or blocked: saving is only a convenience */
  }
}

/** Crop a canvas to its non-transparent pixels and return a PNG. */
function trimCanvas(c: HTMLCanvasElement, pad = 6): SignatureResult | null {
  const ctx = c.getContext('2d')!
  const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height)
  let minX = width, minY = height, maxX = -1, maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return null
  minX = Math.max(0, minX - pad)
  minY = Math.max(0, minY - pad)
  maxX = Math.min(width - 1, maxX + pad)
  maxY = Math.min(height - 1, maxY + pad)
  const out = document.createElement('canvas')
  out.width = maxX - minX + 1
  out.height = maxY - minY + 1
  out.getContext('2d')!.drawImage(c, minX, minY, out.width, out.height, 0, 0, out.width, out.height)
  return { src: out.toDataURL('image/png'), width: out.width, height: out.height }
}

export function SignatureModal({ onClose, onUse }: { onClose: () => void; onUse: (s: SignatureResult) => void }) {
  const [tab, setTab] = useState<'draw' | 'type' | 'upload'>('draw')
  const [ink, setInk] = useState(INK[0])
  const [saved, setSaved] = useState<SignatureResult[]>(loadSaved)
  const [remember, setRemember] = useState(true)
  const [typed, setTyped] = useState('')
  const [scriptFont, setScriptFont] = useState(SCRIPT_FONTS[0])
  const [upload, setUpload] = useState<SignatureResult | null>(null)
  const [removeBg, setRemoveBg] = useState(true)
  const [hasInk, setHasInk] = useState(false)
  const pad = useRef<HTMLCanvasElement>(null)
  const drawing = useRef<{ last: [number, number]; mid: [number, number] } | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    const c = pad.current
    if (!c || tab !== 'draw') return
    const dpr = window.devicePixelRatio || 1
    c.width = c.clientWidth * dpr
    c.height = c.clientHeight * dpr
    const ctx = c.getContext('2d')!
    ctx.scale(dpr, dpr)
    setHasInk(false)
  }, [tab])

  const point = (e: React.PointerEvent): [number, number] => {
    const r = pad.current!.getBoundingClientRect()
    return [e.clientX - r.left, e.clientY - r.top]
  }

  const finish = (result: SignatureResult | null) => {
    if (!result) return
    if (remember) {
      const next = [result, ...saved.filter((s) => s.src !== result.src)]
      storeSaved(next)
    }
    onUse(result)
  }

  const useDrawn = () => finish(pad.current ? trimCanvas(pad.current) : null)

  const useTyped = async () => {
    if (!typed.trim()) return
    await document.fonts.load(`64px "${scriptFont}"`).catch(() => {})
    const c = document.createElement('canvas')
    const ctx = c.getContext('2d')!
    const font = `64px "${scriptFont}", cursive`
    ctx.font = font
    const w = ctx.measureText(typed).width
    c.width = Math.ceil(w + 40) * 2
    c.height = 140 * 2
    ctx.scale(2, 2)
    ctx.font = font
    ctx.fillStyle = ink
    ctx.textBaseline = 'middle'
    ctx.fillText(typed, 20, 70)
    finish(trimCanvas(c))
  }

  const useUpload = async () => {
    if (!upload) return
    if (!removeBg) return finish(upload)
    const img = await loadImage(upload.src)
    const c = document.createElement('canvas')
    c.width = img.naturalWidth
    c.height = img.naturalHeight
    const ctx = c.getContext('2d')!
    ctx.drawImage(img, 0, 0)
    const d = ctx.getImageData(0, 0, c.width, c.height)
    for (let i = 0; i < d.data.length; i += 4) {
      const lum = 0.299 * d.data[i] + 0.587 * d.data[i + 1] + 0.114 * d.data[i + 2]
      // fade near-white paper to transparent, keep ink
      if (lum > 215) d.data[i + 3] = 0
      else if (lum > 170) d.data[i + 3] = Math.round((d.data[i + 3] * (215 - lum)) / 45)
    }
    ctx.putImageData(d, 0, 0)
    finish(trimCanvas(c, 2))
  }

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Create signature">
        <div className="modal-head">
          <h2>Add signature</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </div>

        {saved.length > 0 && (
          <div className="saved-sigs">
            <div className="label">Saved on this device</div>
            <div className="saved-row">
              {saved.map((s, i) => (
                <div key={i} className="saved-sig">
                  <button onClick={() => onUse(s)} title="Use this signature">
                    <img src={s.src} alt="Saved signature" />
                  </button>
                  <button
                    className="saved-del"
                    aria-label="Delete saved signature"
                    onClick={() => {
                      const next = saved.filter((_, k) => k !== i)
                      setSaved(next)
                      storeSaved(next)
                    }}
                  >
                    <Icon name="x" size={12} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="tabs">
          {(['draw', 'type', 'upload'] as const).map((t) => (
            <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
              {t === 'draw' ? 'Draw' : t === 'type' ? 'Type' : 'Upload image'}
            </button>
          ))}
        </div>

        {tab !== 'upload' && (
          <div className="ink-row">
            <span className="label">Ink</span>
            {INK.map((c) => (
              <button
                key={c}
                className={`swatch ${ink === c ? 'active' : ''}`}
                style={{ background: c }}
                onClick={() => setInk(c)}
                aria-label={`Ink color ${c}`}
              />
            ))}
          </div>
        )}

        {tab === 'draw' && (
          <>
            <canvas
              ref={pad}
              className="sig-pad"
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId)
                const p = point(e)
                drawing.current = { last: p, mid: p }
                const ctx = pad.current!.getContext('2d')!
                ctx.beginPath()
                ctx.fillStyle = ink
                ctx.arc(p[0], p[1], 1.2, 0, Math.PI * 2)
                ctx.fill()
                setHasInk(true)
              }}
              onPointerMove={(e) => {
                const d = drawing.current
                if (!d) return
                const p = point(e)
                const mid: [number, number] = [(d.last[0] + p[0]) / 2, (d.last[1] + p[1]) / 2]
                const ctx = pad.current!.getContext('2d')!
                ctx.strokeStyle = ink
                ctx.lineWidth = 2.4
                ctx.lineCap = 'round'
                ctx.lineJoin = 'round'
                ctx.beginPath()
                ctx.moveTo(d.mid[0], d.mid[1])
                ctx.quadraticCurveTo(d.last[0], d.last[1], mid[0], mid[1])
                ctx.stroke()
                drawing.current = { last: p, mid }
              }}
              onPointerUp={() => (drawing.current = null)}
            />
            <div className="modal-foot">
              <button
                className="btn ghost"
                onClick={() => {
                  const c = pad.current!
                  c.getContext('2d')!.clearRect(0, 0, c.width, c.height)
                  setHasInk(false)
                }}
              >
                Clear
              </button>
              <Remember value={remember} onChange={setRemember} />
              <button className="btn primary" disabled={!hasInk} onClick={useDrawn}>
                Use signature
              </button>
            </div>
          </>
        )}

        {tab === 'type' && (
          <>
            <input
              className="input big"
              placeholder="Type your name"
              value={typed}
              autoFocus
              onChange={(e) => setTyped(e.target.value)}
            />
            <div className="font-choices">
              {SCRIPT_FONTS.map((f) => (
                <button
                  key={f}
                  className={`font-choice ${scriptFont === f ? 'active' : ''}`}
                  style={{ fontFamily: `"${f}", cursive`, color: ink }}
                  onClick={() => setScriptFont(f)}
                >
                  {typed || 'Your Name'}
                </button>
              ))}
            </div>
            <div className="modal-foot">
              <span />
              <Remember value={remember} onChange={setRemember} />
              <button className="btn primary" disabled={!typed.trim()} onClick={useTyped}>
                Use signature
              </button>
            </div>
          </>
        )}

        {tab === 'upload' && (
          <>
            <label className="upload-box">
              {upload ? <img src={upload.src} alt="Uploaded signature" /> : <span>Choose a photo or scan of your signature</span>}
              <input
                type="file"
                accept="image/*"
                hidden
                onChange={async (e) => {
                  const f = e.target.files?.[0]
                  if (f) {
                    const r = await fileToEmbeddableDataUrl(f)
                    setUpload({ src: r.src, width: r.width, height: r.height })
                  }
                }}
              />
            </label>
            <label className="check">
              <input type="checkbox" checked={removeBg} onChange={(e) => setRemoveBg(e.target.checked)} />
              Remove white background
            </label>
            <div className="modal-foot">
              <span />
              <Remember value={remember} onChange={setRemember} />
              <button className="btn primary" disabled={!upload} onClick={useUpload}>
                Use signature
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function Remember({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="check">
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      Save on this device
    </label>
  )
}
