FROM node:24-bookworm-slim
ENV NODE_ENV=production PORT=3000 DB_PATH=/data/pricing.sqlite
WORKDIR /app
RUN mkdir /data && chown node:node /data
COPY --chown=node:node package.json product-edit.mjs pricing.mjs shopify.mjs shipping.mjs dhl.mjs shipping-service.mjs postal-directory.mjs store.mjs server.mjs ./
COPY --chown=node:node public ./public
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
