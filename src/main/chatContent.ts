// What a chat message says to the CLI: text, and the images the user attached.
//
// Dropping an image on the chat used to paste its PATH into the message. That is
// not an attachment — whether the agent ever looked depended on it deciding to
// run Read on a string that happened to be a path, and a pasted screenshot had
// to be written to a temp file first just to have a path to paste. The CLI's
// stream-json input takes Anthropic content blocks directly, so an image goes in
// as an image: the model sees it in the same turn, with no tool call.
// (Verified against the CLI: an 8×8 red PNG sent this way came back "Red".)

export interface ChatImageInput {
  mediaType: string
  // base64, no data: prefix
  data: string
  name?: string
}

// The formats the API accepts. Anything else would be rejected by the model call
// after the user had already pressed send, so it is filtered out here, where the
// renderer's own check should already have kept it from being attached.
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const

// The API's per-image ceiling is 5 MB of image. base64 is 4/3 of that.
export const MAX_IMAGE_BASE64 = Math.floor((5 * 1024 * 1024 * 4) / 3)

export function isUsableImage(img: ChatImageInput | null | undefined): img is ChatImageInput {
  return (
    !!img &&
    typeof img.data === 'string' &&
    img.data.length > 0 &&
    img.data.length <= MAX_IMAGE_BASE64 &&
    (IMAGE_TYPES as readonly string[]).includes(img.mediaType)
  )
}

export type UserContent =
  | string
  | Array<
      | { type: 'text'; text: string }
      | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
    >

// A plain string when there is nothing to attach — exactly what was sent before,
// so every existing message path is unchanged.
export function userContent(text: string, images?: ChatImageInput[] | null): UserContent {
  const usable = (images ?? []).filter(isUsableImage)
  if (!usable.length) return text
  const blocks: Exclude<UserContent, string> = []
  // Text first: the question frames what to look for in the pictures.
  if (text.trim()) blocks.push({ type: 'text', text })
  for (const img of usable) {
    blocks.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } })
  }
  return blocks
}
