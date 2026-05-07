#!/usr/bin/env bash
# test-bitmind-apis.sh - Test all BitMind (Subnet 34) APIs via subnet-dispatcher.
# Verifies each response and prints a final Test Passed / Test Failed summary.
# Usage: ./scripts/test-bitmind-apis.sh [OPTIONS] [BASE_URL]
#   --image-only    Run only detect-image (skip video endpoints to avoid using video credits)
# Optional env: TEST_IMAGE (URL or data URI or base64), TEST_VIDEO_URL (for video tests)

set -e

IMAGE_ONLY=0
BASE_URL="http://localhost:7044"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --image-only)
      IMAGE_ONLY=1
      shift
      ;;
    http://*|https://*)
      BASE_URL="$1"
      shift
      ;;
    *)
      echo "Usage: $0 [--image-only] [BASE_URL]" >&2
      echo "  --image-only  Run only detect-image (no video tests)" >&2
      exit 1
      ;;
  esac
done

BITMIND_BASE="${BASE_URL}/subnet-dispatcher/v1/34"

# BitMind expects URL or "data:image/...;base64,...". Default: tiny 1x1 PNG as data URI (no external fetch).
TEST_IMAGE="${TEST_IMAGE:-data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==}"
TEST_VIDEO_URL="${TEST_VIDEO_URL:-}"

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

# Verify get-video-upload-url response: 200 + (url or videoUrl) + (fileKey or fields)
verify_get_upload_url() {
  local json="$1"
  if command -v jq >/dev/null 2>&1; then
    local has_url has_key
    has_url=$(echo "$json" | jq -r 'if .url != null or .videoUrl != null then 1 else 0 end')
    has_key=$(echo "$json" | jq -r 'if .fileKey != null or .fields != null then 1 else 0 end')
    [[ "$has_url" == "1" && "$has_key" == "1" ]] && return 0
  else
    echo "$json" | grep -qE '"url"|"videoUrl"' && echo "$json" | grep -qE '"fileKey"|"fields"' && return 0
  fi
  return 1
}

# Verify detect-image response: has isAI or confidence (or isAi)
verify_detect_image() {
  local json="$1"
  if command -v jq >/dev/null 2>&1; then
    local has_ai has_conf
    has_ai=$(echo "$json" | jq -r 'if .isAI != null or .isAi != null then 1 else 0 end')
    has_conf=$(echo "$json" | jq -r 'if .confidence != null then 1 else 0 end')
    [[ "$has_ai" == "1" || "$has_conf" == "1" ]] && return 0
  else
    echo "$json" | grep -qE '"isAI"|"isAi"|"confidence"' && return 0
  fi
  return 1
}

# Verify detect-video response: has isAI/confidence or frameResults
verify_detect_video() {
  local json="$1"
  if command -v jq >/dev/null 2>&1; then
    local has_ai has_frames
    has_ai=$(echo "$json" | jq -r 'if .isAI != null or .isAi != null or .confidence != null then 1 else 0 end')
    has_frames=$(echo "$json" | jq -r 'if .frameResults != null then 1 else 0 end')
    [[ "$has_ai" == "1" || "$has_frames" == "1" ]] && return 0
  else
    echo "$json" | grep -qE '"isAI"|"isAi"|"confidence"|"frameResults"' && return 0
  fi
  return 1
}

# Verify preprocess-video response: has videoUrl
verify_preprocess_video() {
  local json="$1"
  if command -v jq >/dev/null 2>&1; then
    echo "$json" | jq -e '.videoUrl != null' >/dev/null 2>&1 && return 0
  else
    echo "$json" | grep -q '"videoUrl"' && return 0
  fi
  return 1
}

# POST JSON and optionally verify. Returns 0=pass, 1=fail.
# Usage: run_post "Test name" "/path" '{"json"}' "verify_fn_name"
run_post() {
  local name="$1"
  local path="$2"
  local body="$3"
  local verify_fn="$4"
  local url="${BITMIND_BASE}${path}"

  print_section "BitMind: $name"
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
      echo -e "  ${RED}Result: FAILED (response structure invalid)${NC}"
      return 1
    fi
  else
    echo -e "  ${GREEN}Result: PASSED (HTTP 200)${NC}"
    return 0
  fi
}

main() {
  print_header "BitMind (Subnet 34) API tests"
  echo "Base URL: $BASE_URL"
  [[ "$IMAGE_ONLY" -eq 1 ]] && echo "Mode: image only (video tests skipped)"
  echo ""

  # 1. get-video-upload-url (skipped when --image-only)
  if [[ "$IMAGE_ONLY" -eq 0 ]]; then
    if run_post "Get video upload URL" "/get-video-upload-url" '{"filename":"test-bitmind-apis.mp4"}' "verify_get_upload_url"; then
      PASSED=$((PASSED + 1))
    else
      FAILED=$((FAILED + 1))
      FAILED_NAMES+=("get-video-upload-url")
    fi
  fi

  # 2. detect-image (BitMind expects URL or data:image/...;base64,...)
  local image_val="$TEST_IMAGE"
  if [[ "$image_val" != data:* && "$image_val" != http:* && "$image_val" != https:* ]]; then
    image_val="data:image/png;base64,${image_val}"
  fi
  local image_json
  image_json=$(printf '%s' "$image_val" | python3 -c "import sys,json; s=sys.stdin.read(); print(json.dumps({\"image\": s}))" 2>/dev/null || echo "{\"image\":\"$(printf '%s' "$image_val" | sed 's/"/\\"/g')\"}")
  if run_post "Detect image (AI or not)" "/detect-image" "$image_json" "verify_detect_image"; then
    PASSED=$((PASSED + 1))
  else
    FAILED=$((FAILED + 1))
    FAILED_NAMES+=("detect-image")
  fi

  # 3 & 4. Video tests (skipped when --image-only or no TEST_VIDEO_URL)
  if [[ "$IMAGE_ONLY" -eq 1 ]]; then
    print_section "BitMind: Video tests (skipped, --image-only)"
    echo "  Omit --image-only to run get-video-upload-url and (with TEST_VIDEO_URL) detect-video / preprocess-video."
    echo ""
  elif [[ -n "$TEST_VIDEO_URL" ]]; then
    local video_body="{\"video\":\"${TEST_VIDEO_URL}\",\"startTime\":0,\"endTime\":5,\"fps\":1,\"rich\":false}"
    if run_post "Detect video" "/detect-video" "$video_body" "verify_detect_video"; then
      PASSED=$((PASSED + 1))
    else
      FAILED=$((FAILED + 1))
      FAILED_NAMES+=("detect-video")
    fi
    local preprocess_body="{\"video\":\"${TEST_VIDEO_URL}\",\"startTime\":0,\"endTime\":5,\"fps\":1,\"generateThumbnails\":false}"
    if run_post "Preprocess video" "/preprocess-video" "$preprocess_body" "verify_preprocess_video"; then
      PASSED=$((PASSED + 1))
    else
      FAILED=$((FAILED + 1))
      FAILED_NAMES+=("preprocess-video")
    fi
  else
    print_section "BitMind: Video tests (skipped)"
    echo "  Set TEST_VIDEO_URL to run detect-video and preprocess-video."
    echo "  Example: TEST_VIDEO_URL=https://example.com/sample.mp4 $0"
    echo ""
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