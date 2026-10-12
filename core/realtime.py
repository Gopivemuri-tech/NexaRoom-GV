import asyncio
import socketio
from asgiref.sync import sync_to_async
from django.contrib.auth.models import User
from django.conf import settings
from django.contrib.sessions.backends.db import SessionStore
from http.cookies import SimpleCookie
from django.utils import timezone
from django.db import transaction
from .models import AuditLog
from .models import Meeting, MeetingParticipant, SharedFile, UserProfile
from .invitations import is_valid_invitation

sio = socketio.AsyncServer(
    async_mode="asgi",
    cors_allowed_origins=[],
    max_http_buffer_size=110 * 1024 * 1024,
    ping_interval=20,
    ping_timeout=35,
)

state = {}
rooms = {}
room_policies = {}
cohosts = {}
# Serialize admissions per room, including simultaneous joins from different devices.
# Runtime deployment uses one Daphne process; a multi-worker/SFU migration needs
# centralized presence/locking rather than these in-process maps.
_room_admission_locks = {}

def admission_lock(room):
    return _room_admission_locks.setdefault(room, asyncio.Lock())

DEFAULT_POLICY = {
    "allow_chat": True,
    "allow_screen_share": True,
    "allow_unmute": True,
    "allow_video": True,
}

@sync_to_async
def user_from(environ):
    scope = environ.get("asgi.scope", {})
    headers = {}
    for k, v in scope.get("headers", []):
        if isinstance(k, bytes): k = k.decode("latin1")
        if isinstance(v, bytes): v = v.decode("latin1")
        headers[str(k).lower()] = str(v)
    cookie = SimpleCookie()
    try:
        cookie.load(headers.get("cookie", ""))
    except Exception:
        return None
    morsel = cookie.get(settings.SESSION_COOKIE_NAME)
    if not morsel:
        return None
    session = SessionStore(session_key=morsel.value)
    try:
        user_id = session.get("_auth_user_id")
        backend = session.get("_auth_user_backend")
    except Exception:
        return None
    if not user_id or not backend:
        return None
    try:
        u = User.objects.get(id=user_id, is_active=True)
    except User.DoesNotExist:
        return None
    try:
        image = UserProfile.objects.get(user=u).photo
        photo_url = image.url if image else ''
    except UserProfile.DoesNotExist:
        photo_url = ''
    return {'id': u.id, 'username': u.username, 'name': u.get_full_name() or u.username, 'avatar': photo_url}

@sync_to_async
def meeting_snapshot(room):
    try:
        m = Meeting.objects.select_related("host").get(id=room)
    except Meeting.DoesNotExist:
        return None
    return {
        "id": str(m.id),
        "host_id": m.host_id,
        "locked": m.locked,
        "max_participants": m.max_participants,
        "allow_screen_share": m.allow_screen_share,
        "allow_whiteboard": m.allow_whiteboard,
        "allow_files": m.allow_files,
        "allow_chat": m.allow_chat,
        "allow_unmute": m.allow_unmute,
        "allow_video": m.allow_video,
        "status": m.status,
    }

@sync_to_async
def join_info(room, user_id, invite_token=""):
    try:
        m = Meeting.objects.select_related("host").get(id=room)
    except Meeting.DoesNotExist:
        return {"error": "Meeting not found."}
    if m.status == "ended":
        return {"error": "Meeting has ended."}
    if m.locked and m.host_id != user_id and not is_valid_invitation(m.id, invite_token):
        return {"error": "This meeting is locked by the host."}
    # Never mark another still-connected device belonging to the same account as
    # departed. Each live Socket.IO connection occupies one separate meeting seat.
    # The capacity check is serialized in join_room against its live SID roster.
    p = MeetingParticipant.objects.create(meeting=m, user_id=user_id, is_host=m.host_id == user_id)
    return {
        "pid": p.id,
        "started_at": m.started_at.isoformat() if m.started_at else None,
        "limit": m.duration_limit_minutes,
        "host_id": m.host_id,
        "title": m.title,
        "meeting_code": m.meeting_code_display,
        "locked": m.locked,
    }

