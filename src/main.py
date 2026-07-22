from pathlib import Path
from typing import Optional
import json

from fastapi import APIRouter, Depends, FastAPI, File, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sqlalchemy.orm import Session

try:
    from .auth import create_token, decode_token, hash_password, verify_password
    from .config import settings, is_static_sso_admin
    from .database import get_db
    from .excel_service import (
        get_bookings,
        get_meta,
        get_team_mapping,
        parse_sbtr_excel,
        parse_team_mapping_excel,
        parse_users_excel,
        replace_bookings,
        replace_team_mapping,
    )
    from .models import UserProfile
    from .seed import seed_if_empty
    from .sso_endpoints import sso_router
except ImportError:  # pragma: no cover
    from backend.auth import create_token, decode_token, hash_password, verify_password
    from backend.config import settings, is_static_sso_admin
    from backend.database import get_db
    from backend.excel_service import (
        get_bookings,
        get_meta,
        get_team_mapping,
        parse_sbtr_excel,
        parse_team_mapping_excel,
        parse_users_excel,
        replace_bookings,
        replace_team_mapping,
    )
    from backend.models import UserProfile
    from backend.seed import seed_if_empty
    from backend.sso_endpoints import sso_router

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend" / "public"

app = FastAPI(title="Sobha Sales Dashboard API")

NO_STORE = {"Cache-Control": "no-store, no-cache, must-revalidate", "Pragma": "no-cache"}

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def no_store_api_responses(request: Request, call_next):
    """Prevent proxies/browsers from caching bookings/meta after admin upload."""
    response = await call_next(request)
    path = request.url.path or ""
    if path.startswith("/api/") or path.startswith("/admin/"):
        for key, value in NO_STORE.items():
            response.headers[key] = value
    return response


class LoginRequest(BaseModel):
    username: str
    password: str


class IdentityRequest(BaseModel):
    username: str


def auth_header(authorization: Optional[str] = Header(default=None)) -> dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing token")
    token = authorization.split(" ", 1)[1]
    try:
        return decode_token(token)
    except ValueError as exc:
        raise HTTPException(status_code=401, detail="Invalid token") from exc


def require_admin(payload: dict = Depends(auth_header), db: Session = Depends(get_db)) -> dict:
    if payload.get("role") == "admin":
        return payload
    username = (payload.get("sub") or "").strip().lower()
    if username:
        profile = db.get(UserProfile, username)
        if profile and profile.email and is_static_sso_admin(profile.email):
            return payload
    raise HTTPException(status_code=403, detail="Admin access required")


def require_viewer(payload: dict = Depends(auth_header)) -> dict:
    if not payload.get("role"):
        raise HTTPException(status_code=403, detail="Viewer access required")
    return payload


api_router = APIRouter()


def authenticate_login(body: LoginRequest, db: Session) -> dict:
    username = body.username.strip().lower()
    password = body.password

    if username == settings.admin_username and password == settings.admin_password:
        token = create_token(username, "admin")
        return {"token": token, "role": "admin", "username": username}

    if username == settings.viewer_username and password == settings.viewer_password:
        token = create_token(username, "viewer")
        return {"token": token, "role": "viewer", "username": username}

    profile = db.get(UserProfile, username)
    if profile and profile.password_hash and verify_password(password, profile.password_hash):
        token = create_token(username, profile.role)
        return {
            "token": token,
            "role": profile.role,
            "username": profile.username,
            "name": profile.name,
            "scope_type": profile.scope_type,
            "scope_value": profile.scope_value,
            "email": profile.email,
        }

    raise HTTPException(status_code=401, detail="Invalid username or password")


def sync_dashboard_users(db: Session, users: list[dict[str, str]]) -> dict[str, int]:
    """
    Replace PIN dashboard users from Excel.

    - Keeps built-in admin/viewer accounts untouched.
    - Removes old local/PIN users that are not in the uploaded file.
    - Creates or updates every user row from the file.
    """
    protected = {settings.admin_username.strip().lower(), settings.viewer_username.strip().lower()}
    excel_usernames = {user["username"] for user in users}

    for user in users:
        if user["username"] in protected:
            raise HTTPException(
                status_code=400,
                detail=f"Built-in account '{user['username']}' cannot be uploaded from Excel.",
            )

    removed = 0
    for profile in db.query(UserProfile).all():
        username = profile.username.strip().lower()
        if username in protected or username in excel_usernames:
            continue
        if profile.auth_provider == "local" or profile.password_hash:
            db.delete(profile)
            removed += 1

    created = 0
    updated = 0
    for user in users:
        username = user["username"]
        profile = db.get(UserProfile, username)
        if profile:
            profile.name = user["name"]
            profile.role = user["role"]
            profile.scope_type = user["scope_type"]
            profile.scope_value = user["scope_value"]
            profile.email = user.get("email")
            profile.password_hash = hash_password(user["pin"])
            profile.auth_provider = "local"
            profile.sso_enabled = profile.sso_enabled and bool(profile.microsoft_id)
            updated += 1
        else:
            db.add(
                UserProfile(
                    username=username,
                    name=user["name"],
                    role=user["role"],
                    scope_type=user["scope_type"],
                    scope_value=user["scope_value"],
                    email=user.get("email"),
                    password_hash=hash_password(user["pin"]),
                    auth_provider="local",
                )
            )
            created += 1

    db.commit()
    return {
        "count": len(users),
        "created": created,
        "updated": updated,
        "removed": removed,
    }


