# Application container for the bat dispersion prediction app.
# Includes Shiny, Julia/Circuitscape, Slurm, and PostGIS client.
# Used for both the test stack (docker-compose) and production deployment.
FROM rocker/shiny:4.4.0

RUN apt-get update && apt-get install -y \
    --no-install-recommends \
    git-core \
    libssl-dev \
    libcurl4-gnutls-dev \
    libxml2-dev \
    libudunits2-dev \
    libgeos-dev \
    libgdal-dev \
    libpq-dev \
    libproj-dev \
    postgresql \
    postgis \
    curl \
    slurmd \
    slurmctld \
    munge \
    gettext-base \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://install.julialang.org | sh -s -- -y
ENV PATH="/root/.juliaup/bin:${PATH}"
RUN ln -s /root/.juliaup/bin/julia /usr/local/bin/julia

ENV _R_SHLIB_STRIP_=true

WORKDIR /srv/shiny-server/batApp
COPY renv.lock renv.lock
COPY renv/activate.R renv/activate.R
COPY renv/settings.json renv/settings.json
COPY .Rprofile .Rprofile

RUN Rscript -e "renv::restore()"

WORKDIR /
RUN julia -e 'using Pkg; Pkg.add("Circuitscape")'

COPY . /srv/shiny-server/batApp
COPY test/docker/batapp/shiny-server.conf /etc/shiny-server/shiny-server.conf
COPY test/docker/batapp/bats.cfg.template /opt/bats.cfg.template
COPY test/docker/batapp/start.sh /sbin/start.sh
COPY test/docker/slurm.conf /etc/slurm-llnl/slurm.conf

RUN chmod +x /sbin/start.sh

EXPOSE 3838
ENV SHINY_LOG_STDERR=1
ENV DATABASE_HOST=postgis
ENV DATABASE_NAME=os
ENV DATABASE_PORT=5432
ENV DATABASE_USER=bats
ENV DATABASE_PASSWORD=bats

ENTRYPOINT ["/sbin/start.sh"]