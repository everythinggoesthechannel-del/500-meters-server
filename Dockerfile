# 500 Meters — chat server (permanent host image)
# Build:  docker build -t 500-meters-server .
# Run:    docker run -p 3000:3000 500-meters-server
# The server is zero-dependency Node.js, in-memory only: no database,
# nothing saved to disk, no history. PORT is honoured when the host sets it.
FROM node:20-alpine
WORKDIR /app
COPY package.json server.js ./
EXPOSE 3000
ENV NODE_ENV=production
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:${PORT:-3000}/health || exit 1
CMD ["node", "server.js"]
