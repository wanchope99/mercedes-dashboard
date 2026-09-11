# Contexto operativo de Pulpería Soler

Esto se le pasa a los tres agentes de informes en CADA corrida, como parte de su
prompt de sistema. Son cosas que ya sabemos y que cambian cómo hay que leer los
números. Sin esto, el agente las "descubre" cada semana y las presenta como
hallazgos.

Se puede editar sin tocar código: el archivo se lee en cada corrida. Lo carga
`contextoOperativo()` en `src/informes.js`, que resuelve `contexto-<NEGOCIO_ID>.md`.

Qué va acá y qué no:

- **Acá:** hechos duraderos del negocio que hacen que un número raro no sea raro.
- **No acá:** feedback puntual sobre un hallazgo — eso va como nota desde la app
  (hoja `Informes Notas`), lo escriben los dueños y queda firmado.
- **No acá:** cómo se comporta la app. Eso no cambia la lectura de ningún número.
- **No acá:** lo que alguna planilla ya puede afirmar sola.

**Este archivo NO hereda nada del de Mercedes, y no debe.** Son dos negocios: los
hechos de uno usados para explicar los números del otro son peor que no tener
contexto, porque el modelo no tiene cómo saber que no son suyos.

Arranca casi vacío a propósito. Se llena a medida que Pulpo use la app y aparezca
algo que el agente tenga que dejar de redescubrir.

---

## Qué es este negocio

Pulpería Soler es un bar de vinos en Palermo, Ciudad de Buenos Aires.

**Lo atiende una sola persona.** No es un dato de color: cambia qué es normal.
No hay dotación que explique un salto de costo laboral, no hay reparto de
propinas, y el volumen de un servicio está acotado por lo que una persona puede
atender. Un pico de ventas por encima de eso es más probablemente un error de
carga que un récord.

## Qué está apagado en esta instancia

Nómina, Propinas, Cierre de cocina, Arqueo de caja y Plan / Recupero de inversión
no se usan acá. **Que no haya datos de esas cosas no es un hallazgo**: no es que
falte cargarlas, es que no existen para este negocio. No las pidas ni las marques
como ausentes.

## Lo que todavía no sabemos

Esta instancia arrancó el 09/09/2026. Hasta que haya varias semanas cargadas, las
comparaciones contra la mediana histórica van a estar hechas sobre muy pocos
puntos.

**Decilo cuando pase, en vez de callarlo.** Una desviación medida contra tres
semanas de historia no significa lo mismo que una medida contra seis meses, y el
lector tiene que poder distinguirlas. Si una señal se apoya en menos historia de
la que haría falta, marcalo junto al número — no lo omitas ni lo presentes como
si estuviera igual de sostenido que el resto.
