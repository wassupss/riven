import { useMemo } from 'react'
import { Alert, Pressable, SectionList, StyleSheet, Text, View } from 'react-native'
import { Stack, router, useLocalSearchParams } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import type { RemoteAgent } from '@riven/remote'
import { forgetComputer } from '@/lib/computers'
import { useComputerCtx } from '@/lib/ComputerContext'
import { C, R } from '@/lib/theme'

// One computer: its agents by workspace and the questions they are waiting on.
// A chat agent opens its own message screen.

export const STATUS: Record<RemoteAgent['status'], { label: string; color: string }> = {
  busy: { label: '실행 중', color: C.accent },
  waiting: { label: '확인 필요', color: C.warn },
  done: { label: '완료', color: C.ok },
  idle: { label: '대기', color: C.dim }
}

export default function ComputerScreen(): JSX.Element {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { computer, link } = useComputerCtx()

  const sections = useMemo(() => {
    const by = new Map<string, RemoteAgent[]>()
    for (const a of link.agents) by.set(a.workspace, [...(by.get(a.workspace) ?? []), a])
    return [...by].map(([title, data]) => ({ title, data }))
  }, [link.agents])

  const unpair = (): void =>
    Alert.alert('연결 해제', `이 휴대폰에서 ${computer?.name ?? '컴퓨터'} 연결 정보를 지울까요?`, [
      { text: '취소', style: 'cancel' },
      {
        text: '해제',
        style: 'destructive',
        onPress: () => void forgetComputer(id).then(() => router.dismissTo('/'))
      }
    ])

  const banner =
    link.state === 'revoked'
      ? '컴퓨터에서 이 휴대폰의 연결을 해제했어요.'
      : link.state === 'relay-error'
        ? '중계 서버에 연결하지 못했어요. 재시도 중…'
        : link.state === 'online' && !link.deskOnline
          ? '컴퓨터의 riven이 꺼져 있거나 잠들어 있어요.'
          : null

  return (
    <View style={s.screen}>
      <Stack.Screen
        options={{
          // The first screen of this nested stack: the way back to the computer
          // list has to be provided here.
          headerLeft: () => (
            <Pressable onPress={() => router.dismissTo('/')} hitSlop={12} style={s.back}>
              <Ionicons name="chevron-back" size={24} color={C.fg} />
            </Pressable>
          ),
          headerRight: () => (
            <Pressable onPress={unpair} hitSlop={10}>
              <Text style={s.headerAction}>해제</Text>
            </Pressable>
          )
        }}
      />
      <View style={s.conn}>
        <View style={[s.dot, { backgroundColor: link.deskOnline ? C.ok : C.bad }]} />
        <Text style={s.connText}>
          {link.deskOnline ? '컴퓨터 연결됨' : link.state === 'connecting' ? '연결 중…' : '응답 없음'}
        </Text>
      </View>
      {banner && <Text style={s.banner}>{banner}</Text>}

      <SectionList
        sections={sections}
        keyExtractor={(a) => a.id}
        contentContainerStyle={s.list}
        stickySectionHeadersEnabled={false}
        ListHeaderComponent={
          <>
            <Pressable style={s.jobsRow} onPress={() => router.push({ pathname: '/c/[id]/jobs', params: { id } })}>
              <Ionicons name="calendar-outline" size={18} color={C.accent} />
              <Text style={s.jobsText}>예약 작업</Text>
              <Ionicons name="chevron-forward" size={18} color={C.dim} />
            </Pressable>
            {link.asks.length ? (
              <View style={s.asks}>
                <Text style={s.section}>질문</Text>
                {link.asks.map((q) => (
                  <View key={q.id} style={s.card}>
                    {!!q.title && <Text style={s.who}>{q.title}</Text>}
                    <Text style={s.question}>{q.question}</Text>
                    <View style={s.opts}>
                      {q.options.map((o) => (
                        <Pressable key={o} style={s.opt} onPress={() => link.answer(q.id, o)}>
                          <Text style={s.optText}>{o}</Text>
                        </Pressable>
                      ))}
                    </View>
                  </View>
                ))}
              </View>
            ) : null}
          </>
        }
        ListEmptyComponent={<Text style={s.empty}>{link.deskOnline ? '열려 있는 에이전트가 없어요.' : ' '}</Text>}
        renderSectionHeader={({ section }) => <Text style={s.section}>{section.title}</Text>}
        renderItem={({ item }) => {
          const st = STATUS[item.status] ?? STATUS.idle
          return (
            <Pressable
              style={[s.agent, !item.canSend && s.agentOff]}
              disabled={!item.canSend}
              onPress={() =>
                router.push({
                  pathname: '/c/[id]/chat',
                  params: { id, key: item.id }
                })
              }
            >
              <Text style={s.agentTitle} numberOfLines={1}>
                {item.title}
              </Text>
              <Text style={s.kind}>{item.kind === 'chat' ? '챗' : '터미널'}</Text>
              <Text style={[s.status, { color: st.color }]}>{st.label}</Text>
            </Pressable>
          )
        }}
      />
    </View>
  )
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  back: { paddingRight: 8 },
  headerAction: { color: C.accent, fontSize: 16 },
  conn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 8
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  connText: { color: C.dim, fontSize: 13 },
  banner: {
    marginHorizontal: 16,
    marginBottom: 8,
    padding: 12,
    borderRadius: R,
    backgroundColor: C.bg3,
    color: C.fg,
    fontSize: 14
  },
  list: { padding: 16, paddingTop: 4 },
  section: {
    color: C.dim,
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.6,
    marginTop: 14,
    marginBottom: 8
  },
  asks: { gap: 8 },
  jobsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: C.bg2,
    borderColor: C.edge,
    borderWidth: 1,
    borderRadius: R,
    paddingVertical: 13,
    paddingHorizontal: 14,
    marginTop: 6
  },
  jobsText: { flex: 1, color: C.fg, fontSize: 15 },
  card: {
    backgroundColor: C.bg2,
    borderColor: C.edge,
    borderWidth: 1,
    borderRadius: R,
    padding: 14,
    gap: 8
  },
  who: { color: C.dim, fontSize: 12 },
  question: { color: C.fg, fontSize: 15, lineHeight: 21 },
  opts: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  opt: {
    backgroundColor: C.bg3,
    borderColor: C.edge,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 9,
    paddingHorizontal: 14
  },
  optText: { color: C.fg, fontSize: 15 },
  agent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: C.bg2,
    borderColor: C.edge,
    borderWidth: 1,
    borderRadius: R,
    paddingVertical: 13,
    paddingHorizontal: 14,
    marginBottom: 8
  },
  agentOff: { opacity: 0.6 },
  agentTitle: { flex: 1, color: C.fg, fontSize: 15 },
  kind: { color: C.dim, fontSize: 12 },
  status: { fontSize: 12, fontWeight: '600' },
  empty: { color: C.dim, fontSize: 14, textAlign: 'center', marginTop: 24 }
})
