FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
CMD [\"node\",\"sync-ml-to-shopify.js\"]
