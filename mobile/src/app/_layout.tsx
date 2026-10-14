import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { C } from '@/lib/theme'

export default function Layout(): JSX.Element {
  return (
    <>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: C.bg },
          headerTintColor: C.fg,
          headerShadowVisible: false,
          contentStyle: { backgroundColor: C.bg }
        }}
      >
        <Stack.Screen name="index" options={{ title: 'riven' }} />
        <Stack.Screen name="pair" options={{ title: '컴퓨터 연결', presentation: 'modal' }} />
        <Stack.Screen name="c/[id]" options={{ title: '' }} />
      </Stack>
    </>
  )
}
