import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, unlinkSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { RunJournal } from './run-journal.mjs'
import { applyFill, emptyLedger } from './inventory.mjs'

test('reopens an on-disk receipt and deduplicates overlapping pages of exchange history', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hip4-mm-receipt-'))
  const file = join(dir, 'test.sqlite')
  let journal = new RunJournal(file)
  try {
    const time = Date.now() - 5000
    const id = journal.begin({
      id: 3,
      label: 'Game',
      agent: 'test-agent',
      budget: 25,
      started: time,
      endsAt: time + 60000,
    })
    journal.record(id, [{ c: 'our-order', a: 100000030, b: true }])
    journal.acknowledge([{ c: 'our-order' }], { response: { data: { statuses: [{ resting: { oid: 123 } }] } } })
    journal.finish(id, 'Stopped', [])
    journal.db.close()
    journal = new RunJournal(file)
    const fill = { time, oid: 123, coin: '#30', tid: 1, side: 'B', sz: '1', px: '0.45', fee: '0', feeToken: 'USDC' }
    const unrelated = { time, oid: 777, coin: '#41', cloid: 'other' }
    const first = await journal.refresh(id, 'target', async () => [...Array(1999).fill(unrelated), fill])
    assert.match(first.warning, /continue/)
    const second = await journal.refresh(id, 'target', async (type, p) => {
      assert.equal(p.startTime, time)
      return [fill, { ...fill, tid: 2, time: time + 1 }]
    })
    assert.equal(second.warning, null)
    assert.equal(second.sides[0].shares, 2)
    assert.equal(second.fees[0].builder, 0)
    assert.deepEqual(second.endInventory, [])
  } finally {
    journal.db.close()
    unlinkSync(file)
    rmdirSync(dir)
  }
})

const fillRow = (o) => ({ tid: 1, oid: 5, coin: '#30', side: 'B', sz: '2', px: '0.45', fee: '0', feeToken: 'USDC', ...o })

function endedRun(journal, orders, ack) {
  const time = Date.now() - 5000
  const id = journal.begin({ id: 3, label: 'Game', agent: 'a', budget: 25, started: time, endsAt: time + 60000 })
  journal.record(id, orders)
  journal.acknowledge(orders, { response: { data: { statuses: ack } } })
  journal.finish(id, 'Stopped', [])
  return { id, time }
}

test('accepts a sell fill on an ask order and groups the receipt by coin and side', async () => {
  const journal = new RunJournal()
  const orders = [
    { c: 'bid', a: 100000030, b: true },
    { c: 'ask', a: 100000030, b: false },
  ]
  const { id, time } = endedRun(journal, orders, [{ resting: { oid: 5 } }, { resting: { oid: 6 } }])
  const receipt = await journal.refresh(id, 't', async () => [
    fillRow({ time }),
    fillRow({ time, tid: 2, oid: 6, side: 'A', sz: '1', px: '0.5' }),
  ])
  assert.deepEqual(
    receipt.sides.map((s) => [s.coin, s.side, s.shares, s.value]),
    [
      ['#30', 'A', 1, 0.5],
      ['#30', 'B', 2, 0.9],
    ]
  )
  assert.equal(receipt.markets, null)
  journal.db.close()
})

test('rejects a fill whose side does not match the order side', async () => {
  const journal = new RunJournal()
  const { id, time } = endedRun(journal, [{ c: 'ask', a: 100000030, b: false }], [{ resting: { oid: 6 } }])
  await assert.rejects(
    journal.refresh(id, 't', async () => [fillRow({ time, oid: 6, side: 'B' })]),
    /inconsistent execution details/
  )
  journal.db.close()
})

test('a multi-market run stores market 0 and its list', () => {
  const journal = new RunJournal()
  const id = journal.begin({ markets: [3, 4], label: 'Many', agent: 'a', budget: 25, started: 1, endsAt: 2 })
  assert.equal(journal.db.prepare('SELECT market FROM runs WHERE id=?').get(id).market, 0)
  journal.finish(id, 'Stopped', [])
  assert.deepEqual(journal.receipt(id).markets, [3, 4])
  assert.throws(() => journal.begin({ markets: [], label: 'x', agent: 'a', budget: 1, started: 1, endsAt: 2 }), /market list/)
  journal.db.close()
})

