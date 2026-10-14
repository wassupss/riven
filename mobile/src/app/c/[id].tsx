import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Stack, router, useLocalSearchParams } from 'expo-router'
import type { RemoteAgent } from '@riven/remote'
import { forgetComputer, getComputer, type Computer } from '@/lib/computers'
import { useComputer, type LogLine } from '@/lib/useComputer'
import { C, R } from '@/lib/theme'

// One computer: its agents by workspace, the questions they are waiting on, and
// a message box for any chat agent.

const STATUS: Record<RemoteAgent['status'], { label: string; color: string }> = {
  busy: { label: '실행 중', color: C.accent },
  waiting: { label: '확인 필요', color: C.warn },
  done: { label: '완료', color: C.ok },
  idle: { label: '대기', color: C.dim }
}

export default function ComputerScreen(): JSX.Element {
  const { id } = useLocalSearchParams<{ id: string }>()
  const [computer, setComputer] = useState<Computer | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [open, setOpen] = useState<RemoteAgent | null>(null)

  useEffect(() => {
    void getComputer(id).then(setComputer)
  }, [id])

  const link = useComputer(computer, (title, body) => {
    setToast(body ? `${title} · ${body}` : title)
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 4000)
  })

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
        onPress: () => void forgetComputer(id).then(() => router.back())
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
          title: computer?.name ?? '',
          headerRight: () => (
            <Pressable onPress={unpair} hitSlop={10}>
              <Text style={s.headerAction}>해제</Text>
            </Pressable>
          )
        }}
      />
      <View style={s.conn}>
        <View style={[s.dot, { backgroundColor: link.deskOnline ? C.ok : C.bad }]} />
        <Text style={s.connText}>{link.deskOnline ? '컴퓨터 연결됨' : link.state === 'connecting' ? '연결 중…' : '응답 없음'}</Text>
      </View>
      {banner && <Text style={s.banner}>{banner}</Text>}

      <SectionList
        sections={sections}
        keyExtractor={(a) => a.id}
        contentContainerStyle={s.list}
        stickySectionHeadersEnabled={false}
        ListHeaderComponent={
          link.asks.length ? (
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
          ) : null
        }
        ListEmptyComponent={
          <Text style={s.empty}>{link.deskOnline ? '열려 있는 에이전트가 없어요.' : ' '}</Text>
        }
        renderSectionHeader={({ section }) => <Text style={s.section}>{section.title}</Text>}
        renderItem={({ item }) => {
          const st = STATUS[item.status] ?? STATUS.idle
          return (
            <Pressable
              style={[s.agent, !item.canSend && s.agentOff]}
              disabled={!item.canSend}
              onPress={() => setOpen(item)}
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

      {toast && (
        <Pressable style={s.toast} onPress={() => setToast(null)}>
          <Text style={s.toastText} numberOfLines={2}>
            {toast}
          </Text>
        </Pressable>
      )}

      <ChatSheet
        agent={open}
        lines={open ? (link.logs[open.id] ?? []) : []}
        onSend={(text) => open && link.send(open.id, text)}
        onClose={() => setOpen(null)}
      />
    </View>
  )
}

function ChatSheet({
  agent,
  lines,
  onSend,
  onClose
}: {
  agent: RemoteAgent | null
  lines: LogLine[]
  onSend: (text: string) => void
  onClose: () => void
}): JSX.Element {
  const [text, setText] = useState('')
  const scroll = useRef<ScrollView>(null)
  return (
    <Modal visible={!!agent} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={s.sheet} edges={['top', 'bottom']}>
        <KeyboardAvoidingView style={s.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={s.sheetHead}>
            <Text style={s.sheetTitle} numberOfLines={1}>
              {agent?.title}
            </Text>
            <Pressable onPress={onClose} hitSlop={10}>
              <Text style={s.headerAction}>닫기</Text>
            </Pressable>
          </View>
          <ScrollView
            ref={scroll}
            style={s.flex}
            contentContainerStyle={s.log}
            onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}
          >
            {lines.length === 0 && <Text style={s.empty}>보낸 메시지와 답변이 여기 보여요.</Text>}
            {lines.map((l, i) => (
              <View
                key={i}
                style={[s.bubble, l.who === 'me' ? s.me : s.it, l.who === 'error' && { borderColor: C.bad, borderWidth: 1 }]}
              >
                <Text style={[s.bubbleText, l.who === 'wait' && { color: C.dim }]} selectable>
                  {l.who === 'wait' ? '답변을 기다리는 중…' : l.text}
                </Text>
              </View>
            ))}
          </ScrollView>
          <View style={s.composer}>
            <TextInput
              style={s.input}
              value={text}
              onChangeText={setText}
              placeholder="에이전트에게 보낼 메시지"
              placeholderTextColor={C.dim}
              multiline
            />
            <Pressable
              style={[s.send, !text.trim() && { opacity: 0.4 }]}
              disabled={!text.trim()}
              onPress={() => {
                onSend(text.trim())
                setText('')
              }}
            >
              <Text style={s.sendText}>보내기</Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  )
}

const s = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flex: 1, backgroundColor: C.bg },
  headerAction: { color: C.accent, fontSize: 16 },
  conn: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingBottom: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  connText: { color: C.dim, fontSize: 13 },
  banner: { marginHorizontal: 16, marginBottom: 8, padding: 12, borderRadius: R, backgroundColor: C.bg3, color: C.fg, fontSize: 14 },
  list: { padding: 16, paddingTop: 4, gap: 8 },
  section: { color: C.dim, fontSize: 12, fontWeight: '600', letterSpacing: 0.6, marginTop: 14, marginBottom: 8 },
  asks: { gap: 8 },
  card: { backgroundColor: C.bg2, borderColor: C.edge, borderWidth: 1, borderRadius: R, padding: 14, gap: 8 },
  who: { color: C.dim, fontSize: 12 },
  question: { color: C.fg, fontSize: 15, lineHeight: 21 },
  opts: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  opt: { backgroundColor: C.bg3, borderColor: C.edge, borderWidth: 1, borderRadius: 10, paddingVertical: 9, paddingHorizontal: 14 },
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
  empty: { color: C.dim, fontSize: 14, textAlign: 'center', marginTop: 24 },
  toast: { position: 'absolute', left: 16, right: 16, bottom: 28, backgroundColor: C.bg3, borderColor: C.edge, borderWidth: 1, borderRadius: R, padding: 14 },
  toastText: { color: C.fg, fontSize: 14 },
  sheet: { flex: 1, backgroundColor: C.bg },
  sheetHead: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12, borderBottomColor: C.edge, borderBottomWidth: 1 },
  sheetTitle: { flex: 1, color: C.fg, fontSize: 17, fontWeight: '600' },
  log: { padding: 16, gap: 10 },
  bubble: { borderRadius: 14, paddingVertical: 10, paddingHorizontal: 13, maxWidth: '88%' },
  me: { alignSelf: 'flex-end', backgroundColor: '#3b3466' },
  it: { alignSelf: 'flex-start', backgroundColor: C.bg3 },
  bubbleText: { color: C.fg, fontSize: 15, lineHeight: 21 },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 12, borderTopColor: C.edge, borderTopWidth: 1 },
  input: { flex: 1, minHeight: 44, maxHeight: 140, color: C.fg, backgroundColor: C.bg2, borderColor: C.edge, borderWidth: 1, borderRadius: R, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  send: { backgroundColor: C.accent, borderRadius: R, paddingVertical: 12, paddingHorizontal: 16 },
  sendText: { color: '#fff', fontSize: 15, fontWeight: '600' }
})
