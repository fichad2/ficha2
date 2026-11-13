# Reconstrucción de historial — fase 1

Ejecutar desde `app/app2`:

```powershell
node --test tests/session-reconstruction.test.mjs
```

El módulo `src/session-reconstruction.js` es una función pura, sin Firebase,
credenciales, lecturas de red ni dependencias externas. No está conectado a React,
a los informes ni a escrituras. Las pruebas utilizan exclusivamente datos ficticios.

## Contrato

`reconstructSessions(records, { now } = {})` recibe documentos con su `id` original
y los campos actuales de `logs`: `companyId`, `userId`, `tipo`, `timestamp`,
`entradaLogId`, `inicioSesion` y `minutosSesion` (los tres últimos corresponden
a salidas; inicioSesion y minutosSesion pueden faltar en datos antiguos).

Las fechas aceptadas son `Date` válidos o timestamps con `seconds` y `nanoseconds`,
incluidas las instancias de Timestamp de Firestore. Se conserva su precisión para
comparar referencias y ordenar. No se interpreta texto de fechas, no se usa el
campo derivado `date` como sustituto de un timestamp inválido y no se resuelven
timestamps de servidor pendientes.

Solo se confirma un cierre con una referencia explícita, única y coherente a una
entrada del mismo trabajador y empresa. Una salida antigua sin `entradaLogId`
queda pendiente de revisión, aunque exista una única entrada cercana.

- `records`: todos los documentos recibidos, en su orden original.
- `sessions`: entradas reconstruibles ordenadas por empresa, trabajador e instante,
  con estado `open`, `closed` o `conflict`;
  conservan los objetos originales de entrada/salida. `minutes` es null salvo
  para cierres coherentes. No representa las duraciones desconocidas como cero.
- `unresolvedLogs`: registros inválidos, duplicados o salidas sin cierre confirmado.
  Las entradas válidas sin cierre se conservan en `sessions`.
- `issues`: códigos de incidencia, identificadores, índices de origen y si impiden
  reconstruir con confianza. IDs distintos al mismo instante, actor y tipo son
  **posibles** duplicados; no se afirma que sean el mismo fichaje ni se elimina uno.
- `groups`: resultado por empresa/trabajador. `canReconstruct=false` implica revisión
  y nunca debe utilizarse para desbloquear automáticamente al trabajador.
- `canReconstruct`: indica que no hay incidencias bloqueantes en el conjunto.

`open` significa que no hay salida validada **en el historial aportado**. El llamador
debe suministrar un historial completo antes de extraer conclusiones operativas.
El módulo no certifica que los documentos estén autenticados ni completos.

`now` debe inyectarse para detectar fechas futuras y entradas de más de 24 horas.
Sin esa opción, el resultado no depende del reloj actual. La alerta de antigüedad
no invalida la reconstrucción de una entrada abierta inequívoca. La comparación
de 24 horas es exacta; no se aplica redondeo por minutos a ese límite.

No se mutan los objetos recibidos; se devuelven referencias a los originales.
Los consumidores deben tratarlos como solo lectura. Solapamientos y entradas
consecutivas se señalan sin modificar emparejamientos explícitos ni inventar cierres.
Un dato de duración guardado que difiera del tiempo entre timestamps se señala
para revisión, incluso si la diferencia pudiera proceder del reloj del dispositivo.
`inicioSesion` admite la pérdida de precisión a milisegundos producida por el
`Timestamp.toDate()` del cliente actual, con aviso no bloqueante. Otras diferencias
se rechazan. Los timestamps originales mantienen su precisión para ordenar y
calcular la duración; ese reconocimiento no inventa una referencia ausente.

## Alcance pendiente

Esta fase no crea `session_states`, no regulariza incidencias, no modifica reglas,
no decide horas desconocidas y no migra datos. No cambia el comportamiento actual
de App.jsx ni su límite efectivo. Su futura integración requiere aprobación aparte.
