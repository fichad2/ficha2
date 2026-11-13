# Paso 3.6 — reglas alternativas y modos de escritura locales

Alcance: exclusivamente `demo-fichad2-phase3`, Auth/Firestore/Functions Emulator en loopback. No constituye activación, migración ni autorización de despliegue. `firestore.rules`, `firebase.json`, `.firebaserc`, React y los tres servicios transaccionales permanecen intactos en este paso.

## Auditoría

React usa `addDoc(logs)` para entrada/salida; consulta logs con `companyId` y, para trabajadores, `userId`. El administrador consulta usuarios/logs de su empresa. Registro, invitaciones, datos de empresa y auditoría utilizan sus colecciones actuales; no se cambian esos permisos ni las validaciones del formato histórico de logs.

Las reglas originales no conocen `session_control` y deniegan por defecto las colecciones internas. La alternativa conserva sus reglas públicas, añadiendo únicamente la condición de modo para crear logs y lecturas internas mínimas para usuarios verificados de la empresa. No hay permisos recursivos generales ni escrituras internas de cliente. La lectura histórica de logs propios por UID, incluso si cambió la adscripción del trabajador, ya existe en las reglas originales y se conserva; esto no concede acceso a otros trabajadores. Una política distinta sobre cambios de empresa requeriría decisión separada.

Los tres servicios leen `companies/{companyId}/session_control/config` dentro de la misma transacción que escribe los efectos. `evaluateSessionOperation` exige control válido, protocolo y epoch vigentes y modo `backend` antes de generar un plan nuevo. El Admin SDK elude reglas, pero esta comprobación independiente ya estaba implementada: no ha sido necesario modificar los servicios ni duplicar su lógica.

## Matriz de autoridad

| Control de empresa | Cliente crea logs | Callable crea efectos nuevos | Reintento ya confirmado |
| --- | --- | --- | --- |
| Ausente | Validaciones originales (legacy compatible) | Rechazado: INVALID_CONTROL | Rechazado sin control válido |
| legacy válido | Validaciones originales | Rechazado: SERVICE_PAUSED | Solo recupera el justificante, sin escribir |
| paused válido | Rechazado | Rechazado: SERVICE_PAUSED | Solo recupera el justificante, sin escribir |
| backend válido | Rechazado | Permitido si supera todas las validaciones | Solo recupera el justificante, sin escribir |
| Existente inválido | Rechazado | Rechazado | Requiere control válido |

Control válido: `companyId` coincide con el perfil/ruta, `writeMode` pertenece a los tres modos, `epoch` entero seguro no negativo, `minProtocolVersion` entero seguro positivo. No interpretar un control parcial como ausencia ni deducir modo de campos enviados por React.

El justificante confirmado se recupera antes de comprobar el modo/epoch vigente, pero después de autenticar y comprobar perfil, rol, empresa y forma del control. Esta recuperación no altera log, estado, regularización ni fecha de commit. Una nueva solicitud durante la pausa se rechaza. No equivale a mantener dos sistemas de escritura activos.

## Reglas locales

Archivo candidato: `firestore.phase3-local.rules`. Solo lo referencia `firebase.emulators.phase3.json`; la configuración normal sigue intacta. El lanzador copia ambos archivos de reglas a un directorio temporal. La configuración local bloquea también el predeploy de Firestore, además del de Functions. Estos bloqueos son protecciones contra errores operativos; no sustituyen una revisión y autorización futura de IAM/despliegues.

- Logs: create únicamente en legacy; update/delete prohibidos en todos los modos. Se conservan las validaciones anteriores de identidad, correo, timestamps, campos y 1440 minutos.
- session_states: trabajador verificado lee su documento por UID y empresa; administrador verificado lee estados de su empresa. Para listar estados propios se necesita restringir también el ID documental; normalmente basta obtener el documento del UID conocido.
- regularizations: trabajador verificado lee las vinculadas a su workerUid y empresa; administrador verificado lee su empresa.
- session_requests: actor verificado lee sus justificantes y empresa; administrador verificado lee su empresa. El trabajador consulta la regularización que le afecta, no el justificante de otro actor administrador.
- session_control: miembro verificado con rol vigente trabajador/administrador lee únicamente `config` de su empresa.
- Todas las creaciones, ediciones y eliminaciones de estas cuatro colecciones se rechazan desde cualquier cliente, incluso administrador. Las rutas globales homónimas y otras rutas no reconocidas siguen denegadas.

