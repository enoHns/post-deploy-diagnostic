FROM node:24-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash ca-certificates coreutils curl dnsutils iproute2 iputils-ping jq \
    netcat-openbsd openssh-client openssl procps tcpdump \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 10001 --create-home diagnostic
WORKDIR /opt/diagnostic
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY VERSION ./
COPY bin/ bin/
COPY lib/ lib/
RUN chmod +x bin/diagnostic lib/*.sh && ln -s /opt/diagnostic/bin/diagnostic /usr/local/bin/diagnostic
USER 10001:10001
WORKDIR /work
ENTRYPOINT ["diagnostic"]
CMD ["--help"]

FROM runtime AS test
USER root
RUN apt-get update && apt-get install -y --no-install-recommends shellcheck libxml2-utils \
    && rm -rf /var/lib/apt/lists/*
COPY tests/ /opt/diagnostic/tests/
COPY scripts/ /opt/diagnostic/scripts/
COPY lab/vm/ /opt/diagnostic/lab/vm/
COPY templates/ /opt/diagnostic/templates/
COPY .gitlab-ci.yml /opt/diagnostic/.gitlab-ci.yml
WORKDIR /opt/diagnostic
ENTRYPOINT ["bash", "scripts/test.sh"]

FROM runtime AS final
