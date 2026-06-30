import os
import logging

cors_env = os.environ.get("CORS_ORIGINS", "http://localhost:5180,http://localhost:5173")
CORS_ORIGINS = [origin.strip() for origin in cors_env.split(",") if origin.strip()]

LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO")
PIPELINE_WORK_DIR = os.environ.get("PIPELINE_WORK_DIR", "/tmp/circuitscape")

DB_HOST = os.environ.get("DB_HOST", "localhost")
DB_PORT = int(os.environ.get("DB_PORT", "5432"))
DB_NAME = os.environ.get("DB_NAME", "bats")
DB_USER = os.environ.get("DB_USER", "postgres")
DB_PASSWORD = os.environ.get("DB_PASSWORD", "") 

def setup_logging():
    logging.basicConfig(
        level=getattr(logging, LOG_LEVEL.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )