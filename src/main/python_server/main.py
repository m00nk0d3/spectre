from contextlib import asynccontextmanager
from io import BytesIO
import os

from fastapi import FastAPI, HTTPException, Response
from kokoro import KPipeline
from pydantic import BaseModel
import numpy as np
import soundfile as sf
import torch


LANG_CODE = os.environ.get("KOKORO_LANG_CODE", "p")
DEFAULT_VOICE = os.environ.get("TTS_VOICE", "pf_dora")
SAMPLE_RATE = 24000

pipeline: KPipeline | None = None


class TTSPayload(BaseModel):
    text: str
    voice: str = DEFAULT_VOICE


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global pipeline

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(
        f"[PYTHON-SERVER] Loading Kokoro for language {LANG_CODE} on {device}",
        flush=True,
    )
    pipeline = KPipeline(lang_code=LANG_CODE, device=device)
    print(
        f"[PYTHON-SERVER] Model loaded successfully on {device}",
        flush=True,
    )
    yield
    pipeline = None


app = FastAPI(lifespan=lifespan)


def create_wav(audio: np.ndarray) -> bytes:
    buffer = BytesIO()
    sf.write(buffer, audio, SAMPLE_RATE, format="WAV", subtype="PCM_16")
    return buffer.getvalue()


@app.post("/tts")
async def generate_tts(payload: TTSPayload):
    if pipeline is None:
        raise HTTPException(status_code=503, detail="Kokoro model is not ready")

    text = payload.text.strip()
    if not text:
        silence = np.zeros(SAMPLE_RATE // 2, dtype=np.float32)
        return Response(content=create_wav(silence), media_type="audio/wav")

    try:
        chunks = [
            audio
            for _graphemes, _phonemes, audio in pipeline(
                text,
                voice=payload.voice,
                speed=1,
            )
        ]
    except Exception as error:
        raise HTTPException(
            status_code=500,
            detail=f"TTS generation failed: {error}",
        ) from error

    if not chunks:
        raise HTTPException(status_code=500, detail="Kokoro produced no audio")

    audio = np.concatenate(chunks).astype(np.float32, copy=False)
    return Response(
        content=create_wav(audio),
        media_type="audio/wav",
        headers={
            "Content-Disposition": f'attachment; filename="tts_{payload.voice}.wav"',
        },
    )


@app.get("/health")
async def health_check():
    return {
        "status": "ok" if pipeline is not None else "loading",
        "ready": pipeline is not None,
        "language": LANG_CODE,
        "voice": DEFAULT_VOICE,
        "device": "cuda" if torch.cuda.is_available() else "cpu",
    }
