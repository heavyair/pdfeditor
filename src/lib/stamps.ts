export interface StampPreset {
  id: string
  en: string
  zh: string
  color: string
  kind: 'badge' | 'check' | 'cross' | 'dot'
}

export const STAMPS: StampPreset[] = [
  { id: 'approved', en: 'APPROVED', zh: '已批准', color: '#1f8a4c', kind: 'badge' },
  { id: 'rejected', en: 'REJECTED', zh: '已驳回', color: '#ce2c31', kind: 'badge' },
  { id: 'paid', en: 'PAID', zh: '已付款', color: '#1f8a4c', kind: 'badge' },
  { id: 'received', en: 'RECEIVED', zh: '已收到', color: '#1f3fbf', kind: 'badge' },
  { id: 'draft', en: 'DRAFT', zh: '草稿', color: '#1f3fbf', kind: 'badge' },
  { id: 'confidential', en: 'CONFIDENTIAL', zh: '机密', color: '#ce2c31', kind: 'badge' },
  { id: 'copy', en: 'COPY', zh: '副本', color: '#6e56cf', kind: 'badge' },
  { id: 'check', en: '✓', zh: '✓', color: '#111111', kind: 'check' },
  { id: 'cross', en: '✗', zh: '✗', color: '#111111', kind: 'cross' },
  { id: 'dot', en: '●', zh: '●', color: '#111111', kind: 'dot' },
]

/** Render a stamp to a PNG data URL; returns its natural size in page points. */
export function renderStamp(p: StampPreset, label: string, withDate: boolean): { src: string; w: number; h: number } {
  const S = 4 // pixels per point
  const c = document.createElement('canvas')
  const ctx = c.getContext('2d')!
  if (p.kind !== 'badge') {
    const size = 18
    c.width = c.height = size * S
    ctx.scale(S, S)
    ctx.strokeStyle = ctx.fillStyle = p.color
    ctx.lineWidth = 2.4
    ctx.lineCap = ctx.lineJoin = 'round'
    ctx.beginPath()
    if (p.kind === 'check') {
      ctx.moveTo(3, 9.5)
      ctx.lineTo(7.5, 14)
      ctx.lineTo(15, 4)
      ctx.stroke()
    } else if (p.kind === 'cross') {
      ctx.moveTo(4, 4)
      ctx.lineTo(14, 14)
      ctx.moveTo(14, 4)
      ctx.lineTo(4, 14)
      ctx.stroke()
    } else {
      ctx.arc(9, 9, 4.5, 0, Math.PI * 2)
      ctx.fill()
    }
    return { src: c.toDataURL('image/png'), w: size, h: size }
  }
  const font = '800 22px Helvetica, Arial, "PingFang SC", "Microsoft YaHei", sans-serif'
  const small = '600 9px Helvetica, Arial, sans-serif'
  ctx.font = font
  const tw = ctx.measureText(label).width
  const date = new Date().toLocaleDateString()
  const w = Math.max(tw + 28, 90)
  const h = withDate ? 46 : 36
  c.width = Math.ceil(w * S)
  c.height = Math.ceil(h * S)
  ctx.scale(S, S)
  ctx.strokeStyle = ctx.fillStyle = p.color
  ctx.globalAlpha = 0.9
  ctx.lineWidth = 2.5
  const r = 6
  ctx.beginPath()
  ctx.roundRect(2, 2, w - 4, h - 4, r)
  ctx.stroke()
  ctx.lineWidth = 0.8
  ctx.beginPath()
  ctx.roundRect(5, 5, w - 10, h - 10, r - 2)
  ctx.stroke()
  ctx.font = font
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, w / 2, withDate ? 19 : h / 2 + 1)
  if (withDate) {
    ctx.font = small
    ctx.fillText(date, w / 2, 35)
  }
  return { src: c.toDataURL('image/png'), w, h }
}
