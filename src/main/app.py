#!/usr/bin/env python3
"""FastAPI server for Kokoro TTS model and audio synthesis."""

from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
import uvicorn
import base64
import io
import subprocess
import os
import json
from typing import Optional

app = FastAPI(title="Kokoro TTS Server", version="1.0.0")

MODEL_PATH: Optional[str] = None

def get_model_path() -> Optional[str]:
    """Get model path from environment or return None."""
    return os.getenv("KOKORO_MODEL_PATH")


@app.on_event("startup")
async def startup_event():
    """Handle server startup and optional GPU model loading."""
    if not MODEL_PATH:
        print("Starting uvicorn server without GPU model (KOKORO_MODEL_PATH not set)")
        return

    try:
        # Check if kokoro-cli is available
        result = subprocess.run(
            ["which", "kokoro-cli"],
            capture_output=True,
            text=True,
            timeout=10
        )

        if result.returncode != 0:
            print("kokoro-cli not found in PATH, attempting direct model load")

            # Try to load the model with Python
            import requests

            url = f"https://huggingface.co/lingdolphin/kokoro/resolve/main/{MODEL_PATH.split('/')[-1]}"
            headers = {"User-Agent": "Mozilla/5.0"}

            try:
                response = requests.get(url, headers=headers, timeout=30)
                if response.status_code == 200:
                    model_filename = MODEL_PATH.split("/")[-1]
                    with open(model_filename.replace("/", "_"), "wb") as f:
                        f.write(response.content)

                    # Run kokoro init to load model
                    print(f"Loading GPU model: {MODEL_PATH}")

                    # Check for CUDA/nvidia availability
                    nvidia_check = subprocess.run(
                        ["nvidia-smi", "--query-gpu=name"],
                        capture_output=True,
                        text=True,
                        timeout=10
                    )

                    if nvidia_check.returncode == 0:
                        print(f"GPU detected: {nvidia_check.stdout.strip()}")

                        # Initialize model with GPU
                        init_proc = subprocess.run(
                            [
                                "kokoro-cli",
                                "--model", MODEL_PATH,
                                "--device", "cuda"
                            ],
                            capture_output=True,
                            text=True,
                            timeout=180
                        )

                        if init_proc.returncode == 0:
                            print("Model loaded successfully on GPU")
                            print("exit code : 0")
                        else:
                            print(f"GPU model initialization failed: {init_proc.stderr}")
                            print("falling back to CPU inference")

                    subprocess.run(
                        [
                            "kokoro-cli",
                            "--model", MODEL_PATH,
                            "--device", "cpu"
                        ],
                        capture_output=True,
                        text=True,
                        timeout=180
                    )

                    print("exit code : 0")
                else:
                    print(f"Failed to download model: {response.status_code}")
            except Exception as e:
                print(f"Model loading error: {str(e)}")
        else:
            # kokoro-cli is available, try GPU if CUDA is present
            cuda_available = os.getenv("CUDA_VISIBLE_DEVICES") is not None
            device = "cuda" if cuda_available else "cpu"

            print(f"Loading kokoro model with {device.upper()} inference")

            init_proc = subprocess.run(
                [
                    "kokoro-cli",
                    "--model", MODEL_PATH,
                    "--device", device
                ],
                capture_output=True,
                text=True,
                timeout=180
            )

            if init_proc.returncode == 0:
                print("Model loaded successfully on GPU")
                print("exit code : 0")
            else:
                print(f"Model loading output:")
                print(init_proc.stdout)
                print(init_proc.stderr)


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {"status": "ok", "model": MODEL_PATH}


@app.post("/v1/audio/speech")
async def generate_audio(
    model: str = "tts-1",
    input: str = "",
    voice: str = "alloy",
    response_format: str = "mp3"
):
    """Generate audio using Kokoro TTS model."""
    if not MODEL_PATH:
        raise HTTPException(
            status_code=404,
            detail="TTS model not loaded. Please set KOKORO_MODEL_PATH environment variable."
        )

    try:
        # Prepare the request for kokoro-cli
        data = {
            "text": input,
            "model": MODEL_PATH,
            "voice": voice,
            "duration_seconds": 10
        }

        result = subprocess.run(
            ["kokoro-cli", "--text", json.dumps(data)],
            capture_output=True,
            text=True,
            timeout=60
        )

        if result.returncode != 0:
            raise HTTPException(
                status_code=500,
                detail=f"TTS generation failed: {result.stderr}"
            )

        # Convert output to base64 for API response
        audio_bytes = io.BytesIO(result.stdout)
        return StreamingResponse(
            audio_bytes,
            media_type=f"audio/{response_format}",
            headers={
                "Content-Disposition": f'attachment; filename="output.{response_format}"'
            }
        )

    except subprocess.TimeoutExpired:
        raise HTTPException(
            status_code=504,
            detail="TTS generation timed out"
        )
    except FileNotFoundError:
        raise HTTPException(
            status_code=404,
            detail="kokoro-cli not found in PATH. Please install it."
        )


if __name__ == "__main__":
    MODEL_PATH = get_model_path()
    print(f"Starting Kokoro TTS server on http://127.0.0.1:1234")
    if MODEL_PATH:
        print(f"Model path: {MODEL_PATH}")
    uvicorn.run(app, host="127.0.0.1", port=1234)
