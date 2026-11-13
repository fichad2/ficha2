# Paso 3.5 — Regularización administrativa transaccional local

## Alcance

Callable regularizeSession solo en demo-fichad2-phase3, con los guardas, hosts loopback y credenciales ficticias del paso 3.2. Sin producción, React, reglas, migraciones, Blaze, servicios nuevos, despliegues ni commits. No se inicia el paso 3.6.

## Contrato y autoridad

Se utiliza validateSessionRequest/evaluateSessionOperation del dominio existente. El cuerpo exacto incluye operation=regularizeSession, requestId UUID v4 estable, companyContext como aserción, expectedStateVersion, expectedEpoch, protocolVersion, originalEntryId, mode, reason, evidenceReference y accreditedExitAt. Ningún UID, rol, empresa autoritativa, minutos, estado o fecha de regularización del cliente es admisible.

Authentication/correo/cuenta desactivada/revocada se validan con el adaptador existente createClockInHandler, sin crear un acceso administrativo alternativo. La transacción lee users/{auth.uid} y exige role=administrador y empresa vigente. La empresa se deriva del perfil del servidor. El trabajador se deriva exclusivamente de logs/{originalEntryId}.userId; se verifica que entrada y perfil vigente del trabajador pertenecen a esa empresa y que el estado corresponde al mismo UID/entrada. El perfil del trabajador debe existir y tener un rol ordinario válido del dominio; no se exige que su cuenta Auth esté activa para revisar su histórico. El administrador solo puede actuar dentro de su empresa actual, incluso al recuperar un justificante previo.

## Condición de vencimiento y coherencia

Se añade al dominio la función pura validateOverdueRegularization sin alterar las transiciones generales existentes. La callable la usa para exigir una sesión activa estrictamente mayor de 24 h, con nanosegundos enteros y el mismo límite del dominio. Ni 24 h exactas ni un estado marcado manualmente needs_review permiten saltarse ese requisito. Se comprueba antes y después de leer el histórico, utilizando hora del servidor de cada intento transaccional.

La lectura de historia/cierres, validación de DTOs y precisión persistible se extraen del paso 3.4 a session-transaction-support.js. clockOut consume el mismo código extraído, con sus criterios y mensajes conservados. No se copian validaciones de fechas/duraciones/permisos del dominio.

Se exige entrada existente, tipo entrada, UID/empresa y timestamp coherentes con el estado, sin cierre ni regularización anterior. Se leen las referencias de cierre, el histórico propio completo y las regularizaciones canónicas/no canónicas que enlacen la entrada. No se filtra por fechas ni se infiere un emparejamiento para una salida sin referencia. Una consulta fallida no equivale a histórico vacío.

Política conservadora de este paso: cualquier entrada posterior bloquea la regularización, incluso si una hora acreditada pudiera quedar antes de ella. La operación no puede reconstruir el estado operativo de esa sesión posterior ni darlo por libre: requeriría otro procedimiento autorizado. No se reasigna el estado ni se elige una entrada histórica arbitraria. Esta condición específica no cambia el motor general del dominio.

## Dos resoluciones

- accredited_exit: motivo y evidencia obligatorios, salida posterior a entrada y no futura, duración positiva y como máximo 1440 minutos según el dominio. Conservar una duración positiva inferior a un minuto como cero cuantificado, distinguible de null. Registrar referencia no verifica automáticamente la autenticidad o contenido de la evidencia; su revisión corresponde al administrador.
- unknown_exit: motivo obligatorio, accreditedExitAt=null, evidenceReference=null y effectiveMinutes=null. No crear log salida ni usar regularizedAt como hora de salida.

El paso 3.4 comprobó que Firestore persiste microsegundos. Se reutiliza la validación de representabilidad: ni la hora acreditada ni la hora del servidor se redondean silenciosamente. Se rechaza la precisión que no pueda guardarse íntegramente, manteniendo intacto el cálculo en nanosegundos del dominio. El adaptador real Timestamp.now() ya produce milisegundos compatibles.

## Una transacción y auditoría

Todas las lecturas preceden las escrituras. Un commit crea/actualiza exactamente:

1. create companies/{companyId}/regularizations/{originalEntryId}, inmutable: originalEntryId, workerUid, companyId, mode, reason, evidenceReference, accreditedExitAt o null, effectiveMinutes o null, adminUid, regularizedAt del servidor, committedAt del commit, status y requestId.
2. update companies/{companyId}/session_states/{workerUid} con el plan del dominio: status=regularized, version+1, sin activeEntryId/openedAt y con lastResolution trazable. Preservar initializationId/sourceDigest y otros metadatos.
3. create companies/{companyId}/session_requests/{requestKey}, con actor, empresa, trabajador, UUID, huella de contenido, resultado del dominio y committedAt.

La regularización y el justificante forman conjuntamente la auditoría confiable del servidor, guardada atómicamente. Esto sigue la arquitectura aprobada: audit_logs, que admite otros usos desde clientes, no es la prueba de ejecución y no se escribe como efecto posterior. No hay ninguna escritura ni eliminación de logs originales.

## Reintentos y conflictos

