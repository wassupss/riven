import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

// Full-size view of an image in the app: a thumbnail in a chat is 180px wide,
// which is enough to recognise a screenshot and not enough to read one.
//
// Anything with an image can open it by firing this event, so the viewer itself
// is mounted once and knows nothing about chats or attachments.
export interface ViewImage {
  src: string
  name?: string
}
export function viewImage(img: ViewImage): void {
  window.dispatchEvent(new CustomEvent('riven:viewimage', { detail: img }))
}

export default function ImageLightbox(): JSX.Element | null {
  const [img, setImg] = useState<ViewImage | null>(null)

  useEffect(() => {
    const onView = (e: Event): void => setImg((e as CustomEvent<ViewImage>).detail ?? null)
    window.addEventListener('riven:viewimage', onView)
    return () => window.removeEventListener('riven:viewimage', onView)
  }, [])

  useEffect(() => {
    if (!img) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setImg(null)
      }
    }
    // Capture: a chat pane's own Escape handling (closing menus, blurring the
    // composer) must not swallow the one that closes this.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [img])

  if (!img) return null
  return createPortal(
    <div className="img-view" onClick={() => setImg(null)}>
      <button className="img-view-x" aria-label="닫기" onClick={() => setImg(null)}>
        <X size={16} />
      </button>
      {/* The image itself does not close the viewer, so it can be dragged out or
          right-clicked (copy / save) like any other image. */}
      <img src={img.src} alt={img.name ?? ''} onClick={(e) => e.stopPropagation()} />
      {img.name && <div className="img-view-name">{img.name}</div>}
    </div>,
    document.body
  )
}
