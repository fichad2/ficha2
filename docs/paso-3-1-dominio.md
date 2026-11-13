# Paso 3.1 — dominio puro de fichajes

Implementación local autorizada de contratos y decisiones. No es un endpoint,
una transacción ni una integración con la aplicación actual.

## Archivos y API

- functions/src/session-domain.js: módulo ESM independiente. Su única dependencia
  es node:crypto, incorporada en Node, para SHA-256 determinista. No hay SDK Firebase,
  lectura de reloj, generación aleatoria, red, archivos ni cambios de entorno.
- validateSessionRequest(request): valida/normaliza un contrato JSON estricto.
- inspectSessionState(state, now): valida el estado y proyecta el vencimiento.
- evaluateSessionOperation(context): devuelve error estructurado, replay o plan.
- tests/phase3/session-domain.test.mjs: datos ficticios exclusivamente.

## Estados

| Estado | Significado | Transiciones de negocio |
| --- | --- | --- |
| idle | Sin sesión activa | clockIn -> open |
| open | Entrada original activa | clockOut -> idle; regularizeSession -> regularized |
| needs_review | Sesión pendiente de revisión/regularización | regularizeSession -> regularized si referencias/historia son coherentes |
| regularized | Sesión resuelta, sin entrada activa; conserva referencia de resolución | clockIn -> open |

regularized se mantiene explícito conforme al requisito de este paso; sustituye
la transición a idle sugerida en la preparación para la regularización. Es un
estado libre para nueva entrada, no una sesión todavía abierta. La resolución
histórica permanece en el evento/justificante aunque una entrada nueva reemplace
la proyección del estado. No se modifica el documento de preparación anterior.

Una entrada con más de 24 horas se proyecta como needs_review/overdue sin mutar
el estado recibido ni incrementar su versión. No se propone escritura al fallar.
Un conflicto histórico no se oculta mediante regularización. Un estado ausente
se rechaza: la inicialización y las pruebas de alta nueva pertenecen a pasos
posteriores y no se simulan mediante un idle implícito.

## Contratos

Campos comunes obligatorios: operation (clockIn, clockOut o regularizeSession),
requestId (UUID v4 generado fuera del módulo y reutilizado en reintentos),
companyContext, expectedStateVersion, expectedEpoch y protocolVersion=1.
No se admiten campos extra como role, userId, timestamp o minutosSesion.

Regularización exige además originalEntryId, mode, reason, evidenceReference y
accreditedExitAt. reason: 1–1000 caracteres, tras comprobar longitud de entrada y
recortar espacios. accredited_exit exige referencia de evidencia de 1–500
caracteres y Timestamp JSON explícito; unknown_exit exige ambos campos null.
Nunca se calcula la salida desconocida con la hora de regularización.

Los instantes JSON tienen exactamente seconds (entero válido para Firestore) y
nanoseconds (0..999999999). No se admiten horas locales, ISO ambiguos ni Date en
el cuerpo de la solicitud. La conversión de una hora acreditada Europe/Madrid a
un instante inequívoco, incluidos los cambios DST, será responsabilidad de una
capa futura con pruebas. Los contextos confiables sí aceptan Date o Timestamp
con seconds/nanoseconds, sin importar Firebase.

Los modelos de contexto son DTOs: el adaptador futuro debe proyectarlos desde
los documentos persistidos (que tendrán metadatos adicionales), sin pasar datos
del navegador como actor, historia o justificante confiable.

Contexto confiable:

- actor: uid, companyId, role (trabajador/administrador), emailVerified.
- control: companyId, writeMode (legacy/paused/backend), epoch, minProtocolVersion.
- state: schemaVersion=1, companyId, userId, status, version, activeEntryId,
  openedAt, reviewReason, lastResolution y lastRequestId. Es un DTO estricto de
  dominio; el adaptador futuro debe proyectarlo desde almacenamiento y conservar
  por separado initializationId/sourceDigest/updatedAt, no perder metadatos al aplicar planes.
- now: instante confiable obligatorio; nunca se consulta Date.now().
- history para salida/regularización: complete=true, entry original, exitIds,
  regularizationIds, nextEntryAt y conflicts. Las colecciones negativas tienen
  que probarse mediante lecturas reales del backend futuro; no fiarse de flags
  del navegador. Si ya hay salida o resolución, se rechaza otro cierre.
- receipt opcional: justificante confiable de una solicitud ya confirmada.

