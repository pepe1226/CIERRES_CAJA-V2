# Importacion de reportes Perseo 21:00

Esta integracion llena automaticamente las columnas de sistema de cada cierre:

- `systemAmount`: Venta Sistema
- `systemBalance`: Cuadre Sistema
- `difference`: Fisico - Cuadre Sistema

## Endpoint

```txt
POST /api/perseo/import-report
```

Ruta limpia:

```txt
POST /perseo/import-report
```

## Seguridad

Configura en Vercel:

```txt
PERSEO_IMPORT_SECRET=una_clave_larga
```

Si no existe, el endpoint acepta `CRON_SECRET` como respaldo.

Enviar el secreto como:

```txt
Authorization: Bearer TU_SECRETO
```

## JSON aceptado

```json
{
  "source": "perseo-21h",
  "rows": [
    {
      "fecha": "2026-06-23",
      "responsable": "ERICK",
      "venta sistema": 386.67,
      "cuadre sistema": 386.67
    }
  ]
}
```

Si el reporte solo trae una columna `sistema`, ese valor se usa como venta y cuadre:

```json
{
  "rows": [
    {
      "fecha": "23/06/2026",
      "cajero": "ERICK",
      "sistema": "$386.67"
    }
  ]
}
```

## CSV aceptado

Separado por coma o punto y coma:

```csv
fecha;responsable;sistema
23/06/2026;ERICK;$386.67
```

## Cruce

El sistema busca cierres en `closures` por:

1. Misma fecha de negocio.
2. Responsable/cajero normalizado.

Cuando encuentra un cierre, actualiza:

```txt
systemAmount
systemBalance
difference
systemSource=perseo
perseoReportId
perseoMatchedAt
perseoAuditStatus
perseoRaw
```

Si no encuentra cierre o hay ambiguedad, lo devuelve en `results` sin modificar datos.