def _admin_login_html_success(token: str) -> HTMLResponse:
    token_js = json.dumps(token)
    return HTMLResponse(
        f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Signing in…</title></head>
<body><p style="font-family:sans-serif;text-align:center;margin-top:40vh">Signing in…</p>
<script>
sessionStorage.setItem("sobha_token", {token_js});
location.replace("/admin");
</script></body></html>"""
    )


def _admin_login_html_error(message: str, status_code: int = 401) -> HTMLResponse:
    msg_js = json.dumps(message)
    return HTMLResponse(
        f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Sign in failed</title></head>
<body><script>
sessionStorage.removeItem("sobha_token");
location.replace("/admin?login_error=" + encodeURIComponent({msg_js}));
</script></body></html>""",
        status_code=status_code,
    )


def _dashboard_login_html_success(result: dict) -> HTMLResponse:
    """Full-page login success — avoids Cloudflare blocking JSON fetch POST to /api/*."""
    token = result.get("token") or ""
    username = (result.get("username") or "").strip().lower()
    role = result.get("role") or "viewer"
    # Built-in admin account lands on the admin panel; all other PIN users go to dashboard.
    redirect_to = "/admin" if username == "admin" and role == "admin" else "/"
    user_payload = {
        "username": username,
        "name": result.get("name") or username,
        "role": role,
        "scope_type": result.get("scope_type") or "all",
        "scope_value": result.get("scope_value") or "",
        "email": result.get("email") or "",
    }
    token_js = json.dumps(token)
    user_js = json.dumps(user_payload)
    redirect_js = json.dumps(redirect_to)
    return HTMLResponse(
        f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Signing in…</title></head>
<body><p style="font-family:sans-serif;text-align:center;margin-top:40vh">Signing in…</p>
<script>
sessionStorage.setItem("sobha_token", {token_js});
sessionStorage.setItem("sobha_user_v5", JSON.stringify({user_js}));
sessionStorage.setItem("sobha_user", JSON.stringify({user_js}));
sessionStorage.removeItem("sobha_identity");
sessionStorage.setItem("sobha_pending_login_reload", "1");
location.replace({redirect_js});
</script></body></html>"""
    )


def _dashboard_login_html_error(message: str, status_code: int = 401) -> HTMLResponse:
    msg_js = json.dumps(message)
    return HTMLResponse(
        f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Sign in failed</title></head>
<body><script>
sessionStorage.removeItem("sobha_token");
sessionStorage.removeItem("sobha_user_v5");
location.replace("/?login_error=" + encodeURIComponent({msg_js}));
</script></body></html>""",
        status_code=status_code,
    )


async def _form_or_json_login(request: Request, db: Session) -> tuple[LoginRequest, bool]:
    content_type = (request.headers.get("content-type") or "").lower()
    wants_json = "application/json" in content_type
    if wants_json:
        try:
            payload = await request.json()
            return LoginRequest(**payload), True
        except Exception as exc:
            raise HTTPException(status_code=422, detail="Invalid login payload") from exc
    form = await request.form()
    username = form.get("username")
    password = form.get("password")
    if not username or not password:
        raise HTTPException(status_code=422, detail="Username and password are required.")
    return LoginRequest(username=str(username), password=str(password)), False


@api_router.post("/auth/login")
def login(body: LoginRequest, db: Session = Depends(get_db)):
    return authenticate_login(body, db)


@api_router.post("/auth/identity")
def set_identity(body: IdentityRequest, db: Session = Depends(get_db), _: dict = Depends(require_viewer)):
    profile = db.get(UserProfile, body.username.strip().lower())
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")
    return {
        "username": profile.username,
        "name": profile.name,
        "role": profile.role,
        "scope_type": profile.scope_type,
        "scope_value": profile.scope_value,
    }


class UserCreateRequest(BaseModel):
    username: str
    password: str
    name: str
    role: str
    scope_type: str
    scope_value: str
    email: Optional[str] = None


