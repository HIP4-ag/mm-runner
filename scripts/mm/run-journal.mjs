import { DatabaseSync } from 'node:sqlite'
import { isLedger } from './inventory.mjs'
import { dailyRows } from './daily-pnl.mjs'

const decimal = (s) => typeof s === 'string' && /^-?\d+(\.\d+)?$/.test(s) && Number.isFinite(Number(s))

// One file per testnet owner and target. Only public order and execution data belong here.
export class RunJournal {
  constructor(file = ':memory:', { busyMs = 5000 } = {}) {
    this.db = new DatabaseSync(file)
    // Wait for another connection's lock instead of failing at once with "database is locked".
    this.db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(Number(busyMs) || 0))};`)
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY, market INTEGER NOT NULL, label TEXT NOT NULL, agent TEXT NOT NULL,
        budget REAL NOT NULL, started INTEGER NOT NULL, deadline INTEGER NOT NULL, ended INTEGER,
        result TEXT NOT NULL, checked INTEGER, warning TEXT, cursor INTEGER, endInventory TEXT, markets TEXT
      );
      CREATE TABLE IF NOT EXISTS orders (
        cloid TEXT PRIMARY KEY, run INTEGER NOT NULL REFERENCES runs(id), coin TEXT NOT NULL, oid INTEGER,
        side TEXT NOT NULL DEFAULT 'B'
      );
      CREATE TABLE IF NOT EXISTS ledger (
        id INTEGER PRIMARY KEY CHECK(id=1), state TEXT NOT NULL, updated INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS orders_run ON orders(run);
      CREATE TABLE IF NOT EXISTS fills (
        cloid TEXT NOT NULL REFERENCES orders(cloid), tid INTEGER NOT NULL, oid INTEGER NOT NULL,
        time INTEGER NOT NULL, px TEXT NOT NULL, sz TEXT NOT NULL, fee TEXT NOT NULL,
        token TEXT NOT NULL, builderFee TEXT NOT NULL, PRIMARY KEY(cloid, tid)
      );
    `)
    // Additive tables for the daily view. Older files simply gain them.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS day_marks (
        day TEXT PRIMARY KEY, positions TEXT NOT NULL, marks TEXT NOT NULL, updated INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rewards (
        earningDay TEXT PRIMARY KEY, usd REAL NOT NULL, status TEXT NOT NULL, updated INTEGER NOT NULL
      );
    `)
    // Files written by older versions lack these columns. CREATE IF NOT EXISTS leaves them as they were.
    const columns = (table) => this.db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)
    // Old rows get NULL, not a guessed side: a fill refresh learns the real one from the exchange.
    if (!columns('orders').includes('side')) this.db.exec('ALTER TABLE orders ADD COLUMN side TEXT')
    if (!columns('runs').includes('markets')) this.db.exec('ALTER TABLE runs ADD COLUMN markets TEXT')
    // Fills come from two places. The engine books each fill it detects at once, with a negative tid built from the
    // order's filled total (see recordEngineFills). A receipt refresh later adds the exchange's own rows, with real
    // tids. Per order, the exchange rows are used once they cover what the engine booked; until then the engine's.
    // Nothing is counted twice either way.
    this.db.exec(`
      CREATE VIEW IF NOT EXISTS fills_effective AS
      WITH t AS (
        SELECT cloid,
          SUM(CASE WHEN tid >= 0 THEN CAST(sz AS REAL) ELSE 0 END) AS seen,
          SUM(CASE WHEN tid < 0 THEN CAST(sz AS REAL) ELSE 0 END) AS booked
        FROM fills GROUP BY cloid
      )
      SELECT f.* FROM fills f JOIN t ON t.cloid = f.cloid
      WHERE (f.tid >= 0 AND t.seen >= t.booked - 1e-9) OR (f.tid < 0 AND t.seen < t.booked - 1e-9);
    `)
    this.syncing = new Map()
  }
  // A multi-market run passes markets: number[]; its market column is 0.
  begin({ id, markets, label, agent, budget, started, endsAt }) {
    let list = null
    if (markets !== undefined && markets !== null) {
      if (!Array.isArray(markets) || !markets.length || !markets.every((m) => Number.isSafeInteger(m) && m >= 0))
        throw Error('Invalid market list.')
      list = JSON.stringify(markets)
    }
    return Number(
      this.db
        .prepare(
          `INSERT INTO runs(market,markets,label,agent,budget,started,deadline,result)
      VALUES(?,?,?,?,?,?,?,'Running')`
        )
        .run(list ? 0 : id, list, label, agent, budget, started, endsAt).lastInsertRowid
    )
  }
  // The position ledger survives restarts. Returns null only when no ledger row exists. A row that is not valid JSON
  // or not a valid ledger throws: starting fresh would reset the day's realized loss and drop pending orders.
  loadLedger() {
    const row = this.db.prepare('SELECT state FROM ledger WHERE id=1').get()
    if (!row) return null
    let ledger
    try {
      ledger = JSON.parse(row.state)
    } catch {
      throw Error('The saved position ledger is damaged. Check it before starting a run.')
    }
    if (!isLedger(ledger)) throw Error('The saved position ledger is damaged. Check it before starting a run.')
    return ledger
  }
  // Synchronous and committed on return. The engine calls it before any order that depends on the ledger.
  saveLedger(ledger) {
    if (!isLedger(ledger)) throw Error('Refusing to save an invalid ledger.')
    this.db
      .prepare(
        'INSERT INTO ledger(id,state,updated) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,updated=excluded.updated'
      )
      .run(JSON.stringify(ledger), Date.now())
  }
  // Small named values the engine keeps between ticks and restarts (for example the exit price samples).
  saveState(key, json) {
    if (typeof key !== 'string' || !key) throw Error('A state key is required.')
    this.db
      .prepare('INSERT INTO kv(key,value,updated) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated=excluded.updated')
      .run(key, JSON.stringify(json ?? null), Date.now())
  }
  loadState(key) {
    const row = this.db.prepare('SELECT value FROM kv WHERE key=?').get(key)
    if (!row) return null
    try {
      return JSON.parse(row.value)
    } catch {
      return null
    }
  }
  // End of a UTC day: shares held per coin and the price each was marked at.
  saveDayMarks(day, { positions, marks }) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw Error('A day must look like 2026-11-21.')
    const check = (obj, what) => {
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw Error(`${what} must be an object.`)
      for (const v of Object.values(obj)) if (!Number.isFinite(v)) throw Error(`${what} must hold numbers.`)
    }
    check(positions, 'Positions')
    check(marks, 'Marks')
    this.db
      .prepare('INSERT INTO day_marks(day,positions,marks,updated) VALUES(?,?,?,?) ON CONFLICT(day) DO UPDATE SET positions=excluded.positions,marks=excluded.marks,updated=excluded.updated')
      .run(day, JSON.stringify(positions), JSON.stringify(marks), Date.now())
  }
  dayMarks(day) {
    const row = this.db.prepare('SELECT positions,marks FROM day_marks WHERE day=?').get(day)
    return row ? { positions: JSON.parse(row.positions), marks: JSON.parse(row.marks) } : null
  }
  allDayMarks() {
    const out = {}
    for (const r of this.db.prepare('SELECT day,positions,marks FROM day_marks ORDER BY day').all())
      out[r.day] = { positions: JSON.parse(r.positions), marks: JSON.parse(r.marks) }
    return out
  }
  // Every fill on or between two UTC days, with its side. Old rows without a side count as buys, as in receipts.
  dailyFills(fromDay, toDay) {
    return this.db
      .prepare(
        `SELECT f.time AS time, o.coin AS coin, COALESCE(o.side,'B') AS side, CAST(f.px AS REAL) AS px, CAST(f.sz AS REAL) AS sz,
          CAST(f.fee AS REAL) AS fee, CAST(f.builderFee AS REAL) AS builderFee
         FROM fills_effective f JOIN orders o USING(cloid)
         WHERE date(f.time/1000,'unixepoch') >= ? AND date(f.time/1000,'unixepoch') <= ?
         ORDER BY f.time,f.tid`
      )
      .all(fromDay ?? '0000-01-01', toDay ?? '9999-12-31')
  }
  // Rewards booked to the UTC day they paid for. A paid figure is not replaced by an estimate.
  saveRewards(rows) {
    const put = this.db.prepare(
      `INSERT INTO rewards(earningDay,usd,status,updated) VALUES(?,?,?,?)
       ON CONFLICT(earningDay) DO UPDATE SET usd=excluded.usd,status=excluded.status,updated=excluded.updated
       WHERE NOT (rewards.status='paid' AND excluded.status<>'paid')`
    )
    for (const r of rows) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(r?.earningDay) || !Number.isFinite(r.usd) || !['estimated', 'paid'].includes(r.status))
        throw Error('A reward needs an earning day, an amount and a status of estimated or paid.')
    }
    this.db.exec('BEGIN')
    try {
      for (const r of rows) put.run(r.earningDay, r.usd, r.status, Date.now())
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }
  dailyRows() {
    const rewards = this.db.prepare('SELECT earningDay,usd,status FROM rewards').all()
    return dailyRows({ fills: this.dailyFills(), dayMarks: this.allDayMarks(), rewards })
  }
  /**
   * Fills the engine detected from its own order reads, booked at the moment it saw them: [{ cloid, filledTotal, sz,
   * px, oid, time, fee, builderFee }]. The key is (cloid, -filledTotal in millionths of a share), so the same fill seen
   * again after a restart is the same row and is skipped. Orders this journal never recorded are skipped too.
   */
  recordEngineFills(rows) {
    const text = (x) => {
      if (!Number.isFinite(x) || x < 0) throw Error('A fill needs finite, non-negative amounts.')
      return x.toFixed(10).replace(/\.?0+$/, '') || '0'
    }
    const checked = rows.map((r) => {
      const tid = -Math.round(Number(r.filledTotal) * 1e6)
      if (typeof r?.cloid !== 'string' || !r.cloid || !(tid < 0) || !Number.isSafeInteger(tid)) throw Error('Invalid fill.')
      if (!(r.sz > 0) || !(r.px > 0 && r.px < 1) || !Number.isSafeInteger(r.time) || !Number.isSafeInteger(r.oid))
        throw Error('Invalid fill.')
      return [r.cloid, tid, r.oid, r.time, text(r.px), text(r.sz), text(r.fee), 'USDC', text(r.builderFee), r.cloid]
    })
    const insert = this.db.prepare(
      `INSERT INTO fills(cloid,tid,oid,time,px,sz,fee,token,builderFee)
       SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM orders WHERE cloid=?)
       ON CONFLICT(cloid,tid) DO NOTHING`
    )
    this.db.exec('BEGIN')
    try {
      for (const row of checked) insert.run(...row)
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }
  record(id, orders) {
    const insert = this.db.prepare('INSERT INTO orders(cloid,run,coin,side) VALUES(?,?,?,?)')
    this.db.exec('BEGIN')
    try {
      for (const o of orders) insert.run(o.c, id, '#' + (o.a - 100000000), o.b ? 'B' : 'A')
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }
  acknowledge(orders, result) {
    const statuses = result?.response?.data?.statuses
    if (!Array.isArray(statuses) || statuses.length !== orders.length) return
    const update = this.db.prepare('UPDATE orders SET oid=? WHERE cloid=?')
    statuses.forEach((status, i) => {
      const oid = status?.resting?.oid ?? status?.filled?.oid
      if (Number.isSafeInteger(oid)) update.run(oid, orders[i].c)
    })
  }
  finish(id, result, balances = null) {
    this.db
      .prepare('UPDATE runs SET ended=?,result=?,endInventory=? WHERE id=?')
      .run(
        Date.now(),
        result,
        balances === null ? null : JSON.stringify(balances.map(({ coin, total }) => ({ coin, total }))),
        id
      )
  }
  interrupted() {
    this.db
      .prepare("UPDATE runs SET ended=?, result='Runner restarted. Check resting orders.' WHERE ended IS NULL")
      .run(Date.now())
    return this.db.prepare('SELECT id FROM runs WHERE endInventory IS NULL ORDER BY id DESC LIMIT 1').get()?.id
  }
  list(before) {
    return this.db
      .prepare('SELECT id,label,started,result FROM runs WHERE id < ? ORDER BY id DESC LIMIT 20')
      .all(before ?? Number.MAX_SAFE_INTEGER)
  }
  receipt(id) {
    const run = this.db.prepare('SELECT * FROM runs WHERE id=?').get(id)
    if (!run) throw Error('Unknown run on this device.')
    const from = ' FROM fills_effective f JOIN orders o USING(cloid) WHERE o.run=?'
    const sides = this.db
      .prepare(
        "SELECT coin,COALESCE(o.side,'?') AS side,COUNT(*) AS fills,SUM(CAST(sz AS REAL)) AS shares,SUM(CAST(px AS REAL)*CAST(sz AS REAL)) AS value" +
          from +
          " GROUP BY coin,COALESCE(o.side,'?') ORDER BY coin,COALESCE(o.side,'?')"
      )
      .all(id)
    const fees = this.db
      .prepare(
        'SELECT token,SUM(CAST(fee AS REAL)) AS total,SUM(CAST(builderFee AS REAL)) AS builder' +
          from +
          ' GROUP BY token'
      )
      .all(id)
    const fills = this.db
      .prepare('SELECT coin,f.oid,tid,time,px,sz,fee,token,builderFee' + from + ' ORDER BY time DESC,tid DESC LIMIT 50')
      .all(id)
    return {
      ...run,
      markets: run.markets ? JSON.parse(run.markets) : null,
      endInventory: JSON.parse(run.endInventory),
      sides,
      fees,
      fills,
    }
  }
  refresh(id, target, info) {
    if (!this.syncing.has(id)) {
      const job = this.collect(id, target, info).finally(() => this.syncing.delete(id))
      this.syncing.set(id, job)
    }
    return this.syncing.get(id)
  }
  async collect(id, target, info) {
    const run = this.db.prepare('SELECT * FROM runs WHERE id=?').get(id)
    if (!run) throw Error('Unknown run on this device.')
    if (!run.ended) throw Error('Fill receipts can be refreshed after the session stops.')
    const orders = this.db.prepare('SELECT * FROM orders WHERE run=?').all(id)
    const byClient = new Map(orders.map((o) => [o.cloid, o]))
    const byVenue = new Map(orders.filter((o) => o.oid !== null).map((o) => [o.oid, o]))
    const checked = Date.now()
    // Include fills after a lost cancel acknowledgement, through the last possible venue deadline.
    const endTime = Math.min(checked, Math.min(run.ended, run.deadline) + 60000)
    const startTime = run.cursor ?? Math.max(0, run.started - 60000)
    const rows = orders.length
      ? await info('userFillsByTime', {
          user: target,
          startTime,
          endTime,
          aggregateByTime: false,
        })
      : []
    if (!Array.isArray(rows) || rows.length > 2000) throw Error('Incomplete fill response from testnet.')
    const insert = this.db.prepare('INSERT INTO fills VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(cloid,tid) DO NOTHING')
    const unresolvedCoins = new Set()
    let unknown = false
    // Resolve our recorded submissions, even if the process lost their acknowledgements.
    // Looking up account-wide trades individually wastes reads on unrelated orders.
    const needsLookup = new Set(rows.filter((f) => !f.cloid && !byVenue.has(f.oid)).map((f) => f.coin))
    const missing = orders.filter((o) => o.oid === null && needsLookup.has(o.coin))
    for (const order of missing.slice(0, 6)) {
      const detail = (await info('orderStatus', { user: target, oid: order.cloid }))?.order?.order
      if (detail?.cloid === order.cloid && detail.coin === order.coin && Number.isSafeInteger(detail.oid)) {
        this.db.prepare('UPDATE orders SET oid=? WHERE cloid=?').run(detail.oid, order.cloid)
        order.oid = detail.oid
        byVenue.set(detail.oid, order)
      } else {
        unresolvedCoins.add(order.coin)
      }
    }
    for (const o of missing.slice(6)) unresolvedCoins.add(o.coin)
    const matched = []
    for (const f of rows) {
      if (!Number.isSafeInteger(f.time) || f.time < startTime || f.time > endTime)
        throw Error('Invalid fill timestamp from testnet.')
      const order = f.cloid ? byClient.get(f.cloid) : byVenue.get(f.oid)
      if (!order && !f.cloid && unresolvedCoins.has(f.coin)) unknown = true
      if (!order) continue
      if (
        f.coin !== order.coin ||
        (order.side != null && f.side !== order.side) ||
        (f.side !== 'B' && f.side !== 'A') ||
        !Number.isSafeInteger(f.tid) ||
        !Number.isSafeInteger(f.oid) ||
        (order.oid !== null && order.oid !== f.oid) ||
        !decimal(f.sz) ||
        Number(f.sz) <= 0 ||
        !decimal(f.px) ||
        !(Number(f.px) > 0 && Number(f.px) < 1) ||
        !decimal(f.fee) ||
        !decimal(f.builderFee ?? '0') ||
        typeof f.feeToken !== 'string' ||
        !f.feeToken.trim()
      )
        throw Error('Testnet returned inconsistent execution details. Saved fills are preserved.')
      order.oid = f.oid
      order.side = f.side
      byVenue.set(f.oid, order)
      matched.push([order.cloid, f.tid, f.oid, f.time, f.px, f.sz, f.fee, f.feeToken.trim(), f.builderFee ?? '0'])
    }
    let cursor = run.cursor
    let warning = unknown ? 'Some fills could not be attributed. Refresh to retry.' : null
    if (rows.length === 2000 && !unknown) {
      const last = Math.max(...rows.map((f) => f.time))
      warning =
        last > startTime
          ? 'More exchange fills are available. Refresh to continue.'
          : 'Exchange history limit reached at one timestamp. Totals may be partial.'
      cursor = last
    }
    this.db.exec('BEGIN')
    try {
      const update = this.db.prepare('UPDATE orders SET oid=? WHERE cloid=?')
      const learn = this.db.prepare('UPDATE orders SET side=? WHERE cloid=? AND side IS NULL')
      for (const record of matched) {
        insert.run(...record)
        update.run(record[2], record[0])
        learn.run(byClient.get(record[0]).side, record[0])
      }
      this.db.prepare('UPDATE runs SET checked=?,warning=?,cursor=? WHERE id=?').run(checked, warning, cursor, id)
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
    return this.receipt(id)
  }
}
