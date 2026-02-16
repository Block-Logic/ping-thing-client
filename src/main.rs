mod utils;

use anyhow::Result;
use base64::prelude::BASE64_STANDARD;
use base64::Engine;
use dotenv::dotenv;
use log::{debug, error, info, warn};
use reqwest::Client;
use serde_json::{json, Value};
use solana_client::{nonblocking::rpc_client::RpcClient, rpc_config::RpcSendTransactionConfig};
use solana_compute_budget_interface::ComputeBudgetInstruction;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_system_interface::instruction as system_instruction;
use solana_transaction::Transaction;
use solana_transaction_status::UiTransactionEncoding;
use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, RwLock};
use std::time::Instant;
use tokio::sync::{mpsc, Mutex};
use utils::{
    blockhash::{watch_blockhash, GlobalBlockhash},
    grpc_client::{create_grpc_client, parse_commitment},
    metrics::Metrics,
    misc::sleep_ms,
    priority_fees::{watch_prioritization_fees, GlobalPriorityFees},
    slot::{watch_slot, GlobalSlotSent},
    subscription_manager::watch_transactions,
};

#[derive(Debug)]
enum SendTransactionRequestError {
    TransactionSerializationFailed { reason: String },
    SendTransactionRequestFailed {
        endpoint: String,
        send_transaction_request_error: reqwest::Error,
    },
    SendTransactionResponseReadFailed {
        endpoint: String,
        send_transaction_response_read_error: reqwest::Error,
    },
    SendTransactionRequestNonSuccessStatus {
        endpoint: String,
        status_code: u16,
        response_body: String,
    },
    SendTransactionResponseInvalidJson {
        endpoint: String,
        response_body: String,
        reason: String,
    },
    SendTransactionResponseRpcError {
        endpoint: String,
        code: i64,
        message: String,
    },
    SendTransactionResponseMissingSignature { endpoint: String, response_body: String },
    SendTransactionResponseSignatureMismatch {
        endpoint: String,
        expected_signature: String,
        actual_signature: String,
    },
    RpcClientSendTransactionFailed {
        rpc_client_send_transaction_error: solana_client::client_error::ClientError,
    },
}

impl fmt::Display for SendTransactionRequestError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SendTransactionRequestError::TransactionSerializationFailed { reason } => {
                write!(formatter, "Failed to serialize transaction: {}", reason)
            }
            SendTransactionRequestError::SendTransactionRequestFailed {
                endpoint,
                send_transaction_request_error,
            } => {
                write!(
                    formatter,
                    "Failed to send sendTransaction request to {}: {:?}",
                    endpoint, send_transaction_request_error
                )
            }
            SendTransactionRequestError::SendTransactionResponseReadFailed {
                endpoint,
                send_transaction_response_read_error,
            } => {
                write!(
                    formatter,
                    "Failed to read sendTransaction response from {}: {:?}",
                    endpoint, send_transaction_response_read_error
                )
            }
            SendTransactionRequestError::SendTransactionRequestNonSuccessStatus {
                endpoint,
                status_code,
                response_body,
            } => {
                write!(
                    formatter,
                    "sendTransaction request to {} failed with status {}: {}",
                    endpoint, status_code, response_body
                )
            }
            SendTransactionRequestError::SendTransactionResponseInvalidJson {
                endpoint,
                response_body,
                reason,
            } => {
                write!(
                    formatter,
                    "sendTransaction response from {} had invalid JSON: {} ({})",
                    endpoint, response_body, reason
                )
            }
            SendTransactionRequestError::SendTransactionResponseRpcError {
                endpoint,
                code,
                message,
            } => {
                write!(
                    formatter,
                    "sendTransaction response from {} returned error {}: {}",
                    endpoint, code, message
                )
            }
            SendTransactionRequestError::SendTransactionResponseMissingSignature {
                endpoint,
                response_body,
            } => {
                write!(
                    formatter,
                    "sendTransaction response from {} missing result signature: {}",
                    endpoint, response_body
                )
            }
            SendTransactionRequestError::SendTransactionResponseSignatureMismatch {
                endpoint,
                expected_signature,
                actual_signature,
            } => {
                write!(
                    formatter,
                    "sendTransaction response from {} returned mismatched signature {} (expected {})",
                    endpoint, actual_signature, expected_signature
                )
            }
            SendTransactionRequestError::RpcClientSendTransactionFailed {
                rpc_client_send_transaction_error,
            } => write!(
                formatter,
                "RPC client sendTransaction failed: {:?}",
                rpc_client_send_transaction_error
            ),
        }
    }
}