Entrada/salida solo operan sobre el UID del actor, incluido un administrador que
fiche para sí mismo. Regularizar requiere administrador verificado de la misma
empresa del estado y del original. CompanyContext es una aserción, no autoridad.

Duración: el instante de salida es exactamente el now recibido para salida
ordinaria, o el instante acreditado para regularización conocida. La duración
ha de ser positiva y <=24 horas exactas, con precisión de nanosegundos. Se
conserva el truncado de minutos completos: 30 segundos son cero minutos
confirmados; unknown_exit mantiene null. Se rechazan fechas futuras, referencias
ajenas y solapamientos. Una salida desconocida no resuelve un histórico con una
entrada posterior de límite no acreditado: se requiere revisión.

## Resultados e idempotencia

Error: {ok:false,error:{code,message,details,retryable:false}}. No contiene plan,
no modifica datos ni incluye el contenido personal del motivo en errores.
Los códigos permiten separar autenticación, empresa/rol, sesión abierta,
regularización requerida, información incompleta, versión/epoch obsoletos,
conflictos de solicitud y justificantes inválidos. Un error de dominio no es
una recomendación de reintento automático; los fallos de red se modelarán después.

Decisión nueva: {ok:true,replayed:false,result,plan}. El plan tiene requestKey,
payloadFingerprint, precondiciones de versión/epoch, nextState, un event y un
receipt propuesto. El evento es entrada, salida o regularización: nunca una
regularización disfrazada de log salida. No representa una operación guardada.

SHA-256 identifica empresa+actor+requestId; el fingerprint se calcula sobre el
contrato normalizado, incluidos versión, epoch y motivo. Los IDs de entrada y
salida son deterministas; el de regularización es el originalEntryId dentro de
la colección de la empresa. Una solicitud reutilizada con otro contenido falla.

Con justificante válido: {ok:true,replayed:true,result,plan:null}. Devuelve el
resultado anterior sin otra transición, incluso si ahora hay pausa, otro epoch
o versión posterior. Se comprueban de nuevo identidad, correo, empresa y rol de
administrador para regularizaciones. El justificante debe proceder de
almacenamiento confiable: su comprobación estructural no es una firma digital.

El módulo garantiza determinismo e idempotencia de la decisión con un justificante
recibido; NO proporciona exclusión entre dispositivos ni unicidad persistente.
Dos llamadas aisladas con el mismo estado pueden producir planes válidos. La
transacción futura debe leer justificante/estado/fuentes, comprobar y aplicar
precondiciones y crear evento+estado+justificante atómicamente. Los replays no
se ejecutan. No guardar ni confirmar los planes desde React.

Los minutos guardados por fases 1/2 y sus módulos no se modifican. Las propuestas
ordinarias se prueban con reconstrucción/reporting existentes; las regularizaciones
aún no se conectan a esos modelos. La salvaguarda de reparto diario con fracciones
de minuto permanece independiente de resolver una incidencia operativa.

## Validación

Nuevas pruebas puras:

    node --test tests/phase3/session-domain.test.mjs

Regresión previa de 114 pruebas:

    node --test tests/session-reconstruction.test.mjs tests/session-reporting.test.mjs tests/session-calculation-compatibility.test.mjs tests/session-history-integration.test.mjs tests/session-report-integration.test.mjs tests/session-daily-allocation.test.mjs

Además: 16 pruebas originales de firestore.rules en emulador aislado con proyecto
demo, reglas sin cambios y host 127.0.0.1, y compilación de Vite con salida temporal.
No se requiere Functions Emulator ni crear su configuración para este paso.

Pendiente: autenticación real de endpoints, transacciones/concurrencia persistente,
inicialización, evidencia acreditada, UI, integración de regularizaciones e IAM.
Este módulo no prueba esas capacidades ni autoriza avanzar al paso 3.2.

## Resultado de la validación local

- Dominio nuevo: 112 pruebas aprobadas, ninguna fallida.
- Regresión anterior: 114 pruebas locales y 16 de reglas en emulador aprobadas.
- Total: 242 aprobadas, ninguna fallida ni omitida.
- Compilación correcta; avisos existentes de Browserslist y tamaño de paquetes.
- Reglas ejecutadas en proyecto demo-fichad2-step31, host 127.0.0.1:18080, con
  copias temporales idénticas a las reglas y pruebas originales. Emulador apagado.
- Los 25 archivos previos de código, pruebas, configuración y preparación bajo
  control de integridad permanecen idénticos. No se instalaron dependencias.
- Sin acceso a producción, migraciones, despliegues, cambios de plan ni commits.
