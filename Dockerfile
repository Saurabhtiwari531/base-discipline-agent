# Base Discipline Agent — long-running XMTP agent process.
#
#   docker build -t discipline-agent .
#   docker run -d --env-file .env -v $(pwd)/data:/app/data --name agent discipline-agent
#
# bookworm-slim (not alpine): @xmtp/node-sdk ships native bindings built
# against glibc. Node >= 22.5 required for the built-in node:sqlite.
FROM node:24-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

# Agent SQLite state lives here — mount a volume or it dies with the container.
VOLUME /app/data
ENV DB_PATH=/app/data/agent.db

CMD ["npx", "tsx", "src/index.ts"]
