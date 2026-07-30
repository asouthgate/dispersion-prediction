import os
import logging
import configparser

_cors_env = os.environ.get("CORS_ORIGINS", "")
CORS_ORIGINS = [origin.strip() for origin in _cors_env.split(",") if origin.strip()]

LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO")
PIPELINE_WORK_DIR = os.environ.get("PIPELINE_WORK_DIR", "/tmp/circuitscape")
PMTILES_DIR = os.environ.get("PMTILES_DIR", "/data/pmtiles")

PIPELINE_TIMEOUT = int(os.environ.get("PIPELINE_TIMEOUT", "1800"))
MAX_PIXEL_DIMENSION = int(os.environ.get("MAX_PIXEL_DIMENSION", "2000"))
TOKEN_TTL_SECONDS = int(os.environ.get("AUTH_TOKEN_TTL_SECONDS", "86400"))

CELERY_BROKER_URL = os.environ.get("CELERY_BROKER_URL")
if not CELERY_BROKER_URL:
    raise RuntimeError("CELERY_BROKER_URL must be set in the environment")

AUTH_REDIS_URL = os.environ.get("AUTH_REDIS_URL", CELERY_BROKER_URL)

CELERY_RESULT_BACKEND = os.environ.get("CELERY_RESULT_BACKEND")
if not CELERY_RESULT_BACKEND:
    raise RuntimeError("CELERY_RESULT_BACKEND must be set in the environment")

RATE_LIMIT_TOKENS_PER_MINUTE = int(os.environ.get("AUTH_RATE_LIMIT_PER_MINUTE", "10"))

# Global cap on in-flight pipeline jobs (running + queued). New submissions
# get HTTP 429 once this many jobs are in flight. Size it around
# PIPELINE_MAX_WORKERS * 2 so the broker queue stays short.
MAX_INFLIGHT_JOBS = int(os.environ.get("MAX_INFLIGHT_JOBS", "8"))

ANALYTICS_HASH_SECRET = os.environ.get("ANALYTICS_HASH_SECRET")
if not ANALYTICS_HASH_SECRET:
    raise RuntimeError("ANALYTICS_HASH_SECRET must be set in the environment")


def _load_bats_cfg() -> dict[str, str]:
    """Load ~/.bats.cfg at startup.  All processes (API, Celery workers) import
    this module so the config is read once per process and cached in memory.

    ~/.bats.cfg is the single source of truth for database configuration
    (connection details and table names).  Both the Python API and the R
    pipeline read from this file."""
    cfg_path = os.path.expanduser("~/.bats.cfg")
    if not os.path.isfile(cfg_path):
        raise RuntimeError(
            f"~/.bats.cfg not found at {cfg_path}. "
            "This file is required for the pipeline to know which database tables "
            "contain DTM/DSM/LCM data.  Ensure the container entrypoint generates it "
            "or create it manually with [database] section containing dtm_table, "
            "dsm_table, lcm_table keys."
        )
    config = configparser.ConfigParser()
    config.read(cfg_path)
    if "database" not in config:
        raise RuntimeError(
            f"~/.bats.cfg at {cfg_path} is missing the [database] section. "
            "It must contain dtm_table, dsm_table, lcm_table keys."
        )
    return dict(config["database"])


BATS_CFG = _load_bats_cfg()

DATABASE_HOST = BATS_CFG.get("host", "localhost")
DATABASE_PORT = int(BATS_CFG.get("port", "5432"))
DATABASE_NAME = BATS_CFG.get("name", "bats")
DATABASE_USER = BATS_CFG.get("user", "postgres")
DATABASE_PASSWORD = BATS_CFG.get("password", "")

DTM_TABLE = BATS_CFG.get("dtm_table", "dtm")
DSM_TABLE = BATS_CFG.get("dsm_table", "dsm")
LCM_TABLE = BATS_CFG.get("lcm_table", "lcm")


def setup_logging():
    logging.basicConfig(
        level=getattr(logging, LOG_LEVEL.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )