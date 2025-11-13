mod utils;

use anyhow::Result;
use dotenv::dotenv;
use log::{debug, error, info, warn};
use reqwest::Client;
use serde_json::json;
use solana_client::{nonblocking::rpc_client::RpcClient, rpc_config::RpcSendTransactionConfig};
use solana_compute_budget_interface::ComputeBudgetInstruction;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_system_interface::instruction as system_instruction;
use solana_transaction::Transaction;
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::Instant;
use tokio::sync::{mpsc, Mutex};
use utils::{
    blockhash::{watch_blockhash, GlobalBlockhash},
    grpc_client::{create_grpc_client, parse_commitment},
    metrics::Metrics,
    misc::sleep_ms,
    slot::{watch_slot, GlobalSlotSent},
    subscription_manager::{add_transaction_subscription, start_grpc_subscriptions},
};

#[tokio::main]
async fn main() -> Result<()> {
    info!("=== Starting Ping Thing Client ===");
    dotenv().ok();
    env_logger::init();
    info!("Environment logger initialized");

    info!("Loading configuration from environment variables...");
    let rpc_endpoint = std::env::var("RPC_ENDPOINT").expect("RPC_ENDPOINT must be set");
    info!("RPC_ENDPOINT: {}", rpc_endpoint);

    let grpc_endpoint = std::env::var("GRPC_ENDPOINT").expect("GRPC_ENDPOINT must be set");
    info!("GRPC_ENDPOINT: {}", grpc_endpoint);

    let grpc_x_token = std::env::var("GRPC_X_TOKEN").ok();
    if grpc_x_token.is_some() {
        info!("GRPC_X_TOKEN: [SET]");
    } else {
        info!("GRPC_X_TOKEN: [NOT SET]");
    }

    let sleep_ms_loop = std::env::var("SLEEP_MS_LOOP")
        .unwrap_or_else(|_| "0".to_string())
        .parse::<u64>()
        .unwrap_or(0);
    info!("SLEEP_MS_LOOP: {}ms", sleep_ms_loop);

    let va_api_key = std::env::var("VA_API_KEY").expect("VA_API_KEY must be set");
    info!("VA_API_KEY: [SET]");

    let verbose_log = std::env::var("VERBOSE_LOG")
        .map(|v| v == "true")
        .unwrap_or(false);
    info!("VERBOSE_LOG: {}", verbose_log);

    let commitment_str = std::env::var("COMMITMENT").unwrap_or_else(|_| "confirmed".to_string());
    info!("COMMITMENT: {}", commitment_str);
    let commitment = parse_commitment(&commitment_str)?;
    debug!("Parsed commitment level: {:?}", commitment);

    let tx_confirmation_timeout = std::env::var("TX_CONFIRMATION_TIMEOUT")
        .unwrap_or_else(|_| "60".to_string())
        .parse::<u64>()
        .unwrap_or(60);
    info!("TX_CONFIRMATION_TIMEOUT: {}s", tx_confirmation_timeout);

    let use_priority_fee = std::env::var("USE_PRIORITY_FEE")
        .map(|v| v == "true")
        .unwrap_or(false);
    info!("USE_PRIORITY_FEE: {}", use_priority_fee);

    let priority_fee_micro_lamports = if use_priority_fee {
        std::env::var("PRIORITY_FEE_MICRO_LAMPORTS")
            .unwrap_or_else(|_| "5000".to_string())
            .parse::<u64>()
            .unwrap_or(5000)
    } else {
        0
    };
    info!(
        "PRIORITY_FEE_MICRO_LAMPORTS: {}",
        priority_fee_micro_lamports
    );

    let pinger_region = std::env::var("PINGER_REGION").expect("PINGER_REGION must be set");
    info!("PINGER_REGION: {}", pinger_region);

    let skip_validators_app = std::env::var("SKIP_VALIDATORS_APP")
        .map(|v| v == "true")
        .unwrap_or(false);
    info!("SKIP_VALIDATORS_APP: {}", skip_validators_app);

    let skip_prometheus = std::env::var("SKIP_PROMETHEUS")
        .map(|v| v == "true")
        .unwrap_or(false);
    info!("SKIP_PROMETHEUS: {}", skip_prometheus);

    let pinger_name = std::env::var("PINGER_NAME").unwrap_or_else(|_| "UNSET".to_string());
    info!("PINGER_NAME: {}", pinger_name);
    info!("Configuration loaded successfully");

    info!("Initializing RPC client...");
    let rpc_client = Arc::new(RpcClient::new(rpc_endpoint.clone()));
    info!("RPC client initialized for endpoint: {}", rpc_endpoint);

    info!("Initializing shared state structures...");
    let g_blockhash = Arc::new(Mutex::new(GlobalBlockhash::new()));
    let g_slot_sent = Arc::new(Mutex::new(GlobalSlotSent::new()));
    // HashMap: key = signature, value = (slot_sent, send_time)
    let sent_transactions: Arc<RwLock<HashMap<String, (u64, Instant)>>> =
        Arc::new(RwLock::new(HashMap::new()));
    info!("Shared state structures initialized");

    info!("Loading wallet keypair...");
    let keypair_bytes: Vec<u8> = bs58::decode(
        std::env::var("WALLET_PRIVATE_KEYPAIR").expect("WALLET_PRIVATE_KEYPAIR must be set"),
    )
    .into_vec()
    .expect("Invalid private key");
    debug!("Keypair bytes length: {}", keypair_bytes.len());

    // Keypair is 64 bytes: 32 bytes secret key + 32 bytes public key
    // But new_from_array expects just the 32-byte secret key
    if keypair_bytes.len() < 32 {
        error!(
            "Invalid keypair length: {} (expected at least 32 bytes)",
            keypair_bytes.len()
        );
        return Err(anyhow::anyhow!("Invalid keypair length"));
    }

    let secret_key: [u8; 32] = keypair_bytes[..32]
        .try_into()
        .map_err(|_| anyhow::anyhow!("Invalid keypair length"))?;

    let wallet_keypair = Keypair::new_from_array(secret_key);
    let wallet_pubkey = wallet_keypair.pubkey();
    info!(
        "Wallet keypair loaded successfully. Pubkey: {}",
        wallet_pubkey
    );

    let metrics = if !skip_prometheus {
        info!("Initializing Prometheus metrics...");
        let metrics = Some(Arc::new(Metrics::new()?));
        info!("Prometheus metrics initialized successfully");
        metrics
    } else {
        info!("Prometheus metrics disabled (SKIP_PROMETHEUS=true)");
        None
    };

    if let Some(metrics) = &metrics {
        let metrics_clone = Arc::clone(metrics);
        tokio::spawn(async move {
            let port = std::env::var("PROMETHEUS_PORT")
                .unwrap_or_else(|_| "9090".to_string())
                .parse()
                .unwrap_or(9090);
            info!("Starting Prometheus metrics server on port {}...", port);
            metrics_clone.start_server(port).await;
        });
        info!("Prometheus metrics server task spawned");
    }

    info!("Creating shared gRPC client connection...");
    let grpc_client = create_grpc_client(&grpc_endpoint, grpc_x_token.clone()).await?;
    let shared_grpc_client = Arc::new(Mutex::new(grpc_client));
    info!("Shared gRPC client created successfully");

    // Spawn blockhash watching task
    info!("Starting blockhash watching task...");
    let g_blockhash_clone = Arc::clone(&g_blockhash);
    let grpc_client_blockhash = Arc::clone(&shared_grpc_client);
    tokio::spawn(async move {
        if let Err(e) = watch_blockhash(grpc_client_blockhash, g_blockhash_clone, commitment).await
        {
            error!("[Blockhash Watcher] Task failed: {}", e);
        }
    });
    info!("Blockhash watching task spawned");

    // Spawn slot watching task
    info!("Starting slot watching task...");
    let g_slot_sent_clone = Arc::clone(&g_slot_sent);
    let grpc_client_slot = Arc::clone(&shared_grpc_client);
    tokio::spawn(async move {
        if let Err(e) = watch_slot(grpc_client_slot, g_slot_sent_clone, commitment).await {
            error!("[Slot Watcher] Task failed: {}", e);
        }
    });
    info!("Slot watching task spawned");

    // Create channel for transaction confirmations: (signature, slot_landed, confirmed)
    let (confirmation_tx, mut confirmation_rx) = mpsc::channel::<(String, u64, bool)>(100);

    info!("Starting unified gRPC subscription stream...");
    let grpc_client_subscriptions = Arc::clone(&shared_grpc_client);
    let subscribe_tx = start_grpc_subscriptions(
        grpc_client_subscriptions,
        confirmation_tx.clone(),
        commitment,
    )
    .await?;
    info!("Unified gRPC subscription stream started");
    info!("=== Entering main transaction loop ===");

    loop {
        if sleep_ms_loop > 0 {
            debug!("Sleeping {}ms before next transaction cycle", sleep_ms_loop);
            sleep_ms(sleep_ms_loop).await;
        }

        info!("=== Starting new transaction cycle ===");

        // Wait for fresh slot and blockhash
        let (blockhash, slot_sent) = loop {
            let now = chrono::Utc::now().timestamp();
            let g_blockhash = g_blockhash.lock().await;
            let g_slot = g_slot_sent.lock().await;

            if now - g_blockhash.updated_at < 10000 && now - g_slot.updated_at < 50 {
                break (g_blockhash.value, g_slot.value);
            }

            drop(g_blockhash);
            drop(g_slot);
            sleep_ms(1).await;
        };

        let blockhash = match blockhash {
            Some(h) => h,
            None => {
                warn!("Blockhash not available, skipping transaction cycle");
                continue;
            }
        };

        let slot_sent = match slot_sent {
            Some(s) => s,
            None => {
                warn!("Slot not available, skipping transaction cycle");
                continue;
            }
        };

        // Build transaction instructions
        info!("[TX] Building transaction instructions...");
        let instructions = vec![
            ComputeBudgetInstruction::set_compute_unit_limit(500),
            ComputeBudgetInstruction::set_compute_unit_price(priority_fee_micro_lamports),
            system_instruction::transfer(&wallet_keypair.pubkey(), &wallet_keypair.pubkey(), 5000),
        ];

        // Create and sign transaction
        info!("[TX] Creating transaction with blockhash: {}", blockhash);
        let message =
            Message::new_with_blockhash(&instructions, Some(&wallet_keypair.pubkey()), &blockhash);
        let tx = Transaction::new(&[&wallet_keypair], message, blockhash);

        // Get signature from transaction
        let signature = tx.signatures[0].to_string();
        info!("[TX] Transaction signed - Signature: {}", signature);

        // Store signature and slot in sent_transactions map
        let send_time = Instant::now();
        {
            let mut sent = sent_transactions.write().unwrap();
            sent.insert(signature.clone(), (slot_sent, send_time));
        }
        info!("[TX] Stored transaction in sent_transactions map");

        // Subscribe to transaction confirmation via gRPC
        info!("[TX] Subscribing to transaction confirmation...");
        if let Err(e) =
            add_transaction_subscription(&subscribe_tx, signature.clone(), commitment).await
        {
            error!("[TX] Failed to add transaction subscription: {}", e);
            continue;
        }

        // Start 20-second resend loop with confirmation handling
        info!("[TX] Starting 20-second resend loop...");
        let timeout_duration = tokio::time::Duration::from_secs(20);
        let timeout = tokio::time::sleep(timeout_duration);
        tokio::pin!(timeout);

        let mut resend_interval = tokio::time::interval(tokio::time::Duration::from_millis(2000));
        resend_interval.tick().await; // First tick completes immediately

        let mut confirmed = false;
        let mut slot_landed = 0u64;
        let mut is_success = false;

        loop {
            tokio::select! {
                // Timeout after 20 seconds
                _ = &mut timeout => {
                    warn!("[TX] Transaction {} timed out after 20 seconds", signature);
                    break;
                }

                // Confirmation received
                Some((conf_signature, conf_slot_landed, conf_success)) = confirmation_rx.recv() => {
                    if conf_signature == signature {
                        info!("[TX] Confirmation received for transaction: {}", signature);
                        confirmed = true;
                        slot_landed = conf_slot_landed;
                        is_success = conf_success;
                        break;
                    }
                }

                // Resend interval tick
                _ = resend_interval.tick() => {
                    info!("[TX] Resending transaction: {}", signature);
                    match rpc_client.send_transaction_with_config(
                        &tx,
                        RpcSendTransactionConfig {
                            skip_preflight: true,
                            ..Default::default()
                        },
                    ).await {
                        Ok(_) => {
                            debug!("[TX] Successfully resent transaction");
                        }
                        Err(e) => {
                            warn!("[TX] Failed to resend transaction: {}", e);
                        }
                    }
                }
            }
        }

        // Get send data from sent_transactions map
        let (stored_slot_sent, stored_send_time) = {
            let sent = sent_transactions.read().unwrap();
            sent.get(&signature).copied()
        }
        .unwrap_or((slot_sent, send_time));

        // Calculate latencies
        let time_latency_ms = stored_send_time.elapsed().as_millis() as u64;

        if confirmed && is_success {
            let slot_latency = slot_landed.saturating_sub(stored_slot_sent);
            info!(
                "[TX] Transaction confirmed - Signature: {}, Slot latency: {} (landed: {}, sent: {}), Time latency: {}ms",
                signature, slot_latency, slot_landed, stored_slot_sent, time_latency_ms
            );

            // Validate slot ordering
            if slot_landed < stored_slot_sent {
                error!(
                    "[TX] ERROR: Slot {} < {}. Not sending to Validators.app",
                    slot_landed, stored_slot_sent
                );
            } else {
                // Send to Validators.app
                if !skip_validators_app {
                    info!("[TX] Sending metrics to Validators.app...");
                    let payload = json!({
                        "time": time_latency_ms,
                        "signature": signature,
                        "transaction_type": "transfer",
                        "success": true,
                        "application": "web3",
                        "commitment_level": commitment_str,
                        "slot_sent": stored_slot_sent.to_string(),
                        "slot_landed": slot_landed.to_string(),
                        "priority_fee_micro_lamports": priority_fee_micro_lamports.to_string(),
                        "pinger_region": pinger_region,
                    });

                    let client = Client::new();
                    match client
                        .post("https://www.validators.app/api/v1/ping-thing/mainnet")
                        .header("Content-Type", "application/json")
                        .header("Token", &va_api_key)
                        .json(&payload)
                        .send()
                        .await
                    {
                        Ok(response) => {
                            if response.status().is_success() {
                                info!("[TX] Successfully sent metrics to Validators.app");
                            } else {
                                error!(
                                    "[TX] Failed to send to Validators.app - Status: {}",
                                    response.status()
                                );
                            }
                        }
                        Err(e) => {
                            error!("[TX] Error sending to Validators.app: {}", e);
                        }
                    }
                }

                // Update Prometheus metrics
                if let Some(ref metrics) = metrics {
                    metrics
                        .confirmation_latency
                        .with_label_values(&[&pinger_name])
                        .observe(time_latency_ms as f64);
                    metrics
                        .slot_latency
                        .with_label_values(&[&pinger_name])
                        .observe(slot_latency as f64);
                }
            }
        } else {
            warn!(
                "[TX] Transaction {} not confirmed or failed after 20 seconds",
                signature
            );
        }

        // Remove from sent_transactions
        {
            let mut sent = sent_transactions.write().unwrap();
            sent.remove(&signature);
        }

        info!("=== Transaction cycle completed ===");
    }
}
