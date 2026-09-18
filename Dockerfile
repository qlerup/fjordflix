FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg mediainfo curl fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
COPY tests ./tests
RUN mkdir -p app/static/vendor && curl --fail --location https://cdn.jsdelivr.net/npm/hls.js@1.6.15/dist/hls.min.js -o app/static/vendor/hls.min.js
ENV DATA_DIR=/data NVIDIA_VISIBLE_DEVICES=all NVIDIA_DRIVER_CAPABILITIES=compute,video,utility
EXPOSE 8080
HEALTHCHECK --interval=20s --timeout=3s CMD curl -fsS http://localhost:8080/api/health || exit 1
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]

