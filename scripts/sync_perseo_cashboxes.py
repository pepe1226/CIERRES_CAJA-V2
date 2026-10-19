"""Read active Perseo boxes locally and publish a read-only snapshot to the app.

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
import tempfile
import urllib.error
import urllib.request
from collections import defaultdict
from datetime import datetime
from pathlib import Path


DB_TARGET = "EtiquetasTMCHPerseo"
SYNC_TARGET = "CIERRESPerseoCashboxSync"
DB_EXE = Path(r"C:\Program Files\MariaDB 11.3\bin\mariadb.exe")
DATABASE = "7791163287_db0000000003"
BOX_IDS = (1, 2, 3, 12)  # Original favorites; extraction now includes every active box.
ENDPOINT = "https://cierres-caja-v2.vercel.app/api/perseo/cashboxes"
CACHE_PATH = Path(os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData" / "Local"))) / "CierresCaja" / "perseo_cashbox_fingerprints.json"
_cache_to_save: dict = {}


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


def movement_history(where: str, user: str, password: str) -> dict[tuple[int, str], list[dict]]:
    sql = """SELECT movcajasid, cajasid,
        DATE_FORMAT(fechamovimiento,'%Y-%m-%d'),
        COALESCE(DATE_FORMAT(fechacreacion,'%Y-%m-%d %H:%i:%s'),''),
        CAST(ROUND(importe*100,0) AS SIGNED), COALESCE(tipo,''),
        LEFT(REPLACE(REPLACE(REPLACE(COALESCE(concepto,''),CHAR(9),' '),CHAR(10),' '),CHAR(13),' '),200),
        LEFT(REPLACE(REPLACE(REPLACE(COALESCE(comprobante,''),CHAR(9),' '),CHAR(10),' '),CHAR(13),' '),40)
        FROM movcaja WHERE """ + where + " ORDER BY cajasid, fechamovimiento, movcajasid"
    history: dict[tuple[int, str], list[dict]] = defaultdict(list)
    for row in query(sql, user, password):
        if len(row) != 8:
            raise RuntimeError("Perseo devolvió una fila de movimiento incompleta.")
        move_id, box_id, date, recorded_at, cents, kind, description, reference = row
        if not date or not kind:
            raise RuntimeError("Perseo devolvió un movimiento inesperado.")
        history[(int(box_id), date[:7])].append({
            "id": int(move_id), "date": date, "recordedAt": clean(recorded_at),
            "amountCents": int(cents), "type": kind, "description": clean(description), "reference": clean(reference),
        })
    return history


def month_where(box_id: int, month: str) -> str:
    return f"cajasid={box_id} AND fechamovimiento>='{month}-01' AND fechamovimiento<DATE_ADD('{month}-01', INTERVAL 1 MONTH) AND fechamovimiento<=CURRENT_DATE()"


def collect(use_cache: bool = False) -> tuple[dict, dict[tuple[int, str], list[dict]]]:
    global _cache_to_save
    if not DB_EXE.is_file():
        raise RuntimeError("No se encontró el cliente MariaDB local.")
    user, password = credential(DB_TARGET)
    if user != "etiquetas_ro":
        raise RuntimeError("La credencial Perseo no corresponde al usuario lector etiquetas_ro.")
    boxes = query("SELECT cajasid, descripcion FROM cajas WHERE estado=1 ORDER BY cajasid", user, password)
    if not boxes or len(boxes) > 100 or any(not 0 < int(row[0]) <= 1_000_000 for row in boxes):
        raise RuntimeError("Listado de cajas activas no válido.")
    ids = ",".join(row[0] for row in boxes)
    where = f"cajasid IN ({ids}) AND fechamovimiento<=CURRENT_DATE()"
    row_text = """CONCAT_WS(CHAR(31),movcajasid,DATE_FORMAT(fechamovimiento,'%Y-%m-%d'),
        COALESCE(DATE_FORMAT(fechacreacion,'%Y-%m-%d %H:%i:%s'),''),CAST(ROUND(importe*100,0) AS SIGNED),COALESCE(tipo,''),
        LEFT(REPLACE(REPLACE(REPLACE(COALESCE(concepto,''),CHAR(9),' '),CHAR(10),' '),CHAR(13),' '),200),
        LEFT(REPLACE(REPLACE(REPLACE(COALESCE(comprobante,''),CHAR(9),' '),CHAR(10),' '),CHAR(13),' '),40))"""
    fingerprint_sql = f"""SELECT cajasid,DATE_FORMAT(fechamovimiento,'%Y-%m'),COUNT(*),SUM(CAST(ROUND(importe*100,0) AS SIGNED)),
        BIT_XOR(CAST(CONV(SUBSTRING(SHA2({row_text},256),1,16),16,10) AS UNSIGNED)),
        BIT_XOR(CAST(CONV(SUBSTRING(SHA2({row_text},256),17,16),16,10) AS UNSIGNED)),MAX(DATE_FORMAT(fechamovimiento,'%Y-%m-%d'))
        FROM movcaja WHERE {where} GROUP BY cajasid,DATE_FORMAT(fechamovimiento,'%Y-%m') ORDER BY cajasid,DATE_FORMAT(fechamovimiento,'%Y-%m')"""
    manifests = query(fingerprint_sql, user, password)
    try:
        cache = json.loads(CACHE_PATH.read_text(encoding="utf-8")) if use_cache else {}
        if not isinstance(cache, dict): cache = {}
    except (OSError, ValueError):
        cache = {}
    current_cache = {}
    changed = []
    for box_id, month, count, total, first_hash, second_hash, last in manifests:
        if int(count) > 20_000:
            raise RuntimeError(f"La caja {box_id}, mes {month}, supera el límite de movimientos por envío.")
        key = f"{box_id}_{month}"
        fingerprint = hashlib.sha256("|".join((box_id, month, count, total, first_hash, second_hash)).encode()).hexdigest()
        previous = cache.get(key, {})
        if not isinstance(previous, dict): previous = {}
        if previous.get("sourceFingerprint") == fingerprint and isinstance(previous.get("hash"), str):
            current_cache[key] = previous
        else:
            changed.append((int(box_id), month))
            current_cache[key] = {"sourceFingerprint": fingerprint}
    history = movement_history(where if len(changed) == len(manifests) else "(" + " OR ".join("(" + month_where(box_id, month) + ")" for box_id, month in changed) + ")", user, password) if changed else {}
    last_dates = {int(row[0]): row[6] for row in manifests}
    result_boxes = []
    for box_id_text, name in boxes:
        box_id = int(box_id_text)
        months = []
        for owner, month, count, total, _, _, _ in manifests:
            if int(owner) != box_id:
                continue
            item = current_cache[f"{box_id}_{month}"]
            if (box_id, month) in history:
                entries = history[(box_id, month)]
                if len(entries) != int(count) or sum(entry["amountCents"] for entry in entries) != int(total):
                    raise RuntimeError("Perseo cambió durante la consulta. Se reintentará en la siguiente sincronización.")
                item["hash"] = hashlib.sha256(json.dumps(entries, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()
            months.append({"month": month, "hash": item["hash"], "count": int(count), "totalCents": int(total)})
        result_boxes.append({
            "id": box_id, "name": clean(name).strip(),
            "balanceCents": sum(item["totalCents"] for item in months),
            "lastMovementDate": last_dates.get(box_id), "months": months,
        })
    summary = {
        "collectedAt": datetime.now().astimezone().isoformat(),
        "boxes": result_boxes,
    }
    _cache_to_save = current_cache
    return summary, history


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="Consultar Perseo sin enviar datos")
    parser.add_argument("--endpoint", default=ENDPOINT, help="URL HTTPS de la API de la app")
    args = parser.parse_args()
    if not args.endpoint.startswith("https://"):
        raise RuntimeError("La sincronización requiere HTTPS.")
    summary, history = collect(use_cache=True)
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
        entries = history.get((box_id, month))
        if entries is None:
            user, password = credential(DB_TARGET)
            entries = movement_history(month_where(box_id, month), user, password).get((box_id, month), [])
        month_summary = next(value for box in summary["boxes"] if box["id"] == box_id for value in box["months"] if value["month"] == month)
        request({"action": "month", "boxId": box_id, "month": month, "hash": month_summary["hash"], "movements": entries}, args.endpoint, secret)
    result = request({"action": "finalize", **summary}, args.endpoint, secret)
    CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=CACHE_PATH.parent, suffix=".tmp", delete=False) as handle:
        json.dump(_cache_to_save, handle, separators=(",", ":"))
        temporary = handle.name
    os.replace(temporary, CACHE_PATH)
    print(f"Sincronizadas {result['boxes']} cajas y {result['months']} meses.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (RuntimeError, OSError, ValueError) as error:
        print(f"Error: {error}", file=sys.stderr)
        raise SystemExit(1)
