use anyhow::{Context, Result};
use futures::{SinkExt, StreamExt};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};
use yellowstone_grpc_client::GeyserGrpcClient;
use yellowstone_grpc_proto::prelude::{
    subscribe_update::UpdateOneof, CommitmentLevel, SubscribeRequest,
};

/// Starts the unified gRPC subscription stream handler
/// This manages transactions in a single bidirectional stream
/// Returns a channel sender that can be used to add new transaction subscriptions
/// Confirmation channel sends (signature: String, slot_landed: u64, confirmed: bool)
pub async fn start_grpc_subscriptions(
    grpc_client: Arc<Mutex<GeyserGrpcClient<impl yellowstone_grpc_client::Interceptor + 'static>>>,
    confirmation_tx: mpsc::Sender<(String, u64, bool)>,
    commitment: CommitmentLevel,
) -> Result<mpsc::Sender<SubscribeRequest>> {
    // info!("[Subscription Manager] Creating initial combined subscription request...");

    // Create initial subscription request with empty filters
    // Transactions will be added dynamically via the sender
    let initial_request = SubscribeRequest {
        transactions: HashMap::new(), // Will be populated dynamically

        commitment: Some(commitment.into()),
        ..Default::default()
    };

    // info!("[Subscription Manager] Subscribing to unified gRPC stream...");
    let (subscribe_tx, mut stream) = {
        let mut client = grpc_client.lock().await;
        client
            .subscribe_with_request(Some(initial_request))
            .await
            .context("Failed to create unified subscription")?
    };

    // info!("[Subscription Manager] Successfully subscribed to unified gRPC stream");

    // Create a channel for subscription requests
    let (subscription_req_tx, mut subscription_req_rx) = mpsc::channel::<SubscribeRequest>(100);

    // Spawn task to forward subscription requests to the sink
    // Move subscribe_tx into this task since it can't be cloned
    tokio::spawn(async move {
        // info!("[Subscription Manager] Starting subscription request forwarder task...");
        let mut subscribe_tx_forward = subscribe_tx;
        while let Some(request) = subscription_req_rx.recv().await {
            if let Err(_e) = subscribe_tx_forward.send(request).await {
                // error!(
                //     "[Subscription Manager] Failed to forward subscription request: {}",
                //     e
                // );
                break;
            }
        }
        // warn!("[Subscription Manager] Subscription request forwarder task ended");
    });

    // Spawn task to handle incoming stream messages
    let confirmation_tx_clone = confirmation_tx.clone();

    tokio::spawn(async move {
        // info!("[Subscription Manager] Starting stream processing task...");
        let mut _message_count = 0u64;

        while let Some(message) = stream.next().await {
            _message_count += 1;

            match message {
                Ok(msg) => {
                    match msg.update_oneof {
                        Some(UpdateOneof::Transaction(tx_update)) => {
                            if let Some(transaction) = tx_update.transaction {
                                let tx_signature =
                                    bs58::encode(&transaction.signature).into_string();
                                let slot_landed = tx_update.slot;
                                let confirmed = transaction
                                    .meta
                                    .as_ref()
                                    .is_some_and(|meta| meta.err.is_none());

                                // Send simple confirmation tuple: (signature, slot_landed, confirmed)
                                if let Err(_e) = confirmation_tx_clone
                                    .send((tx_signature, slot_landed, confirmed))
                                    .await
                                {
                                    // error!("[Subscription Manager] Failed to send confirmation");
                                }
                            }
                        }
                        _ => {
                            // Ignore other update types
                        }
                    }
                }
                Err(_e) => {
                    // error!("[Subscription Manager] Error in stream");
                    break;
                }
            }
        }
    });

    Ok(subscription_req_tx)
}

/// Adds a transaction signature to the subscription dynamically
pub async fn add_transaction_subscription(
    subscribe_tx: &mpsc::Sender<SubscribeRequest>,
    signature: String,
    commitment: CommitmentLevel,
) -> Result<()> {
    // info!(
    //     "[Subscription Manager] Adding transaction subscription for signature: {}",
    //     signature
    // );

    let mut transactions_filter = HashMap::new();
    transactions_filter.insert(
        "transactions".to_string(),
        yellowstone_grpc_proto::prelude::SubscribeRequestFilterTransactions {
            vote: Some(false),
            failed: Some(false),
            signature: Some(signature.clone()),
            account_include: vec![],
            account_exclude: vec![],
            account_required: vec![],
        },
    );

    let request = SubscribeRequest {
        transactions: transactions_filter,
        commitment: Some(commitment.into()),
        ..Default::default()
    };

    subscribe_tx
        .send(request)
        .await
        .map_err(|e| anyhow::anyhow!("Failed to send transaction subscription request: {}", e))?;

    // info!(
    //     "[Subscription Manager] Successfully added transaction subscription for: {}",
    //     signature
    // );
    Ok(())
}
