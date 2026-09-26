export type FontKey = 'Helvetica' | 'Times' | 'Courier'

export interface TextAnnot {
  id: string
  type: 'text'
  /** top-left corner, in unrotated page units (PDF points, y down) */
  x: number
  y: number
  text: string
  fontSize: number
  color: string
  font: FontKey
  bold: boolean
  italic: boolean
}

export interface BoxBase {
  id: string
  x: number
  y: number
  w: number
  h: number
}

export interface ImageAnnot extends BoxBase {
  type: 'image'
  /** PNG or JPEG data URL */
  src: string
}

export interface ShapeAnnot extends BoxBase {
  type: 'rect' | 'ellipse'
  fill: string | null
  stroke: string | null
  strokeWidth: number
  opacity: number
  /** true for highlighter rectangles (multiply blend) */
  highlight?: boolean
  /**
   * True redaction: on export the page content under the box is deleted.
   * 'text' deletes glyphs only (used when retyping existing text; the box itself is
   * not drawn), 'all' deletes text, graphics and image pixels and then paints the fill.
   */
  redact?: 'text' | 'all'
}

export interface DrawAnnot extends BoxBase {
  type: 'draw'
  /** points normalised to 0..1 within the box */
  points: [number, number][]
  color: string
  strokeWidth: number
}

/** straight line from (x, y) to (x + w, y + h); w/h may be negative */
export interface LineAnnot extends BoxBase {
  type: 'line'
  color: string
  strokeWidth: number
  arrow: boolean
}

/** clickable area: a URL, or "#3" for page 3 of the output */
export interface LinkAnnot extends BoxBase {
  type: 'link'
  url: string
}

/** sticky-note comment (a real PDF annotation, shown by viewers as an icon) */
export interface NoteAnnot {
  id: string
  type: 'note'
  x: number
  y: number
  text: string
  color: string
}

export type BoxAnnot = ImageAnnot | ShapeAnnot | DrawAnnot | LineAnnot | LinkAnnot
export type Annot = TextAnnot | BoxAnnot | NoteAnnot

/** recognised text from OCR, in unrotated page units */
export interface OcrWord {
  text: string
  x: number
  y: number
  w: number
  h: number
}

export interface FormField {
  name: string
  kind: 'text' | 'checkbox' | 'radio' | 'select'
  x: number
  y: number
  w: number
  h: number
  value: string | boolean
  /** on-state of a checkbox / radio widget */
  exportValue?: string
  options?: { value: string; label: string }[]
  multiline?: boolean
  readOnly?: boolean
  maxLen?: number
}

export interface PageModel {
  id: string
  /** source document id, or null for an inserted blank page */
  srcId: string | null
  srcIndex: number
  /** unrotated page size in PDF points */
  width: number
  height: number
  /** pdf.js view box [x0, y0, x1, y1] in PDF user space (maps user space <-> editor space) */
  view?: [number, number, number, number]
  /** /Rotate already present in the source file */
  baseRotation: number
  /** extra rotation applied by the user */
  rotation: number
  annots: Annot[]
  /** OCR result: exported as an invisible, searchable text layer */
  ocr?: { words: OcrWord[]; lines: OcrWord[] }
  fields?: FormField[]
}

export type Tool =
  | 'select'
  | 'editText'
  | 'text'
  | 'whiteout'
  | 'redact'
  | 'highlight'
  | 'rect'
  | 'ellipse'
  | 'line'
  | 'arrow'
  | 'draw'
  | 'link'
  | 'note'
  | 'place'
