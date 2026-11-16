FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY shared ./shared
COPY seed ./seed
COPY dist ./dist
# 线上部署不显示「实验室监控」模块（用户裁定：本地保留、线上不提供）；
# 本地运行不设 VISION_MODULE 即完整保留监控模块。
ENV VISION_MODULE=off
ENV HOST=0.0.0.0 PORT=8787
EXPOSE 8787
CMD ["node", "server/index.ts"]
