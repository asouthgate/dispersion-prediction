#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0
FAIL=0

cd "$REPO_ROOT"
echo "=== API unit tests ==="
if pytest api/test/ -v; then
    PASS=$((PASS + 1))
else
    FAIL=$((FAIL + 1))
fi

cd "$REPO_ROOT"
echo ""
echo "=== Frontend type-check + build ==="
if npm --prefix frontend run build; then
    PASS=$((PASS + 1))
else
    FAIL=$((FAIL + 1))
fi

cd "$REPO_ROOT"
echo ""
echo "=== Frontend unit tests ==="
if npm --prefix frontend run test; then
    PASS=$((PASS + 1))
else
    FAIL=$((FAIL + 1))
fi

cd "$REPO_ROOT"
echo ""
echo "=== Engine unit tests ==="
if npm --prefix frontend/gsbio-engine run test; then
    PASS=$((PASS + 1))
else
    FAIL=$((FAIL + 1))
fi

cd "$REPO_ROOT"
echo ""
echo "=== Wasm-connectivity Rust tests ==="
if cargo test --lib --manifest-path frontend/wasm-connectivity/Cargo.toml; then
    PASS=$((PASS + 1))
else
    FAIL=$((FAIL + 1))
fi

cd "$REPO_ROOT"
echo ""
echo "=== Resistance-cli Rust tests ==="
if cargo test --manifest-path resistance-cli/Cargo.toml; then
    PASS=$((PASS + 1))
else
    FAIL=$((FAIL + 1))
fi

cd "$REPO_ROOT"
echo ""
echo "=== R unit tests ==="
if Rscript --no-init-file test/run_unit_tests.R; then
    PASS=$((PASS + 1))
else
    FAIL=$((FAIL + 1))
fi

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
