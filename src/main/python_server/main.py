from contextlib import asynccontextmanager
from io import BytesIO
import os

from fastapi import FastAPI, HTTPException, Request, Response
from faster_whisper import WhisperModel
from kokoro import KPipeline
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool
import numpy as np
import soundfile as sf
import torch


LANG_CODE = os.environ.get("KOKORO_LANG_CODE", "a")
DEFAULT_VOICE = os.environ.get("TTS_VOICE", "am_michael")
SAMPLE_RATE = 24000

pipeline: KPipeline | None = None
whisper_model: WhisperModel | None = None


class TTSPayload(BaseModel):
    text: str
    voice: str = DEFAULT_VOICE
    speed: float = Field(default=1.1, ge=0.5, le=2.0)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global pipeline, whisper_model

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
    whisper_model = WhisperModel(
        "small",
        device="cpu",
        compute_type="int8",
        cpu_threads=max(1, os.cpu_count() or 1),
        download_root=os.environ.get(
            "WHISPER_CT2_MODEL_PATH",
            os.path.expanduser(
                "~/.local/share/spectre/whisper/faster-whisper",
            ),
        ),
    )
    print("[PYTHON-SERVER] Faster Whisper model loaded on CPU", flush=True)
    yield
    pipeline = None
    whisper_model = None


app = FastAPI(lifespan=lifespan)


def transcribe_audio(audio: bytes) -> str:
    if whisper_model is None:
        raise RuntimeError("Faster Whisper model is not ready")

    segments, _info = whisper_model.transcribe(
        BytesIO(audio),
        language="en",
        beam_size=5,
        initial_prompt=(
            "Accurate US English transcription. Assistant name: Spectre."
        ),
        hotwords=(
            "Spectre, LM Studio, Kokoro, Whisper, AppImage, Linux, "
            "Electron, Hyprland"
        ),
        condition_on_previous_text=False,
        vad_filter=False,
    )
    return "".join(segment.text for segment in segments).strip()


@app.post("/transcribe")
async def transcribe(request: Request):
    if whisper_model is None:
        raise HTTPException(
            status_code=503,
            detail="Faster Whisper model is not ready",
        )

    audio = await request.body()
    if not audio:
        raise HTTPException(status_code=400, detail="Audio body is empty")

    try:
        text = await run_in_threadpool(transcribe_audio, audio)
    except Exception as error:
        raise HTTPException(
            status_code=500,
            detail=f"Transcription failed: {error}",
        ) from error

    if not text:
        raise HTTPException(status_code=422, detail="No speech recognized")
    return {"text": text}


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
                speed=payload.speed,
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
        "whisper_ready": whisper_model is not None,
        "language": LANG_CODE,
        "voice": DEFAULT_VOICE,
        "device": "cuda" if torch.cuda.is_available() else "cpu",
    }
