import { useEffect, useMemo, useState } from 'react'
import { Alert, Pressable, SectionList, StyleSheet, Switch, Text, View } from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { RemoteJob } from '@riven/remote'
import { useComputerCtx } from '@/lib/ComputerContext'
import { reason } from '@/lib/reason'
import { triggerLabel, whenLabel } from '@/lib/schedule'
import { C, R } from '@/lib/theme'

// The computer's scheduled jobs: turn them on and off, run one now, delete one,
// or make a new one. The computer keeps the list current while this is open.

const RUN: Record<'ok' | 'failed' | 'missed', { label: string; color: string }> = {
  ok: { label: '성공', color: C.ok },
  failed: { label: '실패', color: C.bad },
  missed: { label: '놓침', color: C.warn }
}

export default function Jobs(): JSX.Element {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { link, notify } = useComputerCtx()
  const insets = useSafeAreaInsets()
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    if (link.deskOnline) link.loadJobs()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link.deskOnline])

  const sections = useMemo(() => {
    if (!link.jobs) return []
    const names = new Map(link.jobs.workspaces.map((w) => [w.value, w.label]))
    const by = new Map<string, RemoteJob[]>()
    for (const j of link.jobs.jobs) by.set(j.workspace, [...(by.get(j.workspace) ?? []), j])
    return [...by].map(([ws, data]) => ({ title: names.get(ws) ?? ws.split('/').pop() ?? ws, data }))
  }, [link.jobs])

  const act = (jobId: string, run: () => Promise<{ ok: boolean; error?: string }>, failTitle: string): void => {
    setBusy(jobId)
    void run().then((a) => {
      setBusy(null)
      if (!a.ok) notify(failTitle, reason(a.error ?? ''))
    })
  }

  const confirmDelete = (j: RemoteJob): void =>
    Alert.alert('예약 작업 삭제', `"${j.name}"을(를) 지울까요?`, [
      { text: '취소', style: 'cancel' },
      { text: '삭제', style: 'destructive', onPress: () => act(j.id, () => link.deleteJob(j.id), '삭제하지 못했어요') }
    ])

  const confirmRun = (j: RemoteJob): void =>
    Alert.alert('지금 실행', `"${j.name}"을(를) 지금 한 번 실행할까요?`, [
      { text: '취소', style: 'cancel' },
      {
        text: '실행',
        onPress: () =>
          act(
            j.id,
            () =>
              link.runJob(j.id).then((a) => {
                if (a.ok) notify('실행했어요', j.name)
                return a
              }),
            '실행하지 못했어요'
          )
      }
    ])

  return (
    <View style={s.screen}>
      <SectionList
        sections={sections}
        keyExtractor={(j) => j.id}
        contentContainerStyle={[s.list, { paddingBottom: 96 + insets.bottom }]}
        stickySectionHeadersEnabled={false}
        ListEmptyComponent={
          <Text style={s.empty}>
            {!link.deskOnline ? '컴퓨터가 응답하지 않아요.' : link.jobs ? '예약 작업이 없어요.' : '불러오는 중…'}
          </Text>
        }
        renderSectionHeader={({ section }) => <Text style={s.section}>{section.title}</Text>}
        renderItem={({ item: j }) => {
          const last = j.last ? RUN[j.last.status] : null
          return (
            <View style={[s.card, busy === j.id && s.dim]}>
              <View style={s.top}>
                <View style={s.flex}>
                  <Text style={s.name} numberOfLines={1}>
                    {j.name}
                  </Text>
                  <Text style={s.sub} numberOfLines={1}>
                    {triggerLabel(j.trigger)} · {j.target.kind === 'new' ? '새 챗' : j.target.title}
                  </Text>
                </View>
                <Switch
                  value={j.enabled}
                  disabled={busy === j.id}
                  onValueChange={(v) => act(j.id, () => link.setJobEnabled(j.id, v), '바꾸지 못했어요')}
                  trackColor={{ true: C.accent, false: C.bg3 }}
                  thumbColor="#fff"
                />
              </View>
              <Text style={s.prompt} numberOfLines={2}>
                {j.prompt}
              </Text>
              <View style={s.foot}>
                <Text style={s.meta} numberOfLines={1}>
                  {j.enabled ? `다음 ${whenLabel(j.next)}` : '꺼짐'}
                  {last ? ' · 최근 ' : ''}
                  {last && <Text style={{ color: last.color }}>{last.label}</Text>}
                </Text>
                <Pressable onPress={() => confirmRun(j)} hitSlop={8} disabled={busy === j.id}>
                  <Text style={s.link}>지금 실행</Text>
                </Pressable>
                <Pressable onPress={() => confirmDelete(j)} hitSlop={8} disabled={busy === j.id}>
                  <Text style={[s.link, { color: C.bad }]}>삭제</Text>
                </Pressable>
              </View>
            </View>
          )
        }}
      />
      <View style={[s.fabWrap, { paddingBottom: Math.max(insets.bottom, 12) }]}>
        <Pressable
          style={[s.fab, !(link.deskOnline && link.jobs) && s.dim]}
          disabled={!(link.deskOnline && link.jobs)}
          onPress={() => router.push({ pathname: '/c/[id]/job-new', params: { id } })}
        >
          <Text style={s.fabText}>새 예약 작업</Text>
        </Pressable>
      </View>
    </View>
  )
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  flex: { flex: 1 },
  list: { padding: 16, paddingTop: 4 },
  section: { color: C.dim, fontSize: 12, fontWeight: '600', letterSpacing: 0.6, marginTop: 14, marginBottom: 8 },
  empty: { color: C.dim, fontSize: 14, textAlign: 'center', marginTop: 32 },
  card: {
    backgroundColor: C.bg2,
    borderColor: C.edge,
    borderWidth: 1,
    borderRadius: R,
    padding: 14,
    gap: 8,
    marginBottom: 10
  },
  dim: { opacity: 0.5 },
  top: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  name: { color: C.fg, fontSize: 16, fontWeight: '600' },
  sub: { color: C.dim, fontSize: 13, marginTop: 2 },
  prompt: { color: C.fg, fontSize: 14, lineHeight: 20, opacity: 0.85 },
  foot: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  meta: { flex: 1, color: C.dim, fontSize: 12 },
  link: { color: C.accent, fontSize: 14, fontWeight: '600' },
  fabWrap: { position: 'absolute', left: 16, right: 16, bottom: 0 },
  fab: { backgroundColor: C.accent, borderRadius: R, paddingVertical: 15, alignItems: 'center' },
  fabText: { color: '#fff', fontSize: 16, fontWeight: '600' }
})
