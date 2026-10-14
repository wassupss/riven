import { DarkTheme, Stack, ThemeProvider } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import Gate from '@/components/Gate'
import { C } from '@/lib/theme'

// The navigation theme's own background shows through between screens; left
// at its default it flashed white on every transition.
const theme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: C.bg,
    card: C.bg,
    text: C.fg,
    border: C.edge,
    primary: C.accent
  }
}

export default function Layout(): JSX.Element {
  return (
    <ThemeProvider value={theme}>
      <StatusBar style="light" />
      <Gate>
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
          <Stack.Screen name="c/[id]" options={{ headerShown: false }} />
          <Stack.Screen name="auth" options={{ headerShown: false }} />
        </Stack>
      </Gate>
    </ThemeProvider>
  )
}
