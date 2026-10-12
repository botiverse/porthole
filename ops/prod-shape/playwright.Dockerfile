# The browsers Porthole's Playwright version drives, plus certutil, to trust the edge's CA in
# Chromium's NSS store (WebKit reads the system store; Playwright's Firefox reads neither, so
# its project overrides certificate errors).
FROM mcr.microsoft.com/playwright:v1.63.0-noble
RUN apt-get update \
  && apt-get install -y --no-install-recommends libnss3-tools \
  && rm -rf /var/lib/apt/lists/*
