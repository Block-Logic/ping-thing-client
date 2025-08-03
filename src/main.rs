mod utils;

use anyhow::Result;
use dotenv::dotenv;
use log::{error, info};
use reqwest::Client;
use serde_json::json;
use solana_client::{
    nonblocking::rpc_client::RpcClient,
    rpc_config::{RpcSendTransactionConfig, RpcTransactionConfig},
};
use solana_sdk::{
    compute_budget::ComputeBudgetInstruction,
    hash::Hash,
    message::Message,
    pubkey::Pubkey,
    signature::{Keypair, Signature},
    system_instruction,
    transaction::Transaction,
};
use std::{
    str::FromStr,
    sync::{Arc, Mutex},
    time::Instant,
};
use utils::{
    blockhash::{watch_blockhash, GlobalBlockhash},
    metrics::Metrics,
    misc::sleep_ms,
    slot::{watch_slot_sent, GlobalSlotSent},
};

#[tokio::main]
async fn main() -> Result<()> {
    dotenv().ok();
    env_logger::init();

    let rpc_endpoint = std::env::var("RPC_ENDPOINT").expect("RPC_ENDPOINT must be set");
    let ws_endpoint = std::env::var("WS_ENDPOINT").expect("WS_ENDPOINT must be set");
    let sleep_ms_rpc = std::env::var("SLEEP_MS_RPC")
        .unwrap_or_else(|_| "2000".to_string())
        .parse::<u64>()
        .unwrap_or(2000);
    let sleep_ms_loop = std::env::var("SLEEP_MS_LOOP")
        .unwrap_or_else(|_| "0".to_string())
        .parse::<u64>()
        .unwrap_or(0);
    let va_api_key = std::env::var("VA_API_KEY").expect("VA_API_KEY must be set");
    let verbose_log = std::env::var("VERBOSE_LOG")
        .map(|v| v == "true")
        .unwrap_or(false);
    let commitment = std::env::var("COMMITMENT").unwrap_or_else(|_| "confirmed".to_string());
    let use_priority_fee = std::env::var("USE_PRIORITY_FEE")
        .map(|v| v == "true")
        .unwrap_or(false);
    let priority_fee_micro_lamports = if use_priority_fee {
        std::env::var("PRIORITY_FEE_MICRO_LAMPORTS")
            .unwrap_or_else(|_| "5000".to_string())
            .parse::<u64>()
            .unwrap_or(5000)
    } else {
        0
    };
    let pinger_region = std::env::var("PINGER_REGION").expect("PINGER_REGION must be set");
    let skip_validators_app = std::env::var("SKIP_VALIDATORS_APP")
        .map(|v| v == "true")
        .unwrap_or(false);
    let skip_prometheus = std::env::var("SKIP_PROMETHEUS")
        .map(|v| v == "true")
        .unwrap_or(false);
    let pinger_name = std::env::var("PINGER_NAME").unwrap_or_else(|_| "UNSET".to_string());

    let rpc_client = Arc::new(RpcClient::new(rpc_endpoint));
    let g_blockhash = Arc::new(Mutex::new(GlobalBlockhash::new()));
    let g_slot_sent = Arc::new(Mutex::new(GlobalSlotSent::new()));

    let wallet_keypair = Keypair::from_bytes(
        &bs58::decode(std::env::var("WALLET_PRIVATE_KEYPAIR").expect("WALLET_PRIVATE_KEYPAIR must be set"))
            .into_vec()
            .expect("Invalid private key"),
    )?;

    let metrics = if !skip_prometheus {
        Some(Arc::new(Metrics::new()?))
    } else {
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
    }

    let mut try_count = 0;
    let max_tries = 3;
    let fake_signature = "9".repeat(88);

    // Spawn the blockhash and slot watchers
    let g_blockhash_clone = Arc::clone(&g_blockhash);
    let rpc_client_clone = Arc::clone(&rpc_client);
    tokio::spawn(async move {
        watch_blockhash(g_blockhash_clone, rpc_client_clone)
            .await
            .expect("Blockhash watcher failed");
    });

    let g_slot_sent_clone = Arc::clone(&g_slot_sent);
    let ws_endpoint_clone = ws_endpoint.clone();
    tokio::spawn(async move {
        watch_slot_sent(g_slot_sent_clone, &ws_endpoint_clone)
            .await
            .expect("Slot watcher failed");
    });

    loop {
        sleep_ms(sleep_ms_loop).await;

        let mut blockhash = None;
        let mut last_valid_block_height = 0;
        let mut slot_sent = None;
        let mut signature = String::new();
        let mut tx_start = Instant::now();
        let mut slot_landed = None;

        // Wait for fresh slot and blockhash
        loop {
            let now = chrono::Utc::now().timestamp();
            let g_blockhash = g_blockhash.lock().unwrap();
            let g_slot = g_slot_sent.lock().unwrap();

            if now - g_blockhash.updated_at < 10 && now - g_slot.updated_at < 1 {
                blockhash = g_blockhash.value;
                last_valid_block_height = g_blockhash.last_valid_block_height;
                slot_sent = g_slot.value;
                break;
            }

            drop(g_blockhash);
            drop(g_slot);
            sleep_ms(1).await;
        }

        let result = async {
            let mut instructions = vec![
                ComputeBudgetInstruction::set_compute_unit_limit(500),
                ComputeBudgetInstruction::set_compute_unit_price(priority_fee_micro_lamports),
                system_instruction::transfer(
                    &wallet_keypair.pubkey(),
                    &wallet_keypair.pubkey(),
                    5000,
                ),
            ];

            let message = Message::new_with_blockhash(
                &instructions,
                Some(&wallet_keypair.pubkey()),
                &blockhash.unwrap(),
            );

            let tx = Transaction::new(
                &[&wallet_keypair],
                message,
                blockhash.unwrap(),
            );

            tx_start = Instant::now();
            signature = rpc_client
                .send_transaction_with_config(
                    &tx,
                    RpcSendTransactionConfig {
                        skip_preflight: true,
                        ..Default::default()
                    },
                )
                .await?
                .to_string();

            // Sleep a bit to ensure the signature is on an RPC node
            sleep_ms(sleep_ms_rpc).await;

            // Get transaction info
            let tx_info = rpc_client
                .get_transaction_with_config(
                    &Signature::from_str(&signature)?,
                    RpcTransactionConfig {
                        commitment: Some(commitment.parse()?),
                        max_supported_transaction_version: Some(0),
                        ..Default::default()
                    },
                )
                .await?;

            slot_landed = Some(tx_info.slot);

            Ok::<(), anyhow::Error>(())
        }
        .await;

        let tx_end = Instant::now();
        let tx_time = tx_end.duration_since(tx_start).as_millis() as u64;

        if let Err(e) = result {
            error!("Transaction error: {}", e);
            signature = fake_signature.clone();
            try_count += 1;
            if try_count >= max_tries {
                error!("Max retries reached, exiting");
                return Err(e);
            }
            continue;
        }

        // Don't send if slot latency is negative
        if let (Some(slot_landed), Some(slot_sent)) = (slot_landed, slot_sent) {
            if slot_landed < slot_sent {
                error!(
                    "{} ERROR: Slot {} < {}. Not sending to VA.",
                    signature, slot_landed, slot_sent
                );
                continue;
            }
        }

        if !skip_validators_app {
            let client = Client::new();
            let response = client
                .post("https://www.validators.app/api/v1/ping-thing/mainnet")
                .header("Content-Type", "application/json")
                .header("Token", &va_api_key)
                .json(&json!({
                    "time": tx_time,
                    "signature": signature,
                    "transaction_type": "transfer",
                    "success": signature != fake_signature,
                    "application": "web3",
                    "commitment_level": commitment,
                    "slot_sent": slot_sent.unwrap_or_default().to_string(),
                    "slot_landed": slot_landed.unwrap_or_default().to_string(),
                    "priority_fee_micro_lamports": priority_fee_micro_lamports.to_string(),
                    "pinger_region": pinger_region,
                }))
                .send()
                .await?;

            if !response.status().is_success() {
                error!("Failed to update validators: {}", response.status());
            } else if verbose_log {
                info!("VA Response {} {}", response.status(), response.text().await?);
            }
        }

        if !skip_prometheus {
            if let Some(metrics) = &metrics {
                metrics.confirmation_latency
                    .with_label_values(&[&pinger_name])
                    .observe(tx_time as f64);

                if let (Some(slot_landed), Some(slot_sent)) = (slot_landed, slot_sent) {
                    metrics.slot_latency
                        .with_label_values(&[&pinger_name])
                        .observe((slot_landed - slot_sent) as f64);
                }
            }
        }

        try_count = 0;
    }
}
