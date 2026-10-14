import { useState, type ReactNode } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { signIn, useUser } from '@/lib/auth'
import { useAppLock } from '@/lib/appLock'
import { configured } from '@/lib/supabase'
import { C, R } from '@/lib/theme'

// Nothing of the app shows until both are true: the phone's owner unlocked it,
// and it is signed in to a riven account. The account is what the relay checks
// before it lets this phone near a computer's channel.

export default function Gate({ children }: { children: ReactNode }): JSX.Element {
  const lock = useAppLock()
  const { ready, user } = useUser()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (lock.locked)
    return (
      <View style={s.center}>
        <Ionicons name="lock-closed" size={40} color={C.dim} />
        <Text style={s.title}>잠겨 있어요</Text>
        <Pressable style={s.button} onPress={lock.unlock}>
          <Text style={s.buttonText}>잠금 해제</Text>
        </Pressable>
      </View>
    )

  if (!ready) return <View style={s.center} />

  if (!user) {
    const go = (): void => {
      setBusy(true)
      setError(null)
      void signIn().then((r) => {
        setBusy(false)
        if (!r.ok && r.error) setError(r.error)
      })
    }
    return (
      <View style={s.center}>
        <Text style={s.brand}>riven</Text>
        <Text style={s.text}>
          컴퓨터의 riven에 로그인한 것과 같은 계정으로 로그인해 주세요. 그 계정의 컴퓨터에만 연결돼요.
        </Text>
        {!configured ? (
          <Text style={s.error}>이 빌드에는 서버 설정이 없어요.</Text>
        ) : (
          <Pressable style={[s.button, s.github, busy && s.dim]} disabled={busy} onPress={go}>
            {busy ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <>
                <Ionicons name="logo-github" size={20} color="#fff" />
                <Text style={s.buttonText}>GitHub으로 계속하기</Text>
              </>
            )}
          </Pressable>
        )}
        {!!error && <Text style={s.error}>{error}</Text>}
      </View>
    )
  }

  return <>{children}</>
}

const s = StyleSheet.create({
  center: {
    flex: 1,
    backgroundColor: C.bg,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 28,
    gap: 14
  },
  brand: { color: C.fg, fontSize: 32, fontWeight: '700', letterSpacing: 0.5 },
  title: { color: C.fg, fontSize: 18, fontWeight: '600' },
  text: { color: C.dim, fontSize: 15, textAlign: 'center', lineHeight: 22 },
  error: { color: C.bad, fontSize: 14, textAlign: 'center' },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    marginTop: 8,
    minWidth: 240,
    backgroundColor: C.accent,
    borderRadius: R,
    paddingVertical: 14,
    paddingHorizontal: 24
  },
  github: { backgroundColor: '#24292f', borderColor: C.edge, borderWidth: 1 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  dim: { opacity: 0.6 }
})
