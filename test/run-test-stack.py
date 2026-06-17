#!/usr/bin/env python3
"""Test stack utilities for the bat dispersion prediction app.

Assumes the docker-compose stack is already running.

Usage:
    python test/run-test-stack.py seed    Load GIS data into PostGIS
    python test/run-test-stack.py test    Run integration tests
"""

import argparse
import os
import shutil
import subprocess
import sys


def _detect_compose_cmd():
    """Detect whether to use 'docker compose' (v2) or 'docker-compose' (v1)."""
    if shutil.which("docker") and _check_compose_v2():
        return ["docker", "compose"]
    if shutil.which("docker-compose"):
        return ["docker-compose"]
    print("ERROR: neither 'docker compose' nor 'docker-compose' found.", file=sys.stderr)
    sys.exit(1)


COMPOSE = _detect_compose_cmd()
PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def _check_compose_v2():
    """Check if docker compose (v2 plugin) is available."""
    try:
        result = subprocess.run(
            ["docker", "compose", "version"],
            capture_output=True, text=True, timeout=10,
        )
        return result.returncode == 0
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return False


def cmd_seed(args):
    """Load seed data into PostGIS."""
    subprocess.run(
        COMPOSE + ["exec", "-T", "postgis", "python3", "/seed/load-test-data.py"],
        check=True, cwd=PROJECT_ROOT
    )


def cmd_test(args):
    """Run integration tests inside the batapp container."""
    subprocess.run(
        COMPOSE + ["exec", "-T", "batapp", "Rscript", "test/integration/sit.R"],
        check=True, cwd=PROJECT_ROOT
    )


def main():
    parser = argparse.ArgumentParser(
        description="Bat dispersion prediction app - test stack utilities. "
        "The stack must already be running (docker-compose up -d)."
    )
    sub = parser.add_subparsers(dest="command", help="Available commands")

    sub.add_parser("seed", help="Load seed data into PostGIS")
    sub.add_parser("test", help="Run integration tests inside batapp container")

    args = parser.parse_args()

    commands = {
        "seed": cmd_seed,
        "test": cmd_test,
    }

    if args.command in commands:
        commands[args.command](args)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()