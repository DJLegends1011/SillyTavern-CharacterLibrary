# Character Library capture relay: a public place for a site's server to send its chat prompt.
# No dependencies; node 22 for parity with cl-helper.
FROM node:22-bookworm-slim

WORKDIR /app
COPY run-relay.mjs /app/run-relay.mjs

ENV PORT=8787 \
    BIND=0.0.0.0

USER node
EXPOSE 8787
CMD ["node", "/app/run-relay.mjs"]
