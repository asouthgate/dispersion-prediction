#!/bin/bash
# This script starts the batapp container, waiting for postgis to be ready
# generating the bats.cfg file, starting munge and slurm, and finally starting shiny-server.
set -e

echo "starting batapp entrypoint..."

# wait for postgis to accept connections
echo "waiting for postgis at ${DATABASE_HOST}:${DATABASE_PORT}..."
max_attempts=60
attempt=0
until pg_isready -h "${DATABASE_HOST}" -p "${DATABASE_PORT}" -U "${DATABASE_USER}" -d "${DATABASE_NAME}" -q 2>/dev/null; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge "$max_attempts" ]; then
        echo "ERROR: postgis not ready after ${max_attempts} attempts"
        exit 1
    fi
    sleep 2
done
echo "postgis is ready."

# generate ~/.bats.cfg from template using envsubst
echo "generating bats.cfg..."
envsubst < /opt/bats.cfg.template > ~/.bats.cfg
echo "written ~/.bats.cfg"

# start munge (required by slurm)
echo "starting munge..."
mkdir -p /var/run/munge /var/log/munge /tmp/munge
chown munge:munge /var/run/munge /var/log/munge /tmp/munge
if [ ! -f /etc/munge/munge.key ]; then
    echo "generating munge key..."
    dd if=/dev/urandom bs=1 count=1024 > /etc/munge/munge.key 2>/dev/null
    chown munge:munge /etc/munge/munge.key
    chmod 400 /etc/munge/munge.key
fi
runuser -u munge munged 2>/dev/null || munged -f

# start slurm
echo "starting slurm..."
mkdir -p /var/run/slurm-llnl /var/log/slurm-llnl /var/lib/slurm-llnl/slurmctld /var/lib/slurm-llnl/slurmd
chown slurm:slurm /var/lib/slurm-llnl/slurmctld /var/lib/slurm-llnl/slurmd
slurmctld 2>/dev/null || true
slurmd 2>/dev/null || true
echo "slurm started."

# create working directory for circuitscape sessions
mkdir -p /tmp/circuitscape

# ensure shiny user owns the app directory
chown -R shiny:shiny /srv/shiny-server/batApp

# start shiny server (preserve signal handling)
echo "starting shiny server..."
exec shiny-server