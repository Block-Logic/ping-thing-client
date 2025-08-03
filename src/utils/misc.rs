use std::time::Duration;
use tokio::time::sleep;

pub async fn sleep_ms(ms: u64) {
    sleep(Duration::from_millis(ms)).await;
}

#[macro_export]
macro_rules! log_with_timestamp {
    ($($arg:tt)*) => {{
        let now = chrono::Utc::now();
        println!("[{}] {}", now.format("%Y-%m-%d %H:%M:%S%.3f UTC"), format!($($arg)*));
    }}
}
