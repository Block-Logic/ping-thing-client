use anyhow::{Context, Result};
use log::{debug, info, warn};
use std::collections::HashMap;
use tonic::transport::ClientTlsConfig;
use yellowstone_grpc_client::{GeyserGrpcClient, Interceptor};
use yellowstone_grpc_proto::prelude::{
    CommitmentLevel, SubscribeRequest, SubscribeRequestFilterBlocks, SubscribeRequestFilterSlots,
    SubscribeRequestFilterTransactions,
};

/// Creates a gRPC client with proper configuration
/// Based on the Yellowstone gRPC example pattern
pub async fn create_grpc_client(
    endpoint: &str,
    x_token: Option<String>,
) -> Result<GeyserGrpcClient<impl Interceptor>> {
    info!("[gRPC Client] Creating client for endpoint: {}", endpoint);

    // Always use TLS config with native roots (works for both http and https)
    debug!("[gRPC Client] Configuring TLS with native roots...");
    let tls_config = ClientTlsConfig::new().with_native_roots();
    debug!("[gRPC Client] TLS configuration created");

    // Build client following the example pattern - chain methods with ?
    debug!("[gRPC Client] Building client from shared endpoint...");
    let builder = GeyserGrpcClient::build_from_shared(endpoint.to_string())
        .context("Failed to build gRPC client")?
        .tls_config(tls_config)
        .context("Failed to configure TLS")?;
    debug!("[gRPC Client] Client builder created with TLS config");

    // Add x-token header if provided
    let builder = if let Some(token) = x_token {
        debug!("[gRPC Client] Adding x-token authentication header...");
        builder
            .x_token(Some(token))
            .context("Failed to set x-token")?
    } else {
        debug!("[gRPC Client] No x-token provided, proceeding without authentication");
        builder
    };

    info!(
        "[gRPC Client] Attempting to connect to endpoint: {}...",
        endpoint
    );
    let client = builder.connect().await.map_err(|e| {
        warn!("[gRPC Client] Connection failed: {}", e);
        anyhow::anyhow!("Failed to connect to gRPC endpoint {}: {}", endpoint, e)
    })?;

    info!(
        "[gRPC Client] Successfully connected to gRPC endpoint: {}",
        endpoint
    );
    Ok(client)
}

/// Parses commitment string to CommitmentLevel enum
pub fn parse_commitment(commitment_str: &str) -> Result<CommitmentLevel> {
    debug!(
        "[gRPC Client] Parsing commitment string: {}",
        commitment_str
    );
    let commitment = match commitment_str.to_lowercase().as_str() {
        "processed" => {
            debug!("[gRPC Client] Parsed commitment: Processed");
            Ok(CommitmentLevel::Processed)
        }
        "confirmed" => {
            debug!("[gRPC Client] Parsed commitment: Confirmed");
            Ok(CommitmentLevel::Confirmed)
        }
        "finalized" => {
            debug!("[gRPC Client] Parsed commitment: Finalized");
            Ok(CommitmentLevel::Finalized)
        }
        _ => Err(anyhow::anyhow!(
            "Invalid commitment level: {}. Must be one of: processed, confirmed, finalized",
            commitment_str
        )),
    };
    commitment
}
