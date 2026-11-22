#!/usr/bin/env node --import=tsx
/**
 * Audit script for schema.sql vs migrations drift (issue #513).
 *
 * CONTRIBUTING.md requires schema changes to appear in both schema.sql
 * (fresh-database baseline) and a numbered migration (existing-database
 * upgrade path). The test suite only exercises schema.sql, so a migration-only
 * change passes CI but breaks in production against an old database.
 *
 * This script builds two databases:
 * 1. Fresh from schema.sql alone
 * 2. From migrations applied in order to an empty database
 *
 * It then diffs their information_schema shape (tables, columns, types,
 * constraints, indexes) and fails loudly on any difference.
 *
 * Run via: npm run audit:schema-drift
 * CI runs this automatically to catch drift before merge.
 */
import { Pool } from 'pg'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, '..')

interface SchemaObject {
  type: 'table' | 'column' | 'constraint' | 'index'
  schema: string
  table: string
  name: string
  definition: string
}

async function getSchemaShape(pool: Pool): Promise<SchemaObject[]> {
  const objects: SchemaObject[] = []

  // Get all tables
  const tables = await pool.query<{ table_name: string }>(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = current_schema()
     AND table_type = 'BASE TABLE'
     ORDER BY table_name`
  )

  for (const { table_name } of tables.rows) {
    objects.push({
      type: 'table',
      schema: 'public',
      table: table_name,
      name: table_name,
      definition: `table:${table_name}`,
    })

    // Get columns for this table
    const columns = await pool.query<{
      column_name: string
      data_type: string
      is_nullable: string
      column_default: string | null
    }>(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = current_schema()
       AND table_name = $1
       ORDER BY ordinal_position`,
      [table_name]
    )

    for (const col of columns.rows) {
      objects.push({
        type: 'column',
        schema: 'public',
        table: table_name,
        name: col.column_name,
        definition: `${col.column_name} ${col.data_type} ${col.is_nullable === 'NO' ? 'NOT NULL' : 'NULL'} ${col.column_default ? `DEFAULT ${col.column_default}` : ''}`.trim(),
      })
    }

    // Get constraints for this table
    const constraints = await pool.query<{
      constraint_name: string
      constraint_type: string
    }>(
      `SELECT constraint_name, constraint_type
       FROM information_schema.table_constraints
       WHERE table_schema = current_schema()
       AND table_name = $1
       ORDER BY constraint_name`,
      [table_name]
    )

    for (const con of constraints.rows) {
      objects.push({
        type: 'constraint',
        schema: 'public',
        table: table_name,
        name: con.constraint_name,
        definition: `${con.constraint_name} (${con.constraint_type})`,
      })
    }

    // Get indexes for this table
    const indexes = await pool.query<{
      indexname: string
      indexdef: string
    }>(
      `SELECT indexname, indexdef
       FROM pg_indexes
       WHERE schemaname = current_schema()
       AND tablename = $1
       ORDER BY indexname`,
      [table_name]
    )

    for (const idx of indexes.rows) {
      objects.push({
        type: 'index',
        schema: 'public',
        table: table_name,
        name: idx.indexname,
        definition: idx.indexdef,
      })
    }
  }

  return objects
}

function compareSchemas(fresh: SchemaObject[], migrated: SchemaObject[]): {
  onlyInFresh: SchemaObject[]
  onlyInMigrated: SchemaObject[]
  different: Array<{ fresh: SchemaObject; migrated: SchemaObject }>
} {
  const freshMap = new Map<string, SchemaObject>()
  const migratedMap = new Map<string, SchemaObject>()

  for (const obj of fresh) {
    const key = `${obj.type}:${obj.table}:${obj.name}`
    freshMap.set(key, obj)
  }

  for (const obj of migrated) {
    const key = `${obj.type}:${obj.table}:${obj.name}`
    migratedMap.set(key, obj)
  }

  const onlyInFresh: SchemaObject[] = []
  const different: Array<{ fresh: SchemaObject; migrated: SchemaObject }> = []

  for (const [key, freshObj] of freshMap.entries()) {
    const migratedObj = migratedMap.get(key)
    if (!migratedObj) {
      onlyInFresh.push(freshObj)
    } else if (freshObj.definition !== migratedObj.definition) {
      different.push({ fresh: freshObj, migrated: migratedObj })
    }
  }

  const onlyInMigrated: SchemaObject[] = []
  for (const [key, migratedObj] of migratedMap.entries()) {
    if (!freshMap.has(key)) {
      onlyInMigrated.push(migratedObj)
    }
  }

  return { onlyInFresh, onlyInMigrated, different }
}

