use anyhow::{Context, Result};
use futures::StreamExt;
use log::{error, warn};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use yellowstone_grpc_client::GeyserGrpcClient;
use yellowstone_grpc_proto::geyser::SlotStatus;
use yellowstone_grpc_proto::prelude::{
    subscribe_update::UpdateOneof, CommitmentLevel, SubscribeRequest, SubscribeRequestFilterSlots,
};

#[derive(Debug)]
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

/// Watches slot updates via gRPC subscription
pub async fn watch_slot(
    grpc_client: Arc<Mutex<GeyserGrpcClient<impl yellowstone_grpc_client::Interceptor + 'static>>>,
    g_slot_sent: Arc<Mutex<GlobalSlotSent>>,
    _commitment: CommitmentLevel,
) -> Result<()> {
    // Create subscription request for slots
    let mut slots_filter = HashMap::new();
    slots_filter.insert(
        "slots".to_string(),
        SubscribeRequestFilterSlots {
            filter_by_commitment: Some(false),
            interslot_updates: Some(true),
        },
    );

    let subscribe_request = SubscribeRequest {
        slots: slots_filter,
        ..Default::default()
    };

    let (_subscribe_tx, mut stream) = {
        let mut client = grpc_client.lock().await;
        client
            .subscribe_with_request(Some(subscribe_request))
            .await
            .context("Failed to create slot subscription")?
    };

    let mut message_count = 0u64;

    while let Some(message) = stream.next().await {
        message_count += 1;

        match message {
            Ok(msg) => {
                match msg.update_oneof {
                    Some(UpdateOneof::Slot(slot_update)) => {
                        // Only update slot on FIRST_SHRED_RECEIVED status
                        if let Ok(status) = SlotStatus::try_from(slot_update.status) {
                            if status == SlotStatus::SlotFirstShredReceived {
                                let slot = slot_update.slot;

                                let mut g = g_slot_sent.lock().await;
                                let _previous_slot = g.value;
                                g.value = Some(slot);
                                g.updated_at = chrono::Utc::now().timestamp();
                                drop(g);

                                // if previous_slot != Some(slot) {
                                //     // info!(
                                //     //     "[Slot Watcher] Updated slot: {} (previous: {:?})",
                                //     //     slot, previous_slot
                                //     // );
                                // }
                            }
                        }
                    }
                    _ => {
                        // Ignore other update types
                    }
                }
            }
            Err(e) => {
                error!(
                    "[Slot Watcher] Error in stream (message #{:?}): {:?}",
                    message_count, e
                );
                // Stream error - will need to reconnect
                break;
            }
        }
    }

    warn!(
        "[Slot Watcher] Stream ended after processing {} messages",
        message_count
    );

    Ok(())
}
