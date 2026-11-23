// ---------------------------------------------------------------------------
// The @keyframes of custom pet motions (lib/petMotion.ts motionCss), put in
// the document that shows them: one <style> per rule, shared by every pet
// using the same spec and counted, so it goes when the last one does. Added
// once when a spec comes into use, never per frame. The pet window, the app
// and a Settings window are separate documents, so each gets its own.
// ---------------------------------------------------------------------------

const held = new WeakMap<Document, Map<string, { n: number; el: HTMLStyleElement }>>()

/** Make sure `name`'s rule is in `doc`; pair with releaseMotion. */
export function holdMotion(doc: Document, name: string, css: string): void {
  let m = held.get(doc)
  if (!m) held.set(doc, (m = new Map()))
  const cur = m.get(name)
  if (cur) {
    cur.n++
    return
  }
  const el = doc.createElement('style')
  el.dataset.petMotion = name
  el.textContent = css
  doc.head.appendChild(el)
  m.set(name, { n: 1, el })
}

export function releaseMotion(doc: Document, name: string): void {
  const m = held.get(doc)
  const cur = m?.get(name)
  if (!m || !cur) return
  if (--cur.n > 0) return
  cur.el.remove()
  m.delete(name)
}

/** How many rules a document holds (tests). */
export const heldCount = (doc: Document): number => held.get(doc)?.size ?? 0