@api_router.post("/admin/users")
def create_user(body: UserCreateRequest, db: Session = Depends(get_db), _: dict = Depends(require_admin)):
    username = body.username.strip().lower()
    if db.get(UserProfile, username):
        raise HTTPException(status_code=400, detail="Username already exists")
    profile = UserProfile(
        username=username,
        name=body.name.strip(),
        role=body.role.strip(),
        scope_type=body.scope_type.strip(),
        scope_value=body.scope_value.strip(),
        email=body.email.strip() if body.email else None,
        password_hash=hash_password(body.password),
    )
    db.add(profile)
    db.commit()
    return {"success": True, "username": profile.username}


@api_router.delete("/admin/users/{username}")
def delete_user(username: str, db: Session = Depends(get_db), _: dict = Depends(require_admin)):
    username = username.strip().lower()
    profile = db.get(UserProfile, username)
    if not profile:
        raise HTTPException(status_code=404, detail="User not found")
    if profile.username == settings.viewer_username or profile.username == settings.admin_username:
        raise HTTPException(status_code=403, detail="Cannot delete built-in account")
    db.delete(profile)
    db.commit()
    return {"success": True, "username": username}


@api_router.get("/users")
def list_users(db: Session = Depends(get_db), _: dict = Depends(require_viewer)):
    # Include all dashboard roles (including Management). Excluding Management
    # left AUTH incomplete after login and could break leadership sessions.
    profiles = db.query(UserProfile).order_by(UserProfile.name).all()
    return {
        "users": [
            {
                "username": p.username,
                "name": p.name,
                "role": p.role,
                "scope_type": p.scope_type,
                "scope_value": p.scope_value,
                "email": p.email,
            }
            for p in profiles
        ]
    }


@api_router.get("/bookings")
def bookings(db: Session = Depends(get_db), _: dict = Depends(require_viewer)):
    return {"records": get_bookings(db)}


@api_router.get("/team-mapping")
def team_mapping(db: Session = Depends(get_db), _: dict = Depends(require_viewer)):
    data = get_team_mapping(db)
    if not data:
        return {"fileName": "", "headers": [], "rows": []}
    return data


@api_router.get("/meta")
def meta(db: Session = Depends(get_db), _: dict = Depends(require_viewer)):
    return get_meta(db)


@api_router.post("/admin/upload/sbtr")
async def upload_sbtr(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    _: dict = Depends(require_admin),
):
    if not file.filename or not file.filename.lower().endswith((".xlsx", ".xlsm")):
        raise HTTPException(status_code=400, detail="Please upload an .xlsx file")
    content = await file.read()
    try:
        records, as_of = parse_sbtr_excel(content)
        count = replace_bookings(db, records, as_of)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"count": count, "as_of": as_of}


@api_router.post("/admin/upload/team-mapping")
async def upload_team_mapping(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    _: dict = Depends(require_admin),
):
    if not file.filename or not file.filename.lower().endswith((".xlsx", ".xlsm")):
        raise HTTPException(status_code=400, detail="Please upload an .xlsx file")
    content = await file.read()
    try:
        payload = parse_team_mapping_excel(content, file.filename)
        replace_team_mapping(db, payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"count": len(payload.get("rows", [])), "file_name": payload.get("fileName")}


@api_router.post("/admin/upload/users")
async def upload_users(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    _: dict = Depends(require_admin),
):
    if not file.filename or not file.filename.lower().endswith((".xlsx", ".xlsm")):
        raise HTTPException(status_code=400, detail="Please upload an .xlsx file")
    content = await file.read()
    try:
        users = parse_users_excel(content)
        stats = sync_dashboard_users(db, users)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return stats


@api_router.get("/admin/status")
def admin_status(db: Session = Depends(get_db), _: dict = Depends(require_admin)):
    meta = get_meta(db)
    mapping = get_team_mapping(db)
    user_count = db.query(UserProfile).count()
    return {
        **meta,
        "team_mapping_rows": len(mapping.get("rows", [])) if mapping else 0,
        "team_mapping_file": mapping.get("fileName") if mapping else None,
        "user_count": user_count,
    }


@app.on_event("startup")
def startup() -> None:
    seed_if_empty()


app.include_router(api_router, prefix="/api")
app.include_router(api_router, prefix="/api/v1")

# Admin panel API under /admin/* (API only — HTML page is registered separately below)
admin_panel_router = APIRouter(prefix="/admin", tags=["admin-panel"])


