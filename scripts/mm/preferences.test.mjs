import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  boundsFor,
  defaultPreferences,
  fileKeys,
  loadPreferences,
  preferencesFileIn,
  preferencesView,
  riskStatementVersion,
  savePreferences,
  schema,
  startCheck,
  validatePreferences,
} from './preferences.mjs'
import { loadPolicy } from './policy/index.mjs'

const policy = loadPolicy()
const strict = (input) => validatePreferences(input, { policy, strict: true })
const lenient = (input) => validatePreferences(input, { policy, strict: false })
const families = ['nba', 'nfl', 'soccer', 'esports', 'other']

test('the defaults are the neutral ones from the shared contract', () => {
  const { prefs, warnings } = lenient({})
  assert.deepEqual(warnings, [])
  assert.deepEqual(prefs, {
    version: 2,
    budgetUsd: 200,
    perSideUsd: 30,
    maxHeldPerLegUsd: 30,
    markets: 2,
    depthPct: 30,
    bidStopHours: { nba: 3, nfl: 3, soccer: 3, esports: 3, other: 3 },
    requoteSeconds: 120,
    hours: null,
    families: { nba: true, nfl: true, soccer: true, esports: true, other: true },
    familyWeights: { nba: 1, nfl: 1, soccer: 1, esports: 1, other: 1 },
    rankWeights: { pool: 1, start: 1, spread: 1 },
    pick: 'manual',
    manualMarkets: [],
    excludeMarkets: [],
    dailyLossStopUsd: 20,
    hourlyLossStopUsd: 8,
    pullMovePct: 50,
    calmSeconds: 60,
    acknowledged: null,
  })
  assert.deepEqual(strict(prefs).prefs, prefs)
  assert.deepEqual(defaultPreferences(policy), prefs)
  // Dependent defaults follow the user's own numbers.
  const big = lenient({ budgetUsd: 1000, perSideUsd: 60 }).prefs
  assert.equal(big.maxHeldPerLegUsd, 60)
  assert.equal(big.dailyLossStopUsd, 100)
  assert.equal(big.hourlyLossStopUsd, 40)
})

test('the schema rows carry every range from the policy, grouped for the page', () => {
  assert.ok(Array.isArray(schema))
  const keys = schema.map((row) => row.key)
  assert.deepEqual([...keys, 'version', 'acknowledged'].sort(), [...fileKeys].sort())
  for (const row of schema) {
    assert.ok(['sizing', 'depth', 'timing', 'markets', 'loss', 'pull'].includes(row.group), row.key)
    assert.ok('min' in row && 'max' in row && 'default' in row && 'type' in row, row.key)
  }
  const by = Object.fromEntries(schema.map((row) => [row.key, row]))
  assert.deepEqual([by.budgetUsd.min, by.budgetUsd.max, by.budgetUsd.default], [50, 10000, 200])
  assert.deepEqual([by.perSideUsd.min, by.perSideUsd.max, by.perSideUsd.default], [27, 250, 30])
  assert.deepEqual([by.familyWeights.min, by.familyWeights.max, by.familyWeights.default], [0, 3, 1])
  assert.deepEqual([by.rankWeights.min, by.rankWeights.max, by.rankWeights.default], [0, 3, 1])
  assert.equal(by.excludeMarkets.max, 20)
  assert.deepEqual([by.markets.min, by.markets.max, by.markets.default], [1, 6, 2])
  assert.deepEqual([by.depthPct.min, by.depthPct.max, by.depthPct.default], [15, 60, 30])
  assert.deepEqual(by.bidStopHours.min, { nba: 1 / 3, nfl: 1 / 3, soccer: 1, esports: 1, other: 1 / 3 })
  assert.equal(by.bidStopHours.max, 168)
  assert.deepEqual(by.dailyLossStopUsd.maxFrom, { key: 'budgetUsd', share: 0.25 })
  assert.deepEqual(by.hourlyLossStopUsd.maxFrom, { key: 'dailyLossStopUsd', share: 1 })
  assert.deepEqual(by.maxHeldPerLegUsd.maxFrom, { key: 'perSideUsd', share: 1 })
  assert.deepEqual([by.pullMovePct.min, by.pullMovePct.max, by.calmSeconds.min, by.requoteSeconds.min], [25, 100, 60, 60])
  assert.deepEqual(by.pick.values, ['auto', 'manual'])
  assert.equal(by.manualMarkets.max, 6)
})

