# Resolve Issues #512, #513, #528, #529: Schema Sync Tests, Drift Audit, and Prometheus Metrics

## Overview

This PR resolves four issues spanning schema validation, operational observability, and drift detection:
- **#512**: Add test ensuring every `DERIVED_TABLES` entry exists in schema.sql
- **#513**: Add automated schema.sql-vs-migrations drift audit script
- **#528**: Add Prometheus counter for Soroban RPC rate-limit retries
- **#529**: Add Prometheus counters for replay and reindex outcomes

## Changes

### Issue #512: DERIVED_TABLES Schema Sync Test

**Problem**: `DERIVED_TABLES` is kept in sync with `schema.sql` by hand with no automated verification.

**Solution**: Added `test/derived-tables-schema-sync.test.ts` that:
- Runs migrations against a fresh test schema
- Queries `information_schema.tables` to verify every `DERIVED_TABLES` entry exists
- Confirms each is a `BASE TABLE` (not a view)
- Tests that all can be truncated (required for reindex/contract-repoint)

This catches drift immediately in CI if a table is added to `DERIVED_TABLES` but not created in `schema.sql`.

### Issue #513: Schema Drift Audit Script

**Problem**: A contributor who adds a migration but forgets to update `schema.sql` (or vice versa) passes CI but breaks in production.

**Solution**: Created `scripts/audit-schema-drift.ts` that:
- Builds two temporary databases:
  - One from `schema.sql` alone (fresh install path)
  - One from migrations applied to empty database (upgrade path)
- Compares their `information_schema` shapes (tables, columns, types, constraints, indexes)
- Fails with detailed diff if any difference is found

Wired into CI as a dedicated step to catch this class of drift before merge.

### Issue #528: RPC Rate-Limit Retry Metrics

**Problem**: No metric counting how often RPC calls hit 429 rate limits, making it impossible to detect chronic rate-limiting.

**Solution**:
1. Created `src/api/metrics.ts` - Prometheus metrics registry module
2. Added `ourdao_rpc_rate_limit_retries_total` counter (labeled by `operation`)
3. Implemented `withRateLimitRetry()` in `src/stellar/rpc.ts`:
   - Retries up to 5 times with exponential backoff on 429 errors
   - Increments counter on each retry
   - Logs warnings with retry attempt info
4. Wrapped RPC calls (`getLatestLedger`, `getLatestLedgerInfo`)
5. Exposed metrics at `GET /metrics` endpoint

Operators can now alert on `rate(ourdao_rpc_rate_limit_retries_total[5m])` to detect when a configured RPC URL is chronically rate-limiting.

**Note**: Worker process doesn't expose `/metrics` endpoint yet (documented as future work).

### Issue #529: Replay and Reindex Metrics

**Problem**: Replay and reindex are significant recovery operations with no corresponding metrics.

**Solution**:
1. Added to `src/api/metrics.ts`:
   - `ourdao_replay_outcomes_total` counter (labeled by outcome: `replayed`, `already_resolved`, `still_failing`)
   - `ourdao_reindex_runs_total` counter
   - `ourdao_reindex_duration_seconds` histogram
2. Created `src/indexer/replay.ts`:
   - `replayFailedEvent()` - attempts to re-apply quarantined events
   - `ReplayOutcome` type union for discriminated outcomes
   - Increments counter with appropriate label on each replay
3. Instrumented `src/indexer/reindex.ts`:
   - Tracks duration from start to commit
   - Increments counter and observes histogram on successful completion

Operators can now:
- Alert on `ourdao_replay_outcomes_total{outcome="still_failing"}` for persistent failures
- Track reindex frequency and duration trends
- Detect reindex performance regressions

## Files Changed

### Created
- `test/derived-tables-schema-sync.test.ts` - Schema sync verification test
- `scripts/audit-schema-drift.ts` - Drift detection script
- `src/api/metrics.ts` - Prometheus metrics registry
- `src/indexer/replay.ts` - Event replay functionality with metrics
- `test/metrics.test.ts` - Metrics instrumentation tests
- `test/replay.test.ts` - Replay functionality tests

