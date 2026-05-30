FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
# tournament data persists on a mounted volume at /app/data
VOLUME ["/app/data"]
CMD ["node", "index.js"]
