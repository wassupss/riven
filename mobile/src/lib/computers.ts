import * as SecureStore from 'expo-secure-store'
import { deviceIdOf, type KeyPair, type PairingOffer } from '@riven/remote'

// The computers this phone is paired with. Each one is its own entry in the
// OS keystore (Keychain / Android Keystore): this phone's secret key for that
// computer is what lets it drive that computer's agents.

export interface Computer {
  id: string // derived from the computer's public key
  name: string
  channel: string
  desk: string // the computer's public key
  url: string
  anon: string
  keys: KeyPair // this phone's key pair for this computer
  deviceId: string
  pairedAt: number
}

const INDEX = 'riven.computers'
const entry = (id: string): string => `riven.c.${id}`
const OPTS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }

async function readIndex(): Promise<string[]> {
  try {
    const raw = await SecureStore.getItemAsync(INDEX, OPTS)
    const ids = raw ? JSON.parse(raw) : []
    return Array.isArray(ids) ? ids.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

export async function listComputers(): Promise<Computer[]> {
  const out: Computer[] = []
  for (const id of await readIndex()) {
    try {
      const raw = await SecureStore.getItemAsync(entry(id), OPTS)
      if (raw) out.push(JSON.parse(raw))
    } catch {
      /* skip an unreadable entry */
    }
  }
  return out.sort((a, b) => b.pairedAt - a.pairedAt)
}

export async function getComputer(id: string): Promise<Computer | null> {
  try {
    const raw = await SecureStore.getItemAsync(entry(id), OPTS)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export function computerFrom(offer: PairingOffer, keys: KeyPair, name: string): Computer {
  return {
    id: deviceIdOf(offer.desk),
    name: name || offer.name || 'riven',
    channel: offer.channel,
    desk: offer.desk,
    url: offer.url,
    anon: offer.anon,
    keys,
    deviceId: deviceIdOf(keys.publicKey),
    pairedAt: Date.now()
  }
}

export async function saveComputer(c: Computer): Promise<void> {
  await SecureStore.setItemAsync(entry(c.id), JSON.stringify(c), OPTS)
  const ids = await readIndex()
  if (!ids.includes(c.id)) await SecureStore.setItemAsync(INDEX, JSON.stringify([...ids, c.id]), OPTS)
}

export async function forgetComputer(id: string): Promise<void> {
  await SecureStore.deleteItemAsync(entry(id), OPTS)
  await SecureStore.setItemAsync(INDEX, JSON.stringify((await readIndex()).filter((x) => x !== id)), OPTS)
}
