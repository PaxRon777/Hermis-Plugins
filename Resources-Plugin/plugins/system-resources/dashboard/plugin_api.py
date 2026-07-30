"""
System Resources Monitor Plugin - Python Backend
Provides real-time CPU, RAM, GPU, and VRAM usage data.
Uses psutil for CPU/Memory and pynvml/nvidia-smi for GPU.
"""

import os
import platform
import subprocess
import threading
import time
from typing import Any, Optional

from fastapi import APIRouter, Query
from pydantic import BaseModel

try:
    import psutil
except ImportError:
    psutil = None

try:
    import pynvml
    PYNVML_AVAILABLE = True
except ImportError:
    PYNVML_AVAILABLE = False

router = APIRouter()

# Cache for GPU data to avoid excessive nvidia-smi calls
_gpu_cache = {"data": None, "timestamp": 0}
_GPU_CACHE_TTL = 1.0  # seconds

# History storage (in-memory, max 60 points = 2 min at 2s interval)
_history_lock = threading.Lock()
_cpu_history = []
_mem_history = []
_gpu_history = []


def _add_to_history(history_list, value, max_len=60):
    """Thread-safe history append."""
    with _history_lock:
        history_list.append(value)
        if len(history_list) > max_len:
            history_list.pop(0)


def get_cpu_info() -> dict[str, Any]:
    """Get CPU usage: total percent, per-core percents, and history."""
    if not psutil:
        return {"total": 0, "cores": [], "history": list(_cpu_history)}
    
    # Get per-core usage (non-blocking, uses cached values)
    core_percents = psutil.cpu_percent(interval=None, percpu=True)
    total_percent = sum(core_percents) / len(core_percents) if core_percents else 0
    
    _add_to_history(_cpu_history, total_percent)
    
    return {
        "total": round(total_percent, 1),
        "cores": [round(c, 1) for c in core_percents],
        "history": list(_cpu_history)
    }


def get_memory_info() -> dict[str, Any]:
    """Get RAM and swap usage."""
    if not psutil:
        return {"used": 0, "total": 0, "percent": 0, "history": list(_mem_history), "swap": None}
    
    mem = psutil.virtual_memory()
    swap = psutil.swap_memory()
    
    _add_to_history(_mem_history, mem.percent)
    
    return {
        "used": mem.used,
        "total": mem.total,
        "percent": round(mem.percent, 1),
        "available": mem.available,
        "history": list(_mem_history),
        "swap": {
            "used": swap.used,
            "total": swap.total,
            "percent": round(swap.percent, 1)
        } if swap.total > 0 else None
    }


def _get_gpu_pynvml() -> list[dict[str, Any]]:
    """Get GPU info via pynvml (preferred, faster)."""
    if not PYNVML_AVAILABLE:
        return []
    
    try:
        pynvml.nvmlInit()
        device_count = pynvml.nvmlDeviceGetCount()
        gpus = []
        
        for i in range(device_count):
            handle = pynvml.nvmlDeviceGetHandleByIndex(i)
            
            # Name
            name = pynvml.nvmlDeviceGetName(handle)
            if isinstance(name, bytes):
                name = name.decode('utf-8')
            
            # Utilization
            util = pynvml.nvmlDeviceGetUtilizationRates(handle)
            gpu_util = util.gpu
            
            # Memory
            mem_info = pynvml.nvmlDeviceGetMemoryInfo(handle)
            vram_used = mem_info.used
            vram_total = mem_info.total
            vram_percent = (vram_used / vram_total * 100) if vram_total > 0 else 0
            
            # Temperature
            try:
                temp = pynvml.nvmlDeviceGetTemperature(handle, pynvml.NVML_TEMPERATURE_GPU)
            except pynvml.NVMLError:
                temp = None
            
            # Power
            try:
                power_draw = pynvml.nvmlDeviceGetPowerUsage(handle) / 1000.0  # mW to W
                power_limit = pynvml.nvmlDeviceGetEnforcedPowerLimit(handle) / 1000.0
            except pynvml.NVMLError:
                power_draw = None
                power_limit = None
            
            gpus.append({
                "index": i,
                "name": name,
                "utilization": gpu_util,
                "vramUsed": vram_used,
                "vramTotal": vram_total,
                "vramPercent": round(vram_percent, 1),
                "temp": temp,
                "powerDraw": round(power_draw, 1) if power_draw else None,
                "powerLimit": round(power_limit, 1) if power_limit else None,
                "utilHistory": list(_gpu_history)
            })
        
        return gpus
    except Exception as e:
        print(f"pynvml error: {e}")
        return []


