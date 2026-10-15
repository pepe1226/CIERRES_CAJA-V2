"""Read four Perseo boxes locally and publish a read-only snapshot to the app.

No credentials are stored in this repository. Both are fetched from Windows
Credential Manager for the current Windows account.
"""

from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from collections import defaultdict
from datetime import datetime
from pathlib import Path


DB_TARGET = "EtiquetasTMCHPerseo"
SYNC_TARGET = "CIERRESPerseoCashboxSync"
DB_EXE = Path(r"C:\Program Files\MariaDB 11.3\bin\mariadb.exe")
DATABASE = "7791163287_db0000000003"
BOX_IDS = (1, 2, 3, 12)
ENDPOINT = "https://cierres-caja-v2.vercel.app/api/perseo/cashboxes"


class Credential(ctypes.Structure):
    _fields_ = [
        ("Flags", ctypes.c_ulong), ("Type", ctypes.c_ulong),
        ("TargetName", ctypes.c_wchar_p), ("Comment", ctypes.c_wchar_p),
        ("LastWritten", ctypes.c_ulonglong), ("CredentialBlobSize", ctypes.c_ulong),
        ("CredentialBlob", ctypes.POINTER(ctypes.c_ubyte)), ("Persist", ctypes.c_ulong),
        ("AttributeCount", ctypes.c_ulong), ("Attributes", ctypes.c_void_p),
        ("TargetAlias", ctypes.c_wchar_p), ("UserName", ctypes.c_wchar_p),
    ]


def credential(target: str) -> tuple[str, str]:
    pointer = ctypes.POINTER(Credential)()
    api = ctypes.windll.advapi32
    if not api.CredReadW(target, 1, 0, ctypes.byref(pointer)):
        raise RuntimeError(f"No se encontró la credencial Windows {target}.")
    try:
        item = pointer.contents
        blob = ctypes.string_at(item.CredentialBlob, item.CredentialBlobSize)
        return item.UserName or "", blob.decode("utf-16-le") if blob else ""
    finally:
        api.CredFree(pointer)


def query(sql: str, user: str, password: str) -> list[list[str]]:
    if not sql.lstrip().upper().startswith("SELECT "):
        raise ValueError("Solo se permiten consultas SELECT.")
    env = os.environ.copy()
    env["MYSQL_PWD"] = password
    result = subprocess.run(
        [str(DB_EXE), "--host=127.0.0.1", "--port=5588", f"--user={user}",
         "--default-character-set=utf8mb4", "--batch", "--raw", "--skip-column-names",
         "--connect-timeout=5", DATABASE, "--execute=" + sql],
        capture_output=True, text=True, encoding="utf-8", errors="replace", env=env, timeout=120,
    )
    if result.returncode:
        raise RuntimeError(f"Falló la consulta de solo lectura a Perseo (código {result.returncode}).")
    return [line.split("\t") for line in result.stdout.splitlines() if line]


def request(payload: dict, endpoint: str, secret: str) -> dict:
    data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    req = urllib.request.Request(
        endpoint, data=data,
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + secret},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=45) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        try:
            detail = json.load(exc).get("error", "")
        except Exception:
            detail = ""
        raise RuntimeError(f"La API rechazó la sincronización (HTTP {exc.code}): {detail}") from None


def clean(value: str) -> str:
    return "" if value == "NULL" else value


