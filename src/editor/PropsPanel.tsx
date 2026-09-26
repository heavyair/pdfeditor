import { FONT_LABELS } from '../lib/fonts'
import type { Annot, FontKey, Tool } from '../lib/types'
import { Icon } from '../components/Icon'
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
}

function ColorField({ label, value, onChange, allowNone }: { label: string; value: string | null; onChange: (v: string | null) => void; allowNone?: boolean }) {
  return (
    <div className="field">
      <div className="label">{label}</div>
      <div className="swatches">
        {allowNone && (
          <button className={`swatch none ${value === null ? 'active' : ''}`} onClick={() => onChange(null)} title="None" aria-label="No color" />
        )}
        {PALETTE.map((c) => (
          <button key={c} className={`swatch ${value === c ? 'active' : ''}`} style={{ background: c }} onClick={() => onChange(c)} aria-label={c} />
        ))}
        <input type="color" value={value ?? '#000000'} onChange={(e) => onChange(e.target.value)} aria-label={`${label} custom`} />
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
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(parseFloat(e.target.value))} />
    </div>
  )
}

function FontField({ value, onChange }: { value: FontKey; onChange: (f: FontKey) => void }) {
  return (
    <div className="field">
      <div className="label">Font</div>
      <select className="input" value={value} onChange={(e) => onChange(e.target.value as FontKey)}>
        {(Object.keys(FONT_LABELS) as FontKey[]).map((f) => (
          <option key={f} value={f}>
            {FONT_LABELS[f]}
          </option>
        ))}
      </select>
    </div>
  )
}

const TIPS: Partial<Record<Tool, string>> = {
  select: 'Click an item to select it. Drag to move, use the corner handle to resize, double-click text to edit it.',
  editText: 'Existing text is outlined in blue. Click any line to replace it — the original is covered with a matching background and you can retype it.',
  text: 'Click anywhere on a page to add a text box.',
  whiteout: 'Drag over anything you want to hide (text, images, stamps).',
  highlight: 'Drag over text to highlight it.',
  rect: 'Drag to draw a rectangle.',
  ellipse: 'Drag to draw an ellipse.',
  draw: 'Draw freehand on the page.',
  place: 'Click on a page to place it. Press Esc to cancel.',
}

export function PropsPanel({ annot, tool, opts, setOpts, onChange, onDelete, onDuplicate, onLayer }: Props) {
  if (!annot) {
    const showText = tool === 'text'
    const showStroke = tool === 'draw' || tool === 'rect' || tool === 'ellipse'
    return (
      <aside className="props">
        <h3>{tool === 'select' ? 'Properties' : 'Tool options'}</h3>
        <p className="tip">{TIPS[tool]}</p>
        {(showText || showStroke) && (
          <ColorField label="Color" value={opts.color} onChange={(c) => setOpts({ ...opts, color: c ?? '#000000' })} />
        )}
        {showText && (
          <>
            <FontField value={opts.font} onChange={(font) => setOpts({ ...opts, font })} />
            <NumberField label="Size" value={opts.fontSize} min={6} max={72} onChange={(fontSize) => setOpts({ ...opts, fontSize })} />
          </>
        )}
        {showStroke && (
          <NumberField label="Line width" value={opts.strokeWidth} min={0.5} max={16} step={0.5} onChange={(strokeWidth) => setOpts({ ...opts, strokeWidth })} />
        )}
        <div className="shortcuts">
          <div className="label">Shortcuts</div>
          <div><kbd>Ctrl</kbd>+<kbd>Z</kbd> undo · <kbd>Ctrl</kbd>+<kbd>Y</kbd> redo</div>
          <div><kbd>Del</kbd> delete · arrows nudge</div>
          <div><kbd>Ctrl</kbd>+<kbd>V</kbd> paste an image</div>
        </div>
      </aside>
    )
  }

  return (
    <aside className="props">
      <h3>
        {annot.type === 'text'
          ? 'Text'
          : annot.type === 'image'
            ? 'Image'
            : annot.type === 'draw'
              ? 'Drawing'
              : 'highlight' in annot && annot.highlight
                ? 'Highlight'
                : annot.type === 'rect'
                  ? 'Rectangle'
                  : 'Ellipse'}
      </h3>

      {annot.type === 'text' && (
        <>
          <FontField value={annot.font} onChange={(font) => onChange({ font })} />
          <NumberField label="Size" value={annot.fontSize} min={4} max={96} step={0.5} onChange={(fontSize) => onChange({ fontSize })} />
          <div className="field row">
            <button className={`toggle ${annot.bold ? 'on' : ''}`} onClick={() => onChange({ bold: !annot.bold })} style={{ fontWeight: 700 }}>
              B
            </button>
            <button className={`toggle ${annot.italic ? 'on' : ''}`} onClick={() => onChange({ italic: !annot.italic })} style={{ fontStyle: 'italic' }}>
              I
            </button>
          </div>
          <ColorField label="Color" value={annot.color} onChange={(color) => onChange({ color: color ?? '#000000' })} />
          <p className="tip">Double-click the text on the page to edit it.</p>
        </>
      )}

      {(annot.type === 'rect' || annot.type === 'ellipse') && (
        <>
          <ColorField label="Fill" value={annot.fill} allowNone onChange={(fill) => onChange({ fill })} />
          {!annot.highlight && (
            <>
              <ColorField label="Border" value={annot.stroke} allowNone onChange={(stroke) => onChange({ stroke, strokeWidth: stroke && !annot.strokeWidth ? 2 : annot.strokeWidth })} />
              {annot.stroke && <NumberField label="Border width" value={annot.strokeWidth} min={0.5} max={16} step={0.5} onChange={(strokeWidth) => onChange({ strokeWidth })} />}
            </>
          )}
          <NumberField label="Opacity" value={annot.opacity} min={0.05} max={1} step={0.05} onChange={(opacity) => onChange({ opacity })} />
        </>
      )}

      {annot.type === 'draw' && (
        <>
          <ColorField label="Color" value={annot.color} onChange={(color) => onChange({ color: color ?? '#000000' })} />
          <NumberField label="Line width" value={annot.strokeWidth} min={0.5} max={16} step={0.5} onChange={(strokeWidth) => onChange({ strokeWidth })} />
        </>
      )}

      <div className="field">
        <div className="label">Arrange</div>
        <div className="row">
          <button className="btn small" onClick={() => onLayer('front')}>Bring to front</button>
          <button className="btn small" onClick={() => onLayer('back')}>Send to back</button>
        </div>
      </div>
      <div className="row actions">
        <button className="btn small" onClick={onDuplicate}>
          <Icon name="copy" size={15} /> Duplicate
        </button>
        <button className="btn small danger" onClick={onDelete}>
          <Icon name="trash" size={15} /> Delete
        </button>
      </div>
    </aside>
  )
}
