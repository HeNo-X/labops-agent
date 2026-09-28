FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY shared ./shared
COPY seed ./seed
COPY dist ./dist
ENV HOST=0.0.0.0 PORT=8787
EXPOSE 8787
CMD ["node", "server/index.ts"]
