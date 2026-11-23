import { useCallback, useMemo } from 'react'
import { Pressable, SectionList, StyleSheet, Text, View } from 'react-native'
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import type { RemoteTerm } from '@riven/remote'
import { useComputerCtx } from '@/lib/ComputerContext'
import { C, R } from '@/lib/theme'
import { STATUS } from '@/lib/status'

// The computer's terminals that run a CLI agent and that its user chose to
// show on phones. Which ones, and whether this phone sees any at all, is
// decided on the computer; nothing here can widen it.

export default function Terms(): JSX.Element {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { link } = useComputerCtx()
  const { loadTerms, deskOnline } = link

  // Asked for when the screen shows; the computer keeps it current after that.
  useFocusEffect(
    useCallback(() => {
      if (deskOnline) loadTerms()
    }, [deskOnline, loadTerms])
  )

  const sections = useMemo(() => {
    const by = new Map<string, RemoteTerm[]>()
    for (const t of link.terms?.terms ?? []) by.set(t.workspace, [...(by.get(t.workspace) ?? []), t])
    return [...by].map(([title, data]) => ({ title, data }))
  }, [link.terms])

  const empty = !link.terms
    ? deskOnline
      ? '불러오는 중…'
      : '컴퓨터가 응답하지 않아요.'
    : !link.terms.allowed
      ? "이 휴대폰은 터미널을 볼 수 없어요. 컴퓨터의 설정 > 원격 제어에서 이 휴대폰의 '터미널 보기'를 켜 주세요."
      : "보이는 터미널이 없어요. 컴퓨터에서 터미널 탭을 우클릭해 '원격에 보이기'를 켜고, 그 터미널에서 에이전트(Claude Code, Codex 등)가 실행 중이어야 해요."

  return (
    <View style={s.screen}>
      <SectionList
        sections={sections}
        keyExtractor={(t) => t.id}
        contentContainerStyle={s.list}
        stickySectionHeadersEnabled={false}
        ListEmptyComponent={<Text style={s.empty}>{empty}</Text>}
        renderSectionHeader={({ section }) => <Text style={s.section}>{section.title}</Text>}
        renderItem={({ item }) => {
          const st = STATUS[item.status] ?? STATUS.idle
          return (
            <Pressable
              style={s.row}
              onPress={() => router.push({ pathname: '/c/[id]/term', params: { id, key: item.id } })}
            >
              <Ionicons name="terminal-outline" size={16} color={C.dim} />
              <Text style={s.title} numberOfLines={1}>
                {item.title}
              </Text>
              <Text style={s.agent}>{item.agent}</Text>
              {item.canInput && <Ionicons name="create-outline" size={14} color={C.accent} />}
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
  list: { padding: 16, paddingTop: 4 },
  section: { color: C.dim, fontSize: 12, fontWeight: '600', letterSpacing: 0.6, marginTop: 14, marginBottom: 8 },
  row: {
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
  title: { flex: 1, color: C.fg, fontSize: 15 },
  agent: { color: C.dim, fontSize: 12 },
  status: { fontSize: 12, fontWeight: '600' },
  empty: { color: C.dim, fontSize: 14, textAlign: 'center', marginTop: 24, lineHeight: 20, paddingHorizontal: 8 }
})
