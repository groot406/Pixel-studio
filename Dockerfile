# Pixel Studio Cloud (hosted SaaS edition). See docs/saas.md.
FROM node:22-slim
ENV NODE_ENV=production PORT=8080 DATABASE_PATH=/data/pixel-studio.db NODE_NO_WARNINGS=1
WORKDIR /app
COPY . .
RUN mkdir -p /data && chown node:node /data /app
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "cloud/start.mjs"]
