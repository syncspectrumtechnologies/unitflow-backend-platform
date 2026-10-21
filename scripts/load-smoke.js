const { performance } = require('perf_hooks');

const baseUrl = String(process.env.LOAD_TEST_BASE_URL || 'http://127.0.0.1:4210').replace(/\/$/, '');
const concurrency = Math.max(1, Math.min(Number(process.env.LOAD_TEST_CONCURRENCY || 25), 200));
const requests = Math.max(concurrency, Math.min(Number(process.env.LOAD_TEST_REQUESTS || 250), 10000));
const timeoutMs = Math.max(1000, Number(process.env.LOAD_TEST_TIMEOUT_MS || 10000));
const latencies = [];
let failures = 0;
let cursor = 0;

async function worker() {
  while (cursor < requests) {
    cursor += 1;
    const started = performance.now();
    try {
      const response = await fetch(`${baseUrl}/ready`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) failures += 1;
      await response.arrayBuffer();
    } catch {
      failures += 1;
    } finally {
      latencies.push(performance.now() - started);
    }
  }
}

(async () => {
  const started = performance.now();
  await Promise.all(Array.from({ length: concurrency }, worker));
  latencies.sort((a, b) => a - b);
  const percentile = (p) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))] || 0;
  const duration = performance.now() - started;
  const result = {
    base_url: baseUrl,
    requests,
    concurrency,
    failures,
    requests_per_second: Number((requests / (duration / 1000)).toFixed(1)),
    p50_ms: Number(percentile(0.5).toFixed(1)),
    p95_ms: Number(percentile(0.95).toFixed(1)),
    p99_ms: Number(percentile(0.99).toFixed(1))
  };
  console.log(JSON.stringify(result));
  if (failures > 0 || result.p95_ms > Number(process.env.LOAD_TEST_MAX_P95_MS || 1500)) process.exit(1);
})();
