import 'react-native-url-polyfill/auto'
import nacl from 'tweetnacl'
import * as Crypto from 'expo-crypto'

// tweetnacl finds no Web Crypto in React Native, so it is given the system's
// secure random source explicitly. Without this every key and nonce call throws.
nacl.setPRNG((out: Uint8Array, n: number) => {
  const bytes = Crypto.getRandomValues(new Uint8Array(n))
  for (let i = 0; i < n; i++) out[i] = bytes[i]
})
