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

## Resultado de validación local — 13/11/2026

Estado del paso 3.6: implementación validada y cierre documental en su alcance local de reglas y modos de escritura. Este resultado NO valida ni autoriza producción, despliegues, migraciones, activación de backend ni cambios en EMAR. No se inicia el paso 3.7.

Base comprobada: rama `estabilizacion-fichad2`, commit `af5c3a26bb19dc91eab5a2f211d66949e72976c5`, con árbol de trabajo limpio al comenzar y terminar la validación. Se utilizó Node **22.23.3**, Firebase CLI **15.8.0** y Java **21.0.11**, ya disponibles, sin instalar dependencias ni modificar los archivos del proyecto.

Comando del lanzador, ejecutado con Node 22: `node scripts/run-phase3-emulators.mjs test`. Resultado final: **545 pruebas aprobadas, 0 fallidas, 0 omitidas; código de salida 0**.

| Bloque | Aprobadas | Fallidas | Omitidas |
| --- | ---: | ---: | ---: |
| Reglas originales | 16 | 0 | 0 |
| Compatibilidad legacy con reglas alternativas | 16 | 0 | 0 |
| Regresiones generales, dominio y entorno | 262 | 0 | 0 |
| clockIn | 51 | 0 | 0 |
| clockOut | 67 | 0 | 0 |
| Regularización | 77 | 0 | 0 |
| Matriz específica de reglas y modos del paso 3.6 | 56 | 0 | 0 |
| **Total** | **545** | **0** | **0** |

Las 33 pruebas de configuración y aislamiento pasaron también antes del arranque y se repitieron dentro del bloque de 262. No se suman de nuevo al total de 545. La batería incluye las 226 pruebas locales de reconstrucción, informes, integración y dominio previamente aprobadas.

### Aislamiento e integridad comprobados

- Único proyecto: `demo-fichad2-phase3`. Auth en `127.0.0.1:19099`, Firestore en `127.0.0.1:18080` y Functions en `127.0.0.1:15001`, con hub y logging locales y UI desactivada.
- Configuración local validada, JAR existente de Firestore verificado contra la huella esperada por la CLI y credenciales ficticias explícitas. Las guardas rechazaron los casos comprobados de proyectos reales, hosts remotos y variables de credenciales.
- Almacén de configuración de la CLI aislado, sin cuentas ni tokens y con telemetría desactivada. No se registraron llamadas API remotas de la CLI; no se utilizaron credenciales reales ni se consultaron servicios o datos de producción.
- Los 64 archivos versionados conservaron sus hashes durante la validación. Los 13 archivos comprobados del snapshot de backend, paquetes y reglas coincidieron con sus originales.
- Los snapshots, fixtures y logs de ejecución quedaron en carpetas temporales nuevas fuera del repositorio. El entorno principal fue `C:\Users\hugoembuena\AppData\Local\Temp\fichad2-step32-puiT3N`; sus artefactos son temporales y su permanencia no está garantizada.
- El lanzador confirmó el cierre de sus puertos al finalizar. La comprobación posterior no encontró listeners en 19099, 18080, 15001, 14400, 14500 y 9150. Sin reparaciones, cambios de reglas publicadas, commits ni operaciones remotas Git.

### Comportamientos confirmados

La matriz de autoridad de este documento quedó comprobada mediante reglas alternativas y callables HTTP reales en los emuladores:

- `legacy`: se permiten creaciones directas de logs sujetas a las validaciones históricas; las callables rechazan efectos nuevos con `SERVICE_PAUSED`. Los reintentos confirmados pueden recuperar su justificante sin nuevas escrituras.
- `paused`: se rechazan tanto las creaciones directas como los efectos nuevos de las tres callables. La recuperación de justificantes confirmados no altera documentos ni fechas de commit. La barrera de pausa impide efectos nuevos posteriores, sin revertir commits anteriores.
- `backend`: el cliente no puede crear logs directamente. `clockIn`, `clockOut` y `regularizeSession` solo generan efectos tras validar identidad, rol, empresa, control, protocolo, epoch, estado e historial cuando corresponde.
- Control ausente: se conserva la compatibilidad legacy para escrituras directas; las callables rechazan la operación con `INVALID_CONTROL`. Un control existente inválido no se interpreta como ausencia y deniega efectos nuevos.
- Administrador y trabajador: lecturas internas limitadas por identidad y empresa; escrituras internas de cliente prohibidas incluso para administradores. Se comprobaron rechazos entre empresas, anónimos, usuarios no verificados y consultas no restringidas.
- Integridad: edición y borrado de logs originales denegados; regularizaciones sin alterar originales; concurrencia, rollback, idempotencia y recuperación sin escrituras adicionales comprobados. Las escrituras offline de clientes antiguos se rechazaron al reconectar tras el cambio de modo.

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