impl std::error::Error for SendTransactionRequestError {}

async fn send_transaction_using_configured_send_transaction_endpoint_or_rpc_client(
    send_transaction_endpoint: Option<&str>,
    send_transaction_http_client: &Client,
    rpc_client: &RpcClient,
    transaction: &Transaction,
    send_transaction_config: RpcSendTransactionConfig,
) -> Result<(), SendTransactionRequestError> {
    if let Some(send_transaction_endpoint_value) = send_transaction_endpoint {
        let serialized_transaction_bytes = bincode::serialize(transaction).map_err(|error| {
            SendTransactionRequestError::TransactionSerializationFailed {
                reason: error.to_string(),
            }
        })?;
        let serialized_transaction_base64 = BASE64_STANDARD.encode(serialized_transaction_bytes);
        let mut adjusted_send_transaction_config = send_transaction_config;
        if adjusted_send_transaction_config.encoding.is_none() {
            adjusted_send_transaction_config.encoding = Some(UiTransactionEncoding::Base64);
        }
        let request_body = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "sendTransaction",
            "params": [serialized_transaction_base64, adjusted_send_transaction_config],
        });

        let response = send_transaction_http_client
            .post(send_transaction_endpoint_value)
            .json(&request_body)
            .send()
            .await
            .map_err(
                |send_transaction_request_error| SendTransactionRequestError::SendTransactionRequestFailed {
                    endpoint: send_transaction_endpoint_value.to_string(),
                    send_transaction_request_error,
                },
            )?;

        let response_status = response.status();
        let response_body = response
            .text()
            .await
            .map_err(
                |send_transaction_response_read_error| SendTransactionRequestError::SendTransactionResponseReadFailed {
                    endpoint: send_transaction_endpoint_value.to_string(),
                    send_transaction_response_read_error,
                },
            )?;

        if !response_status.is_success() {
            return Err(
                SendTransactionRequestError::SendTransactionRequestNonSuccessStatus {
                    endpoint: send_transaction_endpoint_value.to_string(),
                    status_code: response_status.as_u16(),
                    response_body,
                },
            );
        }

        let response_value: Value = serde_json::from_str(&response_body).map_err(|error| {
            SendTransactionRequestError::SendTransactionResponseInvalidJson {
                endpoint: send_transaction_endpoint_value.to_string(),
                response_body: response_body.clone(),
                reason: error.to_string(),
            }
        })?;

        if let Some(error_value) = response_value.get("error") {
            let error_code = error_value
                .get("code")
                .and_then(|value| value.as_i64())
                .unwrap_or(0);
            let error_message = error_value
                .get("message")
                .and_then(|value| value.as_str())
                .unwrap_or("Unknown RPC error")
                .to_string();
            return Err(SendTransactionRequestError::SendTransactionResponseRpcError {
                endpoint: send_transaction_endpoint_value.to_string(),
                code: error_code,
                message: error_message,
            });
        }

        let response_signature = response_value
            .get("result")
            .and_then(|value| value.as_str())
            .ok_or_else(|| {
                SendTransactionRequestError::SendTransactionResponseMissingSignature {
                    endpoint: send_transaction_endpoint_value.to_string(),
                    response_body: response_body.clone(),
                }
            })?;

        let expected_signature = transaction.signatures[0].to_string();
        if response_signature != expected_signature {
            return Err(
                SendTransactionRequestError::SendTransactionResponseSignatureMismatch {
                    endpoint: send_transaction_endpoint_value.to_string(),
                    expected_signature,
                    actual_signature: response_signature.to_string(),
                },
            );
        }

        Ok(())
    } else {
        rpc_client
            .send_transaction_with_config(transaction, send_transaction_config)
            .await
            .map(|_| ())
            .map_err(
                |rpc_client_send_transaction_error| SendTransactionRequestError::RpcClientSendTransactionFailed {
                    rpc_client_send_transaction_error,
                },
            )
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    info!("=== Starting Ping Thing Client ===");
    dotenv().ok();
    env_logger::init();
    info!("Environment logger initialized");

    info!("Loading configuration from environment variables...");
    let rpc_endpoint = std::env::var("RPC_ENDPOINT").expect("RPC_ENDPOINT must be set");
    info!("RPC_ENDPOINT: {:?}", rpc_endpoint);

    let send_transaction_endpoint_from_environment_variable =
        std::env::var("SEND_TX_ENDPOINT").ok();
    if let Some(send_transaction_endpoint_value) =
        &send_transaction_endpoint_from_environment_variable
    {
        info!("SEND_TX_ENDPOINT: {:?}", send_transaction_endpoint_value);
    } else {
        info!("SEND_TX_ENDPOINT: [NOT SET]");
    }
    let resolved_transaction_send_endpoint = send_transaction_endpoint_from_environment_variable
        .clone()
        .unwrap_or_else(|| rpc_endpoint.clone());
    info!(
        "TRANSACTION_SEND_ENDPOINT: {:?}",
        resolved_transaction_send_endpoint
    );

    let grpc_endpoint = std::env::var("GRPC_ENDPOINT").expect("GRPC_ENDPOINT must be set");
    info!("GRPC_ENDPOINT: {:?}", grpc_endpoint);

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
    info!("SLEEP_MS_LOOP: {:?}ms", sleep_ms_loop);

    let txs_per_minute_limit = std::env::var("TXS_PER_MINUTE_LIMIT")
        .unwrap_or_else(|_| "10".to_string())
        .parse::<u64>()
        .unwrap_or(10);
    info!("TXS_PER_MINUTE_LIMIT: {:?}", txs_per_minute_limit);

    let va_api_key = std::env::var("VA_API_KEY").expect("VA_API_KEY must be set");
    info!("VA_API_KEY: [SET]");

    let verbose_log = std::env::var("VERBOSE_LOG")
        .map(|v| v == "true")
        .unwrap_or(false);
    info!("VERBOSE_LOG: {:?}", verbose_log);

    let commitment_str = std::env::var("COMMITMENT").unwrap_or_else(|_| "confirmed".to_string());
    info!("COMMITMENT: {:?}", commitment_str);
    let commitment = parse_commitment(&commitment_str)?;
    debug!("Parsed commitment level: {:?}", commitment);

    let tx_confirmation_timeout = std::env::var("TX_CONFIRMATION_TIMEOUT")
        .unwrap_or_else(|_| "60".to_string())
        .parse::<u64>()
        .unwrap_or(60);
    info!("TX_CONFIRMATION_TIMEOUT: {:?}s", tx_confirmation_timeout);

    let use_priority_fee = std::env::var("USE_PRIORITY_FEE")
        .map(|v| v == "true")
        .unwrap_or(false);
    info!("USE_PRIORITY_FEE: {:?}", use_priority_fee);

    let priority_fee_micro_lamports = if use_priority_fee {
        std::env::var("PRIORITY_FEE_MICRO_LAMPORTS")
            .unwrap_or_else(|_| "5000".to_string())
            .parse::<u64>()
            .unwrap_or(5000)
    } else {
        0
    };
    info!(
        "PRIORITY_FEE_MICRO_LAMPORTS: {:?}",
        priority_fee_micro_lamports
    );

    let pinger_region = std::env::var("PINGER_REGION").expect("PINGER_REGION must be set");
    info!("PINGER_REGION: {:?}", pinger_region);

    let skip_validators_app = std::env::var("SKIP_VALIDATORS_APP")
        .map(|v| v == "true")
        .unwrap_or(false);
    info!("SKIP_VALIDATORS_APP: {:?}", skip_validators_app);

    let skip_prometheus = std::env::var("SKIP_PROMETHEUS")
        .map(|v| v == "true")
        .unwrap_or(false);
    info!("SKIP_PROMETHEUS: {:?}", skip_prometheus);

    let pinger_name = std::env::var("PINGER_NAME").unwrap_or_else(|_| "UNSET".to_string());
    info!("PINGER_NAME: {:?}", pinger_name);

    let priority_fee_percentile = std::env::var("PRIORITY_FEE_PERCENTILE")
        .unwrap_or_else(|_| "5000".to_string())
        .parse::<u16>()
        .unwrap_or(5000);
    info!("PRIORITY_FEE_PERCENTILE: {:?}", priority_fee_percentile);

    let rpc_client = Arc::new(RpcClient::new(rpc_endpoint.clone()));
    let send_transaction_http_client = Client::new();

    let g_blockhash = Arc::new(Mutex::new(GlobalBlockhash::new()));
    let g_slot_sent = Arc::new(Mutex::new(GlobalSlotSent::new()));
    let g_priority_fees = Arc::new(Mutex::new(GlobalPriorityFees::new()));
    // HashMap: key = signature, value = (slot_sent, send_time)
    let sent_transactions: Arc<RwLock<HashMap<String, (u64, Instant)>>> =
        Arc::new(RwLock::new(HashMap::new()));

    let keypair_bytes: Vec<u8> = bs58::decode(
        std::env::var("WALLET_PRIVATE_KEYPAIR").expect("WALLET_PRIVATE_KEYPAIR must be set"),
    )
    .into_vec()
    .expect("Invalid private key");

    // Keypair is 64 bytes: 32 bytes secret key + 32 bytes public key
    // But new_from_array expects just the 32-byte secret key
    if keypair_bytes.len() < 32 {
        error!(
            "Invalid keypair length: {:?} (expected at least 32 bytes)",
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
        "Wallet keypair loaded successfully. Pubkey: {:?}",
        wallet_pubkey
    );

    let metrics = if !skip_prometheus {
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
            metrics_clone.start_server(port).await;
        });
        info!("Prometheus metrics server task spawned");
    }

    let grpc_client = create_grpc_client(&grpc_endpoint, grpc_x_token.clone()).await?;
    let shared_grpc_client = Arc::new(Mutex::new(grpc_client));

    // Spawn blockhash watching task
    let g_blockhash_clone = Arc::clone(&g_blockhash);
    let grpc_client_blockhash = Arc::clone(&shared_grpc_client);
    tokio::spawn(async move {
        if let Err(e) = watch_blockhash(grpc_client_blockhash, g_blockhash_clone, commitment).await
        {
            error!(
                "[Blockhash Watcher] Task failed for commitment {:?}: {:?}",
                commitment, e
            );
        }
    });
    info!("Blockhash watching task spawned");

    // Spawn slot watching task
    let g_slot_sent_clone = Arc::clone(&g_slot_sent);
    let grpc_client_slot = Arc::clone(&shared_grpc_client);
    tokio::spawn(async move {
        if let Err(e) = watch_slot(grpc_client_slot, g_slot_sent_clone, commitment).await {
            error!(
                "[Slot Watcher] Task failed for commitment {:?}: {:?}",
                commitment, e
            );
        }
    });
    info!("Slot watching task spawned");

    if use_priority_fee {
        let g_priority_fees_clone = Arc::clone(&g_priority_fees);
        tokio::spawn(async move {
            if let Err(e) = watch_prioritization_fees(
                &rpc_endpoint,
                g_priority_fees_clone,
                priority_fee_percentile,
            )
            .await
            {
                error!(
                    "[Priority Fees Watcher] Task failed for endpoint {:?}: {:?}",
                    rpc_endpoint, e
                );
            }
        });
        info!("Priority fees watching task spawned");
    } else {
        info!("Priority fees watching task skipped (USE_PRIORITY_FEE=true)");
    }

    // Create channel for transaction confirmations: (signature, slot_landed, confirmed)
    let (tx_updates_tx, mut tx_updates_rx) = mpsc::channel::<(String, u64, bool)>(100);

    // Spawn transaction watching task for the wallet
    let grpc_client_transactions = Arc::clone(&shared_grpc_client);
    tokio::spawn(async move {
        if let Err(e) = watch_transactions(
            grpc_client_transactions,
            tx_updates_tx,
            wallet_pubkey,
            commitment,
        )
        .await
        {
            error!(
                "[Transaction Watcher] Task failed for wallet {:?}: {:?}",
                wallet_pubkey, e
            );
        }
    });
    info!("Transaction watching task spawned");
    info!("=== Entering main transaction loop ===");

    let tx_window_duration = std::time::Duration::from_secs(60);
    let mut tx_count: u64 = 0;
    let mut tx_window_start = Instant::now();

    loop {
        if sleep_ms_loop > 0 {
            info!("Sleeping {:?}ms before next transaction cycle", sleep_ms_loop);
            sleep_ms(sleep_ms_loop).await;
        }

        if tx_window_start.elapsed() >= tx_window_duration {
            tx_count = 0;
            tx_window_start = Instant::now();
            info!("[TX] Rate limit window reset");
        }

        if tx_count >= txs_per_minute_limit {
            let elapsed = tx_window_start.elapsed();
            let wait_duration = tx_window_duration.saturating_sub(elapsed);
            let wait_ms = wait_duration.as_millis() as u64;
            info!(
                "[TX] Rate limit reached ({:?} per minute). Waiting {:?}ms for reset",
                txs_per_minute_limit, wait_ms
            );
            sleep_ms(wait_ms).await;
            tx_count = 0;
            tx_window_start = Instant::now();
            info!("[TX] Rate limit window reset after wait");
        }

        info!("=== Starting new transaction cycle ===");

        // Wait for fresh slot and blockhash
        let (blockhash, slot_sent) = loop {
            let now = chrono::Utc::now().timestamp();
            let g_blockhash = g_blockhash.lock().await;
            let g_slot = g_slot_sent.lock().await;

            // Calculate time since last update for both (in seconds)
            let blockhash_time_since = now - g_blockhash.updated_at;
            let slot_time_since = now - g_slot.updated_at;

            // Panic if either blockhash or slot hasn't been updated for more than 10 seconds
            if blockhash_time_since >= 10 || slot_time_since >= 10 {
                error!(
                    "[PANIC] Blockhash or slot not updated within 10 seconds! \
                     Blockhash time since last update: {:?}s, Slot time since last update: {:?}s",
                    blockhash_time_since, slot_time_since
                );
                panic!(
                    "Blockhash or slot stale for more than 10 seconds. \
                     Blockhash: {}s since last update, Slot: {}s since last update. \
                     Exiting process.",
                    blockhash_time_since, slot_time_since
                );
            }

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

        let current_priority_fee = if use_priority_fee {
            let g_fees = g_priority_fees.lock().await;
            g_fees.value.unwrap_or(0)
        } else {
            0 // USE_PRIORITY_FEE=true, so set fees to 0
        };

        // Build transaction instructions
        let instructions = vec![
            ComputeBudgetInstruction::set_compute_unit_limit(500),
            ComputeBudgetInstruction::set_compute_unit_price(current_priority_fee),
            system_instruction::transfer(&wallet_keypair.pubkey(), &wallet_keypair.pubkey(), 5000),
        ];

        // Create and sign transaction
        let message =
            Message::new_with_blockhash(&instructions, Some(&wallet_keypair.pubkey()), &blockhash);
        let tx = Transaction::new(&[&wallet_keypair], message, blockhash);

        // Get signature from transaction
        let signature = tx.signatures[0].to_string();
        info!("[TX] Transaction created with signature: {:?}", signature);

        // Send transaction initially
        info!("[TX] Sending initial transaction: {:?}", signature);
        let send_time = Instant::now();
        match send_transaction_using_configured_send_transaction_endpoint_or_rpc_client(
            send_transaction_endpoint_from_environment_variable.as_deref(),
            &send_transaction_http_client,
            rpc_client.as_ref(),
            &tx,
            RpcSendTransactionConfig {
                skip_preflight: true,
                max_retries: Some(0),
                ..Default::default()
            },
        )
        .await
        {
            Ok(_) => {
                info!("[TX] Successfully sent initial transaction");
            }
            Err(send_transaction_request_error) => match &send_transaction_request_error {
                SendTransactionRequestError::SendTransactionRequestFailed {
                    endpoint,
                    send_transaction_request_error,
                } => {
                    error!(
                        "[TX] Failed to send initial transaction for signature {:?} to endpoint {:?}: {:?}",
                        signature, endpoint, send_transaction_request_error
                    );
                }
                SendTransactionRequestError::SendTransactionResponseReadFailed {
                    endpoint,
                    send_transaction_response_read_error,
                } => {
                    error!(
                        "[TX] Failed to read sendTransaction response for signature {:?} from endpoint {:?}: {:?}",
                        signature, endpoint, send_transaction_response_read_error
                    );
                }
                SendTransactionRequestError::RpcClientSendTransactionFailed {
                    rpc_client_send_transaction_error,
                } => {
                    error!(
                        "[TX] Failed to send initial transaction for signature {:?} via RPC client: {:?}",
                        signature, rpc_client_send_transaction_error
                    );
                }
                _ => {
                    error!(
                        "[TX] Failed to send initial transaction for signature {:?}: {:?}",
                        signature, send_transaction_request_error
                    );
                }
            },
        }
        // Count only initial sends; resends are not counted
        tx_count += 1;

        // Store signature and slot in sent_transactions map
        {
            let mut sent = sent_transactions.write().unwrap();
            sent.insert(signature.clone(), (slot_sent, send_time));
        }
        info!("[TX] Stored transaction in sent_transactions map");

        // Start 20-second resend loop with confirmation handling
        info!("[TX] Starting resend loop (20 second timeout)...");
        let timeout_duration = tokio::time::Duration::from_secs(20);
        let resend_interval_duration = tokio::time::Duration::from_millis(2000);

        let mut confirmed = false;
        let mut slot_landed = 0u64;
        let mut is_success = false;

        let start_time = Instant::now();

        loop {
            // Check if timeout elapsed
            if start_time.elapsed() >= timeout_duration {
                warn!("[TX] Transaction {:?} timed out after 20 seconds", signature);
                break;
            }

            // Try to receive confirmation with timeout for resend interval
            match tokio::time::timeout(resend_interval_duration, tx_updates_rx.recv()).await {
                Ok(Some((conf_signature, conf_slot_landed, conf_success))) => {
                    // Received a confirmation notification
                    if conf_signature == signature {
                        // This is the confirmation for our current transaction
                        info!("[TX] Confirmation received for transaction: {:?}", signature);
                        confirmed = true;
                        slot_landed = conf_slot_landed;
                        is_success = conf_success;
                        break; // Exit resend loop
                    } else {
                        // This is a confirmation for a different transaction, ignore it
                        debug!(
                            "[TX] Received confirmation for different transaction: {:?}, current: {:?}",
                            conf_signature, signature
                        );
                    }
                }
                Ok(None) => {
                    // Channel closed
                    error!(
                        "[TX] Transaction update channel closed unexpectedly for signature: {:?}",
                        signature
                    );
                    break;
                }
                Err(_) => {
                    // Timeout elapsed (2 seconds passed), resend transaction
                    info!("[TX] Resending transaction: {:?}", signature);
                    match send_transaction_using_configured_send_transaction_endpoint_or_rpc_client(
                        send_transaction_endpoint_from_environment_variable.as_deref(),
                        &send_transaction_http_client,
                        rpc_client.as_ref(),
                        &tx,
                        RpcSendTransactionConfig {
                            skip_preflight: true,
                            max_retries: Some(0),
                            ..Default::default()
                        },
                    )
                    .await
                    {
                        Ok(_) => {
                            debug!("[TX] Successfully resent transaction");
                        }
                        Err(send_transaction_request_error) => match &send_transaction_request_error {
                            SendTransactionRequestError::SendTransactionRequestFailed {
                                endpoint,
                                send_transaction_request_error,
                            } => {
                                error!(
                                    "[TX] Failed to resend transaction for signature {:?} to endpoint {:?}: {:?}",
                                    signature, endpoint, send_transaction_request_error
                                );
                            }
                            SendTransactionRequestError::SendTransactionResponseReadFailed {
                                endpoint,
                                send_transaction_response_read_error,
                            } => {
                                error!(
                                    "[TX] Failed to read sendTransaction response for resend signature {:?} from endpoint {:?}: {:?}",
                                    signature, endpoint, send_transaction_response_read_error
                                );
                            }
                            SendTransactionRequestError::RpcClientSendTransactionFailed {
                                rpc_client_send_transaction_error,
                            } => {
                                error!(
                                    "[TX] Failed to resend transaction for signature {:?} via RPC client: {:?}",
                                    signature, rpc_client_send_transaction_error
                                );
                            }
                            _ => {
                                error!(
                                    "[TX] Failed to resend transaction for signature {:?}: {:?}",
                                    signature, send_transaction_request_error
                                );
                            }
                        },
                    }
                }
            }
        }

        info!(
            "[TX] Exited resend loop - Confirmed: {:?}, Success: {:?}",
            confirmed, is_success
        );

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
                "[TX] Transaction confirmed - Signature: {:?}, Slot latency: {:?} (landed: {:?}, sent: {:?}), Time latency: {:?}ms",
                signature, slot_latency, slot_landed, stored_slot_sent, time_latency_ms
            );

            // Validate slot ordering
            if slot_landed < stored_slot_sent {
                error!(
                    "[TX] ERROR: Slot {:?} < {:?}. Not sending to Validators.app",
                    slot_landed, stored_slot_sent
                );
            } else {
                let payload = json!({
                    "time": time_latency_ms,
                    "signature": signature,
                    "transaction_type": "transfer",
                    "success": true,
                    "application": "web3",
                    "commitment_level": commitment_str,
                    "slot_sent": stored_slot_sent.to_string(),
                    "slot_landed": slot_landed.to_string(),
                    "priority_fee_micro_lamports": current_priority_fee.to_string(),
                    "priority_fee_percentile": priority_fee_percentile/100,
                    "pinger_region": pinger_region,
                });

                info!("[TX] VA Payload {:?}", payload);

                if !skip_validators_app {
                    info!("[TX] Sending metrics to Validators.app...");

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
                                    "[TX] Failed to send to Validators.app for signature {:?} - Status: {:?}",
                                    signature, response.status()
                                );
                            }
                        }
                        Err(e) => {
                            error!(
                                "[TX] Error sending to Validators.app for signature {:?}: {:?}",
                                signature, e
                            );
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
                "[TX] Transaction {:?} not confirmed or failed after 20 seconds",
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
