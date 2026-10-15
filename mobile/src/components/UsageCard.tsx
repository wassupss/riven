import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import type { RemoteLimit, RemoteUsage } from '@riven/remote'
import type { UsageView } from '@/lib/useComputer'
import { C, R } from '@/lib/theme'

// The computer's plan usage, the same figures as its own usage readout: how
// full each account's short and long windows are and when they reset.

function used(l: RemoteLimit): number {
  return Math.min(100, Math.max(0, Math.round(l.usedPct)))
}

// High usage is what needs attention, so the color follows what is left.
function usedColor(pct: number): string {
  const left = 100 - pct
  return left < 20 ? C.bad : left < 50 ? C.warn : C.accent
}

function resetIn(iso: string | null): string {
  if (!iso) return ''
  const ms = new Date(iso).getTime() - Date.now()
  if (Number.isNaN(ms) || ms <= 0) return ''
  const h = Math.floor(ms / 3600000)
  if (h >= 24) return `${Math.round(h / 24)}일 후 초기화`
  if (h >= 1) return `${h}시간 ${Math.round((ms % 3600000) / 60000)}분 후 초기화`
  return `${Math.max(1, Math.round(ms / 60000))}분 후 초기화`
}

function tokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`
  return String(n)
}

function Bar({ name, l }: { name: string; l: RemoteLimit }): JSX.Element {
  const pct = used(l)
  const color = usedColor(pct)
  return (
    <View style={s.bar}>
      <View style={s.barHead}>
        <Text style={s.barName}>{name}</Text>
        <Text style={[s.barPct, { color }]}>{pct}%</Text>
        <Text style={s.reset}>{resetIn(l.resetsAt)}</Text>
      </View>
      <View style={s.track}>
        <View style={[s.fill, { width: `${pct}%`, backgroundColor: color }]} />
      </View>
    </View>
  )
}

function Account({ a }: { a: RemoteUsage }): JSX.Element {
  const name = a.cli === 'codex' ? 'Codex' : a.label ? `Claude · ${a.label}` : 'Claude'
  const today = [
    a.todayTokens ? `오늘 ${tokens(a.todayTokens)} 토큰` : '',
    a.todayCost ? `$${a.todayCost.toFixed(2)}` : ''
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <View style={s.account}>
      <View style={s.accountHead}>
        <Text style={s.accountName} numberOfLines={1}>
          {name}
        </Text>
        {!!today && <Text style={s.today}>{today}</Text>}
      </View>
      {a.session && <Bar name="세션" l={a.session} />}
      {a.weekly && <Bar name={a.windowDays ? '기간' : '주간'} l={a.weekly} />}
      {!a.session && !a.weekly && <Text style={s.none}>한도 정보를 받지 못했어요.</Text>}
      {a.stale && (a.session || a.weekly) && <Text style={s.none}>최근에 받은 값이에요.</Text>}
    </View>
  )
}

export function UsageCard({
  usage,
  online,
  onRefresh
}: {
  usage: UsageView | null
  online: boolean
  onRefresh: () => void
}): JSX.Element | null {
  if (!usage && !online) return null
  return (
    <View style={s.card}>
      <View style={s.head}>
        <Ionicons name="speedometer-outline" size={18} color={C.accent} />
        <Text style={s.title}>사용량</Text>
        <Pressable onPress={onRefresh} hitSlop={10} disabled={!online}>
          <Ionicons name="refresh" size={18} color={online ? C.dim : C.edge} />
        </Pressable>
      </View>
      {!usage ? (
        <Text style={s.none}>불러오는 중…</Text>
      ) : usage.accounts.length ? (
        usage.accounts.map((a) => <Account key={a.id} a={a} />)
      ) : (
        <Text style={s.none}>사용량을 확인할 계정이 없어요.</Text>
      )}
    </View>
  )
}

const s = StyleSheet.create({
  card: {
    backgroundColor: C.bg2,
    borderColor: C.edge,
    borderWidth: 1,
    borderRadius: R,
    paddingVertical: 13,
    paddingHorizontal: 14,
    marginTop: 6,
    gap: 12
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  title: { flex: 1, color: C.fg, fontSize: 15 },
  account: { gap: 8 },
  accountHead: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  accountName: { flex: 1, color: C.fg, fontSize: 14, fontWeight: '600' },
  today: { color: C.dim, fontSize: 12 },
  bar: { gap: 5 },
  barHead: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  barName: { color: C.dim, fontSize: 12, width: 36 },
  barPct: { fontSize: 13, fontWeight: '600' },
  reset: { flex: 1, color: C.dim, fontSize: 12, textAlign: 'right' },
  track: { height: 6, borderRadius: 3, backgroundColor: C.bg3, overflow: 'hidden' },
  fill: { height: 6, borderRadius: 3 },
  none: { color: C.dim, fontSize: 13 }
})
