import type { FormValues, OverlayPage, RedactRequest } from './mupdfOps'

/** The subset of MuPDF operations the export pipeline needs (worker in the browser, direct in tests). */
export interface Engine {
  redact(bytes: Uint8Array, reqs: RedactRequest[]): Promise<Uint8Array>
  textOverlay(pages: OverlayPage[]): Promise<Uint8Array>
  coverage(strs: string[]): Promise<boolean[]>
  textWidth(str: string, size: number): Promise<number>
  fillForm(bytes: Uint8Array, values: FormValues, flatten: boolean): Promise<Uint8Array>
}
