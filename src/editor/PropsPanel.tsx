import { Icon } from '../components/Icon'
import { useT } from '../i18n'
import { FONT_LABELS } from '../lib/fonts'
import type { Annot, FontKey, Tool } from '../lib/types'
import type { ToolOpts } from './PageView'

const PALETTE = ['#000000', '#444444', '#ffffff', '#e5484d', '#f76b15', '#ffc53d', '#30a46c', '#0090ff', '#3e63dd', '#8e4ec6']

interface Props {
  annot: Annot | null
  tool: Tool
  opts: ToolOpts
  setOpts: (o: ToolOpts) => void
  onChange: (patch: Partial<Annot>) => void
  onDelete: () => void
  onDuplicate: () => void
  onLayer: (dir: 'front' | 'back') => void
  formCount: number
  flattenForms: boolean
  setFlattenForms: (v: boolean) => void
  pageCount: number
}

function ColorField({ label, value, onChange, allowNone }: { label: string; value: string | null; onChange: (v: string | null) => void; allowNone?: boolean }) {
  const t = useT()
  return (
    <div className="field">
      <div className="label">{label}</div>
      <div className="swatches">
        {allowNone && <button className={`swatch none ${value === null ? 'active' : ''}`} onClick={() => onChange(null)} title={t('None')} aria-label={t('None')} />}
        {PALETTE.map((c) => (
          <button key={c} className={`swatch ${value === c ? 'active' : ''}`} style={{ background: c }} onClick={() => onChange(c)} aria-label={c} />
        ))}
        <input type="color" value={value ?? '#000000'} onChange={(e) => onChange(e.target.value)} aria-label={label} />
      </div>
    </div>
  )
}

function NumberField({ label, value, min, max, step = 1, onChange }: { label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void }) {
  return (
    <div className="field">
      <div className="label">
        {label} <span className="muted">{Math.round(value * 10) / 10}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(parseFloat(e.target.value))} aria-label={label} />
    </div>
  )
}

function FontField({ value, onChange }: { value: FontKey; onChange: (f: FontKey) => void }) {
  const t = useT()
  return (
    <div className="field">
      <div className="label">{t('Font')}</div>
      <select className="input" value={value} onChange={(e) => onChange(e.target.value as FontKey)}>
        {(Object.keys(FONT_LABELS) as FontKey[]).map((f) => (
          <option key={f} value={f}>
            {t(FONT_LABELS[f])}
          </option>
        ))}
      </select>
    </div>
  )
}

const TIPS: Partial<Record<Tool, string>> = {
  select: 'Click an item to select it. Drag to move, use the corner handle to resize, double-click text to edit it.',
  editText: 'Existing text is outlined in blue. Click any line to rewrite it: the original text is removed from the page when you download.',
  text: 'Click anywhere on a page to add a text box.',
  whiteout: 'Drag over anything you want to cover with white (it stays in the file underneath).',
  redact: 'Drag over sensitive content. When you download, text, images and graphics under the box are permanently deleted.',
  highlight: 'Drag over text to highlight it.',
  rect: 'Drag to draw a rectangle.',
  ellipse: 'Drag to draw an ellipse.',
  line: 'Drag to draw a line.',
  arrow: 'Drag to draw an arrow.',
  draw: 'Draw freehand on the page.',
  link: 'Drag over an area, then enter a web address or a page number.',
  note: 'Click to add a comment. PDF readers show it as a sticky note.',
  place: 'Click on a page to place it. Press Esc to cancel.',
}

