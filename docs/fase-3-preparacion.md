# Fase 3 — preparación local, sin operaciones implementadas

Fecha: 19/10/2026. Rama revisada: estabilizacion-fichad2.
Estado: propuesta técnica y especificación de QA; requiere autorización para programar.

## 1. Resultado de la revisión

- App.jsx contiene la integración local de fases 1 y 2; todavía ficha con lecturas y addDoc separados.
- getOpenEntry empareja por orden y no conoce regularizaciones; no será la autoridad del nuevo backend.
- guardarSalidaYHoras usa hora local para minutos y serverTimestamp para salida: son instantes distintos y pueden discrepar.
- registrarAuditoria se ejecuta después del fichaje: un error de auditoría puede mostrar fallo tras una escritura correcta.
- Las reglas de logs validan identidad, empresa, campos y hasta 1440 minutos. No garantizan entrada única, cierre único ni referencia íntegra.
- No hay backend functions/ ni conexión de Functions Emulator. Hay Auth/Firestore Emulator.
- Firebase Web instalado: 9.23.0; compatible con callables de segunda generación (mínimo web documentado 9.7.0). No se propone actualizar React/Firebase por este trabajo.
- .firebaserc tiene default=fichad2 y piloto=fichad2-piloto: ninguna prueba debe depender del alias por defecto.
- Firebase Spark es contexto confirmado por el usuario; en esta preparación no se ha consultado Billing ni producción.
- Referencia de fase 2: 114 pruebas locales + 16 de seguridad aprobadas. No se vuelven a ejecutar ni se presentan como pruebas del backend inexistente.
- Referencia histórica: 79 logs, 39 sesiones cerradas, 9623 minutos y una entrada pendiente del 9 de agosto. Estos valores se conservan como control; no autorizan una migración ni una regularización real.

## 2. Arquitectura mínima propuesta

React -> tres callables HTTPS -> servicio transaccional compartido -> Firestore.

Usar entrada, salida y regularización síncronas; no triggers sobre logs, cron, colas, Scheduler ni procesos que cierren jornadas automáticamente. La incidencia de más de 24 horas se deriva de la entrada y la hora actual: no necesita un servicio programado.

Las funciones validan Authentication, correo verificado, perfil vigente, empresa y protocolo. La empresa y el actor se derivan del usuario autenticado; nunca se aceptan como autoridad los roles/companyId que envíe el navegador. Entrada y salida actúan exclusivamente sobre el propio UID, conservando la política de identidad actual. Regularizar exige administrador verificado de la empresa del fichaje.

Admin SDK elude las reglas de Firestore: la autorización debe implementarse también en el backend. Las pruebas de reglas y las de endpoints son dos capas distintas. Identidad de servicio con permisos mínimos, sin claves privadas en React ni nuevas credenciales locales para el emulador.

## 3. Modelo propuesto

Conservar /logs/{id} y /users/{uid} actuales. No reescribir, borrar ni renombrar logs históricos. Agrupar los documentos nuevos por empresa para evitar IDs compuestos ambiguos.

| Ruta | Campos principales | Invariante |
| --- | --- | --- |
| companies/{companyId}/session_states/{uid} | schemaVersion, companyId, userId, status, version, activeEntryId, openedAt, lastRequestId, updatedAt, initializationId, sourceDigest | Un estado operativo por trabajador/empresa; derivado, no sustituye el histórico |
| companies/{companyId}/regularizations/{originalEntryId} | schemaVersion, originalEntryId, companyId, workerUid, mode, reason, evidenceReference, accreditedExitAt, effectiveMinutes, adminUid, regularizedAt, status, requestId | Un registro final inmutable por entrada; nunca una salida ficticia |
| companies/{companyId}/session_requests/{requestKey} | schemaVersion, actorUid, companyId, requestId, operation, payloadHash, outcome, originalEntryId, resultingStateVersion, committedAt | Justificante inmutable y respuesta recuperable; creado en la misma transacción |
| companies/{companyId}/session_control/config | schemaVersion, writeMode, epoch, activatedAt, minProtocolVersion, initializationId | Solo gestión confiable; controla legacy / paused / backend |