def collect() -> tuple[dict, dict[tuple[int, str], list[dict]]]:
    if not DB_EXE.is_file():
        raise RuntimeError("No se encontró el cliente MariaDB local.")
    user, password = credential(DB_TARGET)
    if user != "etiquetas_ro":
        raise RuntimeError("La credencial Perseo no corresponde al usuario lector etiquetas_ro.")
    boxes = query("SELECT cajasid, descripcion FROM cajas WHERE cajasid IN (1,2,3,12) AND estado=1 ORDER BY cajasid", user, password)
    if [int(row[0]) for row in boxes] != list(BOX_IDS):
        raise RuntimeError("No están activas las cuatro cajas seleccionadas en Perseo.")
    sql = """SELECT movcajasid, cajasid,
        DATE_FORMAT(fechamovimiento,'%Y-%m-%d'),
        COALESCE(DATE_FORMAT(fechacreacion,'%Y-%m-%d %H:%i:%s'),''),
        CAST(ROUND(importe*100,0) AS SIGNED), COALESCE(tipo,''),
        LEFT(REPLACE(REPLACE(REPLACE(COALESCE(concepto,''),CHAR(9),' '),CHAR(10),' '),CHAR(13),' '),200),
        LEFT(REPLACE(REPLACE(REPLACE(COALESCE(comprobante,''),CHAR(9),' '),CHAR(10),' '),CHAR(13),' '),40)
        FROM movcaja WHERE cajasid IN (1,2,3,12) AND fechamovimiento<=CURRENT_DATE()
        ORDER BY cajasid, fechamovimiento, movcajasid"""
    rows = query(sql, user, password)
    history: dict[tuple[int, str], list[dict]] = defaultdict(list)
    last_dates: dict[int, str] = {}
    for row in rows:
        if len(row) != 8:
            raise RuntimeError("Perseo devolvió una fila de movimiento incompleta.")
        move_id, box_id, date, recorded_at, cents, kind, description, reference = row
        box_id = int(box_id)
        if box_id not in BOX_IDS or not date or not kind:
            raise RuntimeError("Perseo devolvió un movimiento inesperado.")
        entry = {
            "id": int(move_id), "date": date, "recordedAt": clean(recorded_at),
            "amountCents": int(cents), "type": kind, "description": clean(description),
            "reference": clean(reference),
        }
        history[(box_id, date[:7])].append(entry)
        last_dates[box_id] = max(date, last_dates.get(box_id, date))
    result_boxes = []
    for box_id_text, name in boxes:
        box_id = int(box_id_text)
        months = []
        for (owner, month), entries in sorted(history.items()):
            if owner != box_id:
                continue
            encoded = json.dumps(entries, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            months.append({
                "month": month, "hash": hashlib.sha256(encoded).hexdigest(),
                "count": len(entries), "totalCents": sum(item["amountCents"] for item in entries),
            })
        result_boxes.append({
            "id": box_id, "name": clean(name).strip(),
            "balanceCents": sum(item["totalCents"] for item in months),
            "lastMovementDate": last_dates.get(box_id), "months": months,
        })
    summary = {
        "collectedAt": datetime.now().astimezone().isoformat(),
        "boxes": result_boxes,
    }
    return summary, history


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="Consultar Perseo sin enviar datos")
    parser.add_argument("--endpoint", default=ENDPOINT, help="URL HTTPS de la API de la app")
    args = parser.parse_args()
    if not args.endpoint.startswith("https://"):
        raise RuntimeError("La sincronización requiere HTTPS.")
    summary, history = collect()
    for box in summary["boxes"]:
        print(f"Caja {box['id']}: {box['balanceCents'] / 100:.2f} USD, {sum(month['count'] for month in box['months'])} movimientos")
    if args.dry_run:
        return 0
    _, secret = credential(SYNC_TARGET)
    if not secret:
        raise RuntimeError("La credencial de sincronización está vacía.")
    plan = request({"action": "plan", **summary}, args.endpoint, secret)
    missing = plan.get("missing", [])
    print(f"Meses por actualizar: {len(missing)}")
    for item in missing:
        box_id, month = int(item["boxId"]), str(item["month"])
        entries = history[(box_id, month)]
        month_summary = next(value for box in summary["boxes"] if box["id"] == box_id for value in box["months"] if value["month"] == month)
        request({"action": "month", "boxId": box_id, "month": month, "hash": month_summary["hash"], "movements": entries}, args.endpoint, secret)
    result = request({"action": "finalize", **summary}, args.endpoint, secret)
    print(f"Sincronizadas {result['boxes']} cajas y {result['months']} meses.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (RuntimeError, OSError, ValueError) as error:
        print(f"Error: {error}", file=sys.stderr)
        raise SystemExit(1)
