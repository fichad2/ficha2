# Paso 3.4 — Salida transaccional local

## Alcance

Solo callable clockOut en demo-fichad2-phase3 y destinos loopback. Sin regularizaciones, React, migración, reglas, despliegue ni dependencias nuevas. clockIn, el dominio y los cálculos de las fases anteriores permanecen intactos.

## Operación

Se reutiliza createClockInHandler como adaptador existente de Authentication y errores (su nombre se conserva para evitar una refactorización). Exige token verificado, usuario Auth vigente, correo verificado en ambos, cuenta no desactivada/revocada y perfil/empresa obtenidos por el servidor. La operación actúa exclusivamente sobre el propio UID; conserva la política del dominio para administradores que fichan su propia jornada.

Contrato exacto del dominio: operation=clockOut, requestId UUID v4 estable, companyContext como aserción, expectedStateVersion, expectedEpoch y protocolVersion. El cliente no puede aportar entradaLogId, UID, empresa autoritativa, fechas ni minutos. La entrada a cerrar se obtiene del estado validado, nunca del cuerpo.

Dentro de cada transacción:

1. Leer perfil, empresa, control, estado y justificante, con rutas y claves derivadas del perfil y UID autenticado.
2. Validar permisos/versiones y recuperar un justificante previo idéntico sin crear efectos ni recalcular su duración. Reutilizar una clave con contenido/operación diferente produce REQUEST_ID_CONFLICT.
3. Para una salida nueva, leer logs/{activeEntryId}, la regularización canónica de esa entrada (solo lectura), todos los cierres referenciados, el histórico propio completo de la empresa y las regularizaciones que referencien la entrada. No usar límites o filtros temporales que oculten cierres/incidencias. Si alguna lectura falla, no se declara el histórico completo ni se escribe.
4. Construir los hechos de cierre y pasarlos a evaluateSessionOperation. Exigir tipo entrada, UID/empresa, ID y Timestamp original coherentes con el estado; rechazar salida/regularización previa, entrada duplicada al mismo instante, solapamiento posterior, salida sin referencia o referencia incoherente. No emparejar registros históricos por proximidad. Los cierres anteriores válidamente referenciados que coincidan exactamente con el comienzo actual no crean un falso solapamiento.
5. Obtener de nuevo Timestamp.now() después de leer el histórico y volver a evaluar el dominio. La duración se calcula allí con nanosegundos enteros; debe ser positiva y como máximo 24 h exactas. Un exceso de un nanosegundo bloquea la salida ordinaria y requiere revisión administrativa. No truncar a 1440 minutos ni convertir una duración desconocida en cero. Una duración positiva inferior a un minuto conserva cero minutos cuantificados según el dominio existente.
6. En el mismo commit, create del log de salida, update del estado (idle/version+1) y create del justificante. Conservar metadatos de inicialización/huella en el estado. No escribir sobre la entrada ni otros logs existentes.

El log salida mantiene userId, companyId, tipo, timestamp, entradaLogId, inicioSesion y minutosSesion. timestamp es la hora efectiva de servidor usada para calcular la duración; inicioSesion conserva el Timestamp original, incluidos todos sus nanosegundos almacenados. updatedAt/committedAt son timestamps del commit. El resultado/justificante mantiene el formato JSON del dominio para exitAt y minutes.

## Precisión de almacenamiento comprobada

