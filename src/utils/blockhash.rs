use anyhow::{Context, Result};
use futures::StreamExt;
use log::{error, warn};
use solana_sdk::hash::Hash;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio::time::{sleep, Duration};
use yellowstone_grpc_client::GeyserGrpcClient;
use yellowstone_grpc_proto::prelude::{
    subscribe_update::UpdateOneof, CommitmentLevel, SubscribeRequest,
    SubscribeRequestFilterBlocksMeta,
};

#[derive(Debug)]
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

/// Watches blockhash updates via gRPC block_meta subscription
pub async fn watch_blockhash(
    grpc_client: Arc<Mutex<GeyserGrpcClient<impl yellowstone_grpc_client::Interceptor + 'static>>>,
    g_blockhash: Arc<Mutex<GlobalBlockhash>>,
    commitment: CommitmentLevel,
) -> Result<()> {
    loop {
        // Create subscription request for block_meta
        let mut blocks_filter = HashMap::new();
        blocks_filter.insert(
            "block_meta".to_string(),
            SubscribeRequestFilterBlocksMeta {},
        );

        let subscribe_request = SubscribeRequest {
            blocks_meta: blocks_filter,
            commitment: Some(commitment.into()),
            ..Default::default()
        };

        let (_subscribe_tx, mut stream) = {
            let mut client = grpc_client.lock().await;
            client
                .subscribe_with_request(Some(subscribe_request))
                .await
                .context("Failed to create block_meta subscription")?
        };

        // Process stream updates
        while let Some(message) = stream.next().await {
            match message {
                Ok(msg) => {
                    if let Some(update) = msg.update_oneof {
                        match update {
                            UpdateOneof::BlockMeta(block_meta_update) => {
                                let blockhash_str = block_meta_update.blockhash;
                                let block_height = block_meta_update
                                    .block_height
                                    .map(|bh| bh.block_height)
                                    .unwrap_or(0);

                                // Parse blockhash from base58 string
                                let hash_bytes = match bs58::decode(&blockhash_str).into_vec() {
                                    Ok(decoded) => {
                                        if decoded.len() == 32 {
                                            match <[u8; 32]>::try_from(decoded.as_slice()) {
                                                Ok(arr) => arr,
                                                Err(_) => {
                                                    error!("[Blockhash Watcher] Failed to convert decoded blockhash to array");
                                                    continue;
                                                }
                                            }
                                        } else {
                                            error!(
                                                "[Blockhash Watcher] Decoded blockhash has wrong length: {:?} (expected 32)",
                                                decoded.len()
                                            );
                                            continue;
                                        }
                                    }
                                    Err(e) => {
                                        error!(
                                            "[Blockhash Watcher] Failed to decode blockhash: {:?}",
                                            e
                                        );
                                        continue;
                                    }
                                };

                                let new_hash = Hash::new_from_array(hash_bytes);

                                // Update global blockhash if different
                                let mut g = g_blockhash.lock().await;
                                let previous_hash = g.value;

                                if previous_hash != Some(new_hash) {
                                    g.value = Some(new_hash);
                                    g.last_valid_block_height = block_height;
                                    g.updated_at = chrono::Utc::now().timestamp();
                                    drop(g);
                                }
                            }
                            _ => {
                                // Ignore other update types
                            }
                        }
                    }
                }
                Err(e) => {
                    error!("[Blockhash Watcher] Stream error: {:?}", e);
                    break;
                }
            }
        }

        // Stream ended, reconnect with exponential backoff
        warn!("[Blockhash Watcher] Stream disconnected, reconnecting in 5 seconds...");
        sleep(Duration::from_secs(5)).await;
    }
}
