import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState } from 'react-native'
import * as LocalAuthentication from 'expo-local-authentication'

// The app opens only for the phone's owner: fingerprint, face or the screen
// lock's own PIN, at launch and again after a minute away. An unlocked phone
// left on a desk should not be a way into the computers it is paired with.
// A phone with no screen lock at all has nothing to check against; then the
// app is as open as the phone is.

const RELOCK_AFTER_MS = 60_000

export function useAppLock(): { locked: boolean; unlock: () => void } {
  const [locked, setLocked] = useState(true)
  const away = useRef<number | null>(null)
  const asking = useRef(false)

  const unlock = useCallback(async () => {
    if (asking.current) return
    asking.current = true
    try {
      const level = await LocalAuthentication.getEnrolledLevelAsync()
      if (level === LocalAuthentication.SecurityLevel.NONE) return setLocked(false)
      const r = await LocalAuthentication.authenticateAsync({
        promptMessage: 'riven 잠금 해제',
        cancelLabel: '취소'
      })
      if (r.success) setLocked(false)
    } finally {
      asking.current = false
    }
  }, [])

  useEffect(() => {
    void unlock()
    const sub = AppState.addEventListener('change', (s) => {
      // The system's own auth prompt sends the app to the background and back;
      // that is not "away".
      if (asking.current) return
      if (s === 'background') away.current = Date.now()
      else if (s === 'active' && away.current !== null) {
        const gone = Date.now() - away.current
        away.current = null
        if (gone > RELOCK_AFTER_MS) {
          setLocked(true)
          void unlock()
        }
      }
    })
    return () => sub.remove()
  }, [unlock])

  return { locked, unlock: () => void unlock() }
}
