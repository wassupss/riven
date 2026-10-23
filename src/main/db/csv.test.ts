import { describe, expect, it } from 'vitest'
import { batchRows, columnNames, createTableForImport, CsvParser, detectDelimiter, guessType, insertSql, parseCsv, rowValues, stripBom } from './csv'

describe('CsvParser', () => {
  it('parses plain and quoted fields', () => {
    expect(parseCsv('a,b,c\n1,"x, y",3\n')).toEqual([
      ['a', 'b', 'c'],
      ['1', 'x, y', '3']
    ])
  })

  it('handles escaped quotes, newlines in quotes, CRLF and a missing final newline', () => {
    expect(parseCsv('"he said ""hi""","line1\r\nline2"\r\nlast,')).toEqual([
      ['he said "hi"', 'line1\r\nline2'],
      ['last', '']
    ])
  })

  it('keeps empty quoted fields and skips blank lines', () => {
    expect(parseCsv('a\n\n""\n\n,\n')).toEqual([['a'], [''], ['', '']])
  })

  it('gives the same records however the text is chunked', () => {
    const text = 'id;name;note\r\n1;"A ""q"" b";"x\ny"\r\n2;plain;\r3;"";z'
    const whole = parseCsv(text, ';')
    for (let size = 1; size <= 7; size++) {
      const p = new CsvParser(';')
      const out: string[][] = []
      for (let i = 0; i < text.length; i += size) out.push(...p.push(text.slice(i, i + size)))
      out.push(...p.end())
      expect(out).toEqual(whole)
    }
    expect(whole).toEqual([
      ['id', 'name', 'note'],
      ['1', 'A "q" b', 'x\ny'],
      ['2', 'plain', ''],
      ['3', '', 'z']
    ])
  })

  it('takes a quote mid-field literally', () => {
    expect(parseCsv('5" pipe,b')).toEqual([['5" pipe', 'b']])
  })
})

describe('detectDelimiter', () => {
  it('picks the consistent splitter', () => {
    expect(detectDelimiter('a;b;c\n1;2,5;3\n4;5;6\n')).toBe(';')
    expect(detectDelimiter('a\tb\n1\t2\n')).toBe('\t')
    expect(detectDelimiter('a,b,c\n1,2,3\n')).toBe(',')
    expect(detectDelimiter('a|b\n1|2\n3|4')).toBe('|')
  })
})

describe('guessType', () => {
  it('finds the narrowest type', () => {
    expect(guessType(['1', '-2', ''])).toBe('integer')
    expect(guessType(['1', '99999999999'])).toBe('bigint')
    expect(guessType(['01234'])).toBe('text')
    expect(guessType(['1.5', '2', '1e3'])).toBe('numeric')
    expect(guessType(['true', 'F'])).toBe('boolean')
    expect(guessType(['2024-01-02'])).toBe('date')
    expect(guessType(['2024-01-02 10:00', '2024-01-03'])).toBe('timestamp')
    expect(guessType(['2024-01-02T10:00:00Z', '2024-01-02 10:00:00+09'])).toBe('timestamptz')
    expect(guessType(['3f2504e0-4f89-11d3-9a0c-0305e82c3301'])).toBe('uuid')
    expect(guessType(['', ' '])).toBe('text')
    expect(guessType(['1', 'x'])).toBe('text')
  })
})

describe('import SQL', () => {
  it('names columns uniquely', () => {
    expect(columnNames(['id', ' ', 'ID', 'name'], 5)).toEqual(['id', 'column2', 'ID_2', 'name', 'column5'])
    expect(columnNames(null, 2)).toEqual(['column1', 'column2'])
  })

  it('builds CREATE TABLE and multi-row INSERT', () => {
    expect(
      createTableForImport({ schema: 'public', table: 'My T', columns: [{ name: 'id', source: 0, type: 'integer' }, { name: 'n', source: 1 }] })
    ).toBe('CREATE TABLE public."My T" (\n  id integer,\n  n text\n)')
    expect(insertSql('s', 't', ['a', 'b'], 2)).toBe('INSERT INTO s.t (a, b) VALUES ($1, $2), ($3, $4)')
  })

  it('maps record values with NULL rules', () => {
    expect(rowValues(['1', '', 'NULL'], [0, 1, 2, 5], true, 'NULL')).toEqual(['1', null, null, null])
    expect(rowValues(['1', ''], [1, 0], false)).toEqual(['', '1'])
  })

  it('keeps batches under the parameter limit', () => {
    expect(batchRows(3)).toBe(1000)
    expect(batchRows(100) * 100).toBeLessThanOrEqual(65535)
    expect(batchRows(2000)).toBe(15)
  })

  it('strips a BOM', () => {
    expect(stripBom('﻿a,b')).toBe('a,b')
  })
})