test('migrates an old-schema file and keeps its data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hip4-mm-old-'))
  const file = join(dir, 'old.sqlite')
  const old = new DatabaseSync(file)
  old.exec(`
    CREATE TABLE runs (
      id INTEGER PRIMARY KEY, market INTEGER NOT NULL, label TEXT NOT NULL, agent TEXT NOT NULL,
      budget REAL NOT NULL, started INTEGER NOT NULL, deadline INTEGER NOT NULL, ended INTEGER,
      result TEXT NOT NULL, checked INTEGER, warning TEXT, cursor INTEGER, endInventory TEXT
    );
    CREATE TABLE orders (cloid TEXT PRIMARY KEY, run INTEGER NOT NULL REFERENCES runs(id), coin TEXT NOT NULL, oid INTEGER);
    CREATE TABLE fills (
      cloid TEXT NOT NULL REFERENCES orders(cloid), tid INTEGER NOT NULL, oid INTEGER NOT NULL,
      time INTEGER NOT NULL, px TEXT NOT NULL, sz TEXT NOT NULL, fee TEXT NOT NULL,
      token TEXT NOT NULL, builderFee TEXT NOT NULL, PRIMARY KEY(cloid, tid)
    );
    INSERT INTO runs VALUES(1,3,'Old','a',25,1,2,3,'Stopped',NULL,NULL,NULL,'[]');
    INSERT INTO orders VALUES('o1',1,'#30',9);
    INSERT INTO fills VALUES('o1',1,9,2,'0.4','5','0','USDC','0');
  `)
  old.close()
  let journal
  try {
    journal = new RunJournal(file)
    const receipt = journal.receipt(1)
    assert.deepEqual(
      receipt.sides.map((s) => [s.coin, s.side, s.shares]),
      [['#30', '?', 5]]
    )
    assert.equal(receipt.markets, null)
    const id = journal.begin({ markets: [3], label: 'n', agent: 'a', budget: 1, started: 1, endsAt: 2 })
    journal.record(id, [{ c: 'n1', a: 100000030, b: false }])
    assert.equal(journal.db.prepare("SELECT side FROM orders WHERE cloid='n1'").get().side, 'A')
    assert.equal(journal.loadLedger(), null)
  } finally {
    journal?.db.close()
    unlinkSync(file)
    rmdirSync(dir)
  }
})

test('the ledger round-trips, survives reopening, and a damaged ledger throws instead of loading as none', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hip4-mm-ledger-'))
  const file = join(dir, 'l.sqlite')
  let journal = new RunJournal(file)
  try {
    assert.equal(journal.loadLedger(), null)
    const ledger = applyFill(emptyLedger(0), { cloid: 'c1', legId: '30', side: 'B', filledTotal: 4, px: 0.45, feeRate: 0, now: 0 })
    journal.saveLedger(ledger)
    journal.db.close()
    journal = new RunJournal(file)
    assert.deepEqual(journal.loadLedger(), ledger)
    assert.throws(() => journal.saveLedger({ positions: 1 }), /invalid ledger/)
    const bads = [
      'not json',
      '{}',
      JSON.stringify({ ...ledger, realizedUsd: 'x' }),
      JSON.stringify({ ...ledger, positions: { x: { shares: 1, cost: 1 } } }),
    ]
    bads.push(JSON.stringify({ ...ledger, positions: { 30: { shares: '100', cost: 1 } } }))
    for (const bad of bads) {
      journal.db.prepare('UPDATE ledger SET state=? WHERE id=1').run(bad)
      assert.throws(() => journal.loadLedger(), /damaged/, bad)
    }
    // Only a missing row means no ledger.
    journal.db.exec('DELETE FROM ledger')
    assert.equal(journal.loadLedger(), null)
  } finally {
    journal.db.close()
    unlinkSync(file)
    rmdirSync(dir)
  }
})

test('a pre-migration sell is not guessed as a buy: its side is learned from the fill and refresh does not throw', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hip4-mm-oldsell-'))
  const file = join(dir, 'old.sqlite')
  const old = new DatabaseSync(file)
  old.exec(`
    CREATE TABLE runs (
      id INTEGER PRIMARY KEY, market INTEGER NOT NULL, label TEXT NOT NULL, agent TEXT NOT NULL,
      budget REAL NOT NULL, started INTEGER NOT NULL, deadline INTEGER NOT NULL, ended INTEGER,
      result TEXT NOT NULL, checked INTEGER, warning TEXT, cursor INTEGER, endInventory TEXT
    );
    CREATE TABLE orders (cloid TEXT PRIMARY KEY, run INTEGER NOT NULL REFERENCES runs(id), coin TEXT NOT NULL, oid INTEGER);
    CREATE TABLE fills (
      cloid TEXT NOT NULL REFERENCES orders(cloid), tid INTEGER NOT NULL, oid INTEGER NOT NULL,
      time INTEGER NOT NULL, px TEXT NOT NULL, sz TEXT NOT NULL, fee TEXT NOT NULL,
      token TEXT NOT NULL, builderFee TEXT NOT NULL, PRIMARY KEY(cloid, tid)
    );
    INSERT INTO runs VALUES(1,3,'Old','a',25,1,2000,3000,'Stopped',NULL,NULL,NULL,'[]');
    INSERT INTO orders VALUES('s1',1,'#30',9);
  `)
  old.close()
  let journal
  try {
    journal = new RunJournal(file)
    assert.equal(journal.db.prepare("SELECT side FROM orders WHERE cloid='s1'").get().side, null)
    assert.doesNotThrow(() => journal.receipt(1))
    const fill = { time: 1500, oid: 9, coin: '#30', tid: 1, side: 'A', sz: '2', px: '0.6', fee: '0', feeToken: 'USDC', cloid: 's1' }
    const receipt = await journal.refresh(1, 'target', async () => [fill])
    assert.deepEqual(
      receipt.sides.map((s) => [s.coin, s.side, s.shares]),
      [['#30', 'A', 2]]
    )
    assert.equal(journal.db.prepare("SELECT side FROM orders WHERE cloid='s1'").get().side, 'A')
    // Once learned, a fill on the other side is refused again.
    await assert.rejects(journal.refresh(1, 'target', async () => [{ ...fill, tid: 2, side: 'B' }]), /inconsistent/)
  } finally {
    journal?.db.close()
    unlinkSync(file)
    rmdirSync(dir)
  }
})

