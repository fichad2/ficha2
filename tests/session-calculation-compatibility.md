# Fase 2: caracterización previa de compatibilidad

Ejecutar junto a las pruebas de la fase 1:

```powershell
node --test tests/session-reconstruction.test.mjs tests/session-calculation-compatibility.test.mjs
```

Estas pruebas de caracterización ejecutan exclusivamente las funciones puras
actuales extraídas de App.jsx y las comparan con el módulo independiente. No
ejecutan React, Firebase, descargas ni escrituras. Todas las identidades y fechas
son ficticias. Una prueba BLOCKER aprobada significa que se ha reproducido una
**incompatibilidad pendiente**, no que la integración esté aprobada.

## Diferencias demostradas

| Caso | Cálculo actual | Módulo de fase 1 |
| --- | --- | --- |
| Referencia explícita y duración coherente | 240 minutos | 240 minutos |
| Referencia explícita sin metadatos derivados | 240 minutos | 240 minutos |
| Salida antigua sin entradaLogId | 240 minutos inferidos por orden | Sin cierre confirmado, duración null |
| minutosSesion=239 e intervalo de timestamps de 240 minutos | 239 minutos guardados | Conflicto, duración null |
| 24 h y 30 s, con minutosSesion=1440 | 1440 minutos | Conflicto por superar 24 h exactas |
| Dos entradas sin referencia y una salida | Panel 180; inspección 240 | Sin emparejamiento inventado |
| Dos salidas referidas a la misma entrada | 481 minutos sumados | Conflicto, no se elige una salida |
| Solo una entrada abierta | Total 0 / 0.00 en informes | Duración desconocida, null |
| Sesión que cruza la fecha final del filtro | Panel excluye; inspección incluye por entrada | Sesión reconstruida, sin política de reparto |

El formato sin entradaLogId está documentado en Git: el App.jsx inicial,
commit cba5c2d, escribía userId, companyId, tipo y timestamp para entradas y salidas.
No se puede tratar automáticamente todo ese formato como corrupción. Tampoco se
pueden confirmar referencias que no existen.

Las reglas actuales validan el rango de minutosSesion, pero no su igualdad con
la diferencia entre timestamps. App.jsx calcula la duración con el reloj local
antes de que el servidor asigne el timestamp de salida. La fase 1 puede rechazar
por tanto cierres permitidos por las reglas; su límite exacto de 24 h también
difiere del límite efectivo basado en minutos enteros.

Además, calcularDashboard carga logs sin sus IDs (App.jsx, map de logsSnap),
mientras que el historial y la exportación de inspección sí los conservan. Una
integración directa necesitaría corregir ese adaptador antes de reconstruir.

## Decisiones pendientes para ampliar la compatibilidad

1. Cómo conservar como datos declarados las duraciones históricas sin confirmar
   un cierre o un emparejamiento que no esté acreditado.
2. Cómo mostrar discrepancias entre duración guardada y calculada sin cambiar
   silenciosamente los totales; distinguir ambas cantidades.
3. Aplicar la alerta exacta de 24 h a incidencias sin invalidar silenciosamente
   cierres históricos permitidos por la política de minutos vigente.
4. Política aprobada: reparto entre días naturales Europe/Madrid. Se integra
   donde el reparto exacto conserva los minutos; las fracciones entre días
   requieren revisión, sin redondear ni corregir originales.
5. Mostrar totales parciales y número de duraciones desconocidas, nunca convertir
   null en cero ni presentar como completo un total que omite incidencias.

No se han consultado fichajes reales para estas pruebas de caracterización.
No se afirma que estos casos estén presentes en EMAR. El módulo de fase 1 no se
modifica. El avance local de la integración se documenta en session-reporting.md;
el panel y los informes usan la capa compartida solo para datos compatibles.
Ante ambigüedad de reconstrucción o reparto diario, se conserva el cálculo
anterior del panel marcado como no verificado y se detienen las exportaciones.
