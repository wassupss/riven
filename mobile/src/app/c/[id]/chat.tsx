import { useEffect, useRef, useState } from 'react'
import { KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Stack, useLocalSearchParams } from 'expo-router'
import { useHeaderHeight } from 'expo-router/react-navigation'
import { Ionicons } from '@expo/vector-icons'
import type { Choice } from '@riven/remote'
import { useComputerCtx } from '@/lib/ComputerContext'
import Markdown from '@/components/Markdown'
import Sheet from '@/components/Sheet'
import ToolList from '@/components/ToolList'
import WorkStrip from '@/components/WorkStrip'
import { reason } from '@/lib/reason'
import { C, R } from '@/lib/theme'

// Messages to one chat agent, and its replies. A screen of its own rather than
// a Modal: an Android Modal is a separate window that the edge-to-edge layout
// and the safe-area insets do not line up with, which left a band of empty
// space under the composer.

export default function Chat(): JSX.Element {
  const { key } = useLocalSearchParams<{ key: string }>()
  const { link, notify } = useComputerCtx()
  const insets = useSafeAreaInsets()
  const headerHeight = useHeaderHeight()
  const [text, setText] = useState('')
  const [picking, setPicking] = useState<'model' | 'mode' | null>(null)
  const scroll = useRef<ScrollView>(null)
  const agent = link.agents.find((a) => a.id === key)
  const lines = link.logs[key] ?? []
  const info = link.chatInfo[key]
  const busy = agent?.status === 'busy' || lines.some((l) => l.who === 'wait')

  // The conversation so far comes from the computer each time the chat is
  // opened (and again once the link is up, if it was not yet).
  useEffect(() => {
    if (!link.deskOnline) return
    link.loadHistory(key)
    link.loadChatInfo(key)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, link.deskOnline])

  // While this chat is on screen the computer keeps its running work current.
  useEffect(() => {
    link.watch(key)
    return () => link.watch(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  // A change made here is the same one the chat's own picker makes on the
  // computer; the computer says if it could not (the chat was closed there).
  const apply = (what: 'model' | 'mode', value: string): void => {
    void (what === 'model' ? link.setModel(key, value) : link.setMode(key, value)).then((a) => {
      if (!a.ok) notify(what === 'model' ? '모델을 바꾸지 못했어요' : '권한 모드를 바꾸지 못했어요', reason(a.error))
    })
  }
  const stop = (): void => {
    void link.stop(key).then((a) => {
      if (!a.ok) notify('중지하지 못했어요', reason(a.error))
    })
  }

  const submit = (): void => {
    const t = text.trim()
    if (!t) return
    link.send(key, t)
    setText('')
  }

  return (
    <KeyboardAvoidingView
      style={s.screen}
      behavior="padding"
      // The header sits above this view; without its height the keyboard
      // would cover the bottom of the composer.
      keyboardVerticalOffset={headerHeight}
    >
      <Stack.Screen options={{ title: agent?.title ?? '' }} />
      <View style={s.bar}>
        <Pressable style={[s.chip, !info && s.off]} disabled={!info} onPress={() => setPicking('model')}>
          <Ionicons name="sparkles-outline" size={14} color={C.dim} />
          <Text style={s.chipText} numberOfLines={1}>
            {info ? labelOf(info.models, info.model) : '모델'}
          </Text>
        </Pressable>
        <Pressable style={[s.chip, !info && s.off]} disabled={!info} onPress={() => setPicking('mode')}>
          <Ionicons name="shield-checkmark-outline" size={14} color={C.dim} />
          <Text style={s.chipText} numberOfLines={1}>
            {info ? labelOf(info.modes, info.mode) : '권한'}
          </Text>
        </Pressable>
        <View style={s.flex} />
        {busy && (
          <Pressable style={s.stop} onPress={stop} hitSlop={6}>
            <Ionicons name="stop" size={13} color={C.bad} />
            <Text style={s.stopText}>중지</Text>
          </Pressable>
        )}
      </View>
      <ScrollView
        ref={scroll}
        style={s.flex}
        contentContainerStyle={s.log}
        keyboardDismissMode="interactive"
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}
      >
        {lines.length === 0 && (
          <Text style={s.empty}>{link.loaded[key] ? '아직 대화가 없어요.' : '대화를 불러오는 중…'}</Text>
        )}
        {lines.map((l, i) =>
          l.who === 'agent' ? (
            // The agent's reply, laid out like riven's chat: full width, rendered.
            <View key={i} style={s.reply}>
              {!!l.text.trim() && <Markdown text={l.text} />}
              {!!l.tools && <ToolList count={l.tools} list={l.toolList} />}
            </View>
          ) : (
            <View key={i} style={[s.bubble, l.who === 'me' ? s.me : s.it, l.who === 'error' && s.error]}>
              <Text style={[s.bubbleText, l.who === 'wait' && { color: C.dim }]} selectable>
                {l.who === 'wait' ? '답변을 기다리는 중…' : l.text}
              </Text>
            </View>
          )
        )}
      </ScrollView>
      <WorkStrip work={link.work[key]} />
      <View style={[s.composer, { paddingBottom: Math.max(insets.bottom, 12) }]}>
        <TextInput
          style={s.input}
          value={text}
          onChangeText={setText}
          placeholder="에이전트에게 보낼 메시지"
          placeholderTextColor={C.dim}
          multiline
        />
        <Pressable style={[s.send, !text.trim() && { opacity: 0.4 }]} disabled={!text.trim()} onPress={submit}>
          <Text style={s.sendText}>보내기</Text>
        </Pressable>
      </View>
      {picking && info && (
        <Sheet
          title={picking === 'model' ? '모델' : '권한 모드'}
          options={picking === 'model' ? info.models : info.modes}
          value={picking === 'model' ? info.model : info.mode}
          onPick={(v) => apply(picking, v)}
          onClose={() => setPicking(null)}
        />
      )}
    </KeyboardAvoidingView>
  )
}

const labelOf = (list: Choice[], value: string): string => list.find((x) => x.value === value)?.label ?? value

const s = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flex: 1, backgroundColor: C.bg },
  log: { padding: 16, gap: 10 },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingBottom: 8,
    borderBottomColor: C.edge,
    borderBottomWidth: 1
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    maxWidth: '42%',
    backgroundColor: C.bg2,
    borderColor: C.edge,
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: 6,
    paddingHorizontal: 11
  },
  off: { opacity: 0.5 },
  chipText: { color: C.fg, fontSize: 13, flexShrink: 1 },
  stop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderColor: C.bad,
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: 5,
    paddingHorizontal: 11
  },
  stopText: { color: C.bad, fontSize: 13, fontWeight: '600' },
  empty: { color: C.dim, fontSize: 14, textAlign: 'center', marginTop: 24 },
  bubble: {
    borderRadius: 14,
    paddingVertical: 10,
    paddingHorizontal: 13,
    maxWidth: '88%'
  },
  me: { alignSelf: 'flex-end', backgroundColor: '#3b3466' },
  it: { alignSelf: 'flex-start', backgroundColor: C.bg3 },
  error: { borderColor: C.bad, borderWidth: 1 },
  reply: { alignSelf: 'stretch', gap: 6, paddingVertical: 2 },
  tools: { color: C.dim, fontSize: 12 },
  bubbleText: { color: C.fg, fontSize: 15, lineHeight: 21 },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 10,
    borderTopColor: C.edge,
    borderTopWidth: 1,
    backgroundColor: C.bg
  },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 140,
    color: C.fg,
    backgroundColor: C.bg2,
    borderColor: C.edge,
    borderWidth: 1,
    borderRadius: R,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15
  },
  send: {
    backgroundColor: C.accent,
    borderRadius: R,
    paddingVertical: 12,
    paddingHorizontal: 16
  },
  sendText: { color: '#fff', fontSize: 15, fontWeight: '600' }
})
