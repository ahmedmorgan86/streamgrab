FROM python:3.11-slim

# تثبيت Node.js + ffmpeg + الأدوات الأساسية
RUN apt-get update && apt-get install -y \
    curl \
    ffmpeg \
    ca-certificates \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && pip install --no-cache-dir yt-dlp \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

# إنشاء مجلد tmp لو مش موجود
RUN mkdir -p /tmp

EXPOSE 3000

CMD ["node", "server.js"]
