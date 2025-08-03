use prometheus::{Histogram, HistogramOpts, Registry};
use std::sync::Arc;
use warp::Filter;
use anyhow::Result;

pub struct Metrics {
    pub registry: Registry,
    pub confirmation_latency: Histogram,
    pub slot_latency: Histogram,
}

impl Metrics {
    pub fn new() -> Result<Self> {
        let registry = Registry::new();

        // Generate millisecond buckets
        let mut buckets = Vec::new();
        for i in (0..=1000).step_by(50) {
            buckets.push(i as f64);
        }
        for i in (1100..=2000).step_by(100) {
            buckets.push(i as f64);
        }
        for i in (2200..=10000).step_by(200) {
            buckets.push(i as f64);
        }

        let confirmation_latency = Histogram::with_opts(
            HistogramOpts::new(
                "ping_thing_client_confirmation_latency",
                "Solana transaction confirmation latency in milliseconds",
            )
            .buckets(buckets),
        )?;

        let slot_buckets: Vec<f64> = (1..=30).map(|x| x as f64).collect();
        let slot_latency = Histogram::with_opts(
            HistogramOpts::new(
                "ping_thing_client_slot_latency",
                "Difference between landed slot and sent slot",
            )
            .buckets(slot_buckets),
        )?;

        registry.register(Box::new(confirmation_latency.clone()))?;
        registry.register(Box::new(slot_latency.clone()))?;

        Ok(Self {
            registry,
            confirmation_latency,
            slot_latency,
        })
    }

    pub async fn start_server(&self, port: u16) {
        let metrics = Arc::new(self.registry.clone());

        let metrics_route = warp::path!("metrics")
            .map(move || {
                let metrics = Arc::clone(&metrics);
                let mut buffer = Vec::new();
                let encoder = prometheus::TextEncoder::new();
                encoder.encode(&metrics.gather(), &mut buffer).unwrap();
                String::from_utf8(buffer).unwrap()
            });

        warp::serve(metrics_route)
            .run(([127, 0, 0, 1], port))
            .await;
    }
}
