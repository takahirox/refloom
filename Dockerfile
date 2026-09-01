ARG NODE_IMAGE=node:24.7.0-alpine3.22
FROM ${NODE_IMAGE}

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
RUN apk add --no-cache chromium xvfb-run

ENV REFLOOM_CHROME_PATH=/usr/bin/chromium-browser
ENV DISPLAY=:99

COPY LICENSE README.md mcp-server.mjs server.mjs ./
COPY migrations ./migrations
COPY public ./public
COPY scripts/init-bucket.mjs scripts/check-browser.mjs ./scripts/
COPY src ./src

USER node
ENTRYPOINT ["xvfb-run", "--server-num=99", "--server-args=-screen 0 1920x1080x24 -nolisten tcp"]
EXPOSE 4173
CMD ["node", "server.mjs"]
