# Sync ML -> Shopify (public) - Updated

Incluye prioridad para `TEST_SKU` y opción `FULL_SYNC` para forzar sincronización completa.

## Nuevas variables de entorno
- `TEST_SKU`: (opcional) SKU que se procesará primero y se mostrará aparte en los logs.
- `FULL_SYNC`: (false|true) si es `true` el script procesará TODO el catálogo (usa con precaución).

## Uso recomendado
- Para pruebas rápidas: añade `TEST_SKU` como secret en GitHub (Settings → Secrets) con el SKU que quieras probar.
- Para actualizar todo manualmente: crea secret `FULL_SYNC=true` y ejecuta manualmente el workflow (Actions → Run workflow) — esto hará que el run procese todo el catálogo.
- Para ejecuciones automáticas a una hora del día: el workflow incluye un cron (por defecto `0 14 * * *` = 14:00 UTC). Ajusta a la hora que prefieras o usa la opción `workflow_dispatch` para correr manualmente.

## Precaución
Procesar todo el catálogo (`FULL_SYNC=true`) puede hacer muchas llamadas a la API de MercadoLibre y Shopify; revisa límites y usa `BATCH_SIZE` o frecuencia adecuada si no quieres saturar.