@admin_panel_router.post("/login")
async def admin_panel_login(request: Request, db: Session = Depends(get_db)):
    content_type = (request.headers.get("content-type") or "").lower()
    wants_json = "application/json" in content_type

    if wants_json:
        try:
            payload = await request.json()
            body = LoginRequest(**payload)
        except Exception as exc:
            raise HTTPException(status_code=422, detail="Invalid login payload") from exc
    else:
        form = await request.form()
        username = form.get("username")
        password = form.get("password")
        if not username or not password:
            return _admin_login_html_error("Username and password are required.", 422)
        body = LoginRequest(username=str(username), password=str(password))

    try:
        result = authenticate_login(body, db)
    except HTTPException as exc:
        if wants_json:
            raise
        detail = exc.detail if isinstance(exc.detail, str) else "Sign in failed."
        return _admin_login_html_error(detail, exc.status_code)

    if result.get("role") != "admin":
        msg = "This account is not an admin."
        if wants_json:
            raise HTTPException(status_code=403, detail=msg)
        return _admin_login_html_error(msg, 403)

    if wants_json:
        return result
    return _admin_login_html_success(result["token"])


@admin_panel_router.get("/status")
def admin_panel_status(db: Session = Depends(get_db), _: dict = Depends(require_admin)):
    return admin_status(db, _)


@admin_panel_router.get("/users")
def admin_panel_users(db: Session = Depends(get_db), _: dict = Depends(require_viewer)):
    return list_users(db, _)


@admin_panel_router.post("/users")
def admin_panel_create_user(body: UserCreateRequest, db: Session = Depends(get_db), _: dict = Depends(require_admin)):
    return create_user(body, db, _)


@admin_panel_router.delete("/users/{username}")
def admin_panel_delete_user(username: str, db: Session = Depends(get_db), _: dict = Depends(require_admin)):
    return delete_user(username, db, _)


@admin_panel_router.post("/upload/sbtr")
async def admin_panel_upload_sbtr(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    _: dict = Depends(require_admin),
):
    return await upload_sbtr(file, db, _)


@admin_panel_router.post("/upload/team-mapping")
async def admin_panel_upload_team_mapping(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    _: dict = Depends(require_admin),
):
    return await upload_team_mapping(file, db, _)


@admin_panel_router.post("/upload/users")
async def admin_panel_upload_users(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    _: dict = Depends(require_admin),
):
    return await upload_users(file, db, _)


app.include_router(admin_panel_router)

# Include SSO router
app.include_router(sso_router)

def _html_page(name: str, expected_marker: str) -> FileResponse:
    path = (FRONTEND_DIR / name).resolve()
    if not path.is_file():
        raise HTTPException(status_code=500, detail=f"Missing frontend file: {name}")
    # Guard against a bad deploy that copied admin.html over index.html (or vice versa).
    head = path.read_text(encoding="utf-8", errors="ignore")[:4000]
    if expected_marker not in head:
        raise HTTPException(
            status_code=500,
            detail=f"Frontend file mismatch for {name}. Redeploy frontend/public/{name}.",
        )
    return FileResponse(path, media_type="text/html; charset=utf-8", headers=dict(NO_STORE))


if FRONTEND_DIR.exists():
    # Page routes MUST be registered before /js mount and must stay distinct.
    @app.get("/")
    def index():
        """User dashboard / login (not admin)."""
        return _html_page("index.html", 'content="dashboard"')

    @app.get("/login")
    def login_page():
        return _html_page("index.html", 'content="dashboard"')

    @app.post("/login")
    @app.post("/session/login")
    async def dashboard_form_login(request: Request, db: Session = Depends(get_db)):
        """
        Form POST login for the performance dashboard.

        Cloudflare often blocks JSON fetch POSTs to /api/v1/auth/login with a
        managed challenge. A classic form navigation to /login can complete that
        challenge and still set the session via HTML response.
        """
        try:
            body, wants_json = await _form_or_json_login(request, db)
        except HTTPException as exc:
            if "application/json" in (request.headers.get("content-type") or "").lower():
                raise
            detail = exc.detail if isinstance(exc.detail, str) else "Sign in failed."
            return _dashboard_login_html_error(detail, exc.status_code)

        try:
            result = authenticate_login(body, db)
        except HTTPException as exc:
            if wants_json:
                raise
            detail = exc.detail if isinstance(exc.detail, str) else "Invalid username or password"
            return _dashboard_login_html_error(detail, exc.status_code)

        if wants_json:
            return result
        return _dashboard_login_html_success(result)

    @app.get("/dashboard")
    def dashboard():
        return _html_page("index.html", 'content="dashboard"')

    @app.get("/admin")
    @app.get("/admin/")
    def admin_page():
        """Admin upload panel (SSO-only login)."""
        return _html_page("admin.html", 'content="admin"')

    app.mount("/js", StaticFiles(directory=FRONTEND_DIR / "js"), name="js")