@sync_to_async
def transfer_host_in_database(room, current_host_id, new_host_id):
    """Atomic role handoff; the host remains the meeting's authoritative owner."""
    with transaction.atomic():
        try:
            m = Meeting.objects.select_for_update().get(id=room)
        except Meeting.DoesNotExist:
            return {"error": "Meeting not found."}
        if m.status != "live":
            return {"error": "Only live meetings can transfer hosting."}
        if m.host_id != current_host_id:
            return {"error": "Only the current host can transfer control."}
        if current_host_id == new_host_id:
            return {"error": "Choose another participant."}
        if not MeetingParticipant.objects.filter(meeting=m, user_id=new_host_id, left_at__isnull=True).exists():
            return {"error": "Selected participant is no longer in the meeting."}
        m.host_id = new_host_id
        m.save(update_fields=["host"])
        MeetingParticipant.objects.filter(meeting=m, left_at__isnull=True).update(is_host=False)
        MeetingParticipant.objects.filter(meeting=m, user_id=new_host_id, left_at__isnull=True).update(is_host=True)
        AuditLog.objects.create(user_id=current_host_id, action="host_transfer", detail=f"{room}: {current_host_id} -> {new_host_id}")
        return {"ok": True, "host_id": new_host_id}

@sync_to_async
def set_locked(room, locked):
    try:
        Meeting.objects.filter(id=room).update(locked=locked)
        return True
    except Exception:
        return False

@sync_to_async
def persist_policy(room, name, value):
    field_map = {
        "allow_chat": "allow_chat",
        "allow_screen_share": "allow_screen_share",
        "allow_unmute": "allow_unmute",
        "allow_video": "allow_video",
    }
    field = field_map.get(name)
    if not field:
        return False
    try:
        Meeting.objects.filter(id=room).update(**{field: bool(value)})
        return True
    except Exception:
        return False

@sync_to_async
def leave(pid):
    if pid:
        MeetingParticipant.objects.filter(id=pid, left_at__isnull=True).update(left_at=timezone.now())

@sync_to_async
def save_file(room, user_id, payload):
    try:
        m = Meeting.objects.get(id=room)
        SharedFile.objects.create(
            meeting=m,
            sender_id=user_id,
            original_name=str(payload.get("name", "file"))[:255],
            size_bytes=int(payload.get("size", 0)),
            mime_type=str(payload.get("type", ""))[:120],
            encrypted=True,
        )
    except Exception:
        pass

def _is_host_sid(sid):
    s = state.get(sid)
    if not s or not s.get("room"):
        return False
    return s["user"]["id"] == s.get("host_id")

def _is_host_or_cohost(sid):
    s = state.get(sid)
    if not s or not s.get("room"):
        return False
    room = s["room"]
    return _is_host_sid(sid) or sid in cohosts.get(room, set())

def _policy(room):
    return room_policies.setdefault(room, dict(DEFAULT_POLICY))

@sio.event
async def connect(sid, environ, auth):
    u = await user_from(environ)
    if not u:
        raise ConnectionRefusedError("Authentication required")
    state[sid] = {
        "user": u, "room": None, "pid": None, "host_id": None,
        "media": {"mic": True, "camera": True, "sharing": False},
    }

@sio.event
async def disconnect(sid):
    s = state.pop(sid, None)
    if not s:
        return
    await leave(s.get("pid"))
    room = s.get("room")
    if room:
        rooms.get(room, {}).pop(sid, None)
        cohosts.get(room, set()).discard(sid)
        await sio.emit("peer-left", {"sid": sid}, room=room, skip_sid=sid)

