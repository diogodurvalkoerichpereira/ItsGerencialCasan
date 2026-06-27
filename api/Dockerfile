FROM node:20-alpine
WORKDIR /app
COPY package.json .
RUN npm install --production
COPY index.js schema.sql ./
EXPOSE 3002
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3002/health || exit 1
CMD ["node", "index.js"]