session_states.status: idle, open o needs_review. El exceso de 24 h puede derivarse de open + openedAt aunque ningún proceso haya cambiado el documento. No confundir una ausencia de estado con idle: para usuarios anteriores al corte, estado ausente/no inicializado implica detener la operación. La excepción de alta nueva exige las comprobaciones transaccionales explícitas descritas más abajo.

regularizations.mode: accredited_exit o unknown_exit. En unknown_exit, accreditedExitAt y effectiveMinutes son null; en accredited_exit, salida acreditada válida y minutos derivados de ella. status final: resolved_known o resolved_unknown. Las incidencias pendientes se derivan de estados y logs; no se crean regularizaciones vacías para simular su resolución.

Motivo obligatorio no vacío, con límites de tamaño; referencia textual a la acreditación para el modo conocido, sin añadir almacenamiento de adjuntos en esta versión. El sistema valida coherencia temporal, pero no certifica por sí solo la veracidad de la evidencia: responde el administrador identificado.

V1 permite una única resolución final por entrada. No editar resoluciones para incorporar evidencia posterior: una rectificación futura necesitará un procedimiento adicional de anotaciones enlazadas, autorizado y probado. No está incluido en esta preparación.

## 4. Contratos de las operaciones

Todas reciben requestId aleatorio estable para ese intento de usuario, expectedStateVersion, expectedEpoch, companyContext y protocolVersion. companyContext es una aserción que debe coincidir con la empresa derivada del perfil, nunca una autorización; evita trasladar una solicitud pendiente a otra empresa tras un cambio de adscripción. expectedEpoch impide ejecutar intenciones de un corte anterior. La regularización recibe además originalEntryId, mode, reason y, si corresponde, accreditedExitAt/evidenceReference. No admitir minutos, usuario responsable, estado final ni timestamps de auditoría calculados por el cliente.

| Operación | Condiciones | Escritura atómica |
| --- | --- | --- |
| clockIn | Identidad/empresa válidas, control backend, estado inicializado idle (o alta nueva verificada transaccionalmente) y versión esperada | Crear log entrada, pasar estado a open con version+1 y crear justificante |
| clockOut | Mismo actor, estado open, entrada original válida y única, duración positiva y como máximo 24 h exactas | Crear log salida explícitamente referenciado, pasar estado a idle con version+1 y crear justificante |
| regularizeSession | Administrador de la misma empresa, motivo, entrada realmente pendiente y estado consistente; ninguna salida/resolución previa | Crear regularización, pasar estado a idle con version+1 y crear justificante |

Si la entrada está vencida, clockIn no abre otra y clockOut devuelve incidencia que requiere administrador: no se recorta a 1440 minutos ni se cierra a la hora actual. La empresa debe consultar la lista de incidencias pendientes.

La salida ordinaria mantiene los campos del formato actual. El backend captura un instante de su propio reloj para la salida y calcula minutos usando exactamente ese mismo Timestamp y la entrada original con precisión de nanosegundos. No calcular minutos con un reloj y sustituir luego la marca de salida por serverTimestamp. El justificante/estado guardan además committedAt/updatedAt con serverTimestamp. Reintentos internos no producen efectos externos.

Una salida acreditada debe ser posterior a la entrada, no futura, no contradictoria con sesiones posteriores y sin solapamientos. Exigir instante UTC/offset explícito: una hora local repetida en otoño necesita indicar cuál de las dos ocurrencias está acreditada; una hora inexistente en primavera se rechaza. No resolver esa ambigüedad automáticamente. Para V1, si exige superar el límite actual de 24 h o resolver referencias ambiguas, mantener needs_review y pedir decisión funcional específica; no ampliar por defecto las horas computables.