**Bloqueo para activar backend en una empresa real:** React sigue utilizando escrituras directas y todavía no consume las tres callables ni integra regularizaciones en historial, dashboard, PDF y CSV. Cambiar ahora a `backend` rechazaría sus fichajes directos. La validación local del paso 3.6 no elimina esta incompatibilidad ni autoriza modificar el modo de ninguna empresa real.

Se ha probado emulación, no IAM, índices cloud, latencia o facturación. Las pruebas no certifican recursos desplegados. Admin SDK puede alterar datos si se usa fuera de estos servicios; el futuro acceso operativo debe quedar restringido por IAM y procedimientos. Una pausa se serializa con las transacciones que leen su control, pero no revierte una escritura anterior; siempre reconciliar antes de inicializar.

En legacy permanecen las limitaciones anteriores: las reglas no prueban por sí mismas una única sesión ni la coherencia de entradaLogId con el original. No se amplía esa vía y no se mezcla con backend. Inicialización real, manejo de altas posteriores al corte, avisos React, informes efectivos y ensayo completo de transición requieren pasos y autorizaciones posteriores. No hay promesa de cero interrupciones para clientes antiguos.

El Node 22 utilizado está en una carpeta temporal. Si deja de estar disponible, habrá que comprobar de nuevo el runtime antes de repetir la batería; este cierre no autoriza instalarlo ni actualizar dependencias automáticamente.

Producción y EMAR no se consultan ni se modifican en este paso; no se verifican de nuevo datos reales. Las cifras históricas de EMAR son contexto de referencia, no fixtures copiados de producción ni una nueva auditoría real.

## Condiciones para abordar el paso 3.7 — no iniciado

1. Obtener autorización expresa para comenzar 3.7 y acordar su objetivo, archivos permitidos y criterios de aceptación. Este cierre no decide ni implementa automáticamente el siguiente trabajo.
2. Comprobar el estado de Git y preservar el punto de partida recuperado, tomando este commit y la batería de 545 pruebas como referencia. Mantener íntegros los originales, las pruebas existentes y las salvaguardas de aislamiento.
3. Conservar el alcance local: proyecto demo, destinos loopback, credenciales ficticias y runtime compatible. Preparar y probar cada cambio con datos inventados; no utilizar históricos reales como fixtures.
4. Si el alcance autorizado incluye el cliente, especificar y probar callables, requestId estable, protocolo, epoch, versiones de estado, recuperación de confirmaciones y mensajes de pausa o actualización. No admitir éxito por datos pendientes o en caché ni retorno automático a escrituras directas ante un fallo del backend.
5. Si incluye inicialización, comenzar por un planificador puro y pruebas ficticias de integridad, manifiesto/digest, idempotencia e incidencias. La ejecución sobre datos reales requiere otra autorización y no forma parte de la preparación local.
6. Si incluye historial o informes con regularizaciones, comprobar referencias y lecturas consistentes, conservar registros originales, distinguir duraciones desconocidas de cero y mantener las salvaguardas del reparto diario. No simular salidas históricas inexistentes.
7. Definir las pruebas nuevas del alcance aprobado y exigir que las regresiones existentes sigan pasando. Un ensayo local de transición debe cubrir pausa, solicitudes en vuelo, clientes antiguos/offline e incompatibilidades, sin activar ninguna empresa real.
8. Mantener separada cualquier futura decisión cloud: IAM, índices, costes, Blaze, despliegues, migraciones y ventana de corte requieren revisión y autorización independientes. Ningún resultado local permite declarar producción validada.
