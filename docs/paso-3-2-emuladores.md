# Paso 3.2 — paquete backend y entorno exclusivamente local

Preparación del 20/10/2026. No implementa entrada, salida, regularización,
transacciones, inicialización ni migración. session-domain.js permanece intacto.

## Dependencias y runtime

functions/package.json es privado, ESM, main=src/index.js y runtime Node 22.
Solo dependencias directas: firebase-admin 13.7.0 (mismo major/versión disponible
en el proyecto) y firebase-functions 7.4.0, compatibles entre sí. Lockfile propio;
no modifica el package.json/lockfile de React. No añade herramientas de pruebas,
TypeScript, colas, cron, UI ni SDK cliente al backend.

El equipo tenía Node 24. Las pruebas de emuladores deben usar Node 22 real;
el lanzador aborta con otro major para no aceptar una validación engañosa del
runtime. Puede usarse un Node 22 instalado por el usuario o un runtime temporal
sin cambiar el Node global ni las dependencias del proyecto. El binario temporal
no es una dependencia del paquete backend.

Instalación reproducible del backend: npm ci --prefix functions --ignore-scripts.
Los scripts de instalación de dependencias no se ejecutan. Las dependencias se
obtienen del registro npm, sin activar APIs ni servicios de Firebase.

## Configuración separada

firebase.json, .firebaserc, React y sus conexiones actuales no cambian.
Usar firebase.emulators.phase3.json, nunca el alias default para estas pruebas.
Proyecto fijo: demo-fichad2-phase3.

| Servicio | Dirección |
| --- | --- |
| Authentication | 127.0.0.1:19099 |
| Firestore | 127.0.0.1:18080 |
| Functions | 127.0.0.1:15001 |
| Hub | 127.0.0.1:14400 |
| Logging | 127.0.0.1:14500 |
| Websocket de Firestore, asignación del CLI | 127.0.0.1:9150 |

UI desactivada. No se enlaza Hosting. El proyecto/demo y puertos de este backend
no sustituyen los de la aplicación React actual (9099/8080).

El lanzador valida la configuración, comprueba puertos libres sin detener otros
procesos y crea un workspace temporal con copia de las reglas y una instantánea de los cuatro
archivos autorizados de functions/src y su manifiesto/lockfile. Solo node_modules
se enlaza a las dependencias instaladas. Los logs quedan allí; no carga archivos .env de React. El lanzador genera en la
instantánea emulator-local.json con los dos indicadores FICHAD2 de emulación
(sin secretos). El punto de entrada los lee explícitamente porque discovery
filtra las variables personalizadas del padre y no las carga todavía del dotenv.
El proyecto, indicador FUNCTIONS_EMULATOR y hosts Auth/Firestore siguen siendo
obligatorios en el entorno del SDK; el JSON no los sustituye ni los relaja. No
escribe archivos locales de configuración en el paquete original. Cambiar el código requiere reiniciar para renovar la instantánea.
Ejecuta Firebase CLI con --project explícito y una cuenta/configuración CLI
separada mediante XDG_CONFIG_HOME/CLOUDSDK_CONFIG. Limpia variables de credenciales
y preloads; prepara PATH con el mismo Node 22 que ejecuta el lanzador.
El almacenamiento de credenciales globales no se modifica ni se consulta por el
código de funciones. Las llamadas a metadatos, si una herramienta las intentase,
se redirigen a una dirección de loopback sin servicio.

singleProjectMode=false permite ejecutar las 16 pruebas de reglas anteriores,
que usan el nombre ficticio/emulado fichad2: permanecen sin cambios y siempre
conectadas al host Firestore local. El backend, sus tokens y fixtures nuevos usan
exclusivamente demo-fichad2-phase3. No se prueba con recursos de fichad2-piloto.

## Punto de entrada de diagnóstico

Única función exportada: emulatorHealth, GET autenticado mediante un token de
Auth Emulator. Verifica el usuario contra Auth Emulator y lee un documento fijo
phase3_local_diagnostics/readiness en Firestore Emulator. Reutiliza DOMAIN_VERSION del
módulo puro, sin ejecutar operaciones de fichaje ni integrar React.

La respuesta solo incluye estado, proyecto demo y versión del dominio; no devuelve
UID, email, tokens ni datos personales. Rechaza métodos de escritura, llamadas
sin identidad local y fixtures ausentes. No implementa permisos de negocio:
correo verificado/roles de fichaje se conectarán en pasos posteriores autorizados.

El diagnóstico no escribe. Las únicas escrituras de las pruebas son un usuario
ficticio Auth y el documento de preparación, creados por la suite de integración
en emuladores. Se verifica que llamadas repetidas no alteran ese documento ni
crean logs, companies, session_states, regularizations o session_requests.

## Protección de aislamiento