def _get_gpu_nvidia_smi() -> list[dict[str, Any]]:
    """Fallback: get GPU info via nvidia-smi."""
    try:
        # Query all needed fields at once
        cmd = [
            "nvidia-smi",
            "--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit",
            "--format=csv,noheader,nounits"
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=2)
        
        if result.returncode != 0:
            return []
        
        gpus = []
        for line in result.stdout.strip().split('\n'):
            if not line.strip():
                continue
            parts = [p.strip() for p in line.split(',')]
            if len(parts) < 8:
                continue
            
            idx = int(parts[0])
            name = parts[1]
            util = float(parts[2]) if parts[2] != '[Not Supported]' else 0
            vram_used = int(parts[3]) * 1024 * 1024  # MiB to bytes
            vram_total = int(parts[4]) * 1024 * 1024
            vram_percent = (vram_used / vram_total * 100) if vram_total > 0 else 0
            temp = int(parts[5]) if parts[5].isdigit() else None
            power_draw = float(parts[6]) if parts[6] != '[Not Supported]' else None
            power_limit = float(parts[7]) if parts[7] != '[Not Supported]' else None
            
            gpus.append({
                "index": idx,
                "name": name,
                "utilization": util,
                "vramUsed": vram_used,
                "vramTotal": vram_total,
                "vramPercent": round(vram_percent, 1),
                "temp": temp,
                "powerDraw": power_draw,
                "powerLimit": power_limit,
                "utilHistory": list(_gpu_history)
            })
        
        return gpus
    except (subprocess.TimeoutExpired, FileNotFoundError, ValueError, IndexError) as e:
        print(f"nvidia-smi error: {e}")
        return []


def get_gpu_info() -> list[dict[str, Any]]:
    """Get GPU info with caching."""
    global _gpu_cache
    
    now = time.time()
    if _gpu_cache["data"] and (now - _gpu_cache["timestamp"]) < _GPU_CACHE_TTL:
        # Update history for cached data
        for gpu in _gpu_cache["data"]:
            gpu["utilHistory"] = list(_gpu_history)
        return _gpu_cache["data"]
    
    # Try pynvml first, fallback to nvidia-smi
    gpus = _get_gpu_pynvml()
    if not gpus:
        gpus = _get_gpu_nvidia_smi()
    
    # Update history with first GPU's utilization
    if gpus:
        _add_to_history(_gpu_history, gpus[0]["utilization"])
    
    _gpu_cache = {"data": gpus, "timestamp": now}
    return gpus


def get_all_resources() -> dict[str, Any]:
    """Get all system resources in one call."""
    cpu = get_cpu_info()
    memory = get_memory_info()
    gpu = get_gpu_info()
    
    # Add history to GPU data
    for g in gpu:
        g["utilHistory"] = list(_gpu_history)
    
    return {
        "cpu": cpu,
        "memory": memory,
        "gpu": gpu,
        "platform": platform.system(),
        "platformVersion": platform.version()
    }


def get_summary() -> dict[str, float]:
    """Get a quick summary for the statusbar chip."""
    cpu = get_cpu_info()
    memory = get_memory_info()
    gpu = get_gpu_info()
    
    return {
        "cpu": cpu.get("total", 0),
        "mem": memory.get("percent", 0),
        "gpu": gpu[0].get("utilization", 0) if gpu else 0,
        "vram": gpu[0].get("vramPercent", 0) if gpu else 0
    }


# ─── API Routes ──────────────────────────────────────────────────────────────
# Mounted under /api/plugins/system-resources/

@router.get("/resources")
async def resources_endpoint() -> dict[str, Any]:
    """Main endpoint: returns all resource data."""
    return get_all_resources()


@router.get("/summary")
async def summary_endpoint() -> dict[str, float]:
    """Quick summary for statusbar."""
    return get_summary()


@router.get("/cpu")
async def cpu_endpoint() -> dict[str, Any]:
    """CPU-specific data."""
    return get_cpu_info()


@router.get("/memory")
async def memory_endpoint() -> dict[str, Any]:
    """Memory-specific data."""
    return get_memory_info()


@router.get("/gpu")
async def gpu_endpoint() -> list[dict[str, Any]]:
    """GPU-specific data."""
    return get_gpu_info()


@router.get("/health")
async def health_endpoint() -> dict[str, Any]:
    """Health check endpoint."""
    return {
        "status": "ok",
        "psutil": psutil is not None,
        "pynvml": PYNVML_AVAILABLE,
        "nvidiaSmi": _check_nvidia_smi()
    }


def _check_nvidia_smi() -> bool:
    """Check if nvidia-smi is available."""
    try:
        subprocess.run(["nvidia-smi"], capture_output=True, timeout=1)
        return True
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return False


# Initialize NVML on module load if available
if PYNVML_AVAILABLE:
    try:
        pynvml.nvmlInit()
    except Exception:
        pass