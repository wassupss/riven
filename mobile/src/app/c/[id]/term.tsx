import { useEffect, useRef, useState } from 'react'
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Stack, useLocalSearchParams } from 'expo-router'
import { useHeaderHeight } from 'expo-router/react-navigation'
import { Ionicons } from '@expo/vector-icons'
import { TERM_LINE_MAX, cleanTermLine, type TermGone, type TermKey } from '@riven/remote'
import { useComputerCtx } from '@/lib/ComputerContext'
import { reason } from '@/lib/reason'
import { C, R } from '@/lib/theme'

// One of the computer's terminals, read only unless the computer allows more:
// the last lines of its screen (secrets already hidden by the computer), kept
// current while this is open. When the computer allows this phone to type,
// a bar below offers one line of prompt text and the keys a CLI's prompt
// asks for. There is no way to send anything else, Ctrl+C included.

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' })

const GONE: Record<TermGone, string> = {
  'not-shared': '컴퓨터에서 이 터미널을 휴대폰에 보이지 않게 했거나, 에이전트가 종료됐어요.',
  'no-access': "이 휴대폰의 '터미널 보기'가 컴퓨터 설정에서 꺼져 있어요.",
  closed: '컴퓨터에서 이 터미널이 닫혔어요.',
  stopped: '컴퓨터에서 원격 터미널 접근을 모두 중지했어요.'
}

const KEYS: Array<{ key: TermKey; label?: string; icon?: keyof typeof Ionicons.glyphMap }> = [
  { key: 'up', icon: 'arrow-up' },
  { key: 'down', icon: 'arrow-down' },
  { key: 'enter', label: 'Enter' },
  { key: 'esc', label: 'Esc' },
  ...(['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const).map((k) => ({ key: k }))
]

export default function Term(): JSX.Element {
  const { key } = useLocalSearchParams<{ key: string }>()
  const { link, notify } = useComputerCtx()
  const insets = useSafeAreaInsets()
  const headerHeight = useHeaderHeight()
  const scroll = useRef<ScrollView>(null)
  // Follow the bottom unless the user scrolled up to read.
  const follow = useRef(true)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const term = link.terms?.terms.find((t) => t.id === key)
  const screen = link.termScreens[key]
  const gone = link.termGone[key]
  const canInput = !!screen?.canInput && !gone

  // While this screen is open the computer sends the terminal's text.
  useEffect(() => {
    link.watchTerm(key)
    return () => link.watchTerm(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>): void => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent
    follow.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 24
  }

  const run = (input: Parameters<typeof link.termInput>[1]): void => {
    setSending(true)
    void link.termInput(key, input).then((a) => {
      setSending(false)
      if (!a.ok) notify('보내지 못했어요', reason(a.error))
    })
  }

  const submit = (): void => {
    const line = cleanTermLine(text)
    if (!line) return
    run({ kind: 'line', text: line.slice(0, TERM_LINE_MAX) })
    setText('')
    follow.current = true
  }

  return (
    <KeyboardAvoidingView style={s.screen} behavior="padding" keyboardVerticalOffset={headerHeight}>
      <Stack.Screen options={{ title: term?.title ?? '터미널' }} />
      {gone && (
        <View style={s.banner}>
          <Ionicons name="eye-off-outline" size={16} color={C.warn} />
          <Text style={s.bannerText}>{GONE[gone] ?? gone}</Text>
        </View>
      )}
      <ScrollView
        ref={scroll}
        style={s.flex}
        contentContainerStyle={s.body}
        onScroll={onScroll}
        scrollEventThrottle={100}
        onContentSizeChange={() => {
          if (follow.current) scroll.current?.scrollToEnd({ animated: false })
        }}
      >
        {screen ? (
          // Plain text only: nothing on the screen is turned into a link or markup.
          <Text style={s.mono} selectable>
            {screen.text}
          </Text>
        ) : (
          !gone && <Text style={s.empty}>{link.deskOnline ? '화면을 불러오는 중…' : '컴퓨터가 응답하지 않아요.'}</Text>
        )}
      </ScrollView>
      {canInput && (
        <View style={[s.inputBar, { paddingBottom: Math.max(insets.bottom, 10) }]}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.keys}>
            {KEYS.map((k) => (
              <Pressable key={k.key} style={s.key} disabled={sending} onPress={() => run({ kind: 'key', key: k.key })}>
                {k.icon ? (
                  <Ionicons name={k.icon} size={15} color={C.fg} />
                ) : (
                  <Text style={s.keyText}>{k.label ?? k.key}</Text>
                )}
              </Pressable>
            ))}
          </ScrollView>
          <View style={s.composer}>
            <TextInput
              style={s.input}
              value={text}
              onChangeText={setText}
              placeholder="에이전트에게 보낼 한 줄 (Enter 포함)"
              placeholderTextColor={C.dim}
              maxLength={TERM_LINE_MAX}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="send"
              onSubmitEditing={submit}
              submitBehavior="submit"
            />
            <Pressable
              style={[s.send, (!cleanTermLine(text) || sending) && { opacity: 0.4 }]}
              disabled={!cleanTermLine(text) || sending}
              onPress={submit}
            >
              <Text style={s.sendText}>보내기</Text>
            </Pressable>
          </View>
        </View>
      )}
    </KeyboardAvoidingView>
  )
}

const s = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flex: 1, backgroundColor: C.bg },
  body: { padding: 12 },
  mono: { color: C.fg, fontFamily: MONO, fontSize: 11, lineHeight: 15 },
  empty: { color: C.dim, fontSize: 14, textAlign: 'center', marginTop: 24 },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 12,
    marginBottom: 6,
    padding: 10,
    borderRadius: R,
    backgroundColor: C.bg3
  },
  bannerText: { flex: 1, color: C.fg, fontSize: 13, lineHeight: 18 },
  inputBar: {
    borderTopColor: C.edge,
    borderTopWidth: 1,
    paddingTop: 8,
    gap: 8,
    backgroundColor: C.bg
  },
  keys: { gap: 6, paddingHorizontal: 12 },
  key: {
    minWidth: 38,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.bg2,
    borderColor: C.edge,
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 7,
    paddingHorizontal: 10
  },
  keyText: { color: C.fg, fontSize: 14, fontFamily: MONO },
  composer: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12 },
  input: {
    flex: 1,
    minHeight: 42,
    color: C.fg,
    backgroundColor: C.bg2,
    borderColor: C.edge,
    borderWidth: 1,
    borderRadius: R,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 15
  },
  send: { backgroundColor: C.accent, borderRadius: R, paddingVertical: 11, paddingHorizontal: 16 },
  sendText: { color: '#fff', fontSize: 15, fontWeight: '600' }
})