unknown_exit resuelve administrativamente el impedimento operativo con duración desconocida: no inventa hora, no crea log salida y no convierte minutos en cero. El próximo fichaje se autoriza por el estado transaccional, no reinterpretando la entrada antigua con getOpenEntry.

Una resolución acreditada puede tener duración conocida pero reparto diario ambiguo por fracciones de minuto: la incidencia de salida puede quedar resuelta, pero los informes deben seguir bloqueados por la salvaguarda de fase 2. No confundir resolución operativa con validación contable ni declarar el informe completo.

Alta de trabajadores después del corte: conservar registro/invitaciones actuales. Para que una cuenta nueva pueda hacer su primera entrada sin otro servicio, clockIn tendrá una rama explícita de inicialización segura: perfil con createdAt confiable posterior o igual a activatedAt del corte, identidad/empresa válidas, expectedStateVersion inicial, ausencia de estado y consultas completas de servidor que prueben ausencia de logs y regularizaciones propios en esa empresa. Dentro de la misma transacción crea estado + primera entrada + justificante. Sin todas esas pruebas, no asumir idle ni reconstruir sobre la marcha un histórico antiguo. Probar alta nueva, UID con historia, estado eliminado accidentalmente y carrera de dos primeras entradas. No añadir un trigger de usuarios.

El justificante es la auditoría confiable del backend; motivo, evidencia y administrador están en la regularización. audit_logs existente conserva sus otros usos, pero al admitir escrituras de clientes no es por sí solo prueba de ejecución del backend. No encadenar registrarAuditoria desde el navegador después de un fichaje confirmado para decidir si tuvo éxito.

## 5. Duplicados y conflictos entre dispositivos

1. Normalizar y validar la solicitud. Construir requestKey con hash de actorUid + requestId, dentro de la empresa; guardar hash del contenido semántico y de la versión esperada.
2. Dentro de la transacción, leer perfil/control/justificante/estado y documentos originales necesarios; todas las lecturas antes de las escrituras.
3. Si hay justificante del mismo actor y contenido, devolver su resultado anterior tras comprobar autorización. Una transición de modo puede bloquear nuevas operaciones, pero no debe impedir consultar el justificante propio de una ya confirmada. Mismo ID con otro contenido -> conflicto, ninguna escritura.
4. Si la versión cambió, rechazar la intención obsoleta. Dos entradas o salidas simultáneas con IDs distintos compiten por el mismo estado: solo una puede consumar la transición.
5. IDs de logs/justificantes estables para la solicitud; una regularización por originalEntryId. Creación exclusiva, no sobreescritura. Salida vs regularización comparten la misma versión/estado y comprueban que no hay resolución contradictoria.
6. Guardar evento + estado + justificante en un único commit. No prometer que la función se ejecuta una sola vez: garantizar un solo efecto por solicitud aceptada mediante transacciones e idempotencia.

No eliminar justificantes por TTL en V1: borrarlos permitiría perder la evidencia necesaria para reconciliar solicitudes antiguas. Una política de retención se aprobaría aparte.

## 6. Reglas futuras, todavía sin modificar

- Mantener la prohibición de update/delete de logs.
- session_states: trabajador solo su estado en su empresa actual; administrador solo estados de su empresa. Cualquier escritura desde cliente, incluido administrador, denegada.
- regularizations: trabajador solo las de su UID/empresa mediante consulta correctamente restringida; administrador solo su empresa. Crear/actualizar/borrar desde cualquier cliente, denegado.
- session_requests: lectura del actor propietario, y administrador de la misma empresa cuando sea necesaria para soporte; sin datos personales innecesarios. Escritura/edición/borrado de cliente, denegado.
- session_control: lectura mínima para usuarios de la empresa; escritura de cliente, denegada.
- logs.create conserva sus validaciones actuales únicamente en modo legacy; paused/backend deniegan escrituras directas. La ausencia del control solo mantiene legacy durante la etapa compatible, jamás equivale a backend inicializado.
- No ampliar permisos de otras colecciones ni usar una regla recursiva que conceda acceso a toda la empresa.
- Duplicar las comprobaciones de rol, empresa, referencia y estado en los endpoints; las reglas no protegen las escrituras del Admin SDK.
- Los tests actuales ALLOW de escritura directa siguen siendo válidos para legacy. Añadir DENY para backend/paused; no borrar pruebas anteriores para ocultar una regresión.

