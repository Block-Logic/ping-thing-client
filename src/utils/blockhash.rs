use std::sync::{Arc, Mutex};
use solana_client::nonblocking::rpc_client::RpcClient;
use solana_sdk::hash::Hash;
use tokio::time::{sleep, Duration};
use log::{error, info};
use anyhow::Result;

pub struct GlobalBlockhash {
    pub value: Option<Hash>,
    pub updated_at: i64,
    pub last_valid_block_height: u64,
}

impl GlobalBlockhash {
    pub fn new() -> Self {
        Self {
            value: None,
            updated_at: 0,
            last_valid_block_height: 0,
        }
    }
}

pub async fn watch_blockhash(
    g_blockhash: Arc<Mutex<GlobalBlockhash>>,
    rpc_client: Arc<RpcClient>,
) -> Result<()> {
    let max_attempts = std::env::var("MAX_BLOCKHASH_FETCH_ATTEMPTS")
        .unwrap_or_else(|_| "5".to_string())
        .parse::<u32>()
        .unwrap_or(5);
    let mut attempts = 0;

    loop {
        match tokio::time::timeout(
            Duration::from_secs(5),
            rpc_client.get_latest_blockhash(),
        ).await {
            Ok(Ok(blockhash_response)) => {
                let mut g = g_blockhash.lock().unwrap();
                g.value = Some(blockhash_response.0);
                g.last_valid_block_height = blockhash_response.1;
                g.updated_at = chrono::Utc::now().timestamp();
                attempts = 0;
            }
            Ok(Err(e)) => {
                error!("Failed to fetch blockhash: {}", e);
                attempts += 1;
            }
            Err(e) => {
                error!("Blockhash fetch timeout: {}", e);
                attempts += 1;
            }
        }

        if attempts >= max_attempts {
            error!("Max attempts for fetching blockhash reached, exiting");
            std::process::exit(1);
        }

        sleep(Duration::from_secs(5)).await;
    }
}
