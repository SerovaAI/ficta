# Medical PII analyzer service

This service exposes a Presidio-compatible analyzer API for `OpenMed/privacy-filter-nemotron-v2`.
It is model-only: run Microsoft Presidio separately for general/rule-based PII and configure Ficta
to call both backends natively.

This is best-effort detection. It reduces exposure, but it is not a HIPAA de-identification guarantee.
Validate it with representative clinical text before using it with regulated data.

## Build and run

CPU image:

```sh
docker build --target cpu -t ficta-medical-pii-analyzer:cpu services/medical-pii-analyzer
docker run --rm -p 5003:3000 ficta-medical-pii-analyzer:cpu
```

GPU image using a PyTorch CUDA runtime:

```sh
docker build --target gpu \
  --build-arg BASE_IMAGE=pytorch/pytorch:2.5.1-cuda12.4-cudnn9-runtime \
  --build-arg INSTALL_TORCH=0 \
  -t ficta-medical-pii-analyzer:gpu \
  services/medical-pii-analyzer

docker run --rm --gpus all -p 5003:3000 ficta-medical-pii-analyzer:gpu
```

For production medical workflows, set `MEDICAL_EAGER_LOAD=1` so container startup fails early if the
model cannot load.

## Ficta config

Run Presidio separately on `5002`, run this medical analyzer on `5003`, then configure Ficta to call
both:

```sh
FICTA_PII_ENABLED=1 \
FICTA_PII_BACKENDS=presidio,medical \
FICTA_PII_PRESIDIO_URL=http://127.0.0.1:5002 \
FICTA_PII_MEDICAL_URL=http://127.0.0.1:5003 \
FICTA_PII_FAIL_CLOSED=1 \
ficta claude
```

`FICTA_PII_FAIL_CLOSED=1` is recommended for medical workflows: if either selected backend is down
or returns an error, Ficta blocks the request instead of forwarding unscreened text.

## API

`GET /health` returns detector status:

```json
{
  "status": "ok",
  "detectors": {
    "openmed": { "enabled": true, "loaded": false }
  }
}
```

`POST /analyze` accepts the Presidio request fields Ficta sends:

```json
{
  "text": "Patient Sarah Smith, MRN A12345, called 212-555-0187.",
  "language": "en",
  "score_threshold": 0.5,
  "entities": ["PERSON", "PHONE_NUMBER", "MEDICAL_RECORD_NUMBER"]
}
```

It returns Presidio-shaped spans:

```json
[
  { "entity_type": "MEDICAL_RECORD_NUMBER", "start": 25, "end": 31, "score": 0.88 }
]
```

## Configuration

| Env | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port inside the container |
| `MEDICAL_SCORE_THRESHOLD` | `0.5` | Default threshold when `/analyze` omits `score_threshold` |
| `MEDICAL_EAGER_LOAD` | `0` | Load OpenMed during startup |
| `OPENMED_MODEL` | `OpenMed/privacy-filter-nemotron-v2` | Hugging Face model ID or local path |
| `OPENMED_DEVICE` | `auto` | `auto`, `cpu`, `cuda`, `cuda:N`, or integer device index |
| `OPENMED_TORCH_DTYPE` | `auto` | `auto`, `bfloat16`, `float16`, or `float32` |
| `OPENMED_TRUST_REMOTE_CODE` | `1` | Required by the OpenMed model card's Transformers example |
| `OPENMED_AGGREGATION_STRATEGY` | `simple` | Transformers token-classification aggregation strategy |

## Local tests

The merge/normalization tests do not load OpenMed. API contract tests use a fake detector and run
when the service Python requirements are installed; otherwise they skip cleanly.

```sh
cd services/medical-pii-analyzer
python -m unittest discover
```