Se reutiliza la identidad SHA-256 versionada por empresa/administrador/requestId y la huella normalizada del dominio. El mismo UUID/contenido recupera el mismo resultado sin escribir. Contenido contradictorio con esa clave se rechaza. Administradores distintos tienen justificantes propios, pero compiten por el mismo estado y el mismo ID canónico de regularización: solo uno puede resolverla.

La recuperación de un justificante confirmado precede la relectura del estado objetivo, para no aplicar una resolución antigua a una jornada nueva. Puede recuperar el resultado durante una pausa o cambio de epoch; siempre exige permisos actuales del administrador. Nuevas operaciones exigen modo backend, epoch/protocolo/version correctos y estado inicializado. create evita sobrescrituras incluso ante colisiones.

Se reutilizan los errores estructurados del adaptador, incluidos REQUEST_ID_CONFLICT, VERSION_CONFLICT, HISTORY_CONFLICT, ALREADY_CLOSED y ALREADY_REGULARIZED. La condición de menos/igual 24 h devuelve REGULARIZATION_NOT_DUE. Ante fallo técnico/respuesta perdida se conserva CONFIRMATION_UNAVAILABLE con outcomeUnknown/retryable, sin declarar éxito o ausencia de commit; reintentar el mismo UUID.

## Desbloqueo y límites de integración

clockIn ya admite el estado regularized del dominio. Tras resolver, permite una nueva entrada propia; clockOut puede cerrar esa nueva sesión. Los originales y la resolución antigua permanecen íntegros. Se prueba expresamente el ciclo y el reintento administrativo antiguo después de la nueva jornada.

No activar este backend en producción: faltan reglas de modo, inicialización autorizada, transición del cliente y lecturas/informes capaces de combinar logs y regularizaciones. React/PDF/CSV todavía no consumen estas resoluciones; los logs originales siguen conservando su entrada abierta. Una resolución operativa no autoriza ocultar la incidencia original en informes ni convertir una duración desconocida en cero.

El emulador no reproduce IAM, Billing, índices, cuotas ni todas las latencias cloud. Leer el histórico propio completo incrementa coste/contención con el volumen. Authentication y Firestore no comparten una transacción entre servicios. Si el trabajador se ha cambiado de empresa o falta su perfil, esta callable rechaza la operación; revisar un caso histórico de esa clase requeriría un procedimiento autorizado específico. La veracidad de la evidencia no se automatiza.

## Archivos

Creados: functions/src/regularize-session-service.js, functions/src/session-transaction-support.js, tests/phase3/regularize-session.test.mjs y este documento.

Modificados: functions/src/session-domain.js (política pura adicional), functions/src/clock-out-service.js (extracción/reutilización), functions/src/index.js (callable), scripts/run-phase3-emulators.mjs (snapshot), scripts/run-phase3-tests.mjs (suite) y tests/phase3/backend-environment.test.mjs (cuatro exports autorizados).

Sin cambios en React, reconstrucción/reporting, clockIn/autenticación, reglas ni configuración de producción, dependencias o fichajes reales.

## Validación

**473 pruebas aprobadas, 0 fallidas, 0 omitidas** en la ejecución final: 16 de reglas + 262 anteriores restantes + 51 de clockIn + 67 de clockOut + 77 nuevas de regularización. Ejecutadas con Node 22 mediante scripts/run-phase3-emulators.mjs test, exclusivamente en demo-fichad2-phase3. Código de salida final 0. Backend del snapshot idéntico a los fuentes actuales.

Verificado: ambas modalidades; Auth/perfiles/roles vigentes; trabajador y administrador de otra empresa (también con contexto de su propia empresa válido); entrada inexistente/cerrada; vencimiento exacto; motivo/evidencia/fechas/duración; precisión microsegundo; campos protegidos; versiones/modos; doble clic, reintentos idénticos/contradictorios, dos administradores, carrera con clockOut; conservación de datos y updateTime de originales; commit fallido sin efectos parciales y recuperación; nueva entrada/salida después de ambos tipos de resolución; guardas que impiden llamadas fuera del emulador.

Compilación npm run build aprobada (266 módulos), con salida temporal fuera del repositorio y solo los avisos previos de Browserslist/bundles >500 kB. Sin actualizaciones de dependencias.

Revisión: las funciones de hechos de historial extraídas coinciden con las anteriores; el núcleo anterior del dominio es byte a byte idéntico al retirar virtualmente la nueva política y su mensaje. Hashes verifican que React, reconstrucción/reporting, clockIn/autenticación, reglas, configuración y paquetes/lockfiles permanecen sin cambios respecto al inicio del paso. Revisión de espacios y git diff --check sin errores.

Incidencia del entorno antes de la ejecución final: el primer CLI terminó durante el descubrimiento sin completar el arranque y dejó Firestore y el servidor local de descubrimiento activos. No se ejecutaron pruebas en ese intento. Se identificaron los procesos por PID, ruta del snapshot y proyecto demo; se detuvieron solo esos procesos y se verificó el cierre de sus puertos. La repetición con el mismo código completó 473/473; emuladores y puerto de descubrimiento cerrados al finalizar.

Sin acceso a fichad2-piloto ni a datos reales de EMAR. Sin Blaze, servicios cloud nuevos, despliegues, commits ni paso 3.6.
