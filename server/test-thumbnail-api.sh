#!/bin/bash
# API Testing Examples for Thumbnail Feature

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

API_URL="http://localhost:3000"
API_KEY="your-api-key-here"
USERNAME="your-username"

echo -e "${BLUE}================================================${NC}"
echo -e "${BLUE}  SnapieAudio Thumbnail API - Test Examples${NC}"
echo -e "${BLUE}================================================${NC}\n"

# Example 1: Upload audio WITH thumbnail
echo -e "${GREEN}Example 1: Upload audio with thumbnail URL${NC}"
echo "POST /api/audio/upload"
echo ""
cat << 'EOF'
curl -X POST "$API_URL/api/audio/upload" \
  -H "X-API-Key: $API_KEY" \
  -H "X-User: $USERNAME" \
  -F "audio=@/path/to/audio.mp3" \
  -F "duration=120.5" \
  -F "format=mp3" \
  -F "title=My Song" \
  -F "description=Cool audio track" \
  -F "thumbnail_url=https://files.hive.blog/file/hiveimages/abc123.jpg"

# Response:
# {
#   "success": true,
#   "permlink": "i4p5hzva",
#   "cid": "QmXyz...",
#   "playUrl": "http://localhost:3000/play?a=i4p5hzva",
#   "apiUrl": "http://localhost:3000/api/audio?a=i4p5hzva"
# }
EOF

echo -e "\n"

# Example 2: Upload audio WITHOUT thumbnail (backwards compatible)
echo -e "${GREEN}Example 2: Upload audio without thumbnail (optional)${NC}"
echo "POST /api/audio/upload"
echo ""
cat << 'EOF'
curl -X POST "$API_URL/api/audio/upload" \
  -H "X-API-Key: $API_KEY" \
  -H "X-User: $USERNAME" \
  -F "audio=@/path/to/audio.mp3" \
  -F "duration=120.5" \
  -F "format=mp3" \
  -F "title=My Song"

# Works fine! thumbnail_url will be null
EOF

echo -e "\n"

# Example 3: Update thumbnail for existing audio
echo -e "${GREEN}Example 3: Update thumbnail URL for existing audio${NC}"
echo "PATCH /api/audio/:permlink/thumbnail"
echo ""
cat << 'EOF'
curl -X PATCH "$API_URL/api/audio/i4p5hzva/thumbnail" \
  -H "X-API-Key: $API_KEY" \
  -H "X-User: $USERNAME" \
  -H "Content-Type: application/json" \
  -d '{
    "thumbnail_url": "https://files.hive.blog/file/hiveimages/new-image.jpg"
  }'

# Response:
# {
#   "success": true,
#   "permlink": "i4p5hzva",
#   "thumbnail_url": "https://files.hive.blog/file/hiveimages/new-image.jpg"
# }
EOF

echo -e "\n"

# Example 4: Get audio metadata (includes thumbnail)
echo -e "${GREEN}Example 4: Get audio metadata (includes thumbnail_url)${NC}"
echo "GET /api/audio?a=:permlink"
echo ""
cat << 'EOF'
curl "$API_URL/api/audio?a=i4p5hzva"

# Response includes thumbnail_url:
# {
#   "permlink": "i4p5hzva",
#   "owner": "angeluxx",
#   "audio_cid": "QmXyz...",
#   "duration": 120.5,
#   "format": "mp3",
#   "title": "My Song",
#   "thumbnail_url": "https://files.hive.blog/file/hiveimages/abc123.jpg",
#   "audioUrl": "https://gateway.ipfs.io/ipfs/QmXyz...",
#   "audioUrlFallback": "https://dweb.link/ipfs/QmXyz...",
#   ...
# }
EOF

echo -e "\n"

# Example 5: Error handling - Invalid URL
echo -e "${GREEN}Example 5: Error handling - Invalid URL${NC}"
echo "PATCH /api/audio/:permlink/thumbnail"
echo ""
cat << 'EOF'
curl -X PATCH "$API_URL/api/audio/i4p5hzva/thumbnail" \
  -H "X-API-Key: $API_KEY" \
  -H "X-User: $USERNAME" \
  -H "Content-Type: application/json" \
  -d '{
    "thumbnail_url": "not-a-valid-url"
  }'

# Response:
# {
#   "error": "Invalid URL format"
# }
EOF

echo -e "\n"

# Example 6: Error handling - Unauthorized user
echo -e "${GREEN}Example 6: Error handling - Unauthorized user${NC}"
echo "PATCH /api/audio/:permlink/thumbnail"
echo ""
cat << 'EOF'
curl -X PATCH "$API_URL/api/audio/i4p5hzva/thumbnail" \
  -H "X-API-Key: $API_KEY" \
  -H "X-User: wrong-user" \
  -H "Content-Type: application/json" \
  -d '{
    "thumbnail_url": "https://example.com/image.jpg"
  }'

# Response:
# {
#   "error": "Audio not found or not authorized"
# }
EOF

echo -e "\n${BLUE}================================================${NC}\n"

echo -e "📝 Notes:"
echo "  - thumbnail_url is optional on upload"
echo "  - Only audio owner can update thumbnail"
echo "  - URL must be http:// or https://"
echo "  - Maximum URL length: 2048 characters"
echo "  - Validates URL format before saving"
echo ""