Las consultas deben expresar sus restricciones; las reglas no filtran resultados. Los listados internos de administrador restringen `companyId`; regularizaciones/justificantes de trabajador restringen también workerUid/actorUid. Documentos con companyId incoherente no se exponen por una ruta de otra empresa.

## Ensayo y regresiones

Ejecutar con Node 22: `node scripts/run-phase3-emulators.mjs test`. El lanzador fija proyecto demo, SDK hosts de loopback, credenciales ficticias, almacenes CLI aislados y rechaza credenciales reales/preloads. No usa el alias de `.firebaserc`. Los fixtures y el control se crean exclusivamente en el emulador mediante el adaptador de pruebas confiable, nunca mediante una nueva operación administrativa accesible a React.

Orden: las 16 pruebas originales con reglas originales; las mismas 16 con reglas alternativas sin control (compatibilidad legacy); las demás pruebas anteriores; matriz nueva cargando explícitamente las reglas alternativas y probando callables HTTP reales. Las pruebas originales limpian únicamente el proyecto demo antes de los diagnósticos de lectura. No se suprime ninguna prueba previa.

La matriz nueva verifica lecturas propias/empresa, rechazo entre empresas y anónimo/no verificado, consultas no restringidas, todas las escrituras internas para trabajador y administrador, creación directa entrada/salida en cada modo, controles inválidos, batch malicioso, cola offline de cliente antiguo al reconectar, tres callables en cada modo, recuperación sin nuevas escrituras y barrera de pausa. Los snapshots posteriores comparan datos y updateTime para detectar efectos inesperados.

## Transición futura: no ejecutada

1. Autorizar y ensayar por separado cliente compatible, inicialización y capa de informes con regularizaciones. No activar backend con el React actual: seguirá intentando escrituras directas y no interpreta regularizaciones.
2. Obtener aprobación independiente para servicios cloud/Blaze, IAM, despliegues y ventana de corte. Publicar código compatible inactivo y reglas revisadas que conserven legacy. Ninguna acción cloud forma parte de este paso.
3. Aprobar por empresa el paso a `paused`, incrementando epoch mediante un operador confiable ajeno a React. Reglas y backend impiden efectos nuevos. Una operación que ya confirmó antes de la pausa permanece válida; la pausa no cancela commits anteriores.
4. Drenar/reconciliar solicitudes en vuelo; recuperar justificantes confirmados. Las escrituras offline antiguas que lleguen después se deniegan en servidor. No mostrar éxito por datos en caché ni confirmar una intención pendiente como fichaje guardado.
5. Obtener y aprobar un manifiesto actual del histórico estable; inicialización idempotente y validación de integridad requieren autorización propia. No forzar la antigua cifra de 79 si hubo actividad legítima posterior; no alterar originales para encajar un baseline.
6. Verificar estado inicializado para cada trabajador, incidencias, digest, versiones y reportes compatibles. Autorizar cambio a `backend` con nuevo epoch. No dejar en legacy como excepción a clientes antiguos.
7. Comprobar que solo callables escriben y los clientes desactualizados deben actualizarse. React actual puede mostrar el error genérico de permisos: mensajes de pausa/versión/resultado incierto quedan pendientes de integración futura.

No borrar el control tras el corte: la ausencia vuelve a permitir legacy. No volver automáticamente a legacy ante una caída de Functions. Después de efectos backend/regularizaciones, los estados y el cliente antiguo pueden resultar incompatibles; el retroceso seguro inicial es `paused`, reconciliar y reparar con aprobación. No borrar justificantes ni regularizaciones para deshacer operaciones.

## Riesgos pendientes

Se ha probado emulación, no IAM, índices cloud, latencia o facturación. Las pruebas no certifican recursos desplegados. Admin SDK puede alterar datos si se usa fuera de estos servicios; el futuro acceso operativo debe quedar restringido por IAM y procedimientos. Una pausa se serializa con las transacciones que leen su control, pero no revierte una escritura anterior; siempre reconciliar antes de inicializar.

En legacy permanecen las limitaciones anteriores: las reglas no prueban por sí mismas una única sesión ni la coherencia de entradaLogId con el original. No se amplía esa vía y no se mezcla con backend. Inicialización real, manejo de altas posteriores al corte, avisos React, informes efectivos y ensayo completo de transición requieren pasos y autorizaciones posteriores. No hay promesa de cero interrupciones para clientes antiguos.

Producción y EMAR no se consultan ni se modifican en este paso; no se verifican de nuevo datos reales. Las cifras históricas de EMAR son contexto de referencia, no fixtures copiados de producción ni una nueva auditoría real.
