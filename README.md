# Sigma Pack

ENV (Render → Environment):
- TELEGRAM_BOT_TOKEN=... (BotFather)
- REDIS_URL=rediss://default:PASS@your-upstash-host:6379
- CLOUDINARY_URL=cloudinary://API_KEY:API_SECRET@CLOUD_NAME   (создай unsigned preset "unsigned")
- SERPAPI_KEY=... (https://serpapi.com)
- BASE_URL=https://<sigma-api External URL>  (после первого деплоя, для api и бота)
- N8N_FINALIZE_WEBHOOK=https://<n8n>/webhook/finalize (опционально)

Flow:
1) /new → персонаж → тема → стиль
2) Ждёшь «preview_ready»
3) Пиши 1..15 (выбор), /rec — авто 7, /final — рендер и ссылки
