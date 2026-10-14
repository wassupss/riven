import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { router, useLocalSearchParams } from 'expo-router'
import { OFFER_SCHEME, parseOffer, type PairingOffer } from '@riven/remote'
import { pair } from '@/lib/pairing'
import { C, R } from '@/lib/theme'

// Scan the computer's QR code (or arrive here from it: the system camera opens
// rivenremote://pair?o=…), ask to pair, and wait for the user to approve it on
// the computer.

type Step =
  | { k: 'scan' }
  | { k: 'sending' }
  | { k: 'waiting'; name: string }
  | { k: 'failed'; text: string }

export default function Pair(): JSX.Element {
  const params = useLocalSearchParams<{ o?: string }>()
  const [permission, requestPermission] = useCameraPermissions()
  const [step, setStep] = useState<Step>({ k: 'scan' })
  const busy = useRef(false)
  const cancelRef = useRef<() => void>(() => {})

  const start = (offer: PairingOffer): void => {
    if (busy.current) return
    busy.current = true
    setStep({ k: 'sending' })
    const p = pair(offer, () => setStep({ k: 'waiting', name: offer.name }))
    cancelRef.current = p.cancel
    void p.done.then((o) => {
      busy.current = false
      if (o.ok) router.replace({ pathname: '/c/[id]', params: { id: o.computer.id } })
      else
        setStep({
          k: 'failed',
          text:
            o.reason === 'denied'
              ? '컴퓨터에서 연결을 거절했어요.'
              : o.reason === 'relay'
                ? '중계 서버에 연결하지 못했어요. 인터넷 연결을 확인해 주세요.'
                : '시간 안에 승인되지 않았어요. 컴퓨터에서 QR을 새로 띄워 다시 시도해 주세요.'
        })
    })
  }

  // Opened from the QR by the system camera: the offer is already here.
  useEffect(() => {
    if (!params.o) return
    const offer = parseOffer(params.o)
    if (offer) start(offer)
    else setStep({ k: 'failed', text: '올바른 riven QR 코드가 아니에요.' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.o])

  useEffect(() => () => cancelRef.current(), [])

  if (step.k === 'sending' || step.k === 'waiting')
    return (
      <View style={s.center}>
        <ActivityIndicator color={C.accent} size="large" />
        <Text style={s.title}>{step.k === 'sending' ? '연결 요청 중…' : '컴퓨터에서 승인해 주세요'}</Text>
        {step.k === 'waiting' && (
          <Text style={s.text}>
            {step.name ? `${step.name}의 ` : ''}riven 화면에 뜬 "허용"을 누르면 연결돼요.
          </Text>
        )}
      </View>
    )

  if (step.k === 'failed')
    return (
      <View style={s.center}>
        <Text style={s.title}>연결하지 못했어요</Text>
        <Text style={s.text}>{step.text}</Text>
        <Pressable style={s.button} onPress={() => setStep({ k: 'scan' })}>
          <Text style={s.buttonText}>다시 찍기</Text>
        </Pressable>
      </View>
    )

  if (!permission) return <View style={s.screen} />
  if (!permission.granted)
    return (
      <View style={s.center}>
        <Text style={s.title}>카메라 권한이 필요해요</Text>
        <Text style={s.text}>컴퓨터에 뜬 QR 코드를 찍어 연결해요.</Text>
        <Pressable style={s.button} onPress={requestPermission}>
          <Text style={s.buttonText}>권한 허용</Text>
        </Pressable>
      </View>
    )

  return (
    <View style={s.screen}>
      <CameraView
        style={StyleSheet.absoluteFill}
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={({ data }) => {
          if (busy.current || !data.startsWith(OFFER_SCHEME)) return
          const offer = parseOffer(data)
          if (offer) start(offer)
        }}
      />
      <View style={s.hint}>
        <Text style={s.hintText}>riven 설정 › 원격 제어의 QR 코드를 비춰주세요</Text>
      </View>
    </View>
  )
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#000' },
  center: { flex: 1, backgroundColor: C.bg, alignItems: 'center', justifyContent: 'center', padding: 28, gap: 12 },
  title: { color: C.fg, fontSize: 18, fontWeight: '600', textAlign: 'center' },
  text: { color: C.dim, fontSize: 15, textAlign: 'center', lineHeight: 22 },
  button: { marginTop: 8, backgroundColor: C.accent, borderRadius: R, paddingVertical: 13, paddingHorizontal: 28 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  hint: { position: 'absolute', left: 20, right: 20, bottom: 48, backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: R, padding: 14 },
  hintText: { color: '#fff', textAlign: 'center', fontSize: 15 }
})
