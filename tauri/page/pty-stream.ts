// The page end of the terminal stream (src-tauri/src/services/pty/stream.rs):
// a loopback WebSocket carrying each terminal's output, snapshots, exit, bell
// and title as binary frames, in order. Each frame becomes the ipc event the
// preload always delivered, so the renderer is unchanged.
//
// Frame: [kind u8][key len u16][key utf8][header][payload], little endian.
//   1 data      header rev f64, epoch u32                   payload utf8 text
//      -> pty:data:<key> {data: string, rev, epoch}
//   2 snapshot  header rev f64, epoch u32, cols u16, rows u16   payload snapshot bytes
//      -> pty:snapshot:<key> {data: Uint8Array, rev, epoch, cols, rows}
//   3 exit      header code i32                              -> pty:exit:<key> code
//   4 bell                                                   -> pty:bell {key}
//   5 title                                    payload utf8  -> pty:title {key, title}

type Invoke = (cmd: string, args?: unknown) => Promise<unknown>
type Deliver = (ch: string, args: unknown[]) => void

const dec = new TextDecoder()

function handle(buf: ArrayBuffer, deliver: Deliver): void {
  const dv = new DataView(buf)
  const kind = dv.getUint8(0)
  const klen = dv.getUint16(1, true)
  const key = dec.decode(new Uint8Array(buf, 3, klen))
  const o = 3 + klen
  switch (kind) {
    case 1:
      deliver(`pty:data:${key}`, [
        { data: dec.decode(new Uint8Array(buf, o + 12)), rev: dv.getFloat64(o, true), epoch: dv.getUint32(o + 8, true) }
      ])
      return
    case 2:
      deliver(`pty:snapshot:${key}`, [
        {
          data: new Uint8Array(buf, o + 16),
          rev: dv.getFloat64(o, true),
          epoch: dv.getUint32(o + 8, true),
          cols: dv.getUint16(o + 12, true),
          rows: dv.getUint16(o + 14, true)
        }
      ])
      return
    case 3:
      deliver(`pty:exit:${key}`, [dv.getInt32(o, true)])
      return
    case 4:
      deliver('pty:bell', [{ key }])
      return
    case 5:
      deliver('pty:title', [{ key, title: dec.decode(new Uint8Array(buf, o)) }])
      return
  }
}

let ready: Promise<void> | null = null

// Connected before the first pty:open goes out (the preload waits on it), so
// a new terminal's first bytes and a reattach's snapshot always have a line.
export function ptyStream(invoke: Invoke, label: string, deliver: Deliver): Promise<void> {
  if (ready) return ready
  ready = new Promise<void>((resolve) => {
    let delay = 250
    const open = (): void => {
      invoke('pty_stream')
        .then((v) => {
          const { port, token } = v as { port: number; token: string }
          const ws = new WebSocket(`ws://127.0.0.1:${port}/pty?t=${token}&w=${encodeURIComponent(label)}`)
          ws.binaryType = 'arraybuffer'
          ws.onopen = (): void => {
            delay = 250
            resolve()
          }
          ws.onmessage = (e): void => {
            try {
              handle(e.data as ArrayBuffer, deliver)
            } catch (err) {
              console.error('[pty] bad frame', err)
            }
          }
          // Not expected while the app runs; come back if it happens. A
          // reattach (pty:open) brings each terminal's snapshot.
          ws.onclose = (): void => {
            setTimeout(open, delay)
            delay = Math.min(delay * 2, 5000)
          }
        })
        .catch((e) => {
          console.error('[pty] stream unavailable', e)
          resolve() // terminals still open; they just stay blank
        })
    }
    open()
  })
  return ready
}
