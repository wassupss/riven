import { useEffect, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import type { ChatWork } from '@/lib/useComputer'
import { C } from '@/lib/theme'

// What a chat has running besides its turn, as the strips above riven's own
// composer show it: backgrounded commands, subagents still out, work handed to
// another agent. One line each, never wrapped; the time is how long it has run.

// The same point riven's chat starts calling a subagent quiet.
const QUIET_MS = 3 * 60_000
const FOLDED = 3

export function fmtDur(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}초`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}분 ${s % 60}초`
  return `${Math.floor(m / 60)}시간 ${m % 60}분`
}

type Row = {
  key: string
  icon: keyof typeof Ionicons.glyphMap
  word: string
  label: string
  since?: number
  note?: string
}

export default function WorkStrip({ work }: { work: ChatWork | undefined }): JSX.Element | null {
  const [now, setNow] = useState(Date.now())
  const [open, setOpen] = useState(false)
  const count = work ? work.bg.length + work.agents.length + work.delegations.length : 0

  // A clock only while there is something to time.
  useEffect(() => {
    if (!count) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [count])

  if (!work || !count) return null
  // The computer's "now", so times are right even if the two clocks disagree.
  const deskNow = now + work.offset

  const rows: Row[] = [
    ...work.bg.map((b) => ({
      key: `b${b.id}`,
      icon: 'terminal-outline' as const,
      word: '백그라운드',
      label: b.label || '명령',
      since: b.since
    })),
    ...work.agents.map((a) => {
      const quiet = deskNow - a.lastActivityAt > QUIET_MS
      return {
        key: `a${a.id}`,
        icon: 'git-branch-outline' as const,
        word: '서브에이전트',
        label: a.label,
        since: a.since,
        note: quiet ? `${fmtDur(deskNow - a.lastActivityAt)}째 조용` : a.steps ? `${a.steps}단계` : undefined
      }
    }),
    ...work.delegations.map((d) => ({
      key: `d${d.id}`,
      icon: 'people-outline' as const,
      word: '위임',
      label: d.label,
      since: d.since
    }))
  ]
  const shown = open ? rows : rows.slice(0, FOLDED)

  return (
    <View style={s.strip}>
      {shown.map((r) => (
        <View key={r.key} style={s.row}>
          <View style={s.dot} />
          <Ionicons name={r.icon} size={13} color={C.dim} />
          <Text style={s.word} numberOfLines={1}>
            {r.word}
          </Text>
          <Text style={s.label} numberOfLines={1}>
            {r.label}
          </Text>
          {!!r.note && (
            <Text style={[s.time, r.note.endsWith('조용') && { color: C.warn }]} numberOfLines={1}>
              {r.note}
            </Text>
          )}
          {r.since !== undefined && (
            <Text style={s.time} numberOfLines={1}>
              {fmtDur(deskNow - r.since)}
            </Text>
          )}
        </View>
      ))}
      {rows.length > FOLDED && (
        <Pressable onPress={() => setOpen((o) => !o)} hitSlop={6}>
          <Text style={s.more}>{open ? '접기' : `외 ${rows.length - FOLDED}개 더 보기`}</Text>
        </Pressable>
      )}
    </View>
  )
}

const s = StyleSheet.create({
  strip: {
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderTopColor: C.edge,
    borderTopWidth: 1,
    backgroundColor: C.bg2
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: C.accent },
  word: { color: C.accent, fontSize: 12, fontWeight: '600', flexShrink: 0 },
  label: { flex: 1, color: C.fg, fontSize: 13 },
  time: { color: C.dim, fontSize: 12, flexShrink: 0, fontVariant: ['tabular-nums'] },
  more: { color: C.dim, fontSize: 12, paddingTop: 2 }
})
