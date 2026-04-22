#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATES_DIR="$SCRIPT_DIR/templates"
AGENTS_DIR="${1:-$SCRIPT_DIR/agents}"
AGENTS_JSON="$SCRIPT_DIR/agents.json"

mkdir -p "$AGENTS_DIR"

if ! command -v jq &> /dev/null; then
  echo "Error: jq not found" >&2
  exit 1
fi

for theme in $(jq -r 'keys[]' "$AGENTS_JSON"); do
  for profession in $(jq -r ".[\"$theme\"] | keys[]" "$AGENTS_JSON"); do
    agent_name="$theme-$profession"
    persona_file=$(jq -r ".[\"$theme\"][\"$profession\"].persona_file" "$AGENTS_JSON")
    description=$(jq -r ".[\"$theme\"][\"$profession\"].description" "$AGENTS_JSON")
    welcome_message=$(jq -r ".[\"$theme\"][\"$profession\"].welcome_message" "$AGENTS_JSON")
    
    template_file="$TEMPLATES_DIR/$profession.json"
    output_file="$AGENTS_DIR/$agent_name.json"
    
    if [ ! -f "$template_file" ]; then
      echo "Warning: Template $template_file not found, skipping $agent_name" >&2
      continue
    fi
    
    if [ "$profession" = "orchestrator" ]; then
      agents_json=$(jq -r ".[\"$theme\"] | keys | map(select(. != \"orchestrator\") | \"$theme-\" + .) | tojson" "$AGENTS_JSON")
    else
      agents_json="[]"
    fi
    
    jq -R -s --arg agent_name "$agent_name" \
       --arg theme "$theme" \
       --arg persona_file "$persona_file" \
       --arg description "$description" \
       --arg welcome_message "$welcome_message" \
       --arg agents_json "$agents_json" \
       'gsub("{{AGENT_NAME}}"; $agent_name) |
        gsub("{{THEME}}"; $theme) |
        gsub("{{PERSONA_FILE}}"; $persona_file) |
        gsub("{{DESCRIPTION}}"; $description) |
        gsub("{{WELCOME_MESSAGE}}"; $welcome_message) |
        gsub("\"{{AVAILABLE_AGENTS}}\""; $agents_json) |
        gsub("\"{{TRUSTED_AGENTS}}\""; $agents_json) |
        fromjson' \
       "$template_file" > "$output_file"
    
    echo "Generated: $output_file"
  done
done

echo "Done! Generated all agents."
