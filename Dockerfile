ARG NODE_IMAGE=node:24.7.0-alpine3.22
FROM ${NODE_IMAGE}

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
RUN apk add --no-cache chromium

ENV REFLOOM_CHROME_PATH=/usr/bin/chromium-browser

COPY LICENSE README.md mcp-server.mjs server.mjs ./
COPY migrations ./migrations
COPY public ./public
COPY scripts/init-bucket.mjs scripts/check-browser.mjs ./scripts/
COPY src ./src

USER node
EXPOSE 4173
CMD ["node", "server.mjs"]
