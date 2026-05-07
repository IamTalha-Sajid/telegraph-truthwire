#!/usr/bin/env bash
# test-itsai-apis.sh - Test ItsAI (Subnet 32) /detect endpoint via subnet-dispatcher.
# Verifies each response and prints a final Test Passed / Test Failed summary.
# Usage: ./scripts/test-itsai-apis.sh [BASE_URL]
# Optional env: TEST_TEXT (custom text sample to analyze)

set -e

BASE_URL="http://localhost:7044"
while [[ $# -gt 0 ]]; do
  case "$1" in
    http://*|https://*)
      BASE_URL="$1"
      shift
      ;;
    *)
      echo "Usage: $0 [BASE_URL]" >&2
      exit 1
      ;;
  esac
done

ITSAI_BASE="${BASE_URL}/subnet-dispatcher/v1/32"

# ItsAI requires a minimum of 200 characters per request.
# Default sample: clearly AI-sounding text, well over the 200-char minimum.
TEST_TEXT="${TEST_TEXT:-As an AI language model, I am designed to assist users with a wide range of tasks by leveraging advanced natural language processing capabilities. My architecture enables me to understand context, generate coherent responses, and provide helpful information across many domains.}"

PASSED=0
FAILED=0
FAILED_NAMES=()

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

print_header() {
  echo ""
  echo -e "${BLUE}══════════════════════════════════════════════════════════════${NC}"
  echo -e "${BOLD}$1${NC}"
  echo -e "${BLUE}══════════════════════════════════════════════════════════════${NC}"
}

print_section() {
  echo ""
  echo -e "${CYAN}▶ $1${NC}"
}

pretty_json() {
  if command -v jq >/dev/null 2>&1; then
    jq .
  else
    python3 -c "import sys,json; print(json.dumps(json.load(sys.stdin), indent=2))"
  fi
}

# Verify detect response: must have answer (0 or 1) and status=success.
verify_detect() {
  local json="$1"
  if command -v jq >/dev/null 2>&1; then
    local has_answer has_success
    has_answer=$(echo "$json" | jq -r 'if (.answer | type) == "number" then 1 else 0 end')
    has_success=$(echo "$json" | jq -r 'if .status == "success" then 1 else 0 end')
    [[ "$has_answer" == "1" && "$has_success" == "1" ]] && return 0
  else
    echo "$json" | grep -q '"answer"' && echo "$json" | grep -q '"success"' && return 0
  fi
  return 1
}

# POST JSON and optionally verify. Returns 0=pass, 1=fail.
run_post() {
  local name="$1"
  local path="$2"
  local body="$3"
  local verify_fn="$4"
  local url="${ITSAI_BASE}${path}"

  print_section "ItsAI: $name"
  echo "  POST $url"
  if [[ ${#body} -gt 120 ]]; then
    echo "  Request body: ${body:0:80}... (${#body} chars)"
  else
    echo "  Request body: $body"
  fi
  echo ""

  local resp body_out code
  resp=$(curl -s -w "\n%{http_code}" -X POST "$url" -H "Content-Type: application/json" -d "$body")
  body_out=$(echo "$resp" | head -n -1)
  code=$(echo "$resp" | tail -n 1)

  if [ "$code" != "200" ]; then
    echo -e "${RED}HTTP $code${NC}"
    echo "$body_out" | pretty_json 2>/dev/null || echo "$body_out"
    echo -e "  ${RED}Result: FAILED (HTTP $code)${NC}"
    return 1
  fi

  echo -e "${GREEN}HTTP 200 OK${NC}"
  echo ""
  echo -e "${YELLOW}Response (JSON):${NC}"
  echo "$body_out" | pretty_json
  echo ""

  if [[ -n "$verify_fn" ]]; then
    if "$verify_fn" "$body_out"; then
      echo -e "  ${GREEN}Result: PASSED${NC}"
      return 0
    else
      echo -e "  ${RED}Result: FAILED (response structure invalid — expected score + label)${NC}"
      return 1
    fi
  else
    echo -e "  ${GREEN}Result: PASSED (HTTP 200)${NC}"
    return 0
  fi
}

main() {
  print_header "ItsAI (Subnet 32) API tests"
  echo "Base URL: $BASE_URL"
  echo ""

  # Build JSON body safely
  local text_body
  text_body=$(python3 -c "import sys,json; print(json.dumps({\"text\": sys.argv[1]}))" "$TEST_TEXT" 2>/dev/null \
    || echo "{\"text\":\"$(printf '%s' "$TEST_TEXT" | sed 's/"/\\"/g')\"}")

  # 1. detect — AI-generated text sample
  if run_post "Detect AI text" "/detect" "$text_body" "verify_detect"; then
    PASSED=$((PASSED + 1))
  else
    FAILED=$((FAILED + 1))
    FAILED_NAMES+=("detect-ai-text")
  fi

  # 2. detect — clearly human text sample (200+ chars required)
  local human_text="I went to the market this morning and bought some fresh vegetables for dinner. The tomatoes looked particularly ripe, so I grabbed a few extra. On the way home I bumped into my neighbour and we chatted for a while about the weather and the local football team."
  local human_body
  human_body=$(python3 -c "import sys,json; print(json.dumps({\"text\": sys.argv[1]}))" "$human_text" 2>/dev/null \
    || echo "{\"text\":\"$(printf '%s' "$human_text" | sed 's/"/\\"/g')\"}")

  if run_post "Detect human text" "/detect" "$human_body" "verify_detect"; then
    PASSED=$((PASSED + 1))
  else
    FAILED=$((FAILED + 1))
    FAILED_NAMES+=("detect-human-text")
  fi

  # Final summary
  print_header "Test summary"
  echo -e "  Passed:  ${GREEN}${PASSED}${NC}"
  echo -e "  Failed:  ${RED}${FAILED}${NC}"
  if [ ${#FAILED_NAMES[@]} -gt 0 ]; then
    echo -e "  Failed tests: ${RED}${FAILED_NAMES[*]}${NC}"
  fi
  echo ""
  if [ "$FAILED" -eq 0 ]; then
    echo -e "${GREEN}${BOLD}Test Passed${NC}"
    exit 0
  else
    echo -e "${RED}${BOLD}Test Failed${NC}"
    exit 1
  fi
}

main "$@"