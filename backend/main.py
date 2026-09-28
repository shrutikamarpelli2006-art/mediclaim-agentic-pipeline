"""MediClaim API: stateful claim workflow with human review gates."""

from __future__ import annotations

import json
import os
import re
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = Path(os.getenv("MEDICLAIM_DATA_DIR", ROOT / "data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)
DATABASE_PATH = DATA_DIR / "mediclaim.db"

app = FastAPI(title="MediClaim API", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ORIGINS", "*").split(","),
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@contextmanager
def database() -> Any:
    connection = sqlite3.connect(DATABASE_PATH)
    connection.row_factory = sqlite3.Row
    try:
        yield connection
        connection.commit()
    finally:
        connection.close()


def now() -> str:
    return datetime.now(UTC).isoformat()


def initialize_database() -> None:
    with database() as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS claims (
                id TEXT PRIMARY KEY,
                status TEXT NOT NULL,
                stage INTEGER NOT NULL,
                claim_data TEXT NOT NULL,
                codes TEXT NOT NULL,
                documents TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )


@app.on_event("startup")
def startup() -> None:
    initialize_database()


class ClaimUpdate(BaseModel):
    stage: int | None = Field(default=None, ge=1, le=5)
    fields: dict[str, str] | None = None
    codes: dict[str, list[dict[str, Any]]] | None = None


def blank_codes() -> dict[str, list[dict[str, Any]]]:
    return {
        "icd": [{"code": "J06.9", "name": "Acute upper respiratory infection, unspecified", "confidence": 92, "selected": True}],
        "cpt": [{"code": "99213", "name": "Office or other outpatient visit, established patient", "confidence": 88, "selected": True}],
    }


def get_claim(claim_id: str) -> dict[str, Any]:
    with database() as connection:
        row = connection.execute("SELECT * FROM claims WHERE id = ?", (claim_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Claim not found")
    return {
        "id": row["id"],
        "status": row["status"],
        "stage": row["stage"],
        "fields": json.loads(row["claim_data"]),
        "codes": json.loads(row["codes"]),
        "documents": json.loads(row["documents"]),
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def selected_codes(claim: dict[str, Any]) -> list[dict[str, Any]]:
    return [item for group in claim["codes"].values() for item in group if item.get("selected")]


def validation_checks(claim: dict[str, Any]) -> list[dict[str, Any]]:
    fields = claim["fields"]
    codes = selected_codes(claim)
    return [
        {"label": "Patient identity", "detail": "Name and date of birth recorded" if all(fields.get(key) for key in ("firstName", "lastName", "dob")) else "Add full name and date of birth", "pass": all(fields.get(key) for key in ("firstName", "lastName", "dob"))},
        {"label": "Insurance coverage", "detail": "Payer and member ID recorded" if all(fields.get(key) for key in ("payer", "memberId")) else "Add payer and member ID", "pass": all(fields.get(key) for key in ("payer", "memberId"))},
        {"label": "Encounter details", "detail": "Service date and clinical summary recorded" if all(fields.get(key) for key in ("serviceDate", "clinicalSummary")) else "Add service date and clinical summary", "pass": all(fields.get(key) for key in ("serviceDate", "clinicalSummary"))},
        {"label": "Code confirmation", "detail": f"{len(codes)} confirmed code{'s' if len(codes) != 1 else ''} ready for claim" if codes else "Confirm at least one diagnosis or procedure code", "pass": bool(codes)},
    ]


def coding_suggestions(text: str) -> dict[str, list[dict[str, Any]]]:
    text = text.lower()
    diagnosis = {"code": "J06.9", "name": "Acute upper respiratory infection, unspecified", "confidence": 92, "selected": True}
    if re.search(r"diabet|hyperglyc", text):
        diagnosis = {"code": "E11.9", "name": "Type 2 diabetes mellitus without complications", "confidence": 94, "selected": True}
    elif re.search(r"hypertension|high blood pressure", text):
        diagnosis = {"code": "I10", "name": "Essential (primary) hypertension", "confidence": 93, "selected": True}
    elif re.search(r"low back|back pain", text):
        diagnosis = {"code": "M54.50", "name": "Low back pain, unspecified", "confidence": 90, "selected": True}
    return {"icd": [diagnosis], "cpt": [{"code": "99213", "name": "Office or other outpatient visit, established patient", "confidence": 88, "selected": True}]}


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/claims", status_code=201)
def create_claim() -> dict[str, Any]:
    claim_id = str(uuid.uuid4())
    timestamp = now()
    with database() as connection:
        connection.execute(
            "INSERT INTO claims VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (claim_id, "intake", 1, "{}", json.dumps(blank_codes()), "[]", timestamp, timestamp),
        )
    return get_claim(claim_id)


@app.get("/api/claims/{claim_id}")
def read_claim(claim_id: str) -> dict[str, Any]:
    return get_claim(claim_id)


@app.patch("/api/claims/{claim_id}")
def update_claim(claim_id: str, update: ClaimUpdate) -> dict[str, Any]:
    claim = get_claim(claim_id)
    fields = claim["fields"]
    if update.fields is not None:
        fields.update({key: value for key, value in update.fields.items() if isinstance(value, str)})
    codes = update.codes if update.codes is not None else claim["codes"]
    stage = update.stage if update.stage is not None else claim["stage"]
    with database() as connection:
        connection.execute(
            "UPDATE claims SET stage = ?, claim_data = ?, codes = ?, updated_at = ? WHERE id = ?",
            (stage, json.dumps(fields), json.dumps(codes), now(), claim_id),
        )
    return get_claim(claim_id)


@app.post("/api/claims/{claim_id}/documents")
async def upload_documents(claim_id: str, files: list[UploadFile] = File(...)) -> dict[str, Any]:
    claim = get_claim(claim_id)
    records = claim["documents"]
    extracted_parts: list[str] = []
    for uploaded_file in files:
        contents = await uploaded_file.read()
        if len(contents) > 10 * 1024 * 1024:
            raise HTTPException(status_code=413, detail=f"{uploaded_file.filename} is larger than 10 MB")
        text = ""
        if uploaded_file.content_type == "text/plain" or (uploaded_file.filename or "").lower().endswith(".txt"):
            text = contents.decode("utf-8", errors="replace")
        elif (uploaded_file.filename or "").lower().endswith(".pdf"):
            try:
                from pypdf import PdfReader
                from io import BytesIO
                text = " ".join(page.extract_text() or "" for page in PdfReader(BytesIO(contents)).pages)
            except Exception:
                text = "PDF received. Text extraction needs an OCR-capable document processor for this file."
        else:
            text = "Image received. Connect a production OCR provider to extract image text."
        records.append({"name": uploaded_file.filename or "unnamed document", "type": uploaded_file.content_type, "text": text[:12000]})
        if text:
            extracted_parts.append(text)
    combined_text = "\n".join(extracted_parts)
    with database() as connection:
        connection.execute("UPDATE claims SET documents = ?, updated_at = ? WHERE id = ?", (json.dumps(records), now(), claim_id))
    return {"documents": records, "extractedText": combined_text[:12000]}


@app.post("/api/claims/{claim_id}/coding-suggestions")
def suggest_codes(claim_id: str) -> dict[str, Any]:
    claim = get_claim(claim_id)
    document_text = " ".join(record.get("text", "") for record in claim["documents"])
    suggestions = coding_suggestions(f"{claim['fields'].get('clinicalSummary', '')} {document_text}")
    with database() as connection:
        connection.execute("UPDATE claims SET codes = ?, stage = ?, updated_at = ? WHERE id = ?", (json.dumps(suggestions), 3, now(), claim_id))
    return {"codes": suggestions, "reason": "Suggestions match keywords found in the clinical summary and document text. A reviewer must confirm every code."}


@app.post("/api/claims/{claim_id}/validate")
def validate_claim(claim_id: str) -> dict[str, Any]:
    claim = get_claim(claim_id)
    checks = validation_checks(claim)
    ready = all(check["pass"] for check in checks)
    with database() as connection:
        connection.execute("UPDATE claims SET status = ?, stage = ?, updated_at = ? WHERE id = ?", ("validated" if ready else "needs_information", 4, now(), claim_id))
    return {"claimId": claim_id, "checks": checks, "ready": ready}


@app.get("/api/claims/{claim_id}/cms1500")
def cms1500_draft(claim_id: str) -> dict[str, Any]:
    claim = get_claim(claim_id)
    checks = validation_checks(claim)
    if not all(check["pass"] for check in checks):
        raise HTTPException(status_code=422, detail="Complete all validation checks before generating a CMS-1500 draft")
    fields = claim["fields"]
    diagnosis = [code["code"] for code in claim["codes"]["icd"] if code.get("selected")]
    procedures = [code for code in claim["codes"]["cpt"] if code.get("selected")]
    with database() as connection:
        connection.execute("UPDATE claims SET status = ?, stage = ?, updated_at = ? WHERE id = ?", ("draft_ready", 5, now(), claim_id))
    return {"claimId": claim_id, "patient": f"{fields.get('firstName', '')} {fields.get('lastName', '')}".strip(), "fields": fields, "diagnosis": diagnosis, "procedures": procedures, "reviewRequired": True}


@app.get("/", include_in_schema=False)
def website() -> FileResponse:
    return FileResponse(ROOT / "index.html")


@app.get("/styles.css", include_in_schema=False)
def stylesheet() -> FileResponse:
    return FileResponse(ROOT / "styles.css", media_type="text/css")


@app.get("/app.js", include_in_schema=False)
def client_script() -> FileResponse:
    return FileResponse(ROOT / "app.js", media_type="text/javascript")
