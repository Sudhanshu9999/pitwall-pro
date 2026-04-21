"""
PitWall Pro — FastAPI backend entry point.

Run with:
  uvicorn main:app --reload --host 0.0.0.0 --port 8000
"""
from __future__ import annotations
import logging
import os

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

load_dotenv()

from routers.archive import router as archive_router
from routers.schedule import router as schedule_router
from routers.live import router as live_router

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="PitWall Pro API",
    description="FastF1 archive pipeline and OpenF1 live stream proxy",
    version="0.1.0",
)

# CORS — explicit origins from env + regex matching any localhost port for dev
_origins = [o.strip() for o in os.getenv("CORS_ORIGINS", "http://localhost:3000").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_origin_regex=r"http://localhost:\d+",   # covers any Next.js dev port
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(Exception)
async def _unhandled(request: Request, exc: Exception) -> JSONResponse:
    """
    Catch-all for exceptions that escape route handlers.
    Returns JSON with CORS headers so the browser sees the real error
    instead of a misleading 'CORS error' when the actual problem is a 5xx.
    """
    logger.exception("Unhandled error on %s %s", request.method, request.url.path)
    origin = request.headers.get("origin", "")
    headers = {}
    if origin:
        headers["Access-Control-Allow-Origin"] = origin
        headers["Access-Control-Allow-Credentials"] = "true"
    return JSONResponse(
        status_code=500,
        content={"detail": str(exc)},
        headers=headers,
    )

app.include_router(archive_router)
app.include_router(schedule_router)
app.include_router(live_router)


@app.get("/health")
async def health():
    from services.redis_service import ping
    redis_ok = await ping()
    return {"status": "ok", "redis": redis_ok}
