# Application container for the bat dispersion prediction app.
# Includes Shiny, Julia/Circuitscape, Slurm, and PostGIS client.
# Used for both the test stack (docker-compose) and production deployment.
FROM rocker/shiny:4.3.3

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
    libuv1 \
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

COPY test/docker/JuliaProject.toml /srv/shiny-server/batApp/JuliaProject.toml

WORKDIR /srv/shiny-server/batApp
COPY .Rprofile.docker /srv/shiny-server/batApp/.Rprofile
COPY renv.lock /srv/shiny-server/batApp/renv.lock
COPY renv/ /srv/shiny-server/batApp/renv/

# For binary package installation, use the RStudio Package Manager CRAN mirror...
RUN echo 'options(repos = c(CRAN = "https://packagemanager.posit.co/cran/__linux__/jammy/latest"))' >> /usr/local/lib/R/etc/Rprofile.site
RUN Rscript -e "install.packages('renv')"
RUN Rscript -e "renv::restore(library = '/usr/local/lib/R/site-library')"

RUN ls -la /srv/shiny-server/batApp/renv/library/

WORKDIR /
RUN julia -e 'using Pkg; Pkg.activate("/srv/shiny-server/batApp"); Pkg.instantiate()'

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