El dominio sigue operando con nanosegundos enteros, sin cambios. Firestore almacena timestamps con precisión de microsegundos y trunca los dígitos adicionales ([documentación oficial](https://firebase.google.com/docs/firestore/manage-data/data-types)). La primera ejecución de integración tuvo cuatro fallos: dos fixtures suponían que se conservarían nanosegundos no persistibles, y dos cierres sintéticos mostraron que un justificante podía describir una hora distinta del Timestamp finalmente guardado. Se añadieron pruebas explícitas de esa restricción y una protección en clockOut: si una hora efectiva válida no es representable íntegramente (nanoseconds % 1000 != 0), abortar con INVALID_TIME antes de escribir. No redondear silenciosamente ni dejar que el justificante describa otra hora que el log.

El adaptador real Timestamp.now() ya produce milisegundos, por lo que cumple la protección. Las integraciones prueban un microsegundo positivo, marcas fraccionarias representables, cero, discrepancia de un microsegundo y 24 h exactas. El cálculo del dominio conserva todos los nanosegundos disponibles: 24 h + 1 ns se rechaza como REGULARIZATION_REQUIRED antes de cualquier escritura/normalización. Las 112 pruebas puras anteriores siguen comprobando la precisión de nanosegundos del dominio. No se modifica ningún formato histórico ni se truncan originales.

## Idempotencia y conflictos

La clave/huella siguen exactamente el esquema del paso 3.3 y el dominio. Un reintento confirmado devuelve el mismo resultado sin modificar documentos, incluso tras pausa/cambio de epoch o una nueva jornada posterior. Se revalidan Auth, perfil y empresa actuales antes de recuperarlo. Una respuesta perdida nunca debe llevar al cliente a generar otro requestId o recurrir a escrituras directas.

Todas las lecturas y las tres escrituras se cercan por la transacción. Dispositivos con versiones concurrentes crean un único cierre; los demás recuperan el mismo justificante o reciben VERSION_CONFLICT. create evita sobrescribir un ID existente. Los errores técnicos mantienen CONFIRMATION_UNAVAILABLE y outcomeUnknown/retryable del adaptador existente: nunca se confirma una salida cuyo commit no se ha confirmado.

## Aislamiento y protección

Guardas del paso 3.2 antes de SDK/operación y antes de encolar escrituras. Instancia Firestore fijada al proyecto demo y host local; credenciales ficticias explícitas, sin ADC ni claves reales. El snapshot temporal incorpora clock-out-service.js. Solo se exportan emulatorHealth, clockIn y clockOut. No hay endpoint ni escrituras de regularización: los documentos de regularización usados en pruebas son fixtures ficticios para comprobar rechazos.

Las reglas heredadas siguen verificándose primero en el mismo proyecto demo; después se ejecutan las otras pruebas anteriores, clockIn y finalmente clockOut. No se cambian firestore.rules, firebase.json, .firebaserc, paquetes/lockfiles, React ni dominio.

## Límites y riesgos pendientes

No activable en producción. Faltan regularización, inicialización autorizada, reglas de modo y transición del cliente. No mezclar escritores directos legacy con backend. El estado inicializado debe proceder de una reconstrucción autorizada y completa; esta operación no reconstruye ni repara estados históricos ausentes/incoherentes.

Las comprobaciones del cierre son conservadoras: una incidencia de referencia/fechas del histórico propio puede bloquearlo; no se reinterpretan originales para permitir una salida. Se lee el histórico propio completo, con coste/contención creciente según su volumen; antes de un corte real habrá que medir y revisar el alcance/índices necesarios con datos de prueba representativos. No se crean índices ni se optimiza reduciendo la integridad de la comprobación.

El emulador no acredita IAM, cuotas, costes, todos los índices ni latencias cloud. Authentication y Firestore no comparten una transacción entre servicios. Colisiones de IDs/documentos o inconsistencias requieren diagnóstico, nunca sobrescritura automática. El cliente aún no consume estas callables. La futura regularización deberá revisar también la precisión persistible de las horas acreditadas; no se implementa en este paso.

## Validación

Resultado final: **396 pruebas aprobadas, 0 fallidas, 0 omitidas** (16 de reglas + 262 anteriores restantes + 51 de clockIn + 67 nuevas de clockOut). Node 22, exclusivamente demo-fichad2-phase3. Comando: node scripts/run-phase3-emulators.mjs test. Ejecución final terminada con código 0; snapshot del backend idéntico a los fuentes probados.

Incluye salida correcta, estado ausente/idle/pendiente, originales inexistentes/ajenos/incoherentes, duración y precisión, límite de 24 h y exceso de 1 ns, referencias/solapamientos, campos protegidos, correo/Auth/perfil/empresa, versiones/epoch/modos, reintentos, dos dispositivos, 20 cierres simultáneos con claves iguales y distintas, compatibilidad de ciclo clockIn -> clockOut -> clockIn, recuperación de un justificante antiguo sin cerrar la nueva sesión y rollback real del emulador con reintento posterior correcto.

Compilación npm run build aprobada, 266 módulos, con salida temporal fuera del repositorio. Los avisos existentes de Browserslist y bundles >500 kB permanecen; no se cambian dependencias. La carga/ejecución del backend final se comprobó en Functions Emulator. Revisión de diferencias y espacios finales completada.

Huellas verificadas: intactos App.jsx, reconstrucción/reporting, dominio, servicio/adaptador de clockIn, firestore.rules, firebase.json, .firebaserc, configuración local de emuladores, paquetes/lockfiles y las pruebas de clockIn.

Incidencias previas a la ejecución final: primer arranque detenido antes de las pruebas por timeout local de Firestore; primera ejecución completa con 329/329 anteriores aprobadas y 60/64 nuevas, con cuatro fallos que revelaron la precisión de almacenamiento descrita arriba. Tras añadir la protección y ajustar/ampliar los fixtures, repetición completa 396/396. El CLI mostró un aviso al detener Firestore; el lanzador verificó todos los puertos cerrados y terminó con código 0.

Producción no utilizada: sin lecturas/escrituras de fichad2-piloto ni datos reales de EMAR, sin cambios de plan, servicios cloud, reglas desplegadas, commits ni paso 3.5.

## Archivos del paso

Creados: functions/src/clock-out-service.js, tests/phase3/clock-out.test.mjs y este documento.

Modificados: functions/src/index.js, scripts/run-phase3-emulators.mjs, scripts/run-phase3-tests.mjs y tests/phase3/backend-environment.test.mjs.

Sin acceso a producción ni datos reales de EMAR. Sin Blaze, despliegues, commits ni paso 3.5.
