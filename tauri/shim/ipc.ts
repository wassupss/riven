// ipcMain, kept in Electron's shape. The transport is the WebSocket in
// server.ts; handlers registered here are exactly the ones src/main registers.
import { EventEmitter } from 'events'
import type { WebContents } from './windows'

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

export interface IpcMainEvent {
  sender: WebContents
  returnValue: unknown
  reply: (channel: string, ...args: unknown[]) => void
  frameId: number
  processId: number
  preventDefault: () => void
}
export type IpcMainInvokeEvent = Omit<IpcMainEvent, 'returnValue' | 'reply'>

class IpcMain extends EventEmitter {
  private handlers = new Map<string, Handler>()

  constructor() {
    super()
    this.setMaxListeners(0)
  }

  handle(channel: string, fn: Handler): void {
    if (this.handlers.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`)
    this.handlers.set(channel, fn)
  }

  handleOnce(channel: string, fn: Handler): void {
    this.handle(channel, (e, ...a) => {
      this.handlers.delete(channel)
      return fn(e, ...a)
    })
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel)
  }

  // ---- used by server.ts ----

  async _invoke(sender: WebContents, channel: string, args: unknown[]): Promise<unknown> {
    const fn = this.handlers.get(channel)
    if (!fn) throw new Error(`No handler registered for '${channel}'`)
    return fn(baseEvent(sender), ...args)
  }

  _send(sender: WebContents, channel: string, args: unknown[]): IpcMainEvent {
    const ev: IpcMainEvent = {
      ...baseEvent(sender),
      returnValue: undefined,
      reply: (ch, ...a) => sender.send(ch, ...a)
    }
    this.emit(channel, ev, ...args)
    return ev
  }
}

function baseEvent(sender: WebContents): IpcMainInvokeEvent {
  return { sender, frameId: 1, processId: process.pid, preventDefault: () => {} }
}

export const ipcMain = new IpcMain()