### Modified
- `package.json` - Added `prom-client` dependency, `audit:schema-drift` script
- `.github/workflows/ci.yml` - Added "Schema drift audit" step
- `src/stellar/rpc.ts` - Added `withRateLimitRetry()` wrapper with metrics
- `src/api/server.ts` - Added `GET /metrics` endpoint
- `src/indexer/reindex.ts` - Added metrics instrumentation

## Testing

### Schema Sync Test (#512)
```bash
npm test -- derived-tables-schema-sync
```

Tests verify:
- All `DERIVED_TABLES` entries exist as tables in migrated schema
- Each is a `BASE TABLE`
- All can be truncated

### Schema Drift Audit (#513)
```bash
npm run audit:schema-drift
```

Creates two temp databases, compares them, reports any differences.

### Metrics (#528, #529)
```bash
npm test -- metrics
npm test -- replay
```

Tests verify:
- All counters/histograms are registered
- Incrementation/observation works correctly
- Metrics appear in Prometheus text format at `/metrics`

### All Checks
```bash
npm run typecheck  # ✅ Passes
npm run build      # ✅ Passes
npm test           # ✅ Passes (with Postgres running)
```

## Acceptance Criteria

### Issue #512 ✅
- [x] Test runs `migrate()` against fresh test schema
- [x] Queries `information_schema.tables` and asserts every `DERIVED_TABLES` entry present
- [x] Narrowly scoped to drift-detection check
- [x] Tests fail without the change, run against real Postgres
- [x] All checks pass

### Issue #513 ✅
- [x] Script builds two databases (schema.sql-only vs migrated)
- [x] Diffs their information_schema shape
- [x] Fails loudly on differences
- [x] Wired into CI as dedicated step
- [x] All checks pass

### Issue #528 ✅
- [x] `ourdao_rpc_rate_limit_retries_total` counter added, labeled by operation
- [x] Incremented on each retry in `withRateLimitRetry()`
- [x] Metric reachable from API process at `/metrics`
- [x] Documented worker doesn't expose `/metrics` (future work)
- [x] Tests verify counter works
- [x] All checks pass

### Issue #529 ✅
- [x] `ourdao_replay_outcomes_total` counter added, labeled by outcome
- [x] Incremented at end of `replayFailedEvent()`
- [x] `ourdao_reindex_runs_total` counter added
- [x] `ourdao_reindex_duration_seconds` histogram added
- [x] Incremented/observed at end of `reindexFromEventLog()`
- [x] Tests verify all metrics work
- [x] All checks pass

## Metrics Example

After this PR, the `/metrics` endpoint exposes:

```prometheus
# HELP ourdao_rpc_rate_limit_retries_total Total number of RPC rate-limit (429) retries
# TYPE ourdao_rpc_rate_limit_retries_total counter
ourdao_rpc_rate_limit_retries_total{operation="getLatestLedger"} 3
ourdao_rpc_rate_limit_retries_total{operation="getLatestLedgerInfo"} 1

# HELP ourdao_replay_outcomes_total Count of replay outcomes for quarantined events
# TYPE ourdao_replay_outcomes_total counter
ourdao_replay_outcomes_total{outcome="replayed"} 5
ourdao_replay_outcomes_total{outcome="still_failing"} 2
ourdao_replay_outcomes_total{outcome="already_resolved"} 1

# HELP ourdao_reindex_runs_total Total number of reindex operations completed
# TYPE ourdao_reindex_runs_total counter
ourdao_reindex_runs_total 3

# HELP ourdao_reindex_duration_seconds Duration of reindex operations in seconds
# TYPE ourdao_reindex_duration_seconds histogram
ourdao_reindex_duration_seconds_bucket{le="1"} 0
ourdao_reindex_duration_seconds_bucket{le="5"} 2
ourdao_reindex_duration_seconds_bucket{le="10"} 3
ourdao_reindex_duration_seconds_sum 18.4
ourdao_reindex_duration_seconds_count 3
```

## Notes

- **No extra additions or subtractions**: Only what's specified in acceptance criteria
- **Worker metrics**: Worker process doesn't expose `/metrics` yet - noted as future work, not blocking
- **Backwards compatible**: All changes are additive, no breaking changes
- **Ready for merge**: All acceptance criteria met, all checks pass

---

Closes #512  
Closes #513  
Closes #528  
Closes #529
