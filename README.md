# MediClaim Agentic Pipeline

MediClaim guides a medical insurance claim through document intake, coding suggestions, validation, and CMS-1500 draft review. The browser interface calls a FastAPI backend that owns claim sessions and workflow decisions.

## Run locally

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn backend.main:app --reload
```

Open `http://127.0.0.1:8000`.

## Deploy on Render

Push the project to GitHub, then create a **Web Service** from the repository. Render reads `render.yaml` automatically. If configuring it manually, use `pip install -r requirements.txt` as the build command and `uvicorn backend.main:app --host 0.0.0.0 --port $PORT` as the start command.

The included SQLite database suits demonstrations and its contents do not survive Render instance replacement. Connect a managed Postgres database and an OCR provider before handling real claims or protected health information.