test('strict mode rejects an unknown key, a wrong type and an out-of-range value, naming it', () => {
  const bad = {
    nope: 1,
    budgetUsd: [20000, 49, '100'],
    perSideUsd: [26, 251],
    maxHeldPerLegUsd: [35, 5],
    familyWeights: [{ golf: 1 }, { nba: 4 }, { nfl: -1 }, 'all'],
    rankWeights: [{ alpha: 1 }, { pool: 4 }, { start: -0.5 }, 'all'],
    excludeMarkets: ['701', [-1]],
    markets: [0, 7, 2.5],
    depthPct: [10, 61],
    requoteSeconds: [59, 3601, 90.5],
    dailyLossStopUsd: [0.5, 51],
    hourlyLossStopUsd: [21],
    pullMovePct: [24, 101],
    calmSeconds: [59, 61.5],
    pick: ['best'],
    manualMarkets: ['701', [1, 2, 3, 4, 5, 6, 7], 'all', [-1]],
    families: [{ golf: true }, { nba: 'yes' }, 'all', { futures: true }],
    bidStopHours: [{ nba: 0.2 }, { soccer: 0.5 }, { esports: 169 }, { golf: 3 }, { nba: '3' }, 3],
    acknowledged: [{ version: 'risk-1' }, { version: 'risk-1', at: 'yesterday' }, { version: '', at: 1 }, 'yes', { version: 'risk-1', at: 1, by: 'x' }],
    risk: ['cautious'],
    perMarketCapUsd: [50],
  }
  for (const [key, values] of Object.entries(bad)) {
    for (const value of Array.isArray(values) ? values : [values])
      assert.throws(() => strict({ [key]: value }), new RegExp(key), `${key} ${JSON.stringify(value)}`)
  }
  assert.throws(() => strict([]), /object/)
  assert.throws(() => strict({ version: 1 }), /version/)
  for (const hours of [{ from: '25:00', to: '06:00' }, { from: '09:00', to: '09:00' }, { from: '9:00', to: '10:00' }, { from: '09:00' }, { from: '09:00', to: '10:00', extra: 1 }, 'always', { from: ['09:00'], to: '17:00' }])
    assert.throws(() => strict({ hours }), /hours/, JSON.stringify(hours))
  const ok = strict({
    budgetUsd: 1000,
    perSideUsd: 100,
    maxHeldPerLegUsd: 60,
    markets: 4,
    depthPct: 45,
    bidStopHours: { nba: 72, soccer: 1, nfl: 1 / 3 },
    requoteSeconds: 600,
    hours: { from: '22:00', to: '06:00' },
    families: { soccer: false },
    pick: 'auto',
    manualMarkets: [701, 702, 701],
    dailyLossStopUsd: 250,
    hourlyLossStopUsd: 250,
    pullMovePct: 25,
    calmSeconds: 3600,
    acknowledged: { version: 'risk-1', at: Date.UTC(2026, 10, 21) },
  }).prefs
  assert.equal(ok.bidStopHours.nba, 72)
  assert.equal(ok.bidStopHours.other, 3)
  assert.equal(ok.families.soccer, false)
  assert.deepEqual(ok.manualMarkets, [701, 702])
  assert.deepEqual(ok.acknowledged, { version: 'risk-1', at: '2026-11-21T00:00:00.000Z' })
})

