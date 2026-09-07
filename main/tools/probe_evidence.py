from __future__ import annotations

from typing import Any

from deepem.devices.abstract import DeviceCommand
from deepem.protocol import ToolResult, utc_now
from deepem.probe_evidence_compaction import build_probe_evidence_pack
from deepem.tools.base import ToolContext, ToolDefinition, ToolExecutionResult


def _collect_probe_evidence(args: dict[str, Any], context: ToolContext) -> ToolExecutionResult:
    adapter = context.device_registry.find_by_capability("collect_wifi_bluetooth_probe_evidence")
    if adapter is None:
        return ToolExecutionResult(result=ToolResult(status="error", error="WiFi/蓝牙探针适配器未注册"))

    def emit(stage: str, data: dict[str, Any]) -> None:
        if context.stream_handler is not None:
            context.stream_handler("probe_progress", {"stage": stage, **dict(data or {})})

    client = getattr(adapter, "client", None)
    try:
        if client is not None and callable(getattr(client, "collect_evidence", None)):
            result = client.collect_evidence(
                probe_ids=[str(item) for item in args.get("probe_ids", [])],
                kinds=[str(item) for item in args.get("kinds", ["wifi_ap", "wifi_client", "bluetooth"])],
                active_minutes=int(args.get("active_minutes", 30)),
                page_size=int(args.get("page_size", 200)),
                progress=emit,
            )
        else:
            device_result = adapter.execute(
                DeviceCommand(
                    device_id=adapter.device_id,
                    capability="collect_wifi_bluetooth_probe_evidence",
                    args=dict(args or {}),
                )
            )
            if device_result.status != "success":
                return ToolExecutionResult(result=ToolResult(status="error", error=device_result.error or "探针证据采集失败"))
            result = dict(device_result.data or {})
    except Exception as exc:
        return ToolExecutionResult(result=ToolResult(status="error", error=str(exc)))

    evidence_pack = build_probe_evidence_pack(result)
    state = context.state_repo.get(context.task.id)
    history = list(state.metadata.get("wifi_bluetooth_probe_evidence_history") or [])
    stored = {
        "capture_task_id": str(args.get("capture_task_id") or ""),
        "updated_at": utc_now().isoformat(),
        "counts": dict(result.get("counts") or {}),
        "overview": evidence_pack["overview"],
        "raw_result_sha256": evidence_pack["manifest"]["full_result_sha256"],
        "storage_note": "原始证据由调用方落盘；任务状态仅保存受限长度索引，避免后续提示词上下文膨胀。",
    }
    history.append(stored)
    state.metadata["wifi_bluetooth_probe_evidence"] = stored
    state.metadata["wifi_bluetooth_probe_evidence_history"] = history[-20:]
    context.state_repo.save(state)
    return ToolExecutionResult(result=ToolResult(status="success", data=result))


def build_collect_probe_evidence_tool() -> ToolDefinition:
    return ToolDefinition(
        name="collect_wifi_bluetooth_probe_evidence",
        description=(
            "依次调用设备管理平台的 /api/probe/devices、/api/probe/targets 和 /api/probe/observations，"
            "采集 WiFi 热点、WiFi 客户端和蓝牙设备辅助证据，并写入任务状态供后续研判使用。"
        ),
        input_schema={
            "type": "object",
            "properties": {
                "probe_ids": {"type": "array", "items": {"type": "string"}},
                "kinds": {
                    "type": "array",
                    "items": {"type": "string", "enum": ["wifi_ap", "wifi_client", "bluetooth"]},
                },
                "active_minutes": {"type": "integer", "minimum": 1, "maximum": 1440},
                "page_size": {"type": "integer", "minimum": 1, "maximum": 200},
                "capture_task_id": {"type": "string"},
            },
            "required": ["probe_ids"],
        },
        handler=_collect_probe_evidence,
    )
