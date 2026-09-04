"""Closed semantic-event validation and bounded recording."""

from qa.server_auth import INVALID_BODY

def handle_event(handler, max_events: int) -> None:
    value = handler._read_json()
    if value is INVALID_BODY:
        return
    if not isinstance(value, dict):
        handler._error(400, "invalid semantic event")
        return
    expected_keys = {"type", "controlId", "stepId"}
    if value.get("type") == "uploaded":
        expected_keys.add("expectedFilenameMatched")
    if set(value) != expected_keys:
        handler._error(400, "invalid semantic event")
        return
    if any(
        not isinstance(value[key], str)
        for key in ("type", "controlId", "stepId")
    ):
        handler._error(400, "invalid semantic event")
        return

    event_type = value["type"]
    control_id = value["controlId"]
    step_id = value["stepId"]
    step = handler.server.steps.get(step_id)
    control_entry = handler.server.controls.get(control_id)
    valid = False
    if event_type in {"filled", "uploaded", "validation"} and control_entry is not None:
        control, control_step_id = control_entry
        if control_step_id == step_id:
            if event_type == "filled":
                valid = control["role"] != "file"
            elif event_type == "uploaded":
                valid = control["role"] == "file" and isinstance(
                    value["expectedFilenameMatched"], bool
                )
            else:
                valid = True
    elif event_type == "advanced":
        valid = control_id == "" and step is not None and step["kind"] == "form"
    elif event_type == "reviewed":
        valid = control_id == "" and step is not None and step["kind"] == "review"
    if not valid:
        handler._error(400, "invalid semantic event")
        return

    with handler.server.state_lock:
        if len(handler.server.events) >= max_events:
            event_recorded = False
        else:
            handler.server.events.append(dict(value))
            event_recorded = True
    if not event_recorded:
        handler._error(503, "event limit reached")
        return
    handler._send(204, content_type="application/json; charset=utf-8")


record_event = handle_event
