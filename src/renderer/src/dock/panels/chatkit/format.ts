// Small formatting shared by the chat panes.

/** "12초", "3분 4초", "5분" (the chat's own compact duration). */
export const fmtDur = (ms: number): string => {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}초`
  const m = Math.floor(s / 60)
  return s % 60 ? `${m}분 ${s % 60}초` : `${m}분`
}
