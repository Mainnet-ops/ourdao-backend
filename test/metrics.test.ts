import { describe, it, expect, beforeEach } from 'vitest'
import {
  rpcRateLimitRetriesCounter,
  replayOutcomesCounter,
  reindexRunsCounter,
  reindexDurationHistogram,
  register,
} from '../src/api/metrics.js'

/**
 * Tests for Prometheus metrics (issues #528, #529).
 *
 * Verify that counters and histograms are registered and can be incremented/observed.
 */
describe('Prometheus metrics', () => {
  beforeEach(async () => {
    // Reset all metrics before each test
    register.resetMetrics()
  })

  describe('Issue #528: RPC rate-limit retries counter', () => {
    it('rpcRateLimitRetriesCounter is registered', async () => {
      const metrics = await register.getMetricsAsJSON()
      const counter = metrics.find((m) => m.name === 'ourdao_rpc_rate_limit_retries_total')
      expect(counter).toBeDefined()
      expect(counter?.help).toContain('RPC rate-limit')
    })

    it('can be incremented with operation label', async () => {
      rpcRateLimitRetriesCounter.inc({ operation: 'getLatestLedger' })
      rpcRateLimitRetriesCounter.inc({ operation: 'getLatestLedger' })
      rpcRateLimitRetriesCounter.inc({ operation: 'getEvents' })

      const metricsText = await register.metrics()
      expect(metricsText).toContain('ourdao_rpc_rate_limit_retries_total{operation="getLatestLedger"} 2')
      expect(metricsText).toContain('ourdao_rpc_rate_limit_retries_total{operation="getEvents"} 1')
    })
  })

  describe('Issue #529: Replay outcomes counter', () => {
    it('replayOutcomesCounter is registered', async () => {
      const metrics = await register.getMetricsAsJSON()
      const counter = metrics.find((m) => m.name === 'ourdao_replay_outcomes_total')
      expect(counter).toBeDefined()
      expect(counter?.help).toContain('replay outcomes')
    })

    it('can be incremented with outcome labels', async () => {
      replayOutcomesCounter.inc({ outcome: 'replayed' })
      replayOutcomesCounter.inc({ outcome: 'replayed' })
      replayOutcomesCounter.inc({ outcome: 'still_failing' })
      replayOutcomesCounter.inc({ outcome: 'already_resolved' })

      const metricsText = await register.metrics()
      expect(metricsText).toContain('ourdao_replay_outcomes_total{outcome="replayed"} 2')
      expect(metricsText).toContain('ourdao_replay_outcomes_total{outcome="still_failing"} 1')
      expect(metricsText).toContain('ourdao_replay_outcomes_total{outcome="already_resolved"} 1')
    })
  })

  describe('Issue #529: Reindex counter and histogram', () => {
    it('reindexRunsCounter is registered', async () => {
      const metrics = await register.getMetricsAsJSON()
      const counter = metrics.find((m) => m.name === 'ourdao_reindex_runs_total')
      expect(counter).toBeDefined()
      expect(counter?.help).toContain('reindex operations')
    })

    it('reindexDurationHistogram is registered', async () => {
      const metrics = await register.getMetricsAsJSON()
      const histogram = metrics.find((m) => m.name === 'ourdao_reindex_duration_seconds')
      expect(histogram).toBeDefined()
      expect(histogram?.help).toContain('Duration of reindex')
    })

    it('can increment counter and observe duration', async () => {
      reindexRunsCounter.inc()
      reindexDurationHistogram.observe(5.2)
      reindexDurationHistogram.observe(12.8)

      const metricsText = await register.metrics()
      expect(metricsText).toContain('ourdao_reindex_runs_total 1')
      expect(metricsText).toContain('ourdao_reindex_duration_seconds')
      // Histogram creates multiple metrics (buckets, sum, count)
      expect(metricsText).toMatch(/ourdao_reindex_duration_seconds_count \d+/)
    })
  })

  describe('/metrics endpoint integration', () => {
    it('register.metrics() returns Prometheus text format', async () => {
      rpcRateLimitRetriesCounter.inc({ operation: 'test' })
      
      const metricsText = await register.metrics()
      
      // Should be in Prometheus exposition format
      expect(typeof metricsText).toBe('string')
      expect(metricsText).toContain('# HELP')
      expect(metricsText).toContain('# TYPE')
      expect(metricsText).toContain('ourdao_rpc_rate_limit_retries_total')
    })

    it('register.contentType is correct for Prometheus', () => {
      expect(register.contentType).toMatch(/^text\/plain/)
    })
  })
})
