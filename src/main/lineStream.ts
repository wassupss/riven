import { createReadStream } from 'fs'

// Reading an append-only log (the CLI's .jsonl transcripts) line by line, from
// a byte offset, without holding the file in memory.
//
// Resolves to the offset just past the last COMPLETE line. A trailing line with
// no newline yet is still being written: it is not handed to `onLine`, and a
// caller that resumes from the returned offset will see it whole next time.

const NL = 0x0a

export function readLinesFrom(file: string, start: number, onLine: (line: string) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    let offset = start
    let carry: Buffer | null = null
    const stream = createReadStream(file, { start })
    stream.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      const data = carry ? Buffer.concat([carry, buf]) : buf
      let from = 0
      let nl: number
      // Splitting on the newline BYTE is safe in UTF-8: no multi-byte
      // character contains 0x0a.
      while ((nl = data.indexOf(NL, from)) >= 0) {
        onLine(data.toString('utf8', from, nl))
        from = nl + 1
      }
      offset += from - (carry?.length ?? 0)
      carry = from < data.length ? data.subarray(from) : null
    })
    stream.on('error', reject)
    stream.on('end', () => resolve(offset))
  })
}