test('lenient mode clamps numbers, resets a bad choice and drops unknown keys, warning for each', () => {
  const clamped = lenient({ budgetUsd: 20000, markets: 50, perSideUsd: 1000, depthPct: 5, dailyLossStopUsd: 99999, requoteSeconds: 1 })
  assert.equal(clamped.prefs.budgetUsd, 10000)
  assert.equal(clamped.prefs.markets, 6)
  assert.equal(clamped.prefs.perSideUsd, 250)
  assert.equal(clamped.prefs.maxHeldPerLegUsd, 250)
  assert.equal(clamped.prefs.depthPct, 15)
  assert.equal(clamped.prefs.dailyLossStopUsd, 2500)
  assert.equal(clamped.prefs.requoteSeconds, 60)
  assert.ok(clamped.warnings.length >= 6)
  const reset = lenient({
    pick: 'best',
    families: { nba: 'lots', nfl: false, golf: true },
    hours: { from: '1', to: '2' },
    bidStopHours: { soccer: 0.1, golf: 4 },
    manualMarkets: [701, 'x', 702, 703, 704, 705, 706, 707],
    acknowledged: { version: 'risk-1' },
    secret: 'x',
  })
  assert.equal(reset.prefs.pick, 'manual')
  assert.equal(reset.prefs.families.nba, true)
  assert.equal(reset.prefs.families.nfl, false)
  assert.equal('golf' in reset.prefs.families, false)
  assert.equal(reset.prefs.hours, null)
  assert.equal(reset.prefs.bidStopHours.soccer, 1)
  assert.deepEqual(reset.prefs.manualMarkets, [701, 702, 703, 704, 705, 706])
  assert.equal(reset.prefs.acknowledged, null)
  assert.equal('secret' in reset.prefs, false)
  assert.ok(reset.warnings.length >= 9)
})

test('a smaller budget tightens the loss stops, so a hand-edited file cannot widen them', () => {
  const edited = lenient({ budgetUsd: 100, dailyLossStopUsd: 500, hourlyLossStopUsd: 400, maxHeldPerLegUsd: 200, perSideUsd: 28 })
  assert.equal(edited.prefs.dailyLossStopUsd, 25)
  assert.equal(edited.prefs.hourlyLossStopUsd, 25)
  assert.equal(edited.prefs.maxHeldPerLegUsd, 28)
  assert.ok(edited.warnings.length >= 3)
  // Size across every market beyond the budget is allowed but warned about; the policy limits it.
  const wide = strict({ budgetUsd: 100, perSideUsd: 50, markets: 2 })
  assert.match(wide.warnings.join(' '), /perSideUsd/)
  assert.equal(policy.settingsFor(wide.prefs).perSideUsd, 25)
})

test('a v1 file keeps its budget and markets and defaults the rest, with a warning', () => {
  const v1 = {
    version: 1,
    budgetUsd: 600,
    perMarketCapUsd: 120,
    markets: 3,
    risk: 'active',
    families: { nba: 'exclude', soccer: 'more', futures: 'normal' },
    dailyLossStopUsd: 15,
    hours: { from: '08:00', to: '23:30' },
  }
  const { prefs, warnings } = lenient(v1)
  assert.equal(prefs.version, 2)
  assert.equal(prefs.budgetUsd, 600)
  assert.equal(prefs.markets, 3)
  assert.deepEqual(prefs, { ...defaultPreferences(policy), budgetUsd: 600, markets: 3, dailyLossStopUsd: 60, hourlyLossStopUsd: 24 })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /older version/)
  // An old small budget is clamped up to the new minimum, with a warning.
  const small = lenient({ version: 1, budgetUsd: 25, markets: 12 })
  assert.equal(small.prefs.budgetUsd, 50)
  assert.equal(small.prefs.markets, 6)
  // The migration, the two clamps, and $25 a side across 6 markets now being over the budget.
  assert.equal(small.warnings.length, 4)
})

