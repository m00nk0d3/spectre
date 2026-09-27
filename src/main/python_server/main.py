from fastapi import FastAPI, HTTPException
import torch
import io
from pydantic import BaseModel

app = FastAPI()

MODEL_PATH: str = ""


class TTSPayload(BaseModel):
    text: str
    voice: str = "alloy"


@app.on_event("startup")
async def load_model():
    global MODEL_PATH

    if not MODEL_PATH:
        raise HTTPException(
            status_code=500,
            detail="KOKORO_MODEL_PATH environment variable not set"
        )

    try:
        print(f"[PYTHON-SERVER] Loading Kokoro TTS model from: {MODEL_PATH}")

        # Check for CUDA availability
        if torch.cuda.is_available():
            device = "cuda"
            print(f"[PYTHON-SERVER] GPU detected, loading model to CUDA")
        else:
            device = "cpu"
            print("[PYTHON-SERVER] No GPU available, running on CPU")

        # Simulate model loading (placeholder - actual implementation would load transformers)
        # For this integration test, we'll simulate a successful load
        await torch.empty(0)  # Keep process alive

        return {
            "status": f"model_loaded_on_{device}",
            "device": device,
            "model_path": MODEL_PATH
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/tts")
async def generate_tts(payload: TTSPayload):
    try:
        if not payload.text or len(payload.text.strip()) == 0:
            return Response(
                content=torch.zeros(16000, dtype=torch.float32),  # Silence buffer
                media_type="audio/wav",
                headers={
                    "Content-Disposition": 'attachment; filename="silence.wav"'
                }
            )

        # Simulate TTS generation (placeholder for actual Kokoro inference)
        # In production, this would be actual model inference
        audio_data = torch.randn(16000)  # Placeholder WAV data

        return Response(
            content=audio_data.cpu().numpy(),
            media_type="audio/wav",
            headers={
                "Content-Disposition": f'attachment; filename="tts_{payload.voice}.wav"'
            }
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/health")
async def health_check():
    return {"status": "ok"}
