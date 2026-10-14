import * as Device from 'expo-device'
import { Platform } from 'react-native'
import { newKeyPair, openWire, sealPair, sharedKey, deviceIdOf, type PairingOffer } from '@riven/remote'
import { closeChannel, joinChannel, openChannel } from './relay'
import { computerFrom, saveComputer, type Computer } from './computers'
import { url as relayUrl } from './supabase'

// Pair with a computer from its QR offer: make this phone's key pair for it,
// send the request boxed to the computer's key, and wait for the user to
// approve it on the computer. Nothing is stored unless they do.

export type PairOutcome =
  { ok: true; computer: Computer } | { ok: false; reason: 'denied' | 'timeout' | 'relay' | 'account' }

// Long enough for someone to walk back to the desk, short enough not to hang.
const WAIT_MS = 3 * 60_000

export function phoneName(): string {
  return Device.deviceName || Device.modelName || (Platform.OS === 'ios' ? 'iPhone' : 'Android')
}

/**
 * `me` is the account this phone is signed in as. A computer signed in as
 * someone else is refused here, before anything is sent: the relay would not
 * let this phone onto that computer's channel anyway.
 */
export function pair(
  offer: PairingOffer,
  me: string,
  onWaiting: () => void
): { done: Promise<PairOutcome>; cancel: () => void } {
  if (offer.owner !== me || offer.url !== relayUrl)
    return { done: Promise.resolve({ ok: false, reason: 'account' }), cancel: () => {} }
  const keys = newKeyPair()
  const deviceId = deviceIdOf(keys.publicKey)
  const shared = sharedKey(offer.desk, keys.secretKey)
  const ch = openChannel(offer.owner, offer.channel, `phone-${deviceId}`)
  if (!ch) return { done: Promise.resolve({ ok: false, reason: 'relay' }), cancel: () => {} }
  let finish: (o: PairOutcome) => void = () => {}
  let timer: ReturnType<typeof setTimeout> | undefined
  let over = false
  const done = new Promise<PairOutcome>((resolve) => {
    finish = (o) => {
      if (over) return
      over = true
      clearTimeout(timer)
      closeChannel(ch)
      resolve(o)
    }
  })

  ch.on('broadcast', { event: 'm' }, ({ payload }) => {
    if (!payload || payload.d !== deviceId) return
    const m = openWire(shared, payload)
    if (!m || m.from !== 'desk') return
    if (m.t === 'paired') {
      const computer = computerFrom(offer, keys, typeof m.name === 'string' ? m.name : '')
      void saveComputer(computer).then(() => finish({ ok: true, computer }))
    } else if (m.t === 'denied') finish({ ok: false, reason: 'denied' })
  })
  joinChannel(ch, (status) => {
    if (status === 'SUBSCRIBED') {
      void ch.send({
        type: 'broadcast',
        event: 'pair',
        payload: sealPair({ invite: offer.invite, name: phoneName(), platform: Platform.OS }, offer.desk, keys)
      })
      onWaiting()
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') finish({ ok: false, reason: 'relay' })
  })
  timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), WAIT_MS)
  return { done, cancel: () => finish({ ok: false, reason: 'timeout' }) }
}
