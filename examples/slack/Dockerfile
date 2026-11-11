FROM oven/bun:1.3.2-alpine

WORKDIR /app

COPY package.runtime.json ./package.json
COPY agent.ts index.ts mcp-fixture.ts mcp-server.ts model.ts simulator.ts ui.ts ./
COPY .release ./release

# Install the repository tarballs, not the monorepo source or dev dependencies.
RUN bun add --ignore-scripts \
  ./release/fevex-core-*.tgz \
  ./release/fevex-openai-*.tgz \
  ./release/fevex-deepseek-*.tgz \
  ./release/fevex-mcp-*.tgz \
  ./release/fevex-slack-*.tgz \
  ./release/fevex-sqlite-*.tgz

ENV PORT=3000
EXPOSE 3000
CMD ["bun", "run", "index.ts"]
