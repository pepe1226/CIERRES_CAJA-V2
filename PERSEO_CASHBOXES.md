# Cajas de Perseo en Cierres Caja

La app muestra, solo a administradores, el saldo y el historial de las cajas activas 1 (Esperado), 2 (Ganancias), 3 (Ganancias CNB) y 12 (Compra PDV). La sección es de **consulta**; no crea ni modifica movimientos en Perseo y no mezcla sus saldos con En Tienda, En Tránsito, Banco o Banquitos.

## Origen y actualización

`scripts/sync_perseo_cashboxes.py` usa la credencial Windows `EtiquetasTMCHPerseo` del usuario SQL `etiquetas_ro` y consulta `cajas` y `movcaja` en `PegasusDB`. Suma `importe` de movimientos con `fechamovimiento <= CURRENT_DATE()` en centavos y publica un resumen y meses de historial a través de `/api/perseo/cashboxes`. Los movimientos futuros no se cuentan. Cada mes lleva una huella SHA-256; la API verifica integridad, cantidad y suma antes de publicar el nuevo resumen.

La credencial de la API es independiente (`CIERRESPerseoCashboxSync` en Windows; `PERSEO_CASHBOX_SYNC_SECRET` en Vercel). El script de aprovisionamiento crea ambas sin mostrar ni guardar el valor en el repositorio. La API GET verifica el token de Firebase y el rol `admin`; Firestore no expone directamente las colecciones nuevas.

## Operación local

Con `PegasusDB` encendido y la sesión Windows del propietario abierta:

1. `python scripts/sync_perseo_cashboxes.py --dry-run` muestra los saldos leídos sin enviar datos.
2. Una sola vez: `python scripts/provision_perseo_cashbox_secret.py` crea el secreto local y en Vercel.
3. `python scripts/sync_perseo_cashboxes.py` realiza la primera sincronización.
4. `powershell -ExecutionPolicy Bypass -File scripts/install_perseo_cashbox_sync.ps1` instala la tarea de Windows cada 15 minutos.

La tarea usa el usuario Windows actual con sesión interactiva porque el Administrador de credenciales pertenece a ese usuario. Si el equipo está apagado, no hay sesión abierta o `PegasusDB` no está disponible, la app conserva el último dato y lo marca como atrasado después de 24 horas. El botón «Actualizar vista» relee la copia publicada; **no** inicia Perseo desde el teléfono.

## Validación de cifras

El saldo mostrado es la suma SQL de `movcaja.importe` de cada caja hasta la fecha actual. Conviene contrastarlo visualmente con el saldo presentado por Perseo antes de considerarlo una conciliación contable; no se modifica `valorapertura` ni se asumen anulaciones que la tabla no registra.
