import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { zh } from './i18n.zh'

export type Lang = 'en' | 'zh'
type Vars = Record<string, string | number>
export type T = (key: string, vars?: Vars) => string

const STORE = 'free-pdf-editor:lang'

function detect(): Lang {
  try {
    const saved = localStorage.getItem(STORE)
    if (saved === 'en' || saved === 'zh') return saved
  } catch {
    /* storage blocked */
  }
  return /^zh/i.test(navigator.language || '') ? 'zh' : 'en'
}

const interpolate = (s: string, vars?: Vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s)

/** English strings are the keys; missing Chinese entries fall back to English. */
export const translate = (lang: Lang, key: string, vars?: Vars) => interpolate(lang === 'zh' ? (zh[key] ?? key) : key, vars)

const Ctx = createContext<{ lang: Lang; setLang: (l: Lang) => void; t: T }>({
  lang: 'en',
  setLang: () => {},
  t: (k, v) => interpolate(k, v),
})

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(detect)
  const setLang = useCallback((l: Lang) => {
    setLangState(l)
    try {
      localStorage.setItem(STORE, l)
    } catch {
      /* ignore */
    }
  }, [])
  useEffect(() => {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
    document.title = translate(lang, 'Free PDF Editor')
  }, [lang])
  const t = useCallback<T>((key, vars) => translate(lang, key, vars), [lang])
  return <Ctx.Provider value={{ lang, setLang, t }}>{children}</Ctx.Provider>
}

export const useI18n = () => useContext(Ctx)
export const useT = () => useContext(Ctx).t

/** Map engine error codes to readable text. */
export function errorText(t: T, e: unknown): string {
  const msg = (e as Error)?.message ?? String(e)
  const [code, a, b] = msg.split(':')
  if (code === 'RANGE_INVALID') return t('"{s}" is not a valid page range', { s: a })
  if (code === 'RANGE_OUTSIDE') return t('"{s}" is outside 1–{n}', { s: a, n: b })
  if (code === 'RANGE_EMPTY') return t('Enter at least one page range')
  const known: Record<string, string> = {
    WRONG_PASSWORD: 'Wrong password',
    PASSWORD_REQUIRED: 'This PDF is password protected',
    PASSWORD_COMMA: 'Passwords cannot contain commas',
    CROP_TOO_LARGE: 'The margins are larger than the page',
  }
  return t(known[msg] ?? msg)
}
