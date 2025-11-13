use anyhow::Result;
use log::{debug, info};
use prometheus::{Encoder, HistogramOpts, HistogramVec, Registry};
use std::sync::Arc;
use warp::Filter;

pub struct Metrics {
    pub registry: Registry,
    pub confirmation_latency: HistogramVec,
    pub slot_latency: HistogramVec,
}

impl Metrics {
    pub fn new() -> Result<Self> {
        info!("[Metrics] Initializing Prometheus metrics registry...");
        let registry = Registry::new();

        info!("[Metrics] Creating histogram buckets for confirmation latency...");
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
        debug!(
            "[Metrics] Created {} buckets for confirmation latency",
            buckets.len()
        );

        info!("[Metrics] Registering confirmation_latency histogram...");
        let confirmation_latency = HistogramVec::new(
            HistogramOpts::new(
                "ping_thing_client_confirmation_latency",
                "Solana transaction confirmation latency in milliseconds",
            )
            .buckets(buckets),
            &["pinger_name"],
        )?;

        info!("[Metrics] Creating histogram buckets for slot latency...");
        let slot_buckets: Vec<f64> = (1..=30).map(|x| x as f64).collect();
        debug!(
            "[Metrics] Created {} buckets for slot latency",
            slot_buckets.len()
        );

        info!("[Metrics] Registering slot_latency histogram...");
        let slot_latency = HistogramVec::new(
            HistogramOpts::new(
                "ping_thing_client_slot_latency",
                "Difference between landed slot and sent slot",
            )
            .buckets(slot_buckets),
            &["pinger_name"],
        )?;

        info!("[Metrics] Registering metrics with Prometheus registry...");
        registry.register(Box::new(confirmation_latency.clone()))?;
        registry.register(Box::new(slot_latency.clone()))?;
        info!("[Metrics] All metrics registered successfully");

        Ok(Self {
            registry,
            confirmation_latency,
            slot_latency,
        })
    }

    pub async fn start_server(&self, port: u16) {
        info!(
            "[Metrics] Starting Prometheus metrics server on port {}...",
            port
        );
        let metrics = Arc::new(self.registry.clone());

        let metrics_route = warp::path!("metrics").map(move || {
            debug!("[Metrics] Handling /metrics request");
            let metrics = Arc::clone(&metrics);
            let mut buffer = Vec::new();
            let encoder = prometheus::TextEncoder::new();
            encoder.encode(&metrics.gather(), &mut buffer).unwrap();
            String::from_utf8(buffer).unwrap()
        });

        info!(
            "[Metrics] Prometheus metrics server listening on http://127.0.0.1:{}/metrics",
            port
        );
        warp::serve(metrics_route).run(([127, 0, 0, 1], port)).await;
    }
}
