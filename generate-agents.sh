#!/bin/bash
set -e

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
    
    sed -e "s|{{AGENT_NAME}}|$agent_name|g" \
        -e "s|{{THEME}}|$theme|g" \
        -e "s|{{PERSONA_FILE}}|$persona_file|g" \
        -e "s|{{DESCRIPTION}}|$description|g" \
        -e "s|{{WELCOME_MESSAGE}}|$welcome_message|g" \
        -e "s|{{AVAILABLE_AGENTS}}|$agents_json|g" \
        -e "s|{{TRUSTED_AGENTS}}|$agents_json|g" \
        "$template_file" | jq '.' > "$output_file"
    
    echo "Generated: $output_file"
  done
done

echo "Done! Generated all agents."
