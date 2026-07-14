FROM python:3.12-slim

# markitdown's PDF/Office backends need a few system libs; docling additionally needs these for OCR.
RUN apt-get update \
  && apt-get install -y --no-install-recommends libmagic1 libgl1 libglib2.0-0 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py signature_probe.py test_signature_probe.py ./
RUN python -m unittest -v test_signature_probe.py

ENV CONVERTER_BACKEND=markitdown
EXPOSE 5003
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "5003"]