test('a start needs the current risk statement acknowledged', () => {
  assert.equal(startCheck(defaultPreferences(policy)).ok, false)
  assert.equal(startCheck(defaultPreferences(policy)).code, 'acknowledgement')
  const ack = strict({ acknowledged: { version: riskStatementVersion, at: '2026-11-21T12:00:00Z' } }).prefs
  assert.deepEqual(startCheck(ack), { ok: true })
  assert.equal(startCheck(ack, { version: 'risk-2' }).ok, false)
  assert.equal(startCheck(undefined).ok, false)
})

test('bounds resolve every dependent range for one set of choices', () => {
  const b = boundsFor(policy, { budgetUsd: 400, perSideUsd: 40, dailyLossStopUsd: 30 })
  assert.deepEqual(b.maxHeldPerLegUsd, { min: 10, max: 40 })
  assert.deepEqual(b.dailyLossStopUsd, { min: 1, max: 100 })
  assert.deepEqual(b.hourlyLossStopUsd, { min: 1, max: 30 })
  assert.deepEqual(b.markets, { min: 1, max: 6 })
  assert.equal(b.bidStopHours.min.soccer, 1)
  // A budget alone still works, for older callers.
  assert.deepEqual(boundsFor(policy, 200).dailyLossStopUsd, { min: 1, max: 50 })
  const view = preferencesView(lenient({}), policy)
  assert.deepEqual(Object.keys(view).sort(), ['bounds', 'prefs', 'schema', 'warnings'])
  assert.equal(view.schema.length, schema.length)
})

test('the preferences file lives in the state dir', () => {
  assert.equal(preferencesFileIn(join('x', 'state')), join('x', 'state', 'preferences.json'))
})

test('a missing file gives the defaults, a damaged one the defaults with a warning', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mm-prefs-'))
  const missing = loadPreferences(preferencesFileIn(join(dir, 'none')), policy)
  assert.deepEqual(missing.prefs, defaultPreferences(policy))
  assert.deepEqual(missing.warnings, [])
  const file = join(dir, 'bad.json')
  writeFileSync(file, '{not json')
  const damaged = loadPreferences(file, policy)
  assert.deepEqual(damaged.prefs, defaultPreferences(policy))
  assert.equal(damaged.warnings.length, 1)
})

test('the saved file holds only schema keys, is atomic and owner-only, and round-trips', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mm-prefs-'))
  const file = preferencesFileIn(join(dir, 'sub'))
  const wanted = { budgetUsd: 600, depthPct: 40, markets: 2, families: { nfl: false }, hours: { from: '08:00', to: '23:30' }, bidStopHours: { soccer: 12 } }
  const saved = savePreferences(file, wanted, policy)
  const onDisk = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual(Object.keys(onDisk).sort(), [...fileKeys].sort())
  assert.deepEqual(onDisk, saved.prefs)
  assert.deepEqual(readdirSync(join(dir, 'sub')), ['preferences.json'])
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.deepEqual(loadPreferences(file, policy).prefs, saved.prefs)
  assert.throws(() => savePreferences(file, { ...wanted, extra: 1 }, policy), /extra/)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), saved.prefs)
  writeFileSync(file, JSON.stringify({ ...onDisk, extra: 1, dailyLossStopUsd: 10000 }))
  const reread = loadPreferences(file, policy)
  assert.equal(reread.prefs.dailyLossStopUsd, 150)
  assert.equal('extra' in reread.prefs, false)
})

test('a failed rename leaves no temp file behind and the error reaches the caller', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hip4-mm-prefs-rename-'))
  const file = join(dir, 'preferences.json')
  mkdirSync(file)
  assert.throws(() => savePreferences(file, { budgetUsd: 100 }, policy))
  assert.deepEqual(readdirSync(dir), ['preferences.json'])
})

test('every family is a user choice: none is preferred by default', () => {
  const prefs = defaultPreferences(policy)
  assert.deepEqual(new Set(families.map((f) => prefs.bidStopHours[f])), new Set([3]))
  assert.ok(families.every((f) => prefs.families[f] === true))
})