## 7. Disponibilidad y confirmación

Sin conexión antes de enviar: «No se ha enviado el fichaje. Conéctate para registrarlo». No registrar una hora del móvil como si fuese un fichaje de servidor.

Si hay timeout o se pierde la respuesta tras enviar: «Pendiente de confirmar». Conservar requestId y contenido mínimo, aislados por UID/empresa, y consultar el justificante desde servidor o reintentar la misma solicitud. No generar otro requestId ni recurrir automáticamente a addDoc. Reintentar no equivale a registrar retroactivamente una hora elegida por el cliente.

Mostrar éxito solo tras respuesta de commit o justificante confirmado en servidor. Un refresco de historial fallido después del commit se comunica como fallo de actualización, no como fichaje perdido. Desactivar doble pulsación es comodidad; la garantía está en el backend.

Si cae Functions, no hay fichaje confirmado ni ruta directa alternativa. Debe acordarse aparte el procedimiento de acreditación de una incidencia de servicio: no se incluye una cola de fichajes offline con horas retrospectivas.

Correo/token desactualizado: refresco explícito y mensaje diferenciado; no confundir sesión vencida, falta de permiso, versión obsoleta y servicio no disponible. El SDK callable transporta el token; el servidor exige correo verificado y perfil vigente.

## 8. Reconstrucción de estados y conservación de EMAR

Primero programar y probar un planificador puro de inicialización con datos ficticios. Usará fase 1 para referencias e inconsistencias; no utilizar la compatibilidad contable del reparto diario para decidir por sí sola si hay una jornada operativamente abierta.

- Historia coherente cerrada -> idle; una única entrada pendiente acreditada por el histórico -> open, conservando ID/Timestamp originales.
- Referencias ausentes, duplicados, solapamientos, cierres contradictorios o varias entradas pendientes -> needs_review, nunca elegir una arbitrariamente.
- Un bloqueo solo de reparto diario no convierte una sesión realmente cerrada en abierta.
- Sin historia, solo un conjunto completo y verificado permite proponer idle. Consulta fallida/incompleta, nunca.
- Generar manifiesto de solo lectura: conteos, IDs, digest canónico ordenado de todos los campos y timestamps, incidencias y estado propuesto. No introducir emails/datos reales en fixtures ni en el repositorio.
- Para EMAR, baseline de aceptación: los 79 documentos idénticos, 39 sesiones cerradas/9623 minutos y la entrada del 9 de agosto aún pendiente; inicializar estado no la regulariza.
- La futura aplicación del plan exige aprobación expresa, ventana de corte, entrada de logs estable y transacción/validación que compruebe que el digest y los documentos no han cambiado. Crear solo estados nuevos, no sobrescribir los existentes. Repetir la ejecución debe ser idempotente o detenerse por conflicto.
- Verificar digest/IDs y totales antes/después y detener todo ante una diferencia. Si el número de fichajes cambia por uso normal desde la auditoría, volver a obtener y aprobar el baseline; no forzar que producción tenga exactamente 79 en una fecha futura.

## 9. Impacto en lecturas e informes

Crear una capa de resolución adicional a la reconstrucción estricta; no falsificar logs para que fase 1 considere una entrada cerrada. La capa combinará originales con regularizaciones verificadas y conservará originalEntryId/regularizationId y trazabilidad de las fuentes.

