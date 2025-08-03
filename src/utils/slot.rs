use solana_client::nonblocking::pubsub_client::PubsubClient;
use solana_client::rpc_config::RpcSlotUpdateConfig;
use std::sync::{Arc, Mutex};
use tokio::time::Duration;
use log::{error, info};
use anyhow::Result;

pub struct GlobalSlotSent {
    pub value: Option<u64>,
    pub updated_at: i64,
}

impl GlobalSlotSent {
    pub fn new() -> Self {
        Self {
            value: None,
            updated_at: 0,
        }
    }
}

pub async fn watch_slot_sent(
    g_slot_sent: Arc<Mutex<GlobalSlotSent>>,
    ws_url: &str,
) -> Result<()> {
    let max_attempts = std::env::var("MAX_SLOT_FETCH_ATTEMPTS")
        .unwrap_or_else(|_| "100".to_string())
        .parse::<u32>()
        .unwrap_or(100);
    let subscription_delay = std::env::var("SLOTS_SUBSCRIPTION_DELAY")
        .unwrap_or_else(|_| "4000".to_string())
        .parse::<u64>()
        .unwrap_or(4000);
    let mut attempts = 0;

    loop {
        match PubsubClient::new(ws_url).await {
            Ok(pubsub_client) => {
                let (mut slot_notifications, _unsubscribe) = pubsub_client
                    .slot_updates_subscribe()
                    .await?;

                while let Some(slot_info) = slot_notifications.next().await {
                    if slot_info.type_field == "firstShredReceived" || slot_info.type_field == "completed" {
                        let mut g = g_slot_sent.lock().unwrap();
                        g.value = Some(slot_info.slot);
                        g.updated_at = chrono::Utc::now().timestamp();
                        attempts = 0;
                    } else {
                        attempts += 1;
                    }

                    if attempts >= max_attempts {
                        error!("Max attempts for fetching slot type 'firstShredReceived' or 'completed' reached, exiting");
                        std::process::exit(1);
                    }

                    // Check if we need to resubscribe
                    {
                        let g = g_slot_sent.lock().unwrap();
                        if g.value.is_some() && chrono::Utc::now().timestamp() - g.updated_at >= 3 {
                            break;
                        }
                    }
                }
            }
            Err(e) => {
                error!("Failed to connect to WebSocket: {}", e);
                tokio::time::sleep(Duration::from_millis(subscription_delay)).await;
            }
        }
    }
}
