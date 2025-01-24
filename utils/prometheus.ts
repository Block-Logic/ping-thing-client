import { Registry, Histogram } from 'prom-client';
import express from 'express';
import dotenv from "dotenv"
dotenv.config()

const METRICS_PORT = process.env.PROMETHEUS_PORT || 9090;

// Initialize Prometheus registry
const register = new Registry();

// Generate millisecond buckets from 0 to 10000
const generateBuckets = () => {
  const buckets = [];
  // Fine granularity for 0-1000ms range (50ms steps)
  for (let i = 0; i <= 1000; i += 50) buckets.push(i);
  // Medium granularity 1000-2000ms (100ms steps)
  for (let i = 1100; i <= 2000; i += 100) buckets.push(i);
  // Coarse granularity 2000-10000ms (200ms steps)
  for (let i = 2200; i <= 10000; i += 200) buckets.push(i);
  return buckets;
};

// Create histograms
export const confirmationLatency = new Histogram({
  name: 'ping_thing_client_confirmation_latency',
  help: 'Solana transaction confirmation latency in milliseconds',
  labelNames: ['pinger_name'],
  buckets: generateBuckets(),
  registers: [register]
});

export const slotLatency = new Histogram({
  name: 'ping_thing_client_slot_latency',
  help: 'Difference between landed slot and sent slot',
  labelNames: ['pinger_name'],
  buckets: Array.from({ length: 30 }, (_, i) => i + 1),
  registers: [register]
});

export async function initPrometheus() {
  const app = express();

  app.get('/metrics', async (req, res) => {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  });

  app.listen(METRICS_PORT, () => {
    console.log(`Metrics server listening on port ${METRICS_PORT}`);
  });
}