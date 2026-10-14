import { useEffect, useRef, useState } from 'react'
import { Stack, useLocalSearchParams } from 'expo-router'
import { getComputer, type Computer } from '@/lib/computers'
import { useComputer } from '@/lib/useComputer'
import { ComputerProvider } from '@/lib/ComputerContext'
import { C } from '@/lib/theme'

// A paired computer: the link to it is opened here, once, and shared by the
// agent list and the chat screens below.
export default function ComputerLayout(): JSX.Element {
  const { id } = useLocalSearchParams<{ id: string }>()
  const [computer, setComputer] = useState<Computer | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    void getComputer(id).then(setComputer)
  }, [id])

  const link = useComputer(computer, (title, body) => {
    setToast(body ? `${title} · ${body}` : title)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setToast(null), 4000)
  })

  return (
    <ComputerProvider value={{ computer, link, toast }}>
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: C.bg },
          headerTintColor: C.fg,
          headerShadowVisible: false,
          contentStyle: { backgroundColor: C.bg }
        }}
      >
        <Stack.Screen name="index" options={{ title: computer?.name ?? '' }} />
        <Stack.Screen name="chat" options={{ title: '' }} />
      </Stack>
    </ComputerProvider>
  )
}