Algoritmo de resolución a implementar y probar: validar primero cada regularización (entrada existente, mismo UID/empresa, ausencia de cierre ordinario y resolución única); separar las entradas ya resueltas solo de la reconstrucción operativa, conservándolas en el historial original completo; reconstruir los demás logs con fase 1 y agregar las resoluciones como fuentes tipadas independientes. No crear objetos de salida ficticios ni IDs de logs que no existen. Una incidencia original solo puede marcarse explicada cuando la resolución justifica exactamente esa referencia; conservar los demás conflictos. Probar expresamente entrada antigua + resolución desconocida + nueva entrada/salida: no debe reactivarse un consecutive_entries espurio ni desaparecer el original. Para duración conocida, adaptar el cálculo de reparto a extremos efectivos tipados sin hacer pasar la acreditación por un log salida.

- accredited_exit: cierre efectivo derivado de evidencia, claramente etiquetado, sin inventar un ID de log salida.
- unknown_exit: incidencia resuelta, duración desconocida y exclusión del total cuantificado; contadores visibles, nunca un cero trabajado.
- Panel/historial/PDF/CSV consumen el mismo modelo efectivo. Mantener reparto Europe/Madrid, desconocidos y discrepancias de fase 2.
- Añadir estado/motivo/administrador/fecha/ID de regularización y hora acreditada cuando exista. No presentar el instante de regularización como salida.
- Leer logs y regularizaciones con alcance de empresa/usuario y validación de referencias; lectura completa y consistente o informe bloqueado. No usar un caché de regularizaciones anterior a una regularización confirmada. Vincular instantánea a usuario/empresa/filtro como en fase 2; invalidar tras operaciones.
- En modo backend, cercar la carga con lecturas de servidor de control/epoch y versiones de todos los estados del alcance, antes y después de consultar logs/regularizaciones. Solo aceptar si permanecen iguales, completos y sin datos de caché/escrituras pendientes; cada operación backend debe incrementar la versión. Una regularización nueva o un fichaje concurrente obliga a recargar. En legacy se mantiene el camino previo, sin asumir esta garantía nueva.
- Si no puede obtenerse una lectura consistente (estado/versiones cambiando durante carga), reintentar y no exportar un informe parcial. Sin mezclar una entrada antigua «abierta» con un estado ya resuelto para declarar un cierre normal.
- Probar que sin regularizaciones el modelo nuevo coincide exactamente con los 130 controles previos y los 9623 minutos de referencia. Tras regularizar con hora acreditada, cualquier incremento histórico es una decisión explícita sobre evidencia, no una migración automática ni una modificación de los 9623 originales.

## 10. Orden de implementación futuro y validación por paso

Cada paso requiere una autorización de programación y revisión antes del siguiente. La autorización actual solo permite este documento.

| Paso | Un cambio | Validación de cierre |
| --- | --- | --- |
| 1 | Contratos y máquina de estados puros, sin Firebase ni integración | Invariantes, idempotencia semántica, campos admitidos, desconocido/cero y rechazo por versión |
| 2 | Paquete backend aislado y configuración exclusiva de emuladores | Auth/Firestore/Functions conectados a loopback con proyecto demo, sin credenciales reales ni acceso externo |
| 3 | Implementar clockIn transaccional | Dos dispositivos/doble clic/reintentos crean una sola entrada y un solo efecto |
| 4 | Implementar clockOut transaccional | Una sola salida válida, minutos de su mismo Timestamp, límite exacto de 24 h y recuperación tras respuesta perdida |
| 5 | Implementar regularizeSession | Solo admin de la empresa; motivo; dos modos; ninguna modificación de logs; competencia salida/regularización |
| 6 | Reglas locales y controles de modo | Denegación de escrituras clientes nuevas, aislamiento y matriz legacy/paused/backend; ALLOW previos conservados en legacy |
| 7 | Planificador puro de inicialización y dry-run ficticio | Digest, historias completas, conflictos, idempotencia; no ejecuta escrituras ni conecta producción |
| 8 | Capa efectiva de regularizaciones para informes | Paridad sin regularizaciones y trazabilidad/horas desconocidas en todos los informes |
| 9 | Cliente callable y mensajes, detrás de modo legacy | Sincronización de token, requestId persistente, timeout, caché, protocolo antiguo, regresiones completas y compilación |
| 10 | Ensayo completo de corte/retroceso en emuladores | Escrituras antiguas en vuelo/offline, pausa, inicialización, activación, digest intacto y cero mezcla de escritores |