- El entry point ESM no usa await de nivel superior: carga los SDK con
  createRequire después de validar el entorno, compatible con la carga del
  runtime de emuladores en Node 22.
- Guard antes de importar/inicializar SDKs: requiere modo local, indicador de
  Functions Emulator, proyecto exacto demo, coherencia de FIREBASE_CONFIG y los
  tres destinos fijados literalmente a 127.0.0.1 con sus puertos.
- Rechaza hosts externos, esquemas http en variables de host, proyectos reales,
  variables administrativas, configuración incoherente y emuladores ausentes.
- Revalida el entorno antes de cada solicitud y antes de cualquier lectura.
- Auth usa una credencial artificial owner, válida solo en emulación; no cert(),
  claves de servicio ni applicationDefault().
- Firestore usa el constructor público exportado por firebase-admin/firestore,
  con host/SSL explícitos y una credencial artificial inválida fuera del emulador.
  No descubre ADC del equipo. No contiene claves privadas reales.
- La configuración local tiene predeploy incondicionalmente bloqueado. La suite
  prueba directamente ese script, nunca ejecuta un comando firebase deploy.
- No hay scripts de publicación, activación de APIs ni alternativas de escritura
  directa al fallar los emuladores.

Estas medidas protegen este punto de entrada y el lanzador. No son un firewall
para código arbitrario añadido en el futuro: cualquier nuevo servicio/operación
exigirá mantener las mismas guardas y pruebas antes de habilitarse. Esta versión
no debe desplegarse ni habilitarse con una variable de escape.

## Ejecución

Con Node 22 y Firebase CLI disponibles, desde la raíz:

    node scripts/run-phase3-emulators.mjs test

Arranque manual, también aislado:

    node scripts/run-phase3-emulators.mjs start

El modo test usa emulators:exec, ejecuta todas las suites y comprueba al terminar
que no hay listeners en los puertos del entorno. Devuelve error si una prueba,
el arranque o la parada falla. No conecta con procesos ya existentes ni mata
procesos ajenos. El workspace temporal se conserva para revisión.

Pruebas de configuración/aislamiento sin arrancar emuladores:

    node --test tests/phase3/backend-environment.test.mjs

La suite de integración backend-emulator.test.mjs necesita los tres emuladores y
las variables del lanzador; aborta si faltan. El modo test incluye las 242 pruebas
anteriores: 114 de fases 1/2, 112 de dominio y 16 de reglas. Conserva sus archivos.

## Límites y fuentes

El emulador no acredita IAM, arranques en frío cloud, cuotas, costes ni aislamiento
de un despliegue real. Ninguno de esos servicios se activa en este paso. Continúa
pendiente implementar transacciones, operaciones y conectar la aplicación.

- [Emulación y proyectos demo](https://firebase.google.com/docs/emulator-suite/connect_functions).
- [Authentication Emulator y tokens locales](https://firebase.google.com/docs/emulator-suite/connect_auth).
- [Runtime Node y ESM](https://firebase.google.com/docs/functions/manage-functions).
- [SDK Functions publicado](https://registry.npmjs.org/firebase-functions/7.4.0).

## Resultado final del paso 3.2

- Runtime de prueba: Node 22.23.3 temporal; Node global 24 sin modificar.
- 242 pruebas anteriores aprobadas, sin modificar sus archivos.
- 33 pruebas nuevas de configuración, aislamiento y carga del runtime aprobadas.
- 3 pruebas nuevas de integración entre Auth, Firestore y Functions aprobadas.
- Total final: 278 aprobadas, 0 fallidas, 0 omitidas.
- Arranque de los tres emuladores y ejecución real de emulatorHealth verificados.
- Parada automática verificada: ningún puerto del entorno permanece escuchando.
- Compilación de React correcta, con los avisos previos de Browserslist y tamaño.
- Los 28 archivos anteriores bajo control de integridad permanecen idénticos,
  incluidos el dominio, React, reglas, firebase.json y manifiestos raíz.

Se corrigieron durante la preparación un plazo de subproceso demasiado corto,
el filtrado de variables del descubrimiento, un identificador reservado del
fixture y la incompatibilidad del runtime con await de nivel superior. Las
comprobaciones de aislamiento se mantuvieron activas durante esos fallos.
La ejecución final completa pasa; los ensayos fallidos también apagaron los
emuladores y verificaron sus puertos.

La instalación avisó de dependencias transitivas obsoletas (uuid/node-domexception);
no se cambió el SDK mayor ni se forzaron actualizaciones ajenas. No se ha realizado
una auditoría exhaustiva de vulnerabilidades ni validado capacidades de nube.
Sin credenciales administrativas reales, acceso a fichad2-piloto, activación de
Blaze/servicios, despliegues, commits ni operaciones de fichaje implementadas.
