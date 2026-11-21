use std::collections::HashMap;

/// Parse `key=value` lines into settings.
pub fn parse_settings(input: &str) -> HashMap<String, String> {
    let mut settings = HashMap::new();
    for line in input.lines() {
        if let Some((key, value)) = line.split_once('=') {
            settings.insert(key.trim().to_string(), value.trim().to_string());
        }
    }
    settings
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_pairs() {
        let settings = parse_settings("port=8080\nhost=localhost");
        assert_eq!(settings["port"], "8080");
    }
}
