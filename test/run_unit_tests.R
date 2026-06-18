#!/usr/bin/env Rscript
options(project_root = getwd())
files <- list.files("test/unit", pattern = "^test_.*\\.R$", full.names = TRUE)
for (f in files) {
  cat("Running:", basename(f), "...\n")
  source(f)
}