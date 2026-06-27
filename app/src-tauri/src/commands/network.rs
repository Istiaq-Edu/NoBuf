use std::net::TcpStream;
use std::time::Duration;

/// Telegram production Data Centres.
/// Used by cmd_is_network_available for failover — if one DC is unreachable,
/// we try the next until one responds or all are exhausted.
const DC_ADDRESSES: &[&str] = &[
    "149.154.167.50:443",  // DC2 (primary — same as original)
    "149.154.175.53:443",  // DC1
    "149.154.167.51:443",  // DC3
    "149.154.167.91:443",  // DC4
    "91.108.56.130:443",   // DC5
];

/// Network check with DC failover.
/// Tries each Telegram DC in order with a 2s timeout. Returns true if any
/// DC accepts a TCP connection. This avoids false negatives when a single
/// DC is temporarily unreachable.
#[tauri::command]
pub async fn cmd_is_network_available() -> Result<bool, String> {
    tokio::task::spawn_blocking(|| {
        for dc in DC_ADDRESSES {
            match TcpStream::connect_timeout(
                &dc.parse().unwrap(),
                Duration::from_secs(2),
            ) {
                Ok(_) => return Ok(true),
                Err(_) => continue,
            }
        }
        Ok(false)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Detect whether a VPN interface is active on the system.
/// Platform-specific implementation:
/// - Windows: parses `ipconfig` output for VPN-related adapter keywords
/// - Linux: reads `/sys/class/net` for tun/tap/wg/ppp interfaces
/// - macOS: parses `ifconfig -l` for utun/tun/wg/ppp interfaces
#[tauri::command]
pub async fn cmd_detect_vpn() -> Result<bool, String> {
    tokio::task::spawn_blocking(detect_vpn_impl)
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(target_os = "windows")]
fn detect_vpn_impl() -> Result<bool, String> {
    use std::process::Command;
    let output = Command::new("ipconfig")
        .output()
        .map_err(|e| format!("Failed to run ipconfig: {}", e))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_lowercase();

    // VPN adapter keywords — match adapter NAMES in ipconfig output.
    // We then check if the adapter is actually connected (has IP, not media disconnected).
    let vpn_keywords = [
        "tap-windows", "wireguard", "openvpn",
        "tailscale", "zerotier", "ipsec",
        "vpn", "l2tp", "sstp",
        "nordvpn", "expressvpn", "protonvpn",
        "surfshark", "cyberghost", "norton",
        "cloudflare", "warp",
        "tunnel", "hamachi", "pptp",
    ];

    // Split ipconfig output into adapter blocks.
    // Each adapter block starts with a line containing "adapter" and ends
    // at the next "adapter" line or end of output.
    // A VPN is active only if the adapter has an IP address (not "media disconnected").
    let lines: Vec<&str> = stdout.lines().collect();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        // Check if this line mentions a VPN adapter name
        if vpn_keywords.iter().any(|kw| line.contains(kw)) {
            // Look ahead in this adapter's block for media state or IP
            let mut has_ip = false;
            let mut media_disconnected = false;
            for j in i..(i + 10).min(lines.len()) {
                let block_line = lines[j];
                // If we hit another "adapter" line, stop
                if j > i && block_line.contains("adapter") {
                    break;
                }
                if block_line.contains("media disconnected") || block_line.contains("media state") && block_line.contains("disconnected") {
                    media_disconnected = true;
                }
                // Has an IPv4 or IPv6 address assigned = connected
                if block_line.contains("ipv4 address") || block_line.contains("ipv6 address") {
                    // Make sure it's not "Media disconnected" masking the IP
                    if !block_line.contains("media") {
                        has_ip = true;
                    }
                }
            }
            // VPN is active only if the adapter has an IP (is connected)
            if has_ip && !media_disconnected {
                return Ok(true);
            }
        }
        i += 1;
    }
    Ok(false)
}

#[cfg(target_os = "linux")]
fn detect_vpn_impl() -> Result<bool, String> {
    use std::fs;
    let entries = fs::read_dir("/sys/class/net")
        .map_err(|e| format!("Failed to read /sys/class/net: {}", e))?;
    let vpn_prefixes = ["tun", "tap", "wg", "ppp", "utun", "ipsec"];
    for entry in entries.flatten() {
        if let Some(name) = entry.file_name().to_str() {
            if vpn_prefixes.iter().any(|p| name.starts_with(p)) {
                // Check if interface is actually UP
                let operstate_path = format!("/sys/class/net/{}/operstate", name);
                if let Ok(state) = fs::read_to_string(&operstate_path) {
                    if state.trim() == "up" {
                        return Ok(true);
                    }
                } else {
                    // Some VPN interfaces (e.g. wireguard) may not have operstate
                    // Fall back to checking carrier
                    let carrier_path = format!("/sys/class/net/{}/carrier", name);
                    if let Ok(carrier) = fs::read_to_string(&carrier_path) {
                        if carrier.trim() == "1" {
                            return Ok(true);
                        }
                    }
                }
            }
        }
    }
    Ok(false)
}

#[cfg(target_os = "macos")]
fn detect_vpn_impl() -> Result<bool, String> {
    use std::process::Command;
    let output = Command::new("ifconfig")
        .args(["-l"])
        .output()
        .map_err(|e| format!("Failed to run ifconfig: {}", e))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_lowercase();
    let vpn_prefixes = ["utun", "tun", "wg", "ppp", "tap", "ipsec"];
    // Split interface list and check each name with starts_with (not contains)
    for iface in stdout.split_whitespace() {
        if vpn_prefixes.iter().any(|p| iface.starts_with(p)) {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
fn detect_vpn_impl() -> Result<bool, String> {
    Ok(false)
}

/// Measure TCP connection latency to Telegram's primary DC (DC2).
/// Returns latency in milliseconds, or -1 if unreachable.
#[tauri::command]
pub async fn cmd_check_latency() -> Result<i64, String> {
    tokio::task::spawn_blocking(|| {
        let start = std::time::Instant::now();
        match TcpStream::connect_timeout(
            &"149.154.167.50:443".parse().unwrap(),
            Duration::from_secs(3),
        ) {
            Ok(_) => Ok(start.elapsed().as_millis() as i64),
            Err(_) => Ok(-1),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Test latency to all 5 Telegram DCs and return results.
/// Returns a vector of (dc_name, latency_ms) pairs.
#[tauri::command]
pub async fn cmd_test_all_dcs() -> Result<Vec<(String, i64)>, String> {
    tokio::task::spawn_blocking(|| {
        let dcs: Vec<(&str, &str)> = vec![
            ("DC1", "149.154.175.53:443"),
            ("DC2", "149.154.167.50:443"),
            ("DC3", "149.154.167.51:443"),
            ("DC4", "149.154.167.91:443"),
            ("DC5", "91.108.56.130:443"),
        ];
        let mut results = Vec::new();
        for (name, addr) in dcs {
            let start = std::time::Instant::now();
            let latency = match TcpStream::connect_timeout(
                &addr.parse().unwrap(),
                Duration::from_secs(3),
            ) {
                Ok(_) => start.elapsed().as_millis() as i64,
                Err(_) => -1,
            };
            results.push((name.to_string(), latency));
        }
        Ok(results)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_dc_addresses_not_empty() {
        assert!(!DC_ADDRESSES.is_empty());
        assert!(DC_ADDRESSES.len() >= 5);
    }

    #[test]
    fn test_dc_addresses_parseable() {
        for dc in DC_ADDRESSES {
            assert!(dc.parse::<std::net::SocketAddr>().is_ok(), "Invalid DC address: {}", dc);
        }
    }

    #[test]
    fn test_dc_addresses_have_port_443() {
        for dc in DC_ADDRESSES {
            assert!(dc.ends_with(":443"), "DC {} should use port 443", dc);
        }
    }
}
