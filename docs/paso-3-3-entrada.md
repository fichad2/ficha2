# Paso 3.3 — Entrada transaccional local

## Alcance

Solo callable clockIn, en demo-fichad2-phase3 y loopback. Sin salida, regularización, inicialización, migración, React, reglas ni despliegue. Mantiene los bloqueos y las credenciales ficticias del paso 3.2. No es un backend desplegable.

## Flujo y contrato

El cuerpo exacto se valida con validateSessionRequest del dominio del paso 3.1: operation=clockIn, requestId UUID v4 estable, companyContext, expectedStateVersion, expectedEpoch y protocolVersion=1. No se admiten UID, rol, empresa autoritativa, timestamp ni minutos del cliente.

La capa callable exige Authentication y obtiene el usuario vigente de Auth Emulator. Comprueba desactivación/revocación y correo verificado tanto en el token como en el usuario actual. Un token anterior a la verificación necesita renovación; no se cambia el cliente en este paso.

Dentro de cada intento de transacción se leen perfil users/{uid}, empresa, control companies/{companyId}/session_control/config, estado companies/{companyId}/session_states/{uid} y justificante companies/{companyId}/session_requests/{requestKey}. Empresa y rol proceden del perfil, no del navegador. companyContext solo es una aserción que debe coincidir. Entradas propias de administradores mantienen la política de identidad del dominio; no pueden fichar para terceros.

Solo con control backend, epoch/protocolo/version válidos y estado operativo inicializado que admita entrada, evaluateSessionOperation produce el plan. Sesión abierta o pendiente de revisión impide crear otra entrada; superar 24 h se detecta sin alterar el original. Un estado ausente se rechaza: no se infiere una historia vacía ni se incluye aún el alta inicial segura de la arquitectura.

En el mismo commit:

1. create logs/entry_{requestKey}, conservando el formato userId, companyId, tipo y timestamp.
2. update del estado con la transición del dominio, preservando initializationId/sourceDigest y metadatos existentes.
3. create del justificante inmutable, con resultado del dominio y committedAt del servidor.

La hora efectiva se obtiene con Timestamp.now() en el servidor, dentro de cada intento; log.timestamp y state.openedAt son idénticos. updatedAt/committedAt usan serverTimestamp de commit. No hay escrituras previas, addDoc alternativo ni sobrescritura de logs.

## Idempotencia y concurrencia

requestKey es SHA-256 del array JSON [DOMAIN_VERSION, empresa, UID, requestId normalizado], igual al dominio; se verifica que el plan coincida antes de escribir. La huella del contenido la calcula el dominio. Mismo UUID/contenido devuelve el resultado confirmado, sin actualizar ningún documento. Mismo UUID con otra versión/epoch/contenido se rechaza. La respuesta diferencia replayed y result, sin exponer el plan de escritura.

El justificante se valida con empresa/actor actuales antes de recuperarlo. Una respuesta confirmada puede recuperarse tras pausa/cambio de epoch, pero un cambio de empresa o pérdida de permisos no autoriza acceder al justificante anterior. Versiones y lecturas transaccionales arbitran dispositivos concurrentes. create impide sobrescribir IDs existentes.

## Errores y disponibilidad

Los errores conocidos devuelven código de transporte callable y details con code, details y retryable. Se distinguen autenticación, correo, perfil/empresa, sesión abierta, regularización requerida, modo, versión y clave contradictoria. No se exponen tokens, excepciones internas ni datos de otros trabajadores.

Ante error técnico o respuesta perdida se devuelve CONFIRMATION_UNAVAILABLE, retryable=true y outcomeUnknown=true: no se afirma que la operación no se guardó. Reintentar exactamente la misma solicitud permite recuperar el resultado si el commit sí ocurrió. El cliente y su persistencia de requestId siguen pendientes de autorización futura.

## Pruebas y aislamiento

El ejecutor ejecuta primero las 16 pruebas de reglas, después las otras 262 anteriores y al final clock-in.test.mjs. Las pruebas heredadas de reglas usaban el namespace emulado fichad2: en modo phase3Local ahora validan el entorno y usan exclusivamente demo-fichad2-phase3. Tras esos 16 casos limpian solo el Firestore emulado de demostración, antes de crear los fixtures de diagnóstico/entrada. Los casos y las reglas no cambian; fuera de este modo se conserva el comportamiento anterior. La prueba de exports permite únicamente emulatorHealth y clockIn; no existen endpoints de salida ni regularización.

