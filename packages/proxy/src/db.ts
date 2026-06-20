import { Database } from 'bun:sqlite'

export function openDb(path: string = process.env.DB_PATH ?? './latchkey.db'): Database {
  const db = new Database(path, { create: true })
  db.run('PRAGMA journal_mode = WAL')

  // Migrate from old single-table schema (providers had hf_repo_id column)
  const hasOldSchema = db
    .query<{ count: number }, []>(
      `SELECT COUNT(*) as count FROM pragma_table_info('providers') WHERE name = 'hf_repo_id'`,
    )
    .get()
  if (hasOldSchema && hasOldSchema.count > 0) {
    db.run('DROP TABLE IF EXISTS billing_log')
    db.run('DROP TABLE IF EXISTS providers')
  }

  // Phase 2 migration: prices/costs are now dollars (REAL), not USDC micro-units (INTEGER).
  // listings is fully regenerable (re-seeded + re-discovered on startup) → drop & recreate.
  // billing_log carries token history the dashboard charts → preserve via column rename.
  const listingsHasOldPrice = db
    .query<{ count: number }, []>(
      `SELECT COUNT(*) as count FROM pragma_table_info('listings') WHERE name = 'price_input'`,
    )
    .get()
  if (listingsHasOldPrice && listingsHasOldPrice.count > 0) {
    db.run('DROP TABLE IF EXISTS listings')
  }
  const billingHasOldCost = db
    .query<{ count: number }, []>(
      `SELECT COUNT(*) as count FROM pragma_table_info('billing_log') WHERE name = 'cost_usdc'`,
    )
    .get()
  if (billingHasOldCost && billingHasOldCost.count > 0) {
    db.run('ALTER TABLE billing_log RENAME COLUMN cost_usdc TO cost_usd')
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS providers (
      id     TEXT PRIMARY KEY,
      name   TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS listings (
      id                TEXT PRIMARY KEY,
      provider_id       TEXT NOT NULL REFERENCES providers(id),
      model_id          TEXT,
      model_prefix      TEXT,
      upstream_format   TEXT NOT NULL DEFAULT 'openai' CHECK(upstream_format IN ('openai', 'anthropic')),
      endpoint          TEXT NOT NULL,
      api_key           TEXT,
      provider_model_id TEXT,
      price_input_usd_per_million   REAL NOT NULL,
      price_output_usd_per_million  REAL NOT NULL,
      ctx_length        INTEGER,
      reliability       REAL NOT NULL DEFAULT 1.0,
      active            INTEGER NOT NULL DEFAULT 1,
      CHECK (model_id IS NOT NULL OR model_prefix IS NOT NULL)
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS billing_log (
      id             TEXT PRIMARY KEY,
      caller_address TEXT NOT NULL,
      listing_id     TEXT NOT NULL,
      model_id       TEXT NOT NULL,
      input_tokens   INTEGER NOT NULL,
      output_tokens  INTEGER NOT NULL,
      cost_usd       REAL NOT NULL,
      created_at     INTEGER NOT NULL
    )
  `)

  // Phase 3: zkTLS proof queue — jobs enqueued after each request, processed async
  // Status: 'pending' | 'submitted' | 'verified' | 'failed'
  db.run(`
    CREATE TABLE IF NOT EXISTS tls_proof_queue (
      id              TEXT PRIMARY KEY,
      billing_log_id  TEXT NOT NULL,
      caller_address  TEXT NOT NULL,
      provider_host   TEXT NOT NULL,
      input_tokens    INTEGER NOT NULL,
      output_tokens   INTEGER NOT NULL,
      status          TEXT NOT NULL DEFAULT 'pending',
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    )
  `)

  // Phase 4: model fingerprints recorded at provider onboarding
  db.run(`
    CREATE TABLE IF NOT EXISTS model_fingerprints (
      id            TEXT PRIMARY KEY,
      listing_id    TEXT NOT NULL,
      prompt_hash   TEXT NOT NULL,
      response_hash TEXT NOT NULL,
      recorded_at   INTEGER NOT NULL
    )
  `)

  // Phase 2: per-wallet pull-payment accounting.
  // accrued_usd = off-chain debt not yet pulled; pending_* = a pull in flight
  // (snapshot + deterministic tx hash + raw signed tx, for crash-safe re-broadcast).
  db.run(`
    CREATE TABLE IF NOT EXISTS wallet_state (
      address             TEXT PRIMARY KEY,
      accrued_usd         REAL    NOT NULL DEFAULT 0.0,
      total_pulled_usd    REAL    NOT NULL DEFAULT 0.0,
      pull_failure_count  INTEGER NOT NULL DEFAULT 0,
      pending_pull_usd    REAL,
      pending_pull_tx     TEXT,
      pending_pull_raw    TEXT,
      last_pull_at        INTEGER,
      last_pull_tx        TEXT,
      blocked             INTEGER NOT NULL DEFAULT 0,
      settled_atomic      INTEGER NOT NULL DEFAULT 0
    )
  `)

  // Migration: add last_pull_tx if it doesn't exist yet
  const hasLastPullTx = db
    .query<{ count: number }, []>(
      `SELECT COUNT(*) as count FROM pragma_table_info('wallet_state') WHERE name = 'last_pull_tx'`,
    )
    .get()
  if (hasLastPullTx && hasLastPullTx.count === 0) {
    db.run(`ALTER TABLE wallet_state ADD COLUMN last_pull_tx TEXT`)
  }

  // Migration: add settled_atomic — the off-chain mirror of the contract's monotonic
  // settled[caller] cumulative checkpoint (atomic USDC, fee-exclusive).
  const hasSettledAtomic = db
    .query<{ count: number }, []>(
      `SELECT COUNT(*) as count FROM pragma_table_info('wallet_state') WHERE name = 'settled_atomic'`,
    )
    .get()
  if (hasSettledAtomic && hasSettledAtomic.count === 0) {
    db.run(`ALTER TABLE wallet_state ADD COLUMN settled_atomic INTEGER NOT NULL DEFAULT 0`)
  }

  return db
}

export function closeDb(db: Database): void {
  db.close()
}

export function seedProviders(db: Database): void {
  // Provider: TwoShoes — DeepSeek + Anthropic
  db.run(`INSERT OR IGNORE INTO providers (id, name) VALUES (?, ?)`, ['twoshoes', 'TwoShoes'])

  db.run(
    `INSERT INTO listings
       (id, provider_id, model_prefix, upstream_format, endpoint, api_key, price_input_usd_per_million, price_output_usd_per_million)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET api_key = excluded.api_key,
       price_input_usd_per_million = excluded.price_input_usd_per_million,
       price_output_usd_per_million = excluded.price_output_usd_per_million`,
    [
      'twoshoes-anthropic',
      'twoshoes',
      'claude-',
      'anthropic',
      'https://api.anthropic.com',
      process.env.ANTHROPIC_API_KEY ?? null,
      3.00,    // $3/M input (rough Claude Sonnet tier)
      15.00,   // $15/M output
    ],
  )

  // Exact aliases for HF repo IDs → DeepSeek API model names
  const deepseekAliases: Array<[string, string, string]> = [
    ['deepseek-ai/DeepSeek-V3',        'deepseek-v4-pro',   'twoshoes-ds-v3'],
    ['deepseek-ai/DeepSeek-V4-Pro',    'deepseek-v4-pro',   'twoshoes-ds-v4-pro'],
    ['deepseek-ai/DeepSeek-V4-Flash',  'deepseek-v4-flash', 'twoshoes-ds-v4-flash'],
    ['deepseek-ai/DeepSeek-R1',        'deepseek-v4-flash', 'twoshoes-ds-r1'],
  ]
  for (const [modelId, providerModelId, id] of deepseekAliases) {
    db.run(
      `INSERT INTO listings
         (id, provider_id, model_id, provider_model_id, upstream_format, endpoint, api_key, price_input_usd_per_million, price_output_usd_per_million)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET api_key = excluded.api_key,
         price_input_usd_per_million = excluded.price_input_usd_per_million,
         price_output_usd_per_million = excluded.price_output_usd_per_million`,
      [id, 'twoshoes', modelId, providerModelId, 'openai', 'https://api.deepseek.com/v1', process.env.DEEPSEEK_API_KEY ?? null, 0.27, 1.10],
    )
  }

  // Prefix catch-all for deepseek- native API names (e.g. deepseek-v4-pro sent directly)
  db.run(
    `INSERT INTO listings
       (id, provider_id, model_prefix, upstream_format, endpoint, api_key, price_input_usd_per_million, price_output_usd_per_million)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET api_key = excluded.api_key,
       price_input_usd_per_million = excluded.price_input_usd_per_million,
       price_output_usd_per_million = excluded.price_output_usd_per_million`,
    ['twoshoes-deepseek', 'twoshoes', 'deepseek-', 'openai', 'https://api.deepseek.com/v1', process.env.DEEPSEEK_API_KEY ?? null, 0.27, 1.10],
  )

  // Provider: BigThought — OpenAI only
  db.run(`INSERT OR IGNORE INTO providers (id, name) VALUES (?, ?)`, ['bigthought', 'BigThought'])

  db.run(
    `INSERT INTO listings
       (id, provider_id, model_prefix, upstream_format, endpoint, api_key, price_input_usd_per_million, price_output_usd_per_million)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET api_key = excluded.api_key,
       price_input_usd_per_million = excluded.price_input_usd_per_million,
       price_output_usd_per_million = excluded.price_output_usd_per_million`,
    [
      'bigthought-gpt',
      'bigthought',
      'gpt-',
      'openai',
      'https://api.openai.com/v1',
      process.env.OPENAI_API_KEY ?? null,
      2.50,   // $2.50/M input (gpt-4o tier)
      10.00,  // $10/M output
    ],
  )

  const oModels = ['o1', 'o1-mini', 'o1-pro', 'o3', 'o3-mini', 'o4-mini']
  for (const model of oModels) {
    db.run(
      `INSERT INTO listings
         (id, provider_id, model_id, upstream_format, endpoint, api_key, price_input_usd_per_million, price_output_usd_per_million)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET api_key = excluded.api_key,
         price_input_usd_per_million = excluded.price_input_usd_per_million,
         price_output_usd_per_million = excluded.price_output_usd_per_million`,
      [
        `bigthought-${model}`,
        'bigthought',
        model,
        'openai',
        'https://api.openai.com/v1',
        process.env.OPENAI_API_KEY ?? null,
        2.50,
        10.00,
      ],
    )
  }
}
