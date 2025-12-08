use anyhow::{Context, Result};
use futures::StreamExt;
use log::{error, info};
use solana_pubkey::Pubkey;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};
use yellowstone_grpc_client::GeyserGrpcClient;
use yellowstone_grpc_proto::prelude::{
    subscribe_update::UpdateOneof, CommitmentLevel, SubscribeRequest,
    SubscribeRequestFilterTransactions,
};

/// Watches all transactions for a specific wallet pubkey via gRPC subscription
/// Sends (signature, slot_landed, confirmed) tuples through the channel
pub async fn watch_transactions(
    grpc_client: Arc<Mutex<GeyserGrpcClient<impl yellowstone_grpc_client::Interceptor + 'static>>>,
    tx_updates_tx: mpsc::Sender<(String, u64, bool)>,
    wallet_pubkey: Pubkey,
    commitment: CommitmentLevel,
) -> Result<()> {
    info!(
        "[Transaction Watcher] Starting transaction watching for wallet: {}",
        wallet_pubkey
    );

    // Create subscription request for all transactions involving the wallet
    let mut transactions_filter = HashMap::new();
    transactions_filter.insert(
        "wallet_transactions".to_string(),
        SubscribeRequestFilterTransactions {
            vote: Some(false),
            failed: Some(false), // Include both successful and failed transactions
            signature: None,     // Watch all transactions, not a specific one
            account_include: vec![wallet_pubkey.to_string()],
            account_exclude: vec![],
            account_required: vec![wallet_pubkey.to_string()],
        },
    );

    let subscribe_request = SubscribeRequest {
        transactions: transactions_filter,
        commitment: Some(commitment.into()),
        ..Default::default()
    };

    let (_subscribe_tx, mut stream) = {
        let mut client = grpc_client.lock().await;
        client
            .subscribe_with_request(Some(subscribe_request))
            .await
            .context("Failed to create transaction subscription")?
    };

    info!("[Transaction Watcher] Successfully subscribed to transaction stream");

    // Process stream updates
    while let Some(message) = stream.next().await {
        match message {
            Ok(msg) => {
                if let Some(update) = msg.update_oneof {
                    match update {
                        UpdateOneof::Transaction(tx_update) => {
                            if let Some(transaction) = tx_update.transaction {
                                let tx_signature =
                                    bs58::encode(&transaction.signature).into_string();
                                let slot_landed = tx_update.slot;
                                let confirmed = transaction
                                    .meta
                                    .as_ref()
                                    .is_some_and(|meta| meta.err.is_none());

                                info!(
                                        "[Transaction Watcher] Transaction update - Signature: {}, Slot: {}, Confirmed: {}",
                                        tx_signature, slot_landed, confirmed
                                    );

                                // Send transaction update through channel
                                if let Err(e) = tx_updates_tx
                                    .send((tx_signature, slot_landed, confirmed))
                                    .await
                                {
                                    error!(
                                            "[Transaction Watcher] Failed to send transaction update: {}",
                                            e
                                        );
                                }
                            }
                        }
                        _ => {
                            // Ignore other update types
                        }
                    }
                }
            }
            Err(e) => {
                error!("[Transaction Watcher] Stream error: {}", e);
                break;
            }
        }
    }
    Ok(())
}
