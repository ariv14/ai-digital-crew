#!/bin/bash
URL="https://staging.aidigitalcrew.com/#projects"

echo "======================================================"
echo " 🛠️  1. RUNNING AXE-CORE (Deep UI & Accessibility) "
echo "======================================================"
# We don't use --exit here so the script continues even if axe finds errors
npx @axe-core/cli $URL

echo ""
echo "======================================================"
echo " ⚡ 2. RUNNING LIGHTHOUSE (Perf, SEO, Best Practices) "
echo "======================================================"
# We skip the 'accessibility' category because axe handles it better
npx lighthouse $URL \
  --chrome-flags="--headless" \
  --only-categories="performance,seo,best-practices" \
  --output json \
  --output-path ./lh-report.json

echo ""
echo "======================================================"
echo " 📊 LIGHTHOUSE SUMMARY (AI-Friendly Format) "
echo "======================================================"
# We use jq to extract ONLY the scores and the audits that actually failed.
# This shrinks a 3MB file down to about 2KB so Claude can easily read it.
jq '{
  scores: .categories | map_values(.score * 100),
  failed_audits: .audits | map(select(.score != null and .score < 1 and .scoreTargetFallback != true)) | map({id: .id, title: .title, displayValue: .displayValue})
}' ./lh-report.json > ./lh-summary.json

cat ./lh-summary.json