@sio.event
async def join_room(sid, data):
    s = state.get(sid)
    if not s:
        return
    room = str((data or {}).get("room", "")).strip()
    snap = await meeting_snapshot(room)
    if not snap:
        return await sio.emit("room-error", {"message": "Meeting not found."}, to=sid)

    if room not in room_policies:
        room_policies[room] = {
            "allow_chat": bool(snap.get("allow_chat", True)),
            "allow_screen_share": bool(snap.get("allow_screen_share", True)),
            "allow_unmute": bool(snap.get("allow_unmute", True)),
            "allow_video": bool(snap.get("allow_video", True)),
        }
    pol = room_policies[room]
    # Keep authorization and ended-meeting errors authoritative even if full.
    invite_token = str((data or {}).get("invite_token", ""))
    if snap.get("status") == "ended":
        return await sio.emit("room-error", {"message": "Meeting has ended."}, to=sid)
    if snap.get("locked") and snap.get("host_id") != s["user"]["id"] and not is_valid_invitation(room, invite_token):
        return await sio.emit("room-error", {"message": "This meeting is locked by the host."}, to=sid)

    if s.get("room") and s["room"] != room:
        return await sio.emit("room-error", {"message": "Leave your current meeting before joining another."}, to=sid)
    async with admission_lock(room):
        live_members = rooms.setdefault(room, {})
        # The Socket.IO SID, not the account's visible name or user_id, is one
        # participant seat. Two Yamika browsers therefore count as two seats.
        if s.get("room") == room and sid in live_members:
            return  # Idempotent repeated join from this exact socket.
        capacity = max(1, int(snap.get("max_participants") or 1))
        if len(live_members) >= capacity:
            return await sio.emit("room-error", {
                "message": f"Meeting is full ({len(live_members)}/{capacity} connections). Close another device or ask the host for a larger plan."
            }, to=sid)

        info = await join_info(room, s["user"]["id"], invite_token)
        if info.get("error"):
            return await sio.emit("room-error", {"message": info["error"]}, to=sid)
        # An interrupted connection might disconnect while the database row is
        # being written. Do not consume a phantom slot after disconnect.
        if state.get(sid) is not s:
            await leave(info["pid"])
            return
        try:
            await sio.enter_room(sid, room)
        except Exception:
            await leave(info["pid"])
            raise
        s["room"] = room
        s["pid"] = info["pid"]
        s["host_id"] = info["host_id"]

        existing = []
        for other_sid, u in live_members.items():
            st = state.get(other_sid, {})
            existing.append({
                "sid": other_sid,
                "user_id": u["id"],
                "username": u["username"],
                "name": u["name"],
                "avatar": u.get("avatar", ""),
                "media": st.get("media", {}),
                "cohost": other_sid in cohosts.get(room, set()),
            })
        live_members[sid] = s["user"]

    await sio.emit("room-ready", {
        "peers": existing,
        "meeting": info,
        "policy": pol,
        "is_cohost": sid in cohosts.get(room, set()),
    }, to=sid)

    await sio.emit("peer-joined", {
        "sid": sid, **s["user"], "media": s["media"], "cohost": False
    }, room=room, skip_sid=sid)

@sio.event
async def webrtc_offer(sid, d):
    if sid in state and state[sid].get("room") and state.get(str(d.get("target")), {}).get("room") == state[sid].get("room"):
        await sio.emit("webrtc-offer", {
            "from": sid, "sdp": d.get("sdp"), "name": state[sid]["user"]["name"]
        }, to=d.get("target"))

@sio.event
async def webrtc_answer(sid, d):
    await sio.emit("webrtc-answer", {"from": sid, "sdp": d.get("sdp")}, to=d.get("target"))

@sio.event
async def ice_candidate(sid, d):
    await sio.emit("ice-candidate", {"from": sid, "candidate": d.get("candidate")}, to=d.get("target"))

@sio.event
async def media_state(sid, d):
    s = state.get(sid)
    if not s or not s.get("room"):
        return
    s["media"] = {
        "mic": bool((d or {}).get("mic", True)),
        "camera": bool((d or {}).get("camera", True)),
        "sharing": bool((d or {}).get("sharing", False)),
    }
    await sio.emit("media-state", {"sid": sid, **s["media"]}, room=s["room"], skip_sid=sid)

@sio.event
async def reaction(sid, d):
    s = state.get(sid)
    emoji = str((d or {}).get("emoji", ""))[:8]
    if s and s.get("room") and emoji:
        await sio.emit("reaction", {"sid": sid, "name": s["user"]["name"], "emoji": emoji}, room=s["room"])

@sio.event
async def chat_message(sid, d):
    s = state.get(sid)
    text = str((d or {}).get("text", "")).strip()[:1000]
    if not s or not s.get("room") or not text:
        return
    if not _policy(s["room"]).get("allow_chat", True):
        return await sio.emit("policy-message", {"message": "Chat is disabled by the host."}, to=sid)
    await sio.emit("chat-message", {
        "sender": s["user"]["name"], "text": text, "at": timezone.now().isoformat()
    }, room=s["room"])