Antes de cualquier prueba cloud, abrir una autorización independiente: proyecto aislado, Billing/Blaze, presupuesto, permisos, región y servicios. El emulador no reproduce IAM, costes, arranques en frío ni todas las condiciones de producción.

## 11. Transición futura: no ejecutada ni autorizada

1. Validar en emulador la app capaz de leer control y mostrar versión mínima; mantiene ruta legacy hasta el corte. No cambiar simultáneamente reglas y todos los clientes sin ensayo.
2. Con autorizaciones cloud independientes, desplegar primero backend inactivo y reglas de modo que preserven legacy. Preparar versión web/móvil compatible, recarga y comprobación de actualización.
3. Aprobar por separado ventana de corte de empresa. Cambiar control a paused: reglas bloquean directas y endpoints bloquean operaciones. Aviso previo, sin promesa de disponibilidad absoluta de clientes antiguos.
4. Drenar/reconciliar solicitudes en vuelo, leer histórico estable y producir un dry-run actual. Comparar manifiestos y revisar cualquier nueva escritura; no aplicar el baseline antiguo a ciegas.
5. Aprobar el manifiesto real. Crear estados mediante inicialización idempotente verificando nuevamente fuentes/versiones. Ninguna regularización automática. Confirmar integridad de originales.
6. Aprobar activación backend solo si todos los estados relevantes están inicializados o explícitamente en needs_review. Nunca interpretar estado ausente como libre.
7. En backend, reglas rechazan todas las directas, incluso SDK antiguo/REST o colas offline que lleguen después. La versión mínima es aviso funcional, no frontera de seguridad.
8. Los clientes antiguos deben recargar/actualizar; si no reconocen el cambio pueden mostrar el error genérico de permisos hasta actualizar. No existe garantía de cero interrupciones para ellos. No recuperar compatibilidad permitiendo dos escritores.

Retroceso: antes de nuevos efectos, volver a legacy solo si se verifica compatibilidad del histórico. Después de regularizaciones, especialmente sin salida conocida, el cliente antiguo no sabe interpretarlas: no basta desactivar un feature flag. Ante fallo, pausar y reparar hacia delante o usar una versión compatible; no borrar eventos ni restaurar estados antiguos por encima de operaciones confirmadas. Cualquier retroceso de producción requiere autorización y revisión de integridad.

## 12. Archivos previstos para programar, sin crearlos todavía