export function PropsPanel({ annot, tool, opts, setOpts, onChange, onDelete, onDuplicate, onLayer, formCount, flattenForms, setFlattenForms, pageCount }: Props) {
  const t = useT()
  if (!annot) {
    const showText = tool === 'text'
    const showStroke = ['draw', 'rect', 'ellipse', 'line', 'arrow'].includes(tool)
    return (
      <aside className="props">
        <h3>{tool === 'select' ? t('Properties') : t('Tool options')}</h3>
        <p className="tip">{t(TIPS[tool] ?? '')}</p>
        {(showText || showStroke) && <ColorField label={t('Color')} value={opts.color} onChange={(c) => setOpts({ ...opts, color: c ?? '#000000' })} />}
        {showText && (
          <>
            <FontField value={opts.font} onChange={(font) => setOpts({ ...opts, font })} />
            <NumberField label={t('Size')} value={opts.fontSize} min={6} max={72} onChange={(fontSize) => setOpts({ ...opts, fontSize })} />
          </>
        )}
        {showStroke && <NumberField label={t('Line width')} value={opts.strokeWidth} min={0.5} max={16} step={0.5} onChange={(strokeWidth) => setOpts({ ...opts, strokeWidth })} />}
        {formCount > 0 && (
          <div className="field form-box">
            <div className="label">{t('Form')}</div>
            <p className="tip">{t('{n} fillable fields. Click a field on the page to fill it in.', { n: formCount })}</p>
            <label className="check">
              <input type="checkbox" checked={flattenForms} onChange={(e) => setFlattenForms(e.target.checked)} />
              {t('Flatten form when downloading (values can no longer be changed)')}
            </label>
          </div>
        )}
        <div className="shortcuts">
          <div className="label">{t('Shortcuts')}</div>
          <div>
            <kbd>Ctrl</kbd>+<kbd>Z</kbd> {t('undo')} · <kbd>Ctrl</kbd>+<kbd>Y</kbd> {t('redo')}
          </div>
          <div>
            <kbd>Del</kbd> {t('delete')} · {t('arrows nudge')}
          </div>
          <div>
            <kbd>Ctrl</kbd>+<kbd>F</kbd> {t('search')} · <kbd>Ctrl</kbd>+<kbd>V</kbd> {t('paste an image')}
          </div>
        </div>
      </aside>
    )
  }

  const title =
    annot.type === 'text'
      ? 'Text'
      : annot.type === 'image'
        ? 'Image'
        : annot.type === 'draw'
          ? 'Drawing'
          : annot.type === 'line'
            ? annot.arrow
              ? 'Arrow'
              : 'Line'
            : annot.type === 'link'
              ? 'Link'
              : annot.type === 'note'
                ? 'Comment'
                : annot.redact === 'all'
                  ? 'Redaction'
                  : annot.redact === 'text'
                    ? 'Replaced text background'
                    : annot.highlight
                      ? 'Highlight'
                      : annot.type === 'rect'
                        ? 'Rectangle'
                        : 'Ellipse'

  return (
    <aside className="props">
      <h3>{t(title)}</h3>

      {annot.type === 'text' && (
        <>
          <FontField value={annot.font} onChange={(font) => onChange({ font })} />
          <NumberField label={t('Size')} value={annot.fontSize} min={4} max={96} step={0.5} onChange={(fontSize) => onChange({ fontSize })} />
          <div className="field row">
            <button className={`toggle ${annot.bold ? 'on' : ''}`} onClick={() => onChange({ bold: !annot.bold })} style={{ fontWeight: 700 }} aria-label={t('Bold')}>
              B
            </button>
            <button className={`toggle ${annot.italic ? 'on' : ''}`} onClick={() => onChange({ italic: !annot.italic })} style={{ fontStyle: 'italic' }} aria-label={t('Italic')}>
              I
            </button>
          </div>
          <ColorField label={t('Color')} value={annot.color} onChange={(color) => onChange({ color: color ?? '#000000' })} />
          <p className="tip">{t('Double-click the text on the page to edit it.')}</p>
        </>
      )}

      {(annot.type === 'rect' || annot.type === 'ellipse') && (
        <>
          {annot.redact === 'all' && <p className="tip warn">{t('Everything under this box is permanently deleted from the PDF when you download.')}</p>}
          {annot.redact === 'text' && <p className="tip">{t('The original text under this box is deleted when you download.')}</p>}
          <ColorField label={t('Fill')} value={annot.fill} allowNone={!annot.redact} onChange={(fill) => onChange({ fill })} />
          {!annot.highlight && !annot.redact && (
            <>
              <ColorField label={t('Border')} value={annot.stroke} allowNone onChange={(stroke) => onChange({ stroke, strokeWidth: stroke && !annot.strokeWidth ? 2 : annot.strokeWidth })} />
              {annot.stroke && <NumberField label={t('Border width')} value={annot.strokeWidth} min={0.5} max={16} step={0.5} onChange={(strokeWidth) => onChange({ strokeWidth })} />}
            </>
          )}
          {!annot.redact && <NumberField label={t('Opacity')} value={annot.opacity} min={0.05} max={1} step={0.05} onChange={(opacity) => onChange({ opacity })} />}
        </>
      )}

      {(annot.type === 'draw' || annot.type === 'line') && (
        <>
          <ColorField label={t('Color')} value={annot.color} onChange={(color) => onChange({ color: color ?? '#000000' })} />
          <NumberField label={t('Line width')} value={annot.strokeWidth} min={0.5} max={16} step={0.5} onChange={(strokeWidth) => onChange({ strokeWidth })} />
          {annot.type === 'line' && (
            <label className="check">
              <input type="checkbox" checked={annot.arrow} onChange={(e) => onChange({ arrow: e.target.checked })} />
              {t('Arrow head')}
            </label>
          )}
        </>
      )}

      {annot.type === 'link' && (
        <div className="field">
          <div className="label">{t('Link to')}</div>
          <input className="input" style={{ width: '100%' }} autoFocus placeholder="https://… / #3" value={annot.url} onChange={(e) => onChange({ url: e.target.value })} />
          <p className="tip">{t('A web address, or # plus a page number (1–{n}) to jump inside the document.', { n: pageCount })}</p>
        </div>
      )}

      {annot.type === 'note' && (
        <>
          <div className="field">
            <div className="label">{t('Comment')}</div>
            <textarea className="input textarea" autoFocus rows={5} value={annot.text} onChange={(e) => onChange({ text: e.target.value })} placeholder={t('Write a comment…')} />
          </div>
          <ColorField label={t('Color')} value={annot.color} onChange={(color) => onChange({ color: color ?? '#ffd400' })} />
        </>
      )}

      <div className="field">
        <div className="label">{t('Arrange')}</div>
        <div className="row">
          <button className="btn small" onClick={() => onLayer('front')}>
            {t('Bring to front')}
          </button>
          <button className="btn small" onClick={() => onLayer('back')}>
            {t('Send to back')}
          </button>
        </div>
      </div>
      <div className="row actions">
        <button className="btn small" onClick={onDuplicate}>
          <Icon name="copy" size={15} /> {t('Duplicate')}
        </button>
        <button className="btn small danger" onClick={onDelete}>
          <Icon name="trash" size={15} /> {t('Delete')}
        </button>
      </div>
    </aside>
  )
}
