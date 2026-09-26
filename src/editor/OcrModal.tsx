import { useState } from 'react'
import { Icon } from '../components/Icon'
import { useI18n } from '../i18n'
import { OCR_LANGS, defaultOcrLangs } from '../lib/ocr'

export interface OcrRequest {
  langs: string[]
  scope: 'empty' | 'all' | 'current'
}

export function OcrModal({ onClose, onStart, progress }: { onClose: () => void; onStart: (r: OcrRequest) => void; progress: { done: number; total: number; status: string } | null }) {
  const { t, lang } = useI18n()
  const [langs, setLangs] = useState<string[]>(defaultOcrLangs(lang))
  const [scope, setScope] = useState<OcrRequest['scope']>('empty')
  const busy = !!progress
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={t('Recognize text (OCR)')}>
        <div className="modal-head">
          <h2>{t('Recognize text (OCR)')}</h2>
          {!busy && (
            <button className="icon-btn" onClick={onClose} aria-label={t('Close')}>
              <Icon name="x" />
            </button>
          )}
        </div>
        <p className="tip">{t('Turns scanned pages into searchable, selectable text. Afterwards you can also use "Edit text" on scanned pages. Language data is downloaded once and then works offline.')}</p>
        <div className="field">
          <div className="label">{t('Document languages')}</div>
          <div className="chips">
            {OCR_LANGS.map((l) => (
              <label key={l.code} className={`chip ${langs.includes(l.code) ? 'on' : ''}`}>
                <input type="checkbox" checked={langs.includes(l.code)} disabled={busy} onChange={(e) => setLangs((xs) => (e.target.checked ? [...xs, l.code] : xs.filter((x) => x !== l.code)))} />
                {l.label}
              </label>
            ))}
          </div>
        </div>
        <div className="field">
          <div className="label">{t('Pages')}</div>
          <div className="row">
            {(
              [
                ['empty', 'Pages without text (scans)'],
                ['current', 'Current page'],
                ['all', 'All pages'],
              ] as const
            ).map(([k, label]) => (
              <label key={k} className="check">
                <input type="radio" name="ocr-scope" checked={scope === k} disabled={busy} onChange={() => setScope(k)} /> {t(label)}
              </label>
            ))}
          </div>
        </div>
        {progress && (
          <div className="progress">
            <div className="progress-bar" style={{ width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%` }} />
            <span>
              {t('Page {a} of {b}', { a: Math.min(progress.done + 1, progress.total), b: progress.total })} · {t(progress.status)}
            </span>
          </div>
        )}
        <div className="modal-foot">
          <span />
          <button className="btn primary" disabled={busy || !langs.length} onClick={() => onStart({ langs, scope })}>
            <Icon name="ocr" /> {busy ? t('Recognizing…') : t('Start OCR')}
          </button>
        </div>
      </div>
    </div>
  )
}
