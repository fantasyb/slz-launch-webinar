# Test fixture only. CI passes the immutable built image ID to the launcher.
FROM node:22-bookworm-slim
RUN mkdir /write-probe && chmod 0777 /write-probe
COPY probe.mjs /probe.mjs
COPY network-witness.mjs /network-witness.mjs
COPY hostile.mjs /hostile.mjs