test('a locked journal waits for the lock instead of failing at once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hip4-mm-busy-'))
  const file = join(dir, 'b.sqlite')
  const a = new RunJournal(file)
  const b = new RunJournal(file, { busyMs: 250 })
  const c = new RunJournal(file, { busyMs: 0 })
  try {
    assert.equal(a.db.prepare('PRAGMA busy_timeout').get().timeout, 5000)
    const ledger = emptyLedger(0)
    a.db.exec('BEGIN IMMEDIATE')
    let started = Date.now()
    assert.throws(() => b.saveLedger(ledger), /locked/)
    assert.ok(Date.now() - started >= 200, 'waited for the busy timeout')
    started = Date.now()
    assert.throws(() => c.saveLedger(ledger), /locked/)
    assert.ok(Date.now() - started < 200, 'no timeout fails at once')
    a.db.exec('ROLLBACK')
    assert.doesNotThrow(() => b.saveLedger(ledger))
  } finally {
    a.db.close()
    b.db.close()
    c.db.close()
    unlinkSync(file)
    rmdirSync(dir)
  }
})

test('a multi-market run may include market id 0', () => {
  const journal = new RunJournal()
  const t = Date.now()
  const id = journal.begin({ markets: [0, 4], label: 'Many', agent: 'a', budget: 25, started: t, endsAt: t + 1000 })
  assert.deepEqual(journal.receipt(id).markets, [0, 4])
  assert.throws(() => journal.begin({ markets: [-1], label: 'x', agent: 'a', budget: 1, started: t, endsAt: t + 1 }), /Invalid market list/)
  journal.db.close()
})

test('named state, day marks and rewards round-trip, and an estimate never replaces a paid reward', () => {
  const journal = new RunJournal()
  assert.equal(journal.loadState('exitSamples'), null)
  journal.saveState('exitSamples', { a: [1, 2] })
  journal.saveState('exitSamples', { a: [3] })
  assert.deepEqual(journal.loadState('exitSamples'), { a: [3] })
  journal.saveDayMarks('2026-11-20', { positions: { '#30': 4 }, marks: { '#30': 0.5 } })
  assert.deepEqual(journal.dayMarks('2026-11-20'), { positions: { '#30': 4 }, marks: { '#30': 0.5 } })
  assert.equal(journal.dayMarks('2026-11-19'), null)
  assert.throws(() => journal.saveDayMarks('today', { positions: {}, marks: {} }))
  assert.throws(() => journal.saveDayMarks('2026-11-20', { positions: { a: 'x' }, marks: {} }))
  journal.saveRewards([{ earningDay: '2026-11-20', usd: 4, status: 'paid' }])
  journal.saveRewards([{ earningDay: '2026-11-20', usd: 9, status: 'estimated' }])
  assert.throws(() => journal.saveRewards([{ earningDay: '2026-11-20', usd: 1, status: 'maybe' }]))
  const rows = journal.dailyRows()
  assert.equal(rows.length, 1)
  assert.deepEqual([rows[0].rewardUsd, rows[0].rewardStatus], [4, 'paid'])
  journal.db.close()
})

test('daily fills and rows come from recorded fills, with the day bounds inclusive', async () => {
  const journal = new RunJournal()
  const t = Date.parse('2026-11-20T10:00:00Z')
  const id = journal.begin({ id: 3, label: 'Game', agent: 'a', budget: 25, started: t, endsAt: t + 60000 })
  const orders = [
    { c: 'buy', a: 100000030, b: true },
    { c: 'sell', a: 100000030, b: false },
  ]
  journal.record(id, orders)
  journal.acknowledge(orders, { response: { data: { statuses: [{ resting: { oid: 1 } }, { resting: { oid: 2 } }] } } })
  journal.finish(id, 'Stopped', [])
  const rows = [
    { tid: 1, oid: 1, coin: '#30', side: 'B', sz: '10', px: '0.4', fee: '0.01', feeToken: 'USDC', builderFee: '0.001', time: t + 1000 },
    { tid: 2, oid: 2, coin: '#30', side: 'A', sz: '10', px: '0.5', fee: '0.02', feeToken: 'USDC', builderFee: '0', time: t + 2000 },
  ]
  await journal.refresh(id, 'target', async () => rows)
  const fills = journal.dailyFills('2026-11-20', '2026-11-20')
  assert.deepEqual(fills.map((f) => f.side), ['B', 'A'])
  assert.equal(journal.dailyFills('2026-11-21', '2026-11-22').length, 0)
  const [day] = journal.dailyRows()
  assert.equal(day.day, '2026-11-20')
  assert.equal(day.tradingUsd, 1)
  assert.ok(Math.abs(day.feesUsd - 0.031) < 1e-9)
  journal.db.close()
})
