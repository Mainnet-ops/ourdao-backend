import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { pool } from '../src/db/index.js'
import { migrate } from '../src/db/migrate.js'
import { DERIVED_TABLES } from '../src/indexer/derived-tables.js'
import { resetDb, closeDb } from './db.js'

/**
 * Issue #512: Verify every entry in DERIVED_TABLES exists as a table in
 * schema.sql after migrations run.
 *
 * DERIVED_TABLES is the authoritative list of tables that reindex/contract-repoint
 * truncate, kept in sync with schema.sql by hand. This test catches drift: if a
 * table is added to DERIVED_TABLES but not actually created in schema.sql, this
 * test fails.
 */
describe('DERIVED_TABLES schema sync (#512)', () => {
  beforeAll(async () => {
    await resetDb()
    await migrate()
  })

  afterAll(closeDb)

  it('every DERIVED_TABLES entry exists as a table in the migrated schema', async () => {
    // Query information_schema to get all actual tables
    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = current_schema()
       AND table_type = 'BASE TABLE'`
    )

    const actualTables = new Set(rows.map((r) => r.table_name))

    // Verify each DERIVED_TABLES entry exists
    const missing: string[] = []
    for (const tableName of DERIVED_TABLES) {
      if (!actualTables.has(tableName)) {
        missing.push(tableName)
      }
    }

    expect(missing, `DERIVED_TABLES references non-existent table(s): ${missing.join(', ')}`).toEqual([])

    // Also log what we found for documentation
    if (missing.length === 0) {
      console.log(`[derived-tables-schema-sync] All ${DERIVED_TABLES.length} DERIVED_TABLES entries exist in schema`)
    }
  })

  it('DERIVED_TABLES entries are real tables, not views or other objects', async () => {
    // Verify they're BASE TABLEs, not VIEWs or other schema objects
    for (const tableName of DERIVED_TABLES) {
      const { rows } = await pool.query<{ table_type: string }>(
        `SELECT table_type
         FROM information_schema.tables
         WHERE table_schema = current_schema()
         AND table_name = $1`,
        [tableName]
      )

      expect(rows.length, `${tableName} should exist`).toBe(1)
      expect(rows[0]?.table_type, `${tableName} should be a BASE TABLE`).toBe('BASE TABLE')
    }
  })

  it('all DERIVED_TABLES entries can be truncated', async () => {
    // Verify TRUNCATE works on each table (tests that foreign keys allow it,
    // or that CASCADE would work)
    for (const tableName of DERIVED_TABLES) {
      await expect(
        pool.query(`TRUNCATE ${tableName} RESTART IDENTITY CASCADE`)
      ).resolves.not.toThrow()
    }
  })
})