| Crear/modificar | Motivo |
| --- | --- |
| functions/package.json y su lockfile | firebase-functions + firebase-admin, runtime soportado fijado y dependencias aisladas del bundle React |
| functions/src/session-domain.js | Contratos, validaciones y transiciones puras; primera tarea recomendada |
| functions/src/session-service.js y functions/src/index.js | Transacciones y tres callables, sin lógica duplicada por endpoint |
| src/session-api.js y src/firebase.js | Cliente callable y conexión explícita al emulador; no cambiar Auth innecesariamente |
| src/session-resolution.js y src/session-reporting.js | Resoluciones efectivas para historial/panel/exportaciones; fase 1 permanece estricta |
| src/App.jsx | Sustituir ruta de fichaje solo en backend, UI de incidencias y regularización de admin, mensajes e invalidación de informes |
| scripts/plan-session-states.mjs | Planificador de solo lectura; futuro aplicador separado no incluido en la primera tarea |
| firebase.emulators.phase3.json | Auth/Firestore/Functions en 127.0.0.1, configuración local independiente |
| firebase.json, firestore.rules, package.json/lockfile si es imprescindible | Vincular backend y tests, reglas futuras revisadas; no modificar alias de producción para probar |
| tests/phase3/*.test.mjs | Matriz de dominio, endpoints, concurrencia, seguridad, transición e informes |

No crear índices en cloud durante la preparación. Identificar los que necesiten las consultas definitivas y probarlos luego en entorno aislado. No reorganizar App completo ni mover funcionalidades ajenas a fichaje/informes.

## 13. Matriz preparada para Firebase Emulator y regresiones

Solo datos ficticios y cuentas Auth Emulator de dos empresas. Proyecto demo-fichad2-phase3, ID coherente en los tres emuladores. El arranque de pruebas debe abortar si faltan FIRESTORE_EMULATOR_HOST/FIREBASE_AUTH_EMULATOR_HOST, si no son loopback o si el proyecto no empieza por demo-. Conectar Functions al emulador explícitamente; sin secretos de producción. Importar fixtures y limpiar únicamente la instancia de prueba.

| Suite futura | Casos obligatorios | Resultado exigido |
| --- | --- | --- |
| domain.test.mjs | idle/open/needs_review; estado ausente sin prueba de alta nueva; contrato inválido; versiones obsoletas | Sin transición implícita ni confianza en datos del navegador |
| auth.test.mjs | Sin token, correo no verificado, token renovado, rol cambiado, companyId/actor falsificados, solicitud pendiente tras cambio de empresa/epoch | Denegación antes de cualquier escritura; permisos vigentes |
| clock-in.test.mjs | Entrada normal, doble clic, dos dispositivos, 20 llamadas concurrentes con mismo/distinto requestId | Un efecto permitido, resto respuesta idéntica o conflicto; ningún duplicado |
| new-worker.test.mjs | Alta posterior al corte sin historia, perfil antiguo sin estado, UID con logs, dos primeras entradas simultáneas | Solo alta nueva acreditada inicia estado; ninguna pérdida de historia ni apertura doble |
| clock-out.test.mjs | Referencia ajena/inexistente; cero real por segundos; 24 h exactas; 24 h + 1 ns; reloj incoherente | Solo cierre válido y minutos coherentes con la marca persistida |
| idempotency.test.mjs | Commit y pérdida de respuesta; reintento; requestId con contenido diferente; intento obsoleto tras otra jornada | Recuperar el resultado, nunca crear otro evento |
| regularization.test.mjs | Trabajador, admin ajeno, admin propio, motivo vacío, sin evidencia, hora futura/anterior/solapada, hora local repetida/inexistente | Solo administrador propio con resolución coherente; cero escrituras parciales |
| regularization-races.test.mjs | Dos admins con horas distintas; conocida vs desconocida; salida ordinaria vs regularización | Una sola resolución; ninguna contradicción; logs originales idénticos |
| unknown-duration.test.mjs | Resolver sin hora, siguiente entrada/salida, ausencia de falso consecutive_entries e informes posteriores | Estado operativo desbloqueado por resolución, duración histórica null y contador visible |
| isolation.rules.test.mjs | Lecturas/escrituras de todas las nuevas colecciones por dos empresas y anónimo | Aislamiento completo; ninguna cuenta cliente puede regularizar ni cambiar estado/control/justificantes |
| modes.rules.test.mjs | Directas legacy, paused y backend; cliente REST antiguo; cola offline al reconectar | Reglas anteriores conservadas solo en legacy; sin escrituras directas después del corte |
| initialization.test.mjs | Formato antiguo sin referencia, varias abiertas, salida huérfana, duplicados, solo discrepancia de reparto | needs_review donde corresponda; no confundir incidencia contable con entrada abierta |
| cutover.test.mjs | Datos cambian tras dry-run, reinicio a mitad, estado existente, solicitud en vuelo, vuelta a legacy insegura | Detención/reconciliación; sin sobreescritura ni ejecución doble |
| report-resolution.test.mjs | Sin regularizaciones, salida acreditada, salida desconocida, versiones de lectura distintas | Paridad previa; ninguna suma ficticia, original/regularización identificados y caché invalidada |
| availability.test.mjs | Sin red, caída del backend, timeout antes/después de commit, refresh fallido | No mostrar éxito no confirmado ni llamar addDoc como fallback |
| full-regression.test.mjs | 130 controles previos, fixture ficticio de 79 logs/9623 minutos, medianoche, mes, DST, PDF/CSV y build | Mismos minutos originales y trazabilidad; informes bloqueados ante ambigüedad |

Pruebas de reglas no sustituyen pruebas de autorización del backend. Los escenarios concurrentes deben consultar después todos los documentos y contar efectos/IDs, no limitarse a comprobar el mensaje devuelto.

## 14. Dependencias y costes pendientes

El desarrollo y las pruebas locales pueden hacerse sin activar Blaze. Desplegar Cloud Functions requiere Blaze y cuenta de facturación. Producción permanece en Spark hasta autorización explícita; no se ha consultado ni cambiado el plan en este trabajo.

Servicios de una futura versión de Functions 2nd gen: ejecución de Functions/Cloud Run, construcción con Cloud Build, imágenes en Artifact Registry, Cloud Logging y operaciones/almacenamiento de Firestore; Authentication y Hosting siguen existentes. No se necesita Scheduler, Pub/Sub, Tasks, BigQuery ni almacenamiento de evidencias para esta versión.

Carga orientativa, no factura: 20 trabajadores x 22 días x 2 operaciones = 880 invocaciones normales/mes, más reintentos y regularizaciones. Cada éxito propone 3 escrituras (log o regularización, estado, justificante) y varias lecturas; reintentos transaccionales pueden aumentar lecturas. Medir esos números en pruebas, no fijar un coste en euros sin región, configuración, métricas y Billing.

Empezar con minInstances=0 y un máximo pequeño de instancias a validar con concurrencia: reduce gasto fijo, acepta arranque en frío. El máximo de instancias y los presupuestos/alertas no son un límite absoluto de toda la factura. Revisar retención de imágenes/logs, IAM y protección contra abuso. App Check es defensa adicional a evaluar y activar por separado tras comprobar clientes; no sustituye autenticación/roles ni se impone silenciosamente a clientes antiguos.

Si no se autoriza Blaze, el backend queda en desarrollo local y producción sigue con el sistema actual. Una alternativa transaccional íntegra con cliente+reglas en Spark requeriría otro diseño y aprobación: no usarla como atajo ni mezclarla con esta propuesta.

## 15. Puntos de aprobación y primera tarea

Aprobar por separado: cada paso de programación local; semánticas históricas no cubiertas (más de 24 h acreditadas, fracciones entre días, rectificación de una regularización); servicios/Billing y pruebas cloud; reglas/hosting/functions desplegados; ventana de corte; manifiesto e inicialización reales; activación; cualquier regularización real con su motivo/evidencia; retroceso.

Primera tarea recomendada: únicamente functions/src/session-domain.js y sus pruebas puras, sin SDK Firebase, sin endpoints, sin escrituras, sin conectar React. Entregable verificable: esquema de solicitudes, máquina de estados y reglas de decisión para entrada/salida/regularización; cubrir desconocido/cero, versión obsoleta e invariantes de identidad/empresa. Detenerse para revisión antes de implementar la transacción.

## Fuentes oficiales consultadas

- [Inicio de Functions: emulación y requisito Blaze](https://firebase.google.com/docs/functions/get-started).
- [Transacciones: atomicidad y reintentos](https://firebase.google.com/docs/firestore/manage-data/transactions).
- [Reglas y bibliotecas de servidor](https://firebase.google.com/docs/firestore/security/rules-conditions).
- [Callables: tokens y compatibilidad de SDK](https://firebase.google.com/docs/functions/callable).
- [Emulación de Functions](https://firebase.google.com/docs/functions/local-emulator).
- [Instancias y artefactos](https://firebase.google.com/docs/functions/manage-functions).
- [Tarifas Firebase](https://firebase.google.com/pricing).

Las rutas, contratos, estados, medidas de transición y estimaciones de carga de este documento son propuestas de diseño para Fichad2; no describen recursos ya desplegados ni costes reales comprobados.