async function applyMigrations(pool: Pool): Promise<void> {
  const migrationsDir = join(PROJECT_ROOT, 'src', 'db', 'migrations')
  const migrationFiles = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  console.log(`[audit-schema-drift] Applying ${migrationFiles.length} migration(s)...`)

  for (const file of migrationFiles) {
    const sql = readFileSync(join(migrationsDir, file), 'utf-8')
    await pool.query(sql)
    console.log(`[audit-schema-drift]   ✓ ${file}`)
  }
}

async function main(): Promise<void> {
  const baseUrl =
    process.env.TEST_DATABASE_URL || 'postgres://ourdao:ourdao@localhost:5432/ourdao_test'

  // Create two test databases with unique names
  const timestamp = Date.now()
  const freshDbName = `schema_drift_fresh_${timestamp}`
  const migratedDbName = `schema_drift_migrated_${timestamp}`

  const adminPool = new Pool({ connectionString: baseUrl })

  try {
    console.log('[audit-schema-drift] Creating temporary databases...')
    await adminPool.query(`CREATE DATABASE ${freshDbName}`)
    await adminPool.query(`CREATE DATABASE ${migratedDbName}`)

    // Database 1: Fresh from schema.sql
    console.log('[audit-schema-drift] Building fresh database from schema.sql...')
    const freshUrl = baseUrl.replace(/\/[^/]+$/, `/${freshDbName}`)
    const freshPool = new Pool({ connectionString: freshUrl })

    try {
      const schemaPath = join(PROJECT_ROOT, 'src', 'db', 'schema.sql')
      const schemaSql = readFileSync(schemaPath, 'utf-8')
      await freshPool.query(schemaSql)

      const freshShape = await getSchemaShape(freshPool)
      console.log(`[audit-schema-drift] Fresh database has ${freshShape.length} schema objects`)

      await freshPool.end()

      // Database 2: From migrations
      console.log('[audit-schema-drift] Building migrated database from migrations...')
      const migratedUrl = baseUrl.replace(/\/[^/]+$/, `/${migratedDbName}`)
      const migratedPool = new Pool({ connectionString: migratedUrl })

      try {
        // Bootstrap schema_migrations table first (it's in schema.sql)
        await migratedPool.query(`
          CREATE TABLE IF NOT EXISTS schema_migrations (
            version    INTEGER PRIMARY KEY,
            name       TEXT NOT NULL,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
          )
        `)

        await applyMigrations(migratedPool)

        const migratedShape = await getSchemaShape(migratedPool)
        console.log(
          `[audit-schema-drift] Migrated database has ${migratedShape.length} schema objects`
        )

        // Compare
        console.log('[audit-schema-drift] Comparing schemas...')
        const { onlyInFresh, onlyInMigrated, different } = compareSchemas(
          freshShape,
          migratedShape
        )

        let hasDrift = false

        if (onlyInFresh.length > 0) {
          hasDrift = true
          console.error('\n❌ Objects only in schema.sql (missing from migrations):')
          for (const obj of onlyInFresh) {
            console.error(`  - ${obj.type}: ${obj.table}.${obj.name}`)
          }
        }

        if (onlyInMigrated.length > 0) {
          hasDrift = true
          console.error('\n❌ Objects only in migrations (missing from schema.sql):')
          for (const obj of onlyInMigrated) {
            console.error(`  - ${obj.type}: ${obj.table}.${obj.name}`)
          }
        }

        if (different.length > 0) {
          hasDrift = true
          console.error('\n❌ Objects with different definitions:')
          for (const { fresh, migrated } of different) {
            console.error(`  - ${fresh.type}: ${fresh.table}.${fresh.name}`)
            console.error(`    schema.sql:  ${fresh.definition}`)
            console.error(`    migrations:  ${migrated.definition}`)
          }
        }

        if (hasDrift) {
          console.error(
            '\n❌ DRIFT DETECTED: schema.sql and migrations produce different schemas!'
          )
          console.error(
            'Fix: update either schema.sql or add/modify a migration so both paths produce identical results.'
          )
          process.exit(1)
        }

        console.log('\n✅ No drift detected: schema.sql and migrations produce identical schemas')

        await migratedPool.end()
      } finally {
        await migratedPool.end().catch(() => {})
      }
    } finally {
      await freshPool.end().catch(() => {})
    }
  } finally {
    // Cleanup: drop the temporary databases
    console.log('[audit-schema-drift] Cleaning up temporary databases...')
    await adminPool.query(`DROP DATABASE IF EXISTS ${freshDbName}`).catch((err) => {
      console.warn(`[audit-schema-drift] Failed to drop ${freshDbName}:`, err.message)
    })
    await adminPool.query(`DROP DATABASE IF EXISTS ${migratedDbName}`).catch((err) => {
      console.warn(`[audit-schema-drift] Failed to drop ${migratedDbName}:`, err.message)
    })
    await adminPool.end()
  }
}

main().catch((err) => {
  console.error('[audit-schema-drift] FATAL:', err)
  process.exit(1)
})
