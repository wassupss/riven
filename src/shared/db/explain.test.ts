import { describe, expect, it } from 'vitest'
import { explainSql, parsePlan, readOnlyStatement } from './explain'

const analyzed = JSON.stringify([
  {
    Plan: {
      'Node Type': 'Hash Join',
      'Join Type': 'Left',
      'Startup Cost': 1,
      'Total Cost': 100,
      'Plan Rows': 10,
      'Plan Width': 8,
      'Actual Total Time': 50,
      'Actual Rows': 5000,
      'Actual Loops': 1,
      'Hash Cond': '(o.user_id = u.id)',
      Plans: [
        {
          'Node Type': 'Seq Scan',
          'Relation Name': 'orders',
          Schema: 'public',
          Alias: 'o',
          'Startup Cost': 0,
          'Total Cost': 60,
          'Plan Rows': 20000,
          'Plan Width': 8,
          'Actual Total Time': 30,
          'Actual Rows': 20000,
          'Actual Loops': 1,
          Filter: '(total > 0)',
          'Rows Removed by Filter': 50000
        },
        {
          'Node Type': 'Hash',
          'Startup Cost': 0,
          'Total Cost': 20,
          'Plan Rows': 100,
          'Plan Width': 8,
          'Actual Total Time': 5,
          'Actual Rows': 100,
          'Actual Loops': 1,
          'Hash Batches': 4
        }
      ]
    },
    'Planning Time': 0.2,
    'Execution Time': 51
  }
])

describe('parsePlan', () => {
  it('builds the tree with labels, self time and warnings', () => {
    const p = parsePlan(analyzed)
    expect(p.analyze).toBe(true)
    expect(p.nodes).toBe(3)
    expect(p.executionMs).toBe(51)
    expect(p.root.label).toBe('Hash Left Join')
    expect(p.root.selfMs).toBe(15)
    expect(p.root.detail).toContain('Hash Cond: (o.user_id = u.id)')
    expect(p.root.warnings).toEqual(['underestimate:500'])
    const scan = p.root.children[0]
    expect(scan.label).toBe('Seq Scan on public.orders o')
    expect(scan.warnings).toEqual(['filterDiscard', 'seqScan'])
    expect(p.root.children[1].warnings).toEqual(['disk'])
    expect(p.maxSelf).toBe(30)
  })
  it('works without ANALYZE (cost only)', () => {
    const p = parsePlan(JSON.stringify([{ Plan: { 'Node Type': 'Nested Loop', 'Join Type': 'Anti', 'Total Cost': 10, 'Plan Rows': 1, Plans: [{ 'Node Type': 'Result', 'Total Cost': 4 }] } }]))
    expect(p.analyze).toBe(false)
    expect(p.root.label).toBe('Nested Loop Anti Join')
    expect(p.root.selfCost).toBe(6)
    expect(p.root.selfMs).toBeUndefined()
  })
  it('rejects other JSON', () => {
    expect(() => parsePlan('[1]')).toThrow()
  })
})

describe('explain helpers', () => {
  it('wraps the statement', () => {
    expect(explainSql('select 1;', { analyze: false })).toBe('EXPLAIN (FORMAT JSON) select 1')
    expect(explainSql('select 1', { analyze: true })).toBe('EXPLAIN (FORMAT JSON, ANALYZE, BUFFERS) select 1')
  })
  it('knows which statements are safe to ANALYZE', () => {
    expect(readOnlyStatement('-- c\nselect * from t')).toBe(true)
    expect(readOnlyStatement('with x as (select 1) select * from x')).toBe(true)
    expect(readOnlyStatement('with x as (delete from t returning *) select * from x')).toBe(false)
    expect(readOnlyStatement('select * from t for update')).toBe(false)
    expect(readOnlyStatement('update t set a = 1')).toBe(false)
  })
})