@sio.event
async def caption_line(sid, d):
    s = state.get(sid)
    text = str((d or {}).get("text", "")).strip()[:350]
    if s and s.get("room") and text:
        await sio.emit("caption-line", {"name": s["user"]["name"], "text": text}, room=s["room"])

@sio.event
async def whiteboard_draw(sid, d):
    s = state.get(sid)
    if s and s.get("room"):
        await sio.emit("whiteboard-draw", d, room=s["room"], skip_sid=sid)

@sio.event
async def whiteboard_clear(sid):
    s = state.get(sid)
    if s and s.get("room"):
        await sio.emit("whiteboard-clear", {}, room=s["room"], skip_sid=sid)

@sio.event
async def encrypted_file(sid, d):
    s = state.get(sid)
    if s and s.get("room"):
        await save_file(s["room"], s["user"]["id"], d)
        await sio.emit("encrypted-file", {"sender": s["user"]["name"], **d}, room=s["room"], skip_sid=sid)

@sio.event
async def host_policy(sid, d):
    if not _is_host_or_cohost(sid):
        return
    s = state[sid]
    room = s["room"]
    name = str((d or {}).get("name", ""))
    value = bool((d or {}).get("value", False))
    if name == "locked":
        if not _is_host_sid(sid):
            return
        await set_locked(room, value)
        await sio.emit("meeting-lock", {"locked": value}, room=room)
        return
    if name in DEFAULT_POLICY:
        _policy(room)[name] = value
        await persist_policy(room, name, value)
        await sio.emit("room-policy", {"policy": _policy(room)}, room=room)

@sio.event
async def host_mute_all(sid):
    if not _is_host_or_cohost(sid):
        return
    s = state[sid]
    await sio.emit("host-mute", {"message": "The host muted your microphone."}, room=s["room"], skip_sid=sid)

@sio.event
async def host_remove(sid, d):
    if not _is_host_or_cohost(sid):
        return
    target = str((d or {}).get("target", ""))
    if not target or target == sid or target not in state or state[target].get("room") != state[sid].get("room"):
        return
    if _is_host_sid(target):
        return
    await sio.emit("removed-from-meeting", {"message": "You were removed from the meeting by the host."}, to=target)
    await sio.disconnect(target)

@sio.event
async def host_transfer(sid, d):
    """Only the live meeting's current host can transfer to a connected member."""
    sender = state.get(sid)
    if not sender or not sender.get("room") or not _is_host_sid(sid):
        return await sio.emit("host-transfer-error", {"message": "Host access is required."}, to=sid)
    room = sender["room"]
    target_sid = str((d or {}).get("target", ""))
    receiver = state.get(target_sid)
    if not receiver or receiver.get("room") != room or target_sid == sid:
        return await sio.emit("host-transfer-error", {"message": "Choose a currently connected participant."}, to=sid)
    new_host_id = receiver["user"]["id"]
    result = await transfer_host_in_database(room, sender["user"]["id"], new_host_id)
    if not result.get("ok"):
        return await sio.emit("host-transfer-error", {"message": result.get("error", "Transfer failed.")}, to=sid)
    for item in state.values():
        if item.get("room") == room:
            item["host_id"] = new_host_id
    cohosts.get(room, set()).discard(target_sid)
    await sio.emit("host-changed", {
        "host_id": new_host_id,
        "host_name": receiver["user"]["name"],
        "previous_host_id": sender["user"]["id"],
    }, room=room)

@sio.event
async def host_make_cohost(sid, d):
    if not _is_host_sid(sid):
        return
    s = state[sid]
    room = s["room"]
    target = str((d or {}).get("target", ""))
    if not target or target not in state or state[target].get("room") != room:
        return
    cohosts.setdefault(room, set()).add(target)
    await sio.emit("cohost-status", {"sid": target, "cohost": True}, room=room)

@sio.event
async def end_meeting(sid):
    s = state.get(sid)
    if not s or not s.get("room") or not _is_host_sid(sid):
        return
    m = await sync_to_async(Meeting.objects.get)(id=s["room"])
    m.status = "ended"
    m.ended_at = timezone.now()
    await sync_to_async(m.save)(update_fields=["status", "ended_at"])
    await sio.emit("meeting-ended", {"message": "The host ended the meeting."}, room=s["room"])
