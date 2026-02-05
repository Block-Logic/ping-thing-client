use anyhow::Result;
use log::{debug, error, info, warn};
use reqwest::Client;
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;
use tokio::time::{sleep, Duration};

#[derive(Debug)]
pub struct GlobalPriorityFees {
    pub value: Option<u64>,
    pub updated_at: i64,
}

impl GlobalPriorityFees {
    pub fn new() -> Self {
        Self {
            value: None,
            updated_at: 0,
        }
    }
}

#[derive(Debug, Deserialize)]
struct PrioritizationFee {
    #[allow(dead_code)]
    slot: u64,
    #[serde(rename = "prioritizationFee")]
    prioritization_fee: u64,
}

#[derive(Debug, Deserialize)]
struct RpcResponse {
    #[allow(dead_code)]
    jsonrpc: String,
    result: Vec<PrioritizationFee>,
    #[allow(dead_code)]
    id: serde_json::Value,
}

/// Watches prioritization fees by polling RPC every 350ms
pub async fn watch_prioritization_fees(
    rpc_endpoint: &String,
    g_priority_fees: Arc<tokio::sync::Mutex<GlobalPriorityFees>>,
    percentile: u16,
) -> Result<()> {
    info!(
        "[Priority Fees Watcher] Starting with percentile: {}",
        percentile
    );

    let client = Client::new();

    loop {
        // Make JSON-RPC call to getRecentPrioritizationFees
        let payload = json!({
            "jsonrpc": "2.0",
            "id": "1",
            "method": "getRecentPrioritizationFees",
            "params": [
                [],
                {
                    "percentile": percentile
                }
            ]
        });

        match client
            .post(rpc_endpoint)
            .header("Content-Type", "application/json")
            .json(&payload)
            .send()
            .await
        {
            Ok(response) => {
                if response.status().is_success() {
                    match response.json::<RpcResponse>().await {
                        Ok(rpc_response) => {
                            // Process the fee results
                            if !rpc_response.result.is_empty() {
                                let mut fees: Vec<u64> = rpc_response
                                    .result
                                    .iter()
                                    .map(|f| f.prioritization_fee)
                                    .collect();

                                // Sort fees and get the maximum
                                fees.sort();
                                let max_fee = fees[fees.len() - 1];

                                // Update global state
                                let mut g = g_priority_fees.lock().await;
                                let previous_fee = g.value;
                                g.value = Some(max_fee);
                                g.updated_at = chrono::Utc::now().timestamp();
                                drop(g);

                                if previous_fee != Some(max_fee) {
                                    debug!(
                                        "[Priority Fees Watcher] Updated priority fee: {} (previous: {:?})",
                                        max_fee, previous_fee
                                    );
                                }
                            } else {
                                warn!("[Priority Fees Watcher] Received empty fee results");
                            }
                        }
                        Err(e) => {
                            error!(
                                "[Priority Fees Watcher] Failed to parse RPC response: {:?}",
                                e
                            );
                        }
                    }
                } else {
                    error!(
                        "[Priority Fees Watcher] RPC request failed with status: {:?}",
                        response.status()
                    );
                }
            }
            Err(e) => {
                error!("[Priority Fees Watcher] HTTP request error: {:?}", e);
                // println!("{:?}", e)
            }
        }

        // Sleep for 350ms before next poll
        sleep(Duration::from_millis(350)).await;
    }
}
