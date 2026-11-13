# Fase 2 local: capa de lectura de sesiones

El módulo estricto de fase 1 permanece sin cambios. `session-reporting.js` lo
utiliza para crear un modelo de lectura sin escrituras y sin mutar originales.
Solo emite totales nuevos cuando la reconstrucción es compatible. Conserva
minutos guardados coherentes, incluido cero, y devuelve null para duraciones
desconocidas. Las discrepancias conservan el valor original y bloquean un agregado
de sustitución, sin convertirlo en cero. Las incidencias se conservan incluso
cuando un filtro excluye sus fechas.

Las fechas se interpretan y presentan en Europe/Madrid. La política aprobada es
repartir los minutos por días naturales, usando los instantes reales entre cada
medianoche local. No se suman 24 horas para buscar medianoches: los días de cambio
de horario tienen 23 o 25 horas. El intervalo es [entrada, salida): una salida
exactamente a medianoche no atribuye minutos al día siguiente.

Cada sesión conserva un único par de IDs y su duración completa. El modelo añade
`dailyMinutes` (desglose diario) y `periodMinutes` (parte incluida en el filtro),
sin crear fichajes ni duplicar sesiones. Los totales del panel, semana y resúmenes
suman exclusivamente las partes del periodo. El historial presenta el desglose
junto a los registros originales. Una entrada abierta no se extiende por días
sucesivos: su duración permanece desconocida y el aviso global no se filtra.

En un único día se conserva el truncado a minutos de la sesión histórica válida.
Para repartir una sesión entre varios días se exige que cada tramo sea un número
entero exacto de minutos y que su suma coincida con la duración conservada. Si hay
fracciones de minuto (incluidos nanosegundos), no existe una política aprobada para
asignarlas: se genera `daily_allocation_ambiguous`, se mantiene el total guardado
y se detiene la sustitución del cálculo y la exportación. No se hacen repartos
proporcionales, redondeos compensatorios ni ajustes de originales. Los conflictos
preexistentes de la reconstrucción, incluido superar 24 horas, siguen bloqueando.

El historial usa el modelo compartido y conserva incluso registros inválidos que
antes podían desaparecer al filtrar fechas. Los manejadores de entrada/salida y
sus consultas de control no se modifican.

Panel, resumen semanal, PDF, CSV resumido e inspección usan el mismo informe
para datos compatibles, con los IDs originales y contadores de duraciones
desconocidas. El informe mantiene los avisos del historial completo aunque queden
fuera del filtro. Las exportaciones utilizan la instantánea cargada al aplicar el
filtro; los cambios de filtro las deshabilitan hasta recalcular. El informe queda
vinculado a la empresa y usuario que lo cargó y no puede exportarse desde otro
contexto de sesión. La inspección
conserva columnas ISO originales y añade fecha Madrid, estado y metadatos de
incidencias. La inspección conserva `session_minutes`/`session_hours` como duración
completa original y añade `minutos_en_rango` (cantidad sumable para ese filtro) y
`reparto_diario_madrid`. No sumar duraciones completas para conciliar filtros
parciales: se usa `minutos_en_rango`. CSV/PDF de resumen incluyen información sobre duraciones desconocidas.

Si la reconstrucción o el reparto diario son incompatibles, el panel conserva explícitamente su cálculo anterior
sin verificar y se bloquean las exportaciones. No se publica un total nuevo cero,
no se confirma un emparejamiento antiguo y no se corrige el valor guardado. Las
funciones de cálculo anteriores se conservan para ese respaldo y las nueve pruebas
de caracterización; la inspección antigua ya no se utiliza para exportar.

Ejecutar sin Firebase ni datos reales:

```powershell
node --test tests/session-reconstruction.test.mjs tests/session-calculation-compatibility.test.mjs tests/session-reporting.test.mjs tests/session-history-integration.test.mjs tests/session-report-integration.test.mjs tests/session-daily-allocation.test.mjs
```

Las pruebas de integración renderizan WorkerPanel real mediante React, aislado
de App y Firebase, para comprobar las presentaciones móvil y escritorio. También
ejecutan el cargador real del dashboard y los exportadores CSV con dependencias
ficticias, sin red ni escrituras. Se ejecuta también el contenido de la exportación
PDF con el generador sustituido por un doble de prueba y se comprueban sus horas,
avisos y fecha Madrid; no se ha verificado visualmente un PDF descargado.
El caso de 79 registros y 9623 minutos usa exclusivamente datos inventados.
No se guarda una copia de los fichajes de EMAR en el repositorio.

Las regresiones del reparto usan datos ficticios: cambio de mes y año, DST de
primavera/otoño, extremos a medianoche, cruce de semana, nanosegundos, minutos
discrepantes y formatos históricos. PDF/CSV y componentes reales se ejecutan
aislados de Firebase para comprobar el reparto sin operaciones de producción.
