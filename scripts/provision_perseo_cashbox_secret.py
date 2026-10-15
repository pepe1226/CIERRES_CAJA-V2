"""Create a private sync token in Windows Credential Manager and Vercel.

The token is never printed, saved in the repository, or passed on a command line.
"""

from __future__ import annotations

import ctypes
import secrets
import shutil
import subprocess
import sys

from sync_perseo_cashboxes import Credential, SYNC_TARGET, credential


def save_credential(secret: str) -> None:
    blob = ctypes.create_string_buffer(secret.encode("utf-16-le"))
    item = Credential()
    item.Type = 1  # CRED_TYPE_GENERIC
    item.TargetName = SYNC_TARGET
    item.UserName = "perseo-sync"
    item.CredentialBlobSize = len(secret.encode("utf-16-le"))
    item.CredentialBlob = ctypes.cast(blob, ctypes.POINTER(ctypes.c_ubyte))
    item.Persist = 2  # CRED_PERSIST_LOCAL_MACHINE, for this Windows user
    if not ctypes.windll.advapi32.CredWriteW(ctypes.byref(item), 0):
        raise RuntimeError("No se pudo guardar la credencial local de sincronización.")


def main() -> int:
    try:
        _, token = credential(SYNC_TARGET)
        print("La credencial local ya existe; se reutilizará.")
    except RuntimeError:
        token = secrets.token_urlsafe(48)
        save_credential(token)
        print("Credencial local creada en el Administrador de credenciales.")
    npx = shutil.which("npx")
    if not npx:
        raise RuntimeError("No se encontró npx para configurar Vercel.")
    command = [npx, "vercel", "env", "add", "PERSEO_CASHBOX_SYNC_SECRET", "production",
               "--sensitive", "--yes", "--scope", "joses-projects-48fd7afe",
               "--project", "cierres-caja-v2"]
    result = subprocess.run(command, input=token + "\n", capture_output=True, text=True, timeout=120)
    if result.returncode:
        raise RuntimeError("Vercel rechazó la variable. Comprueba si ya existe antes de reintentar; el secreto local se conserva.")
    print("Variable secreta de producción configurada en Vercel.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (RuntimeError, OSError, subprocess.TimeoutExpired) as error:
        print(f"Error: {error}", file=sys.stderr)
        raise SystemExit(1)
