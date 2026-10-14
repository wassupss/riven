import { useRef, useState } from 'react'
import { KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Stack, useLocalSearchParams } from 'expo-router'
import { useHeaderHeight } from 'expo-router/react-navigation'
import { useComputerCtx } from '@/lib/ComputerContext'
import { C, R } from '@/lib/theme'

// Messages to one chat agent, and its replies. A screen of its own rather than
// a Modal: an Android Modal is a separate window that the edge-to-edge layout
// and the safe-area insets do not line up with, which left a band of empty
// space under the composer.

export default function Chat(): JSX.Element {
  const { key } = useLocalSearchParams<{ key: string }>()
  const { link } = useComputerCtx()
  const insets = useSafeAreaInsets()
  const headerHeight = useHeaderHeight()
  const [text, setText] = useState('')
  const scroll = useRef<ScrollView>(null)
  const agent = link.agents.find((a) => a.id === key)
  const lines = link.logs[key] ?? []

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
      <ScrollView
        ref={scroll}
        style={s.flex}
        contentContainerStyle={s.log}
        keyboardDismissMode="interactive"
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}
      >
        {lines.length === 0 && <Text style={s.empty}>보낸 메시지와 답변이 여기 보여요.</Text>}
        {lines.map((l, i) => (
          <View key={i} style={[s.bubble, l.who === 'me' ? s.me : s.it, l.who === 'error' && s.error]}>
            <Text style={[s.bubbleText, l.who === 'wait' && { color: C.dim }]} selectable>
              {l.who === 'wait' ? '답변을 기다리는 중…' : l.text}
            </Text>
          </View>
        ))}
      </ScrollView>
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
    </KeyboardAvoidingView>
  )
}

const s = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flex: 1, backgroundColor: C.bg },
  log: { padding: 16, gap: 10 },
  empty: { color: C.dim, fontSize: 14, textAlign: 'center', marginTop: 24 },
  bubble: { borderRadius: 14, paddingVertical: 10, paddingHorizontal: 13, maxWidth: '88%' },
  me: { alignSelf: 'flex-end', backgroundColor: '#3b3466' },
  it: { alignSelf: 'flex-start', backgroundColor: C.bg3 },
  error: { borderColor: C.bad, borderWidth: 1 },
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
  send: { backgroundColor: C.accent, borderRadius: R, paddingVertical: 12, paddingHorizontal: 16 },
  sendText: { color: '#fff', fontSize: 15, fontWeight: '600' }
})
