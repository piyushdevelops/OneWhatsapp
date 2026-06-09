FROM node:20-alpine

WORKDIR /app

COPY outputs/whatsapp-dashboard /app/outputs/whatsapp-dashboard
COPY outputs/whatsapp-webhook-server /app/outputs/whatsapp-webhook-server

ENV HOST=0.0.0.0
ENV PORT=3000
ENV DASHBOARD_DIR=/app/outputs/whatsapp-dashboard
ENV DATA_DIR=/data/oneoperations-whatsapp

EXPOSE 3000

CMD ["node", "/app/outputs/whatsapp-webhook-server/live-server.js"]