Fixtures ficticios, Auth/Firestore/Functions emulados, dos dispositivos, 20 solicitudes iguales y distintas, correo/token, perfiles/empresas, estados/versiones y rechazos de campos protegidos. Una envoltura exclusivamente de prueba provoca un fallo real de precondición en el commit del emulador, tras encolar las escrituras: se comprueba rollback completo. También se prueba colisión de log original, que debe conservarse intacto. El callable no expone mecanismos de inyección de fallos.

Los guardas rechazan proyecto no demo, hosts no loopback o instancia Firestore de otro proyecto antes de consultar adaptadores. El constructor real está fijado a Firestore Emulator; no utiliza ADC ni claves reales. Snapshot temporal de Functions incluye los dos módulos nuevos. Arranque/parada, build y huellas de archivos protegidos se verifican al cerrar. La espera HTTP del smoke test heredado pasa de 60 a 180 segundos para tolerar el arranque lento observado en Windows; sus aserciones no cambian.

## Límites y pendientes

No activable en producción: faltan salida, regularizaciones, reglas de modo, inicialización autorizada, transición y cliente. No se deben mezclar escritores legacy y backend; las reglas actuales no se han cambiado. Un estado ficticio inicializado sirve para probar, no acredita la integridad de un histórico real. La pertenencia empresarial en Firestore queda cercada por la transacción; Authentication es otro servicio y no existe una transacción atómica entre ambos.

El emulador no reproduce IAM, Billing, cuotas, latencias ni todos los fallos cloud. Sin lecturas ni escrituras de producción: no se reauditan los 79 fichajes reales; la referencia de 9623 minutos se valida con las regresiones ficticias existentes. Desplegar, activar Blaze, migrar o avanzar al paso 3.4 requiere autorización independiente.

## Resultado de validación

Validación final: **329 pruebas aprobadas, 0 fallidas, 0 omitidas**: 16 de reglas + 262 anteriores restantes + 51 nuevas de entrada. Ejecutadas mediante Node 22 y scripts/run-phase3-emulators.mjs test, exclusivamente en demo-fichad2-phase3. La ejecución completa terminó con código 0; arranque y parada verificados.

Las nuevas pruebas verifican todas las condiciones solicitadas: autenticación/correo/perfil/empresa, estados abiertos o pendientes, versiones, modo/epoch, doble clic, reintentos idénticos y contradictorios, dos dispositivos, 20 solicitudes con claves iguales y distintas, fallo real de commit sin escrituras parciales y guardas de aislamiento. La renovación del token tras verificar el correo permite fichar.

Compilación npm run build aprobada (266 módulos); salida dirigida a un directorio temporal. Avisos previos de Browserslist y bundles >500 kB, sin cambios de dependencias. Revisadas diferencias y espacios finales. Huellas confirman intactos App.jsx, reconstrucción, reporting, dominio, firestore.rules, firebase.json, .firebaserc y ambos paquetes/lockfiles.

Incidencias de infraestructura previas a la ejecución final: primer intento sin pruebas por timeout de arranque de Firestore (60 s); segundo con 277/278 aprobadas y un timeout HTTP de arranque frío del diagnóstico. Se ajustó exclusivamente la espera HTTP de ese test a 180 s. La repetición completa aprobó 329/329.

### Archivos de este paso

- Creados: functions/src/clock-in-service.js, functions/src/clock-in-callable.js, tests/phase3/clock-in.test.mjs y este documento.
- Modificados: functions/src/index.js, scripts/run-phase3-emulators.mjs, scripts/run-phase3-tests.mjs, tests/phase3/backend-environment.test.mjs, tests/phase3/backend-emulator.test.mjs y tests/firestore.rules.test.mjs.
- Sin cambios de React, dominio, reglas, configuración Firebase de producción, dependencias ni datos reales. Sin commits, Blaze, despliegues ni paso 3.4